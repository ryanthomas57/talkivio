import { MetricsService } from '../../core/metrics.service';
import { Injectable, Logger } from '@nestjs/common';
import type { Attachment, AttachmentState, Chat, Prisma } from '@prisma/client';
import type { Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TenantDb, type Tx } from '../../db/tenant-db';
import {
  AppError,
  badRequest,
  conflict,
  denied,
  notFound,
  type AuthContext,
  type VisitorContext,
} from '../../common/http';
import { AuditService } from '../../common/audit.service';
import { env } from '../../config/env';
import { QueueService, QUEUES } from '../../core/queue.service';
import { RateLimitService } from '../../core/rate-limit.service';
import {
  StorageLimitError,
  StorageService,
  contentDisposition,
  keyHash,
  type StorageArea,
} from '../../core/storage.service';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import { ChatQueriesService } from '../chats/chat-queries.service';
import { ChatStore } from '../chats/chat.store';
import { WidgetService } from '../widget/widget.service';
import { ScannerUnavailableError, clamdScan } from './clamav';
import {
  PLATFORM_MAX_FILE_BYTES,
  PolicyViolation,
  inspectContent,
  isImageMime,
  reasonMessage,
  validateDeclaration,
  type BlockReason,
} from './file-policy';

/** Upload URL lifetime (ch. 19: 5 minutes). */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** Download grant lifetime (ch. 19: 60 seconds). */
export const DOWNLOAD_GRANT_TTL_SECONDS = 60;
const MAX_PENDING_PER_UPLOADER = 10;
const ORPHAN_TTL_MS = 24 * 3600_000;
const REJECTED_RETENTION_MS = 7 * 24 * 3600_000;
const STALE_SCAN_MS = 10 * 60_000;
const UNFINALIZED_TTL_MS = 60 * 60_000;

export type Uploader = { kind: 'agent'; auth: AuthContext } | { kind: 'visitor'; visitor: VisitorContext };

export interface AttachmentResource {
  id: string;
  chatId: string | null;
  name: string;
  sizeBytes: number;
  mime: string;
  state: AttachmentState;
  isImage: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  sha256: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadInit {
  uploadId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
  attachment: AttachmentResource;
}

/** Monotonic aggregate version per state (clients ignore stale versions). */
const STATE_RANK: Record<AttachmentState, number> = {
  initiated: 1,
  uploading: 2,
  uploaded: 3,
  scanning: 4,
  clean: 5,
  rejected: 5,
  expired: 6,
};
const ACTIVE_STATES: AttachmentState[] = ['initiated', 'uploading', 'uploaded', 'scanning'];
const REJECTED_CODES = new Set<BlockReason>([
  'malware',
  'corrupt',
  'checksum_mismatch',
  'size_mismatch',
  'image_too_large',
]);

export function errorCodeFor(a: Pick<Attachment, 'state' | 'rejectReason' | 'scanResult'>): string | null {
  if (a.state === 'rejected')
    return REJECTED_CODES.has(a.rejectReason as BlockReason) ? 'FILE_REJECTED' : 'FILE_TYPE_BLOCKED';
  if (a.state === 'scanning' && a.scanResult?.startsWith('pending:scanner')) return 'FILE_SCAN_PENDING';
  return null;
}

export function attachmentResource(a: Attachment): AttachmentResource {
  const mime = a.detectedMime ?? a.declaredMime;
  return {
    id: a.id,
    chatId: a.chatId,
    name: a.originalName,
    sizeBytes: Number(a.sizeBytes),
    mime,
    state: a.state,
    isImage: isImageMime(mime),
    errorCode: errorCodeFor(a),
    errorMessage:
      a.state === 'rejected'
        ? reasonMessage((a.rejectReason ?? 'type_not_allowed') as BlockReason)
        : a.state === 'scanning' && a.scanResult?.startsWith('pending:scanner')
          ? 'Security scan is delayed; the file will be available once it has been checked.'
          : null,
    sha256: a.sha256,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function policyError(e: PolicyViolation): AppError {
  if (e.code === 'FILE_TOO_LARGE')
    return new AppError(413, 'FILE_TOO_LARGE', e.message, { details: { reason: e.reason } });
  if (e.code === 'VALIDATION_FAILED')
    return badRequest(e.message, { [e.reason === 'name' ? 'name' : 'size_bytes']: [e.message] });
  return new AppError(422, e.code, e.message, { details: { reason: e.reason } });
}

/**
 * Attachment lifecycle (ch. 19): initiated → uploading → uploaded → scanning → clean | rejected | expired.
 * Bytes live in the private quarantine area until a clean verdict; only clean bytes are
 * copied (from the verified, scanned buffer) into the private clean area and served
 * through 60-second grants after re-checking chat authorization.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');

  constructor(
    private readonly db: TenantDb,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly rateLimit: RateLimitService,
    private readonly chats: ChatQueriesService,
    private readonly store: ChatStore,
    private readonly widget: WidgetService,
    private readonly metrics: MetricsService,
  ) {}

  // ───────────────────────── Access helpers ─────────────────────────

  private tenantOf(up: Uploader): string {
    return up.kind === 'agent' ? up.auth.tenantId : up.visitor.tenantId;
  }

  /** Agent may write to the chat: active participant, or supervisor in scope (same rule as messaging). */
  private async agentWritableChat(tx: Tx, auth: AuthContext, chatId: string): Promise<Chat> {
    if (!auth.membershipId) throw denied('Only agents can upload files');
    const chat = await this.chats.getVisible(tx, auth, chatId);
    const participant = await tx.chatParticipant.findFirst({
      where: { tenantId: auth.tenantId, chatId, membershipId: auth.membershipId, leftAt: null },
      select: { id: true },
    });
    const inScope =
      auth.departmentScope === 'all' ||
      (chat.departmentId ? auth.departmentScope.includes(chat.departmentId) : true);
    if (!participant && !(auth.permissions.has('chats.monitor') && inScope))
      throw denied('Join the chat before sharing files');
    return chat;
  }

  private async visitorChat(tx: Tx, v: VisitorContext, chatId: string): Promise<Chat> {
    const chat = await tx.chat.findFirst({
      where: { tenantId: v.tenantId, id: chatId, visitorId: v.visitorId, siteId: v.siteId },
    });
    if (!chat) throw notFound('Chat');
    return chat;
  }

  /** The uploader's own attachment (404 for anyone else — no existence leak). */
  private async ownAttachment(tx: Tx, up: Uploader, id: string): Promise<Attachment> {
    const tenantId = this.tenantOf(up);
    const a = await tx.attachment.findFirst({ where: { tenantId, id, deletedAt: null } });
    if (!a) throw notFound('Upload');
    const mine =
      up.kind === 'agent'
        ? a.uploadedByActor === 'agent' && a.uploadedById === up.auth.membershipId
        : a.uploadedByActor === 'visitor' && a.uploadedById === up.visitor.visitorId;
    if (!mine) throw notFound('Upload');
    if (up.kind === 'visitor' && a.chatId) await this.visitorChat(tx, up.visitor, a.chatId);
    return a;
  }

  private async rawTenantSettings(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    return (t?.settings ?? {}) as Record<string, unknown>;
  }

  private async enforceDailyQuota(tx: Tx, tenantId: string, sizeBytes: number): Promise<void> {
    const raw = await this.rawTenantSettings(tx, tenantId);
    const files = (raw.files ?? {}) as { dailyQuotaMb?: unknown; dailyQuotaFiles?: unknown };
    const quotaMb =
      typeof files.dailyQuotaMb === 'number' && files.dailyQuotaMb > 0
        ? files.dailyQuotaMb
        : env().UPLOAD_DAILY_QUOTA_MB;
    const quotaFiles =
      typeof files.dailyQuotaFiles === 'number' && files.dailyQuotaFiles > 0
        ? files.dailyQuotaFiles
        : env().UPLOAD_DAILY_QUOTA_FILES;
    const usage = await tx.attachment.aggregate({
      where: { tenantId, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    const usedBytes = Number(usage._sum.sizeBytes ?? 0n);
    if (usage._count._all + 1 > quotaFiles || usedBytes + sizeBytes > quotaMb * 1024 * 1024) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'The daily file upload quota for this workspace has been reached.',
        { retryable: true, retryAfter: 3600, details: { reason: 'daily_quota' } },
      );
    }
  }

  // ───────────────────────── Events ─────────────────────────

  private async emit(tx: Tx, a: Attachment, extra: { deleted?: boolean } = {}): Promise<void> {
    if (!a.chatId) return;
    const payload = {
      attachmentId: a.id,
      chatId: a.chatId,
      state: a.state,
      sizeBytes: Number(a.sizeBytes),
      mime: a.detectedMime ?? a.declaredMime,
      ...(errorCodeFor(a) ? { errorCode: errorCodeFor(a) } : {}),
      ...(extra.deleted ? { deleted: true } : {}),
    };
    const scopes: OutboxScope[] = [{ kind: 'chat', id: a.chatId, audience: 'staff' }];
    // The uploading visitor sees their own tray progress; agent uploads stay staff-only until sent.
    if (a.uploadedByActor === 'visitor')
      scopes.push({ kind: 'chat', id: a.chatId, audience: 'public', payload });
    await this.outbox.append(tx, a.tenantId, {
      aggregateType: 'attachment',
      aggregateId: a.id,
      aggregateVersion: STATE_RANK[a.state],
      eventType: 'attachment.updated',
      payload,
      scopes,
    });
  }

  /** Conditional state transition; returns the updated row or null if the guard did not match. */
  private async transition(
    tx: Tx,
    a: Attachment,
    from: AttachmentState[],
    data: Prisma.AttachmentUpdateManyMutationInput & { state: AttachmentState },
  ): Promise<Attachment | null> {
    const r = await tx.attachment.updateMany({
      where: { tenantId: a.tenantId, id: a.id, state: { in: from }, deletedAt: null },
      data,
    });
    if (!r.count) return null;
    const updated = await tx.attachment.findUniqueOrThrow({ where: { id: a.id } });
    await this.emit(tx, updated);
    return updated;
  }

  // ───────────────────────── Upload initiation ─────────────────────────

  async initUpload(
    up: Uploader,
    input: { chatId: string; name: string; sizeBytes: number; mime: string; sha256?: string | null },
  ): Promise<UploadInit> {
    const tenantId = this.tenantOf(up);
    if (up.kind === 'agent')
      await this.rateLimit.enforce(
        `upload:m:${up.auth.membershipId}`,
        120,
        600,
        'Too many uploads. Please wait a moment.',
      );
    else {
      await this.rateLimit.enforce(
        `upload:v:${up.visitor.visitorId}`,
        20,
        600,
        'Too many uploads. Please wait a moment.',
      );
      if (up.visitor.ipNetHash)
        await this.rateLimit.enforce(
          `upload:ip:${up.visitor.ipNetHash}`,
          60,
          600,
          'Too many uploads. Please wait a moment.',
        );
    }
    const created = await this.db.tx(tenantId, async (tx) => {
      const chat =
        up.kind === 'agent'
          ? await this.agentWritableChat(tx, up.auth, input.chatId)
          : await this.visitorChat(tx, up.visitor, input.chatId);
      if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has ended');
      const settings = await this.store.settings(tx, tenantId);
      let allowed = settings.chat.allowAttachments;
      if (up.kind === 'visitor' && allowed)
        allowed = (await this.widget.publishedConfig(tx, chat.siteId)).config.behavior.attachments.enabled;
      if (!allowed)
        throw new AppError(403, 'FILE_TYPE_BLOCKED', 'File sharing is turned off for this chat.', {
          details: { reason: 'disabled' },
        });
      let declared;
      try {
        declared = validateDeclaration(input, {
          maxBytes: Math.min(settings.chat.maxAttachmentMb, 10) * 1024 * 1024,
          tenantAllowed: settings.chat.allowedFileTypes,
        });
      } catch (e) {
        if (e instanceof PolicyViolation) throw policyError(e);
        throw e;
      }
      await this.enforceDailyQuota(tx, tenantId, input.sizeBytes);
      const uploadedById = up.kind === 'agent' ? up.auth.membershipId! : up.visitor.visitorId;
      const pending = await tx.attachment.count({
        where: { tenantId, chatId: chat.id, uploadedById, state: { in: ACTIVE_STATES }, deletedAt: null },
      });
      if (pending >= MAX_PENDING_PER_UPLOADER)
        throw new AppError(429, 'RATE_LIMITED', 'Finish or cancel the current uploads first.', {
          retryable: true,
          retryAfter: 30,
        });
      const id = randomUUID();
      const a = await tx.attachment.create({
        data: {
          id,
          tenantId,
          chatId: chat.id,
          uploadedByActor: up.kind,
          uploadedById,
          objectKey: `t/${tenantId}/att/${id}/${randomBytes(16).toString('hex')}`,
          originalName: declared.name,
          declaredMime: declared.mime,
          sizeBytes: BigInt(input.sizeBytes),
          sha256: input.sha256?.toLowerCase() ?? null,
          state: 'initiated',
          expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
        },
      });
      await this.emit(tx, a);
      return { a, maxBytes: Math.min(settings.chat.maxAttachmentMb, 10) * 1024 * 1024 };
    });
    const { a } = created;
    const ticket = await this.storage.presignUpload({
      area: 'quarantine',
      key: a.objectKey,
      contentType: a.declaredMime,
      contentLength: Number(a.sizeBytes),
      sha256Hex: a.sha256,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
      grant: {
        tenantId,
        resourceId: a.id,
        scope: `attachment:${up.kind === 'agent' ? 'agent' : 'widget'}`,
        path:
          up.kind === 'agent' ? `/api/v1/attachments/${a.id}/content` : `/widget/v1/uploads/${a.id}/content`,
      },
    });
    return {
      uploadId: a.id,
      url: ticket.url,
      method: ticket.method,
      headers: ticket.headers,
      expiresAt: ticket.expiresAt,
      maxBytes: created.maxBytes,
      attachment: attachmentResource(a),
    };
  }

  // ───────────────────────── Local-driver upload receiver ─────────────────────────

  /** `PUT …/content?sig=` (local driver): single-use, expiring, exact-size upload into quarantine. */
  async receiveLocal(
    scope: 'agent' | 'widget',
    id: string,
    sig: string | undefined,
    req: Readable & { headers: Record<string, string | string[] | undefined> },
  ): Promise<AttachmentResource> {
    if (this.storage.driver !== 'local') throw notFound('Upload');
    const claims = this.storage.verifyGrant(sig, {
      kind: 'upload',
      resourceId: id,
      scope: `attachment:${scope}`,
    });
    if (!claims) throw new AppError(403, 'PERMISSION_DENIED', 'This upload link is invalid or has expired.');
    const tenantId = claims.t;
    const lengthHeader = req.headers['content-length'];
    const contentLength =
      typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const claimed = await this.db.tx(tenantId, async (tx) => {
      const a = await tx.attachment.findFirst({ where: { tenantId, id, deletedAt: null } });
      if (!a || keyHash(a.objectKey) !== claims.h) throw notFound('Upload');
      if (Number.isNaN(contentLength))
        throw badRequest('Content-Length is required', { content_length: ['Required'] });
      if (contentLength > Number(a.sizeBytes))
        throw new AppError(413, 'FILE_TOO_LARGE', 'The upload is larger than the declared file size.');
      if (contentLength !== Number(a.sizeBytes))
        throw badRequest('Content-Length must equal the declared size', {
          content_length: [`Expected ${a.sizeBytes}`],
        });
      if (contentType !== a.declaredMime)
        throw badRequest('Content-Type must match the declared type', {
          content_type: [`Expected ${a.declaredMime}`],
        });
      const r = await tx.attachment.updateMany({
        where: { tenantId, id, state: 'initiated', expiresAt: { gt: new Date() }, deletedAt: null },
        data: { state: 'uploading' },
      });
      if (!r.count) throw conflict('CONFLICT', 'This upload link was already used or has expired.');
      const updated = await tx.attachment.findUniqueOrThrow({ where: { id } });
      await this.emit(tx, updated);
      return updated;
    });
    try {
      await this.storage.receive('quarantine', claimed.objectKey, req, Number(claimed.sizeBytes));
    } catch (err) {
      if (err instanceof StorageLimitError && err.reason === 'too_large') {
        await this.db.tx(tenantId, (tx) =>
          this.transition(tx, claimed, ['uploading'], {
            state: 'rejected',
            rejectReason: 'size_mismatch',
            scanResult: 'rejected:size',
          }),
        );
        await this.storage.delete('quarantine', claimed.objectKey).catch(() => undefined);
        throw new AppError(413, 'FILE_TOO_LARGE', 'The upload is larger than the declared file size.');
      }
      // Interrupted transfer: return to `initiated` so the same link can be retried before it expires.
      await this.db
        .tx(tenantId, (tx) =>
          tx.attachment.updateMany({
            where: { tenantId, id, state: 'uploading' },
            data: { state: 'initiated' },
          }),
        )
        .catch(() => undefined);
      if (err instanceof StorageLimitError)
        throw badRequest('The upload was interrupted. Please retry.', {
          content_length: ['Body shorter than declared'],
        });
      throw err;
    }
    const done = await this.db.tx(tenantId, (tx) =>
      this.transition(tx, claimed, ['uploading'], { state: 'uploaded' }),
    );
    if (!done) throw conflict('CONFLICT', 'The upload was cancelled.');
    return attachmentResource(done);
  }

  // ───────────────────────── Finalize ─────────────────────────

  /** Verifies stored size and checksum, then queues the scan. Idempotent for the same checksum. */
  async finalize(up: Uploader, id: string, sha: string): Promise<AttachmentResource> {
    const tenantId = this.tenantOf(up);
    const checksum = sha.toLowerCase();
    const a = await this.db.read(tenantId, (tx) => this.ownAttachment(tx, up, id));
    if (a.state === 'scanning' || a.state === 'clean' || a.state === 'rejected') {
      if (a.sha256 && a.sha256 !== checksum)
        throw conflict('CONFLICT', 'This upload was already finalized with a different checksum.');
      if (a.state === 'scanning') await this.enqueueScan(tenantId, a.id);
      return attachmentResource(a);
    }
    if (a.state === 'expired')
      throw conflict('CONFLICT', 'This upload expired. Please upload the file again.');
    if (a.state === 'uploading') throw conflict('CONFLICT', 'The upload is still in progress.', true);
    if (a.sha256 && a.sha256 !== checksum)
      throw badRequest('Checksum does not match the declared checksum', { sha256: ['Mismatch'] });
    const head = await this.storage.stat('quarantine', a.objectKey);
    if (!head) throw conflict('CONFLICT', 'The file has not been uploaded yet.', true);
    let reject: BlockReason | null = null;
    if (head.sizeBytes !== Number(a.sizeBytes)) reject = 'size_mismatch';
    else {
      const buf = await this.storage.read('quarantine', a.objectKey, PLATFORM_MAX_FILE_BYTES);
      if (!buf || buf.length !== Number(a.sizeBytes)) reject = 'size_mismatch';
      else if (sha256Hex(buf) !== checksum) reject = 'checksum_mismatch';
    }
    const result = await this.db.tx(tenantId, async (tx) => {
      const fresh = await tx.attachment.findUniqueOrThrow({ where: { id: a.id } });
      if (reject) {
        const r = await this.transition(tx, fresh, ['initiated', 'uploaded'], {
          state: 'rejected',
          rejectReason: reject,
          scanResult: `rejected:${reject}`,
          expiresAt: null,
        });
        return r ?? fresh;
      }
      const r = await this.transition(tx, fresh, ['initiated', 'uploaded'], {
        state: 'scanning',
        sha256: checksum,
        scanResult: 'pending:queued',
        expiresAt: null,
      });
      return r ?? fresh;
    });
    if (result.state === 'scanning') await this.enqueueScan(tenantId, result.id);
    return attachmentResource(result);
  }

  async enqueueScan(tenantId: string, attachmentId: string, jobSuffix = ''): Promise<void> {
    await this.queues.add(
      QUEUES.scans,
      'scan',
      { tenantId, attachmentId },
      {
        jobId: `scan-${attachmentId}${jobSuffix}`,
        attempts: 12,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  // ───────────────────────── Scanning (worker) ─────────────────────────

  /**
   * Worker: inspect + scan the quarantined bytes. Throws ScannerUnavailableError to retry
   * (file stays `scanning` with an honest pending status). Idempotent.
   */
  async runScan(tenantId: string, attachmentId: string): Promise<void> {
    const a = await this.db.read(tenantId, (tx) =>
      tx.attachment.findFirst({ where: { tenantId, id: attachmentId, deletedAt: null } }),
    );
    if (!a || a.state !== 'scanning') return;
    const buf = await this.storage.read('quarantine', a.objectKey, PLATFORM_MAX_FILE_BYTES).catch((err) => {
      if (err instanceof StorageLimitError) return Buffer.alloc(0);
      throw err;
    });
    if (!buf || buf.length !== Number(a.sizeBytes))
      return this.reject(a, 'size_mismatch', 'stored size differs');
    // Re-verify: a still-valid presigned URL could have replaced the object after finalize.
    if (!a.sha256 || sha256Hex(buf) !== a.sha256)
      return this.reject(a, 'checksum_mismatch', 'stored checksum differs');
    const inspection = inspectContent(buf, a.declaredMime);
    if (!inspection.ok) return this.reject(a, inspection.reason, inspection.detail);

    const e = env();
    let scanResult: string;
    if (e.SCAN_MODE === 'dev_unscanned') {
      if (e.NODE_ENV === 'production') throw new Error('SCAN_MODE=dev_unscanned is refused in production');
      scanResult = 'unscanned-dev';
    } else {
      try {
        const scanStarted = process.hrtime.bigint();
        const verdict = await clamdScan(buf, {
          host: e.CLAMAV_HOST,
          port: e.CLAMAV_PORT,
          timeoutMs: e.CLAMAV_TIMEOUT_MS,
        });
        this.metrics.scanDuration.observe(
          this.metrics.labels({ verdict: verdict.status }),
          Number(process.hrtime.bigint() - scanStarted) / 1e9,
        );
        if (verdict.status === 'infected') return this.reject(a, 'malware', verdict.signature);
        scanResult = 'clamav:OK';
      } catch (err) {
        if (err instanceof ScannerUnavailableError) {
          await this.db.tx(tenantId, async (tx) => {
            const r = await tx.attachment.updateMany({
              where: {
                tenantId,
                id: a.id,
                state: 'scanning',
                NOT: { scanResult: 'pending:scanner_unavailable' },
              },
              data: { scanResult: 'pending:scanner_unavailable' },
            });
            if (r.count) await this.emit(tx, await tx.attachment.findUniqueOrThrow({ where: { id: a.id } }));
          });
        }
        throw err;
      }
    }

    // Promote exactly the bytes that were verified and scanned.
    await this.storage.write('clean', a.objectKey, buf, inspection.detectedMime);
    const promoted = await this.db.tx(tenantId, (tx) =>
      this.transition(tx, a, ['scanning'], {
        state: 'clean',
        detectedMime: inspection.detectedMime,
        scanResult,
        rejectReason: null,
      }),
    );
    if (!promoted) {
      // Cancelled while scanning: never leave clean bytes behind.
      await this.storage.delete('clean', a.objectKey).catch(() => undefined);
    }
    await this.storage
      .delete('quarantine', a.objectKey)
      .catch((err) => this.logger.warn(`Quarantine cleanup failed for ${a.id}: ${(err as Error).message}`));
  }

  private async reject(a: Attachment, reason: BlockReason, detail: string): Promise<void> {
    await this.db.tx(a.tenantId, async (tx) => {
      const r = await this.transition(tx, a, ['initiated', 'uploading', 'uploaded', 'scanning'], {
        state: 'rejected',
        rejectReason: reason,
        // Internal only (never projected to clients).
        scanResult: `rejected:${detail}`.slice(0, 300),
        expiresAt: null,
      });
      if (r) {
        await this.audit.inTx(
          tx,
          {
            tenantId: a.tenantId,
            userId: null,
            tokenId: null,
            actorName: 'File scanner',
            requestId: '',
            ipHash: null,
          },
          {
            action: 'attachment.rejected',
            objectType: 'attachment',
            objectId: a.id,
            outcome: 'denied',
            safeDiff: { reason, mime: a.declaredMime, sizeBytes: Number(a.sizeBytes) },
          },
        );
      }
    });
    // Bytes stay in private quarantine (never served); the sweep purges them after the retention window.
  }

  // ───────────────────────── Read / cancel ─────────────────────────

  async getForUploader(up: Uploader, id: string): Promise<AttachmentResource> {
    return attachmentResource(await this.db.read(this.tenantOf(up), (tx) => this.ownAttachment(tx, up, id)));
  }

  /** Agent metadata read: anyone who can see the chat. */
  async getForAgent(auth: AuthContext, id: string): Promise<AttachmentResource> {
    // File details are transcript content: chat or history access is required, as for downloads and messages.
    if (!auth.permissions.has('chats.serve') && !auth.permissions.has('history.view')) throw denied();
    return this.db.read(auth.tenantId, async (tx) => {
      const a = await tx.attachment.findFirst({ where: { tenantId: auth.tenantId, id, deletedAt: null } });
      if (!a || !a.chatId) throw notFound('Attachment');
      await this.chats.getVisible(tx, auth, a.chatId);
      return attachmentResource(a);
    });
  }

  /** Cancel an unattached upload (uploader, or an admin for agent uploads). */
  async cancel(up: Uploader, id: string): Promise<void> {
    const tenantId = this.tenantOf(up);
    const removed = await this.db.tx(tenantId, async (tx) => {
      let a: Attachment;
      if (up.kind === 'agent' && up.auth.permissions.has('tenant.manage')) {
        const found = await tx.attachment.findFirst({ where: { tenantId, id, deletedAt: null } });
        if (!found || !found.chatId) throw notFound('Upload');
        await this.chats.getVisible(tx, up.auth, found.chatId);
        a = found;
      } else {
        a = await this.ownAttachment(tx, up, id);
      }
      const attached = await tx.messageAttachment.count({ where: { tenantId, attachmentId: a.id } });
      if (attached)
        throw conflict(
          'CONFLICT',
          'Files that were already sent can only be removed by redacting the message.',
        );
      await tx.attachment.update({
        where: { id: a.id },
        data: {
          deletedAt: new Date(),
          state: ACTIVE_STATES.includes(a.state) ? 'expired' : a.state,
          expiresAt: null,
        },
      });
      const updated = await tx.attachment.findUniqueOrThrow({ where: { id: a.id } });
      await this.emit(tx, updated, { deleted: true });
      if (up.kind === 'agent') {
        await this.audit.inTx(tx, up.auth, {
          action: 'attachment.cancelled',
          objectType: 'attachment',
          objectId: a.id,
          safeDiff: { previousState: a.state },
        });
      }
      return a;
    });
    await this.purgeBytes(removed.objectKey);
  }

  private async purgeBytes(objectKey: string, areas: StorageArea[] = ['quarantine', 'clean']): Promise<void> {
    for (const area of areas)
      await this.storage
        .delete(area, objectKey)
        .catch((err) => this.logger.warn(`Purge ${area} failed: ${(err as Error).message}`));
  }

  // ───────────────────────── Downloads ─────────────────────────

  /**
   * Short (60 s) download grant. Re-checks on every call: clean state, not erased,
   * chat visibility (permission + department membership) and message visibility.
   */
  async downloadGrant(
    actor: { kind: 'agent'; auth: AuthContext } | { kind: 'visitor'; visitor: VisitorContext },
    id: string,
  ) {
    const tenantId = actor.kind === 'agent' ? actor.auth.tenantId : actor.visitor.tenantId;
    if (actor.kind === 'visitor') await this.rateLimit.enforce(`dl:v:${actor.visitor.visitorId}`, 120, 60);
    const a = await this.db.read(tenantId, async (tx) => {
      const att = await tx.attachment.findFirst({ where: { tenantId, id, deletedAt: null } });
      if (!att || !att.chatId) throw notFound('Attachment');
      const refs = await tx.messageAttachment.findMany({
        where: { tenantId, attachmentId: att.id },
        include: { message: { select: { visibility: true, redactedAt: true, chatId: true } } },
      });
      const live = refs.filter((r) => !r.message.redactedAt && r.message.chatId === att.chatId);
      if (actor.kind === 'agent') {
        const auth = actor.auth;
        if (!auth.permissions.has('history.view') && !auth.permissions.has('chats.serve'))
          throw notFound('Attachment');
        await this.chats.getVisible(tx, auth, att.chatId);
        const own = att.uploadedByActor === 'agent' && att.uploadedById === auth.membershipId;
        const visible = live.some(
          (r) => r.message.visibility === 'public' || auth.permissions.has('notes.view'),
        );
        if (refs.length ? !visible : !own) throw notFound('Attachment');
      } else {
        await this.visitorChat(tx, actor.visitor, att.chatId);
        const own = att.uploadedByActor === 'visitor' && att.uploadedById === actor.visitor.visitorId;
        const visible = live.some((r) => r.message.visibility === 'public');
        if (refs.length ? !visible : !own) throw notFound('Attachment');
      }
      return att;
    });
    if (a.state === 'rejected')
      throw conflict('FILE_REJECTED', 'This file failed the security check and cannot be downloaded.');
    if (a.state !== 'clean') {
      if (a.state === 'expired') throw notFound('Attachment');
      throw conflict('FILE_SCAN_PENDING', 'This file is still being checked.', true);
    }
    const scope = actor.kind === 'agent' ? 'agent' : 'widget';
    const mime = a.detectedMime ?? a.declaredMime;
    const grant = await this.storage.presignDownload({
      area: 'clean',
      key: a.objectKey,
      filename: a.originalName,
      contentType: mime,
      ttlSeconds: DOWNLOAD_GRANT_TTL_SECONDS,
      grant: {
        tenantId,
        resourceId: a.id,
        scope: `attachment:${scope}`,
        path:
          scope === 'agent'
            ? `/api/v1/attachments/${a.id}/content`
            : `/widget/v1/attachments/${a.id}/content`,
      },
    });
    return {
      url: grant.url,
      method: grant.method,
      expiresAt: grant.expiresAt,
      name: a.originalName,
      sizeBytes: Number(a.sizeBytes),
      mime,
    };
  }

  /** `GET …/content?sig=` (local driver / proxy mode): stream clean bytes with hardened headers. */
  async serveContent(
    scope: 'agent' | 'widget',
    id: string,
    sig: string | undefined,
    res: Response,
  ): Promise<void> {
    const claims = this.storage.verifyGrant(sig, {
      kind: 'download',
      resourceId: id,
      scope: `attachment:${scope}`,
    });
    if (!claims)
      throw new AppError(403, 'PERMISSION_DENIED', 'This download link is invalid or has expired.');
    const a = await this.db.read(claims.t, (tx) =>
      tx.attachment.findFirst({ where: { tenantId: claims.t, id, state: 'clean', deletedAt: null } }),
    );
    if (!a || keyHash(a.objectKey) !== claims.h) throw notFound('Attachment');
    const obj = await this.storage.openRead('clean', a.objectKey);
    if (!obj) throw notFound('Attachment');
    const mime = a.detectedMime ?? a.declaredMime;
    sendHardened(res, { mime, sizeBytes: obj.sizeBytes, filename: a.originalName });
    await pipeline(obj.stream, res).catch(() => undefined);
  }

  // ───────────────────────── Maintenance ─────────────────────────

  /** Expire abandoned uploads, purge orphans/rejected bytes, re-queue stale scans. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const tenantId of await this.db.activeTenantIds()) {
      const purge: Array<{ key: string; areas: StorageArea[] }> = [];
      const rescan: string[] = [];
      await this.db.tx(tenantId, async (tx) => {
        const abandoned = await tx.attachment.findMany({
          where: {
            tenantId,
            deletedAt: null,
            OR: [
              { state: { in: ['initiated', 'uploading'] }, expiresAt: { lt: new Date(now - 60_000) } },
              { state: 'uploaded', updatedAt: { lt: new Date(now - UNFINALIZED_TTL_MS) } },
            ],
          },
          take: 200,
        });
        for (const a of abandoned) {
          const r = await this.transition(tx, a, ['initiated', 'uploading', 'uploaded'], {
            state: 'expired',
            expiresAt: null,
          });
          if (r) purge.push({ key: a.objectKey, areas: ['quarantine'] });
        }
        const orphans = await tx.attachment.findMany({
          where: {
            tenantId,
            state: 'clean',
            deletedAt: null,
            createdAt: { lt: new Date(now - ORPHAN_TTL_MS) },
            messages: { none: {} },
          },
          take: 200,
        });
        for (const a of orphans) {
          await tx.attachment.update({
            where: { id: a.id },
            data: { state: 'expired', deletedAt: new Date() },
          });
          await this.emit(tx, { ...a, state: 'expired' }, { deleted: true });
          purge.push({ key: a.objectKey, areas: ['clean', 'quarantine'] });
        }
        const rejected = await tx.attachment.findMany({
          where: {
            tenantId,
            state: 'rejected',
            deletedAt: null,
            updatedAt: { lt: new Date(now - REJECTED_RETENTION_MS) },
          },
          take: 200,
        });
        for (const a of rejected) {
          await tx.attachment.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
          purge.push({ key: a.objectKey, areas: ['quarantine'] });
        }
        const stale = await tx.attachment.findMany({
          where: {
            tenantId,
            state: 'scanning',
            deletedAt: null,
            updatedAt: { lt: new Date(now - STALE_SCAN_MS) },
          },
          select: { id: true },
          take: 200,
        });
        rescan.push(...stale.map((s) => s.id));
        if (stale.length)
          await tx.attachment.updateMany({
            where: { tenantId, id: { in: stale.map((s) => s.id) } },
            data: { updatedAt: new Date() },
          });
      });
      for (const p of purge) await this.purgeBytes(p.key, p.areas);
      for (const id of rescan)
        await this.enqueueScan(tenantId, id, `-r${Math.floor(now / STALE_SCAN_MS)}`).catch(() => undefined);
    }
  }

  /** Erasure hook for the privacy workflow: delete bytes and mark attachments of the given chats erased. */
  async eraseChatAttachments(tenantId: string, chatIds: string[]): Promise<number> {
    if (!chatIds.length) return 0;
    const rows = await this.db.tx(tenantId, async (tx) => {
      // Rows deleted earlier (abandoned upload, retention, a removed draft) still carry the file name and content
      // hash, so they are scrubbed as well; their bytes are purged again below (idempotent).
      const list = await tx.attachment.findMany({
        where: { tenantId, chatId: { in: chatIds }, ...UNSCRUBBED },
      });
      await scrubAttachments(
        tx,
        tenantId,
        list.map((a) => a.id),
      );
      return list;
    });
    for (const a of rows) await this.purgeBytes(a.objectKey);
    return rows.length;
  }
}

/** Attachment rows that still hold subject data: not deleted, or deleted without the erasure scrub. */
export const UNSCRUBBED = {
  OR: [{ deletedAt: null }, { originalName: { not: '[erased]' } }, { sha256: { not: null } }],
} satisfies Prisma.AttachmentWhereInput;

/** Erase attachment rows: live rows are deleted now; rows deleted earlier keep their deletion time. Both lose name and hash. */
export async function scrubAttachments(tx: Tx, tenantId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx.attachment.updateMany({
    where: { tenantId, id: { in: ids }, deletedAt: null },
    data: { deletedAt: new Date(), originalName: '[erased]', sha256: null, state: 'expired' },
  });
  await tx.attachment.updateMany({
    where: { tenantId, id: { in: ids } },
    data: { originalName: '[erased]', sha256: null },
  });
}

/** Download response headers: forced download, no sniffing, no rendering context, no caching. */
export function sendHardened(res: Response, f: { mime: string; sizeBytes: number; filename: string }): void {
  res.status(200);
  res.setHeader('Content-Type', f.mime === 'text/plain' ? 'text/plain; charset=utf-8' : f.mime);
  res.setHeader('Content-Length', String(f.sizeBytes));
  res.setHeader('Content-Disposition', contentDisposition(f.filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
}
