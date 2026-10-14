import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma, type Export, type ExportFormat, type Job, type Role } from '@prisma/client';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService, type AuditActor } from '../../common/audit.service';
import { decrypt, encrypt, sha256 } from '../../common/crypto';
import {
  AppError,
  badRequest,
  conflict,
  denied,
  errorBody,
  notFound,
  type AuthContext,
  type VisitorContext,
} from '../../common/http';
import { RedisService } from '../../common/redis.service';
import { env } from '../../config/env';
import { MailService } from '../../core/mail.service';
import { RateLimitService } from '../../core/rate-limit.service';
import { StorageService, keyHash } from '../../core/storage.service';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import { ChatQueriesService } from '../chats/chat-queries.service';
import { WidgetService } from '../widget/widget.service';
import { sendHardened } from '../files/files.service';
import { loadTranscriptChat } from './transcript.loader';
import {
  FORMAT_META,
  isValidTimeZone,
  renderTranscript,
  renderTxt,
  type RenderFormat,
  type TranscriptAudience,
  type TranscriptChat,
  type TranscriptDoc,
} from './transcript.render';

export const EXPORT_TTL_MS = 24 * 3600_000;
const DOWNLOAD_GRANT_TTL_SECONDS = 60;
const DAILY_EXPORTS_PER_REQUESTER = 30;
const DAILY_EXPORTS_PER_TENANT = 300;
const MAX_ACTIVE_PER_REQUESTER = 3;
const MAX_EXPLICIT_CHATS = 500;
const MAX_PDF_CHATS = 200;
const RENDER_CHUNK = 25;
const JOB_LEASE_MS = 10 * 60_000;

/** Bulk export limits by role (ch. 20: limited by role, date range and tenant quotas). */
export const ROLE_EXPORT_LIMITS: Record<Role, { maxChats: number; maxRangeDays: number }> = {
  owner: { maxChats: 5000, maxRangeDays: 366 },
  admin: { maxChats: 5000, maxRangeDays: 366 },
  supervisor: { maxChats: 2000, maxRangeDays: 92 },
  agent: { maxChats: 200, maxRangeDays: 31 },
  analyst: { maxChats: 0, maxRangeDays: 0 },
};

export interface ExportFilters {
  from: string;
  to: string;
  siteId?: string;
  departmentId?: string;
  agentId?: string;
  status?: 'active' | 'closed' | 'queued';
  rating?: 'good' | 'bad' | 'none';
  tagId?: string;
}

export interface ExportInput {
  chatIds?: string[];
  filters?: ExportFilters;
  format: RenderFormat;
  timezone: string;
  includeInternal: boolean;
}

/** Authorisation + query scope snapshot stored with the export (exports.filters). */
interface ExportSnapshot {
  mode: 'chats' | 'filters' | 'visitor' | 'transcript_email' | 'workspace';
  chatIds: string[];
  filters?: ExportFilters;
  audience: TranscriptAudience;
  scope?: { role: Role; departmentScope: 'all' | string[]; membershipId: string | null };
}

interface TranscriptEmailPayload {
  chatId: string;
  recipientCiphertext: string;
  recipientKind: 'visitor' | 'self';
  format: 'txt' | 'pdf';
  includeInternal: boolean;
  audience: TranscriptAudience;
  timezone: string;
  requestedByMembershipId: string | null;
  visitorGrantHash: string | null;
}

export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportResource {
  id: string;
  state: ExportState;
  format: ExportFormat;
  timezone: string;
  includeInternal: boolean;
  progress: number;
  itemCount: number | null;
  sizeBytes: number | null;
  sha256: string | null;
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
}

export function exportState(e: Export, job: Pick<Job, 'state'>): ExportState {
  if (e.erasedAt) return 'expired';
  if (job.state === 'failed' || job.state === 'cancelled') return 'failed';
  if (job.state === 'succeeded') return e.objectKey && e.expiresAt > new Date() ? 'ready' : 'expired';
  return job.state === 'running' ? 'running' : 'queued';
}

export function exportResource(e: Export, job: Job): ExportResource {
  const state = exportState(e, job);
  return {
    id: e.id,
    state,
    format: e.format,
    timezone: e.timezone,
    includeInternal: e.includeInternal,
    progress: state === 'ready' ? 100 : (job.progress ?? 0),
    itemCount: e.itemCount,
    sizeBytes: e.sizeBytes === null ? null : Number(e.sizeBytes),
    sha256: e.sha256,
    expiresAt: e.expiresAt,
    createdAt: e.createdAt,
    completedAt: job.completedAt,
    errorCode:
      state === 'expired' ? 'EXPORT_EXPIRED' : state === 'failed' ? (job.lastErrorCode ?? 'INTERNAL') : null,
  };
}

const visitorGrantHash = (v: Pick<VisitorContext, 'tenantId' | 'visitorId'>) =>
  sha256(`export-visitor:${v.tenantId}:${v.visitorId}`);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dedicated BullMQ queue for export/transcript jobs (durable state lives in `jobs` rows). */
@Injectable()
export class ExportJobsQueue implements OnModuleDestroy {
  static readonly NAME = 'exports';
  private q: Queue | null = null;

  constructor(private readonly redis: RedisService) {}

  queue(): Queue {
    this.q ??= new Queue(ExportJobsQueue.NAME, {
      connection: this.redis.create('queue:exports', { forBullMQ: true }),
      prefix: 'rd',
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 2000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    return this.q;
  }

  async add(tenantId: string, jobId: string, suffix = ''): Promise<void> {
    await this.queue().add(
      'run',
      { tenantId, jobId },
      { jobId: `job-${jobId}${suffix}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.q?.close().catch(() => undefined);
  }
}

/**
 * Transcript export and delivery (ch. 20). Exports are asynchronous jobs backed by
 * `jobs` + `exports` rows; artifacts are stored privately with checksum and a 24 h
 * expiry and are only served through 60-second grants after re-authorisation.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger('Exports');

  constructor(
    private readonly db: TenantDb,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly chats: ChatQueriesService,
    private readonly widget: WidgetService,
    private readonly jobs: ExportJobsQueue,
  ) {}

  // ───────────────────────── Scope resolution ─────────────────────────

  private limitsFor(auth: AuthContext, format: RenderFormat) {
    const base = ROLE_EXPORT_LIMITS[auth.role];
    return {
      maxChats: Math.min(base.maxChats, format === 'pdf' ? MAX_PDF_CHATS : Infinity),
      maxRangeDays: base.maxRangeDays,
    };
  }

  private filterWhere(auth: AuthContext, f: ExportFilters, maxRangeDays: number): Prisma.ChatWhereInput {
    const from = new Date(f.from);
    const to = new Date(f.to);
    if (!(from < to)) throw badRequest('`from` must be before `to`', { filters: ['Invalid date range'] });
    if (to.getTime() - from.getTime() > maxRangeDays * 86_400_000) {
      throw badRequest(`Your role can export at most ${maxRangeDays} days at a time`, {
        'filters.to': [`Maximum range is ${maxRangeDays} days`],
      });
    }
    const and: Prisma.ChatWhereInput[] = [
      { tenantId: auth.tenantId, isPreview: false, requestedAt: { gte: from, lt: to } },
      this.chats.scopeWhere(auth),
    ];
    if (f.siteId) and.push({ siteId: f.siteId });
    if (f.departmentId) and.push({ departmentId: f.departmentId });
    if (f.agentId)
      and.push({
        OR: [{ ownerMembershipId: f.agentId }, { participants: { some: { membershipId: f.agentId } } }],
      });
    if (f.status)
      and.push(f.status === 'queued' ? { status: { in: ['queued', 'offered'] } } : { status: f.status });
    if (f.rating) and.push(f.rating === 'none' ? { rating: null } : { rating: { rating: f.rating } });
    if (f.tagId) and.push({ tags: { some: { tagId: f.tagId } } });
    return { AND: and };
  }

  private async resolveChats(
    tx: Tx,
    auth: AuthContext,
    input: Pick<ExportInput, 'chatIds' | 'filters' | 'format'>,
  ): Promise<{ chatIds: string[]; count: number; limit: number; maxRangeDays: number }> {
    const { maxChats, maxRangeDays } = this.limitsFor(auth, input.format);
    if (maxChats <= 0) throw denied('Your role cannot export transcripts');
    if (input.chatIds?.length) {
      const ids = [...new Set(input.chatIds)];
      if (ids.length > Math.min(maxChats, MAX_EXPLICIT_CHATS))
        throw badRequest(`At most ${Math.min(maxChats, MAX_EXPLICIT_CHATS)} chats per export`, {
          chat_ids: ['Too many chats'],
        });
      const visible = await tx.chat.findMany({
        where: {
          AND: [{ tenantId: auth.tenantId, id: { in: ids }, isPreview: false }, this.chats.scopeWhere(auth)],
        },
        select: { id: true },
      });
      if (visible.length !== ids.length) throw notFound('Chat');
      return { chatIds: ids, count: ids.length, limit: maxChats, maxRangeDays };
    }
    if (!input.filters) throw badRequest('Provide either chat_ids or filters', { chat_ids: ['Required'] });
    const where = this.filterWhere(auth, input.filters, maxRangeDays);
    const count = await tx.chat.count({ where });
    if (count > maxChats) {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        `This export would include ${count} chats; your limit is ${maxChats}. Narrow the filters.`,
        { details: { count, limit: maxChats } },
      );
    }
    const rows = await tx.chat.findMany({
      where,
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: maxChats,
    });
    return { chatIds: rows.map((r) => r.id), count, limit: maxChats, maxRangeDays };
  }

  /** Bulk export count preview (no writes). */
  async preview(
    auth: AuthContext,
    input: Pick<ExportInput, 'chatIds' | 'filters' | 'format' | 'includeInternal'>,
  ) {
    this.assertInternalAllowed(auth, input.includeInternal);
    const { maxChats, maxRangeDays } = this.limitsFor(auth, input.format);
    return this.db.read(auth.tenantId, async (tx) => {
      if (input.chatIds?.length) {
        const r = await this.resolveChats(tx, auth, input);
        return { count: r.count, limit: r.limit, maxRangeDays, allowed: true };
      }
      if (!input.filters) throw badRequest('Provide either chat_ids or filters', { chat_ids: ['Required'] });
      const count = await tx.chat.count({ where: this.filterWhere(auth, input.filters, maxRangeDays) });
      return {
        count,
        limit: maxChats,
        maxRangeDays,
        allowed: count > 0 && count <= maxChats,
        ...(count > maxChats ? { reason: 'too_many_chats' } : count === 0 ? { reason: 'no_chats' } : {}),
      };
    });
  }

  private assertInternalAllowed(auth: AuthContext, includeInternal: boolean): void {
    if (
      includeInternal &&
      !(auth.permissions.has('exports.internal') && auth.permissions.has('notes.view'))
    ) {
      throw denied('Including internal notes requires the internal export permission');
    }
  }

  private async enforceQuotas(
    tx: Tx,
    tenantId: string,
    requester: { membershipId?: string | null; visitorGrantHash?: string | null },
  ): Promise<void> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [mine, tenant] = await Promise.all([
      tx.export.count({
        where: {
          tenantId,
          createdAt: { gte: since },
          ...(requester.membershipId
            ? { requestedBy: requester.membershipId }
            : { visitorGrantHash: requester.visitorGrantHash ?? '__none__' }),
        },
      }),
      tx.export.count({ where: { tenantId, createdAt: { gte: since } } }),
    ]);
    const perRequester = requester.membershipId ? DAILY_EXPORTS_PER_REQUESTER : 10;
    if (mine >= perRequester || tenant >= DAILY_EXPORTS_PER_TENANT) {
      throw new AppError(429, 'RATE_LIMITED', 'The daily export quota has been reached. Try again later.', {
        retryable: true,
        retryAfter: 3600,
        details: { reason: 'daily_quota' },
      });
    }
    if (requester.membershipId) {
      const active = await tx.job.count({
        where: {
          tenantId,
          kind: 'export',
          requestedBy: requester.membershipId,
          state: { in: ['queued', 'running'] },
        },
      });
      if (active >= MAX_ACTIVE_PER_REQUESTER)
        throw new AppError(429, 'RATE_LIMITED', 'Wait for your running exports to finish first.', {
          retryable: true,
          retryAfter: 30,
        });
    }
  }

  // ───────────────────────── Agent exports ─────────────────────────

  async create(auth: AuthContext, input: ExportInput): Promise<ExportResource> {
    if (!auth.membershipId) throw denied('Only workspace members can export transcripts');
    this.assertInternalAllowed(auth, input.includeInternal);
    if (!isValidTimeZone(input.timezone))
      throw badRequest('Unknown time zone', { timezone: ['Use an IANA time zone such as Europe/London'] });
    const created = await this.db.tx(auth.tenantId, async (tx) => {
      await this.enforceQuotas(tx, auth.tenantId, { membershipId: auth.membershipId });
      const resolved = await this.resolveChats(tx, auth, input);
      if (!resolved.chatIds.length)
        throw badRequest('No chats match these filters', { filters: ['No chats found'] });
      const snapshot: ExportSnapshot = {
        mode: input.chatIds?.length ? 'chats' : 'filters',
        chatIds: resolved.chatIds,
        ...(input.filters ? { filters: input.filters } : {}),
        audience: 'staff',
        scope: { role: auth.role, departmentScope: auth.departmentScope, membershipId: auth.membershipId },
      };
      const exportId = randomUUID();
      const job = await tx.job.create({
        data: {
          tenantId: auth.tenantId,
          kind: 'export',
          dedupeKey: exportId,
          state: 'queued',
          payload: { exportId },
          requestedBy: auth.membershipId,
          progress: 0,
        },
      });
      const e = await tx.export.create({
        data: {
          id: exportId,
          tenantId: auth.tenantId,
          requestedBy: auth.membershipId,
          format: input.format,
          filters: snapshot as unknown as Prisma.InputJsonValue,
          includeInternal: input.includeInternal,
          timezone: input.timezone,
          jobId: job.id,
          itemCount: resolved.chatIds.length,
          expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'export.created',
        objectType: 'export',
        objectId: e.id,
        safeDiff: {
          format: input.format,
          includeInternal: input.includeInternal,
          mode: snapshot.mode,
          chatCount: resolved.chatIds.length,
          timezone: input.timezone,
        },
      });
      return { e, job };
    });
    await this.jobs.add(auth.tenantId, created.job.id);
    return exportResource(created.e, created.job);
  }

  /**
   * Workspace transcript archive for a tenant deletion request (ch. 41). Created inside the
   * caller's transaction (the caller enqueues `jobId` with `enqueue` after commit). Covers the
   * newest `limit` non-preview chats as staff JSON transcripts including internal notes; the
   * artifact is kept until `retainUntil` instead of the usual 24 h. Owner-only: downloads go
   * through the normal re-authorised grant of the requesting member.
   */
  async createWorkspaceArchive(
    tx: Tx,
    auth: AuthContext,
    opts: { limit: number; retainUntil: Date; timezone: string },
  ): Promise<{ exportId: string; jobId: string; chatCount: number; totalChats: number }> {
    if (!auth.membershipId || !auth.permissions.has('tenant.owner'))
      throw denied('Only the workspace owner can export the whole workspace');
    const where: Prisma.ChatWhereInput = { tenantId: auth.tenantId, isPreview: false };
    const totalChats = await tx.chat.count({ where });
    const newest = await tx.chat.findMany({
      where,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      take: opts.limit,
    });
    const chatIds = newest.map((c) => c.id).reverse();
    const snapshot: ExportSnapshot = {
      mode: 'workspace',
      chatIds,
      audience: 'staff',
      scope: { role: auth.role, departmentScope: 'all', membershipId: auth.membershipId },
    };
    const exportId = randomUUID();
    const job = await tx.job.create({
      data: {
        tenantId: auth.tenantId,
        kind: 'export',
        dedupeKey: exportId,
        state: 'queued',
        payload: { exportId, retainUntil: opts.retainUntil.toISOString() },
        requestedBy: auth.membershipId,
        progress: 0,
      },
    });
    await tx.export.create({
      data: {
        id: exportId,
        tenantId: auth.tenantId,
        requestedBy: auth.membershipId,
        format: 'json',
        filters: snapshot as unknown as Prisma.InputJsonValue,
        includeInternal: true,
        timezone: isValidTimeZone(opts.timezone) ? opts.timezone : 'UTC',
        jobId: job.id,
        itemCount: chatIds.length,
        expiresAt: opts.retainUntil,
      },
    });
    await this.audit.inTx(tx, auth, {
      action: 'export.created',
      objectType: 'export',
      objectId: exportId,
      safeDiff: {
        format: 'json',
        includeInternal: true,
        mode: 'workspace',
        chatCount: chatIds.length,
        totalChats,
      },
    });
    return { exportId, jobId: job.id, chatCount: chatIds.length, totalChats };
  }

  /** Queue a committed export job (see `createWorkspaceArchive`). */
  async enqueue(tenantId: string, jobId: string): Promise<void> {
    await this.jobs.add(tenantId, jobId);
  }

  /** Export + job rows for one export (no authorisation: callers check ownership). */
  async exportWithJob(tx: Tx, tenantId: string, exportId: string): Promise<ExportResource | null> {
    const e = await tx.export.findFirst({ where: { tenantId, id: exportId } });
    const job = e ? await tx.job.findFirst({ where: { tenantId, id: e.jobId } }) : null;
    return e && job ? exportResource(e, job) : null;
  }

  private async loadExportWithJob(
    tx: Tx,
    tenantId: string,
    where: Prisma.ExportWhereInput,
  ): Promise<{ e: Export; job: Job }> {
    const e = await tx.export.findFirst({ where: { AND: [{ tenantId }, where] } });
    if (!e) throw notFound('Export');
    const job = await tx.job.findFirst({ where: { tenantId, id: e.jobId } });
    if (!job) throw notFound('Export');
    return { e, job };
  }

  private ownerWhere(auth: AuthContext, id: string): Prisma.ExportWhereInput {
    return auth.permissions.has('tenant.manage')
      ? { id }
      : { id, requestedBy: auth.membershipId ?? '__none__' };
  }

  async get(auth: AuthContext, id: string): Promise<ExportResource> {
    return this.db.read(auth.tenantId, async (tx) => {
      const { e, job } = await this.loadExportWithJob(tx, auth.tenantId, this.ownerWhere(auth, id));
      return exportResource(e, job);
    });
  }

  async list(auth: AuthContext): Promise<ExportResource[]> {
    return this.db.read(auth.tenantId, async (tx) => {
      const rows = await tx.export.findMany({
        where: { tenantId: auth.tenantId, requestedBy: auth.membershipId ?? '__none__' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      const jobs = await tx.job.findMany({
        where: { tenantId: auth.tenantId, id: { in: rows.map((r) => r.jobId) } },
      });
      const byId = new Map(jobs.map((j) => [j.id, j]));
      return rows.filter((r) => byId.has(r.jobId)).map((r) => exportResource(r, byId.get(r.jobId)!));
    });
  }

  /**
   * Erasure check at download: chats deleted, messages redacted, attachments removed or
   * visitors erased after the artifact was rendered invalidate it (ch. 20).
   */
  private async erasedSinceRender(tx: Tx, e: Export, job: Job): Promise<boolean> {
    const snap = e.filters as unknown as ExportSnapshot;
    const ids = snap.chatIds ?? [];
    const since = new Date(
      (job.result as { renderedFrom?: string } | null)?.renderedFrom ?? e.createdAt.toISOString(),
    );
    const chats = await tx.chat.findMany({
      where: { tenantId: e.tenantId, id: { in: ids } },
      select: { id: true, visitorId: true },
    });
    if (chats.length !== ids.length) return true;
    const [redacted, removed, erased] = await Promise.all([
      tx.message.count({ where: { tenantId: e.tenantId, chatId: { in: ids }, redactedAt: { gte: since } } }),
      tx.attachment.count({
        where: {
          tenantId: e.tenantId,
          chatId: { in: ids },
          deletedAt: { gte: since },
          messages: { some: {} },
        },
      }),
      tx.visitor.count({
        where: {
          tenantId: e.tenantId,
          id: { in: [...new Set(chats.map((c) => c.visitorId))] },
          erasedAt: { gte: since },
        },
      }),
    ]);
    return redacted + removed + erased > 0;
  }

  private async invalidate(tenantId: string, e: Export): Promise<void> {
    await this.db.tx(tenantId, (tx) =>
      tx.export.updateMany({
        where: { tenantId, id: e.id, erasedAt: null },
        data: { erasedAt: new Date(), objectKey: null },
      }),
    );
    if (e.objectKey) await this.storage.delete('exports', e.objectKey).catch(() => undefined);
  }

  private async grantFor(e: Export, tenantId: string, scope: 'agent' | 'widget') {
    const meta = FORMAT_META[e.format];
    const grant = await this.storage.presignDownload({
      area: 'exports',
      key: e.objectKey!,
      filename: `transcript-${e.id.slice(0, 8)}.${meta.ext}`,
      contentType: meta.mime === 'application/pdf' ? meta.mime : `${meta.mime}; charset=utf-8`,
      ttlSeconds: DOWNLOAD_GRANT_TTL_SECONDS,
      grant: {
        tenantId,
        resourceId: e.id,
        scope: `export:${scope}`,
        path: scope === 'agent' ? `/api/v1/exports/${e.id}/content` : `/widget/v1/exports/${e.id}/content`,
      },
    });
    return {
      url: grant.url,
      method: grant.method,
      expiresAt: grant.expiresAt,
      filename: `transcript-${e.id.slice(0, 8)}.${meta.ext}`,
      mime: meta.mime,
      sizeBytes: Number(e.sizeBytes ?? 0),
      sha256: e.sha256,
    };
  }

  /** Re-authorises (permission, scope, erasure, expiry) and returns a 60-second grant; 410 when expired. */
  async downloadGrant(auth: AuthContext, id: string) {
    const { e, job } = await this.db.read(auth.tenantId, (tx) =>
      this.loadExportWithJob(tx, auth.tenantId, { id, requestedBy: auth.membershipId ?? '__none__' }),
    );
    if (!auth.permissions.has('exports.create')) throw denied();
    if (e.includeInternal) this.assertInternalAllowed(auth, true);
    const state = exportState(e, job);
    if (state === 'expired')
      throw new AppError(410, 'EXPORT_EXPIRED', 'This export has expired. Create a new one.');
    if (state === 'failed') throw conflict('CONFLICT', 'This export failed. Create a new one.');
    if (state !== 'ready') throw conflict('CONFLICT', 'This export is not ready yet.', true);
    const ok = await this.db.read(auth.tenantId, async (tx) => {
      const snap = e.filters as unknown as ExportSnapshot;
      const visible = await tx.chat.count({
        where: { AND: [{ tenantId: auth.tenantId, id: { in: snap.chatIds } }, this.chats.scopeWhere(auth)] },
      });
      if (visible !== snap.chatIds.length) return 'scope' as const;
      return (await this.erasedSinceRender(tx, e, job)) ? ('erased' as const) : ('ok' as const);
    });
    if (ok === 'scope') throw denied('You no longer have access to every chat in this export');
    if (ok === 'erased') {
      await this.invalidate(auth.tenantId, e);
      throw new AppError(
        410,
        'EXPORT_EXPIRED',
        'This export is no longer available because some of its content was erased.',
      );
    }
    await this.audit.log(auth, {
      action: 'export.download_granted',
      objectType: 'export',
      objectId: e.id,
      safeDiff: { format: e.format },
    });
    return this.grantFor(e, auth.tenantId, 'agent');
  }

  /** `GET …/exports/{id}/content?sig=` (local driver, proxy mode and emailed PDF links). */
  async serveContent(
    scope: 'agent' | 'widget',
    id: string,
    sig: string | undefined,
    res: Response,
  ): Promise<void> {
    const claims =
      this.storage.verifyGrant(sig, { kind: 'download', resourceId: id, scope: `export:${scope}` }) ??
      (scope === 'widget'
        ? this.storage.verifyGrant(sig, { kind: 'download', resourceId: id, scope: 'export:email' })
        : null);
    if (!claims)
      throw new AppError(403, 'PERMISSION_DENIED', 'This download link is invalid or has expired.');
    const loaded = await this.db.read(claims.t, async (tx) => {
      const e = await tx.export.findFirst({ where: { tenantId: claims.t, id } });
      if (!e) return null;
      const job = await tx.job.findFirst({ where: { tenantId: claims.t, id: e.jobId } });
      if (!job) return null;
      return { e, job, erased: await this.erasedSinceRender(tx, e, job) };
    });
    if (!loaded || !loaded.e.objectKey || keyHash(loaded.e.objectKey) !== claims.h) throw notFound('Export');
    if (loaded.erased) {
      await this.invalidate(claims.t, loaded.e);
      throw new AppError(410, 'EXPORT_EXPIRED', 'This export is no longer available.');
    }
    if (exportState(loaded.e, loaded.job) !== 'ready')
      throw new AppError(410, 'EXPORT_EXPIRED', 'This export has expired.');
    const obj = await this.storage.openRead('exports', loaded.e.objectKey);
    if (!obj) throw new AppError(410, 'EXPORT_EXPIRED', 'This export is no longer available.');
    const meta = FORMAT_META[loaded.e.format];
    sendHardened(res, {
      mime: meta.mime === 'application/pdf' ? meta.mime : `${meta.mime}; charset=utf-8`,
      sizeBytes: obj.sizeBytes,
      filename: `transcript-${loaded.e.id.slice(0, 8)}.${meta.ext}`,
    });
    await pipeline(obj.stream, res).catch(() => undefined);
  }

  // ───────────────────────── Visitor exports ─────────────────────────

  private async visitorTranscriptChat(tx: Tx, v: VisitorContext, chatId: string) {
    const chat = await tx.chat.findFirst({
      where: { tenantId: v.tenantId, id: chatId, visitorId: v.visitorId, siteId: v.siteId },
    });
    if (!chat) throw notFound('Chat');
    const { config } = await this.widget.publishedConfig(tx, chat.siteId);
    if (!config.behavior.transcripts.enabled) throw denied('Transcripts are not available for this chat');
    return chat;
  }

  async createVisitorExport(
    v: VisitorContext,
    chatId: string,
    input: { format: 'txt' | 'pdf'; timezone?: string | null },
  ): Promise<ExportResource> {
    await this.rateLimit.enforce(
      `export:v:${v.visitorId}`,
      10,
      3600,
      'Too many transcript requests. Please try again later.',
    );
    const created = await this.db.tx(v.tenantId, async (tx) => {
      const chat = await this.visitorTranscriptChat(tx, v, chatId);
      const grant = visitorGrantHash(v);
      await this.enforceQuotas(tx, v.tenantId, { visitorGrantHash: grant });
      const visitor = await tx.visitor.findFirst({
        where: { tenantId: v.tenantId, id: v.visitorId },
        select: { timezone: true },
      });
      const tz = [input.timezone, visitor?.timezone, 'UTC'].find(
        (z): z is string => !!z && isValidTimeZone(z),
      )!;
      const exportId = randomUUID();
      const job = await tx.job.create({
        data: {
          tenantId: v.tenantId,
          kind: 'export',
          dedupeKey: exportId,
          state: 'queued',
          payload: { exportId },
          progress: 0,
        },
      });
      const snapshot: ExportSnapshot = { mode: 'visitor', chatIds: [chat.id], audience: 'public' };
      const e = await tx.export.create({
        data: {
          id: exportId,
          tenantId: v.tenantId,
          visitorGrantHash: grant,
          format: input.format,
          filters: snapshot as unknown as Prisma.InputJsonValue,
          includeInternal: false,
          timezone: tz,
          jobId: job.id,
          itemCount: 1,
          expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
        },
      });
      return { e, job };
    });
    await this.jobs.add(v.tenantId, created.job.id);
    return exportResource(created.e, created.job);
  }

  async getVisitorExport(v: VisitorContext, id: string): Promise<ExportResource> {
    return this.db.read(v.tenantId, async (tx) => {
      const { e, job } = await this.loadExportWithJob(tx, v.tenantId, {
        id,
        visitorGrantHash: visitorGrantHash(v),
      });
      return exportResource(e, job);
    });
  }

  async visitorDownloadGrant(v: VisitorContext, id: string) {
    const { e, job, chatOk, erased } = await this.db.read(v.tenantId, async (tx) => {
      const r = await this.loadExportWithJob(tx, v.tenantId, { id, visitorGrantHash: visitorGrantHash(v) });
      const snap = r.e.filters as unknown as ExportSnapshot;
      const owned = await tx.chat.count({
        where: { tenantId: v.tenantId, id: { in: snap.chatIds }, visitorId: v.visitorId },
      });
      return {
        ...r,
        chatOk: owned === snap.chatIds.length,
        erased: await this.erasedSinceRender(tx, r.e, r.job),
      };
    });
    if (!chatOk) throw notFound('Export');
    const state = exportState(e, job);
    if (state === 'expired')
      throw new AppError(410, 'EXPORT_EXPIRED', 'This transcript download has expired.');
    if (state !== 'ready')
      throw conflict(
        'CONFLICT',
        state === 'failed' ? 'The transcript could not be created.' : 'The transcript is not ready yet.',
        state !== 'failed',
      );
    if (erased) {
      await this.invalidate(v.tenantId, e);
      throw new AppError(410, 'EXPORT_EXPIRED', 'This transcript is no longer available.');
    }
    return this.grantFor(e, v.tenantId, 'widget');
  }

  // ───────────────────────── Transcript email ─────────────────────────

  private async queueTranscriptEmail(
    tenantId: string,
    actor: AuditActor,
    p: Omit<TranscriptEmailPayload, 'recipientCiphertext'> & { recipient: string; lastSeq: number },
    limits: () => Promise<void>,
  ) {
    const dedupeKey = sha256(
      `${p.chatId}|${p.recipient}|${p.format}|${p.includeInternal}|${p.audience}|${p.lastSeq}`,
    ).slice(0, 48);
    const existing = await this.db.read(tenantId, (tx) =>
      tx.job.findFirst({ where: { tenantId, kind: 'transcript_email', dedupeKey } }),
    );
    if (existing) return this.emailJobResource(existing, true);
    await limits();
    const payload: TranscriptEmailPayload = {
      chatId: p.chatId,
      recipientCiphertext: encrypt(p.recipient),
      recipientKind: p.recipientKind,
      format: p.format,
      includeInternal: p.includeInternal,
      audience: p.audience,
      timezone: p.timezone,
      requestedByMembershipId: p.requestedByMembershipId,
      visitorGrantHash: p.visitorGrantHash,
    };
    try {
      const job = await this.db.tx(tenantId, async (tx) => {
        const j = await tx.job.create({
          data: {
            tenantId,
            kind: 'transcript_email',
            dedupeKey,
            state: 'queued',
            payload: payload as unknown as Prisma.InputJsonValue,
            requestedBy: p.requestedByMembershipId,
            progress: 0,
          },
        });
        await this.audit.inTx(tx, actor, {
          action: 'transcript.email_requested',
          objectType: 'chat',
          objectId: p.chatId,
          safeDiff: {
            jobId: j.id,
            format: p.format,
            includeInternal: p.includeInternal,
            recipientKind: p.recipientKind,
            recipientHash: sha256(`recipient:${p.recipient}`).slice(0, 16),
          },
        });
        return j;
      });
      await this.jobs.add(tenantId, job.id);
      return this.emailJobResource(job, false);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const j = await this.db.read(tenantId, (tx) =>
          tx.job.findFirstOrThrow({ where: { tenantId, kind: 'transcript_email', dedupeKey } }),
        );
        return this.emailJobResource(j, true);
      }
      throw err;
    }
  }

  private async emailJobResource(job: Job, duplicate: boolean) {
    const p = job.payload as unknown as TranscriptEmailPayload;
    const emailId = (job.result as { emailId?: string } | null)?.emailId ?? null;
    const email = emailId
      ? await this.db.root.outboundEmail.findUnique({
          where: { id: emailId },
          select: { status: true, acceptedAt: true, deliveredAt: true },
        })
      : null;
    // Job state first (queued → rendering), then mail status: accepted (provider took it) is distinct from delivered.
    const state =
      job.state === 'failed' || job.state === 'cancelled'
        ? 'failed'
        : job.state !== 'succeeded'
          ? job.state === 'running'
            ? 'rendering'
            : 'queued'
          : !email
            ? 'sending'
            : email.status === 'delivered'
              ? 'delivered'
              : email.status === 'accepted'
                ? 'accepted'
                : email.status === 'failed'
                  ? 'retrying'
                  : 'sending';
    return {
      id: job.id,
      chatId: p.chatId,
      state,
      format: p.format,
      recipientKind: p.recipientKind,
      includeInternal: p.includeInternal,
      acceptedAt: email?.acceptedAt ?? null,
      deliveredAt: email?.deliveredAt ?? null,
      duplicate,
      createdAt: job.createdAt,
    };
  }

  /** Agent transcript email: recipient must be the visitor's address on record or the agent's own verified address. */
  async agentTranscriptEmail(
    auth: AuthContext,
    chatId: string,
    input: { recipient: string; format: 'txt' | 'pdf'; includeInternal: boolean },
  ) {
    if (!auth.membershipId || !auth.userId) throw denied('Only workspace members can email transcripts');
    this.assertInternalAllowed(auth, input.includeInternal);
    const recipient = input.recipient.trim().toLowerCase();
    if (!EMAIL_RE.test(recipient))
      throw badRequest('Enter a valid email address', { recipient: ['Enter a valid email address.'] });
    const user = await this.db.root.user.findUnique({
      where: { id: auth.userId },
      select: { email: true, emailVerifiedAt: true },
    });
    const ctx = await this.db.read(auth.tenantId, async (tx) => {
      const chat = await this.chats.getVisible(tx, auth, chatId);
      const visitor = await tx.visitor.findFirst({
        where: { tenantId: auth.tenantId, id: chat.visitorId },
        select: { emailCiphertext: true, erasedAt: true },
      });
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId }, select: { timezone: true } });
      let visitorEmail: string | null = null;
      try {
        visitorEmail =
          visitor?.emailCiphertext && !visitor.erasedAt
            ? decrypt(visitor.emailCiphertext).toLowerCase()
            : null;
      } catch {
        visitorEmail = null;
      }
      return { chat, visitorEmail, timezone: tenant?.timezone ?? 'UTC' };
    });
    const self = !!user?.emailVerifiedAt && user.email.toLowerCase() === recipient;
    const toVisitor = !!ctx.visitorEmail && ctx.visitorEmail === recipient;
    if (!self && !toVisitor)
      throw badRequest("Send transcripts to the visitor's email on record or to your own verified address", {
        recipient: ['Recipient is not verified for this chat'],
      });
    if (input.includeInternal && !self)
      throw denied('Transcripts with internal notes can only be sent to your own address');
    return this.queueTranscriptEmail(
      auth.tenantId,
      auth,
      {
        chatId,
        recipient,
        recipientKind: self ? 'self' : 'visitor',
        format: input.format,
        includeInternal: input.includeInternal,
        audience: input.includeInternal ? 'staff' : 'public',
        timezone: isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC',
        requestedByMembershipId: auth.membershipId,
        visitorGrantHash: null,
        lastSeq: Number(ctx.chat.nextSeq) - 1,
      },
      async () => {
        await this.rateLimit.enforce(
          `tx-email:m:${auth.membershipId}`,
          20,
          3600,
          'Too many transcript emails. Please try again later.',
        );
        await this.rateLimit.enforce(
          `tx-email:r:${auth.tenantId}:${sha256(recipient).slice(0, 16)}`,
          10,
          86_400,
          'Too many transcripts were sent to this address today.',
        );
      },
    );
  }

  async agentTranscriptEmailStatus(auth: AuthContext, chatId: string, jobId: string) {
    return this.db
      .read(auth.tenantId, async (tx) => {
        await this.chats.getVisible(tx, auth, chatId);
        const job = await tx.job.findFirst({
          where: { tenantId: auth.tenantId, id: jobId, kind: 'transcript_email' },
        });
        if (!job || (job.payload as unknown as TranscriptEmailPayload).chatId !== chatId)
          throw notFound('Transcript email');
        return job;
      })
      .then((job) => this.emailJobResource(job, false));
  }

  /** Visitor transcript email (visitor-confirmed address, public transcript only, abuse limits). */
  async visitorTranscriptEmail(
    v: VisitorContext,
    chatId: string,
    input: { email: string; format: 'txt' | 'pdf' },
  ) {
    const recipient = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(recipient) || recipient.length > 200)
      throw badRequest('Enter a valid email address', { email: ['Enter a valid email address.'] });
    const ctx = await this.db.read(v.tenantId, async (tx) => {
      const chat = await this.visitorTranscriptChat(tx, v, chatId);
      const visitor = await tx.visitor.findFirst({
        where: { tenantId: v.tenantId, id: v.visitorId },
        select: { timezone: true },
      });
      return {
        chat,
        timezone: visitor?.timezone && isValidTimeZone(visitor.timezone) ? visitor.timezone : 'UTC',
      };
    });
    return this.queueTranscriptEmail(
      v.tenantId,
      {
        tenantId: v.tenantId,
        userId: null,
        tokenId: null,
        actorName: 'Visitor',
        requestId: v.requestId,
        ipHash: v.ipHash,
      },
      {
        chatId,
        recipient,
        recipientKind: 'visitor',
        format: input.format,
        includeInternal: false,
        audience: 'public',
        timezone: ctx.timezone,
        requestedByMembershipId: null,
        visitorGrantHash: visitorGrantHash(v),
        lastSeq: Number(ctx.chat.nextSeq) - 1,
      },
      async () => {
        await this.rateLimit.enforce(
          `tx-email:v:${v.visitorId}`,
          3,
          3600,
          'Too many transcript emails. Please try again later.',
        );
        await this.rateLimit.enforce(
          `tx-email:c:${chatId}`,
          5,
          86_400,
          'Too many transcript emails for this chat.',
        );
        await this.rateLimit.enforce(
          `tx-email:r:${v.tenantId}:${sha256(recipient).slice(0, 16)}`,
          10,
          86_400,
          'Too many transcripts were sent to this address today.',
        );
        if (v.ipNetHash)
          await this.rateLimit.enforce(
            `tx-email:ip:${v.ipNetHash}`,
            10,
            3600,
            'Too many transcript emails. Please try again later.',
          );
      },
    ).then((r) => ({ id: r.id, state: r.state, format: r.format, duplicate: r.duplicate }));
  }

  // ───────────────────────── Job runner (worker) ─────────────────────────

  /** Runs one export/transcript job with a lease; idempotent and safe to retry. */
  async runJob(tenantId: string, jobId: string, finalAttempt: boolean): Promise<void> {
    const leased = await this.db.tx(tenantId, async (tx) => {
      const r = await tx.job.updateMany({
        where: {
          tenantId,
          id: jobId,
          OR: [{ state: 'queued' }, { state: 'running', leaseUntil: { lt: new Date() } }],
        },
        data: {
          state: 'running',
          attempts: { increment: 1 },
          leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
        },
      });
      return r.count ? tx.job.findFirst({ where: { tenantId, id: jobId } }) : null;
    });
    if (!leased) return;
    try {
      if (leased.kind === 'export') await this.renderExport(tenantId, leased);
      else if (leased.kind === 'transcript_email') await this.sendTranscriptEmail(tenantId, leased);
      else throw new Error(`Unknown job kind ${leased.kind}`);
    } catch (err) {
      // Dependency outages keep their own code (SERVICE_UNAVAILABLE), not a generic INTERNAL.
      const code =
        err instanceof AppError ? err.code : String((errorBody(err).body.error as { code: string }).code);
      this.logger.warn(
        `Job ${leased.kind} ${jobId} failed (attempt ${leased.attempts}): ${(err as Error).message}`,
      );
      await this.db.tx(tenantId, async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: {
            state: finalAttempt ? 'failed' : 'queued',
            lastErrorCode: code,
            leaseUntil: null,
            ...(finalAttempt ? { completedAt: new Date() } : {}),
          },
        });
        if (finalAttempt && leased.kind === 'export') {
          const e = await tx.export.findFirst({ where: { tenantId, jobId } });
          if (e) await this.emitExport(tx, e, 'export.failed', { state: 'failed', errorCode: code });
        }
      });
      if (!finalAttempt) throw err;
    }
  }

  private async emitExport(
    tx: Tx,
    e: Export,
    eventType: 'export.ready' | 'export.failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const snap = e.filters as unknown as ExportSnapshot;
    const scopes: OutboxScope[] = [];
    if (e.requestedBy) scopes.push({ kind: 'agent', id: e.requestedBy, audience: 'staff' });
    else if (snap.mode === 'visitor' && snap.chatIds[0])
      scopes.push({ kind: 'chat', id: snap.chatIds[0], audience: 'public' });
    await this.outbox.append(tx, e.tenantId, {
      aggregateType: 'export',
      aggregateId: e.id,
      aggregateVersion: eventType === 'export.ready' ? 3 : 4,
      eventType,
      payload: { exportId: e.id, format: e.format, ...payload },
      scopes,
    });
  }

  private async loadChats(
    tenantId: string,
    job: Job,
    ids: string[],
    audience: TranscriptAudience,
    includeInternal: boolean,
  ): Promise<TranscriptChat[]> {
    const out: TranscriptChat[] = [];
    for (let i = 0; i < ids.length; i += RENDER_CHUNK) {
      const slice = ids.slice(i, i + RENDER_CHUNK);
      const loaded = await this.db.read(tenantId, async (tx) => {
        const list: TranscriptChat[] = [];
        for (const id of slice) {
          const c = await loadTranscriptChat(tx, tenantId, id, { audience, includeInternal });
          if (c) list.push(c);
        }
        return list;
      });
      out.push(...loaded);
      if (ids.length > RENDER_CHUNK) {
        await this.db.tx(tenantId, (tx) =>
          tx.job.update({
            where: { id: job.id },
            data: {
              progress: Math.min(90, Math.floor(((i + slice.length) / ids.length) * 90)),
              leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
            },
          }),
        );
      }
    }
    return out;
  }

  private async storeArtifact(
    tenantId: string,
    e: Export,
    buf: Buffer,
  ): Promise<{ key: string; sha: string }> {
    const meta = FORMAT_META[e.format];
    const key = `t/${tenantId}/exports/${e.id}/${randomBytes(12).toString('hex')}.${meta.ext}`;
    await this.storage.write('exports', key, buf, meta.mime);
    return { key, sha: createHash('sha256').update(buf).digest('hex') };
  }

  private async renderExport(tenantId: string, job: Job): Promise<void> {
    const e = await this.db.read(tenantId, (tx) =>
      tx.export.findFirst({ where: { tenantId, jobId: job.id } }),
    );
    if (!e) throw new Error('Export row missing');
    if (e.erasedAt) {
      await this.db.tx(tenantId, (tx) =>
        tx.job.update({
          where: { id: job.id },
          data: { state: 'cancelled', lastErrorCode: 'ERASED', completedAt: new Date(), leaseUntil: null },
        }),
      );
      return;
    }
    const snap = e.filters as unknown as ExportSnapshot;
    const renderedFrom = new Date().toISOString();
    const chats = await this.loadChats(
      tenantId,
      job,
      snap.chatIds,
      snap.audience,
      e.includeInternal && snap.audience === 'staff',
    );
    const doc: TranscriptDoc = {
      exportId: e.id,
      brand: env().BRAND_NAME,
      generatedAt: new Date(),
      timezone: e.timezone,
      audience: snap.audience,
      includeInternal: e.includeInternal && snap.audience === 'staff',
      chats,
    };
    const buf = await renderTranscript(doc, e.format);
    const { key, sha } = await this.storeArtifact(tenantId, e, buf);
    // Workspace archives (tenant deletion) stay available for the whole cancellation window.
    const retainUntil = Date.parse(
      String((job.payload as { retainUntil?: unknown } | null)?.retainUntil ?? ''),
    );
    const expiresAt = new Date(
      Math.max(Date.now() + EXPORT_TTL_MS, Number.isFinite(retainUntil) ? retainUntil : 0),
    );
    const committed = await this.db.tx(tenantId, async (tx) => {
      const r = await tx.export.updateMany({
        where: { tenantId, id: e.id, erasedAt: null },
        data: {
          objectKey: key,
          sha256: sha,
          sizeBytes: BigInt(buf.length),
          itemCount: chats.length,
          expiresAt,
        },
      });
      if (!r.count) return false;
      await tx.job.update({
        where: { id: job.id },
        data: {
          state: 'succeeded',
          progress: 100,
          completedAt: new Date(),
          leaseUntil: null,
          lastErrorCode: null,
          result: { renderedFrom, sizeBytes: buf.length, sha256: sha },
        },
      });
      const fresh = await tx.export.findUniqueOrThrow({ where: { id: e.id } });
      await this.emitExport(tx, fresh, 'export.ready', {
        state: 'ready',
        expiresAt: fresh.expiresAt,
        sizeBytes: buf.length,
        itemCount: chats.length,
      });
      await this.audit.inTx(
        tx,
        { tenantId, userId: null, tokenId: null, actorName: 'Export worker', requestId: '', ipHash: null },
        {
          action: 'export.ready',
          objectType: 'export',
          objectId: e.id,
          safeDiff: {
            format: e.format,
            sizeBytes: buf.length,
            chatCount: chats.length,
            checksum: sha.slice(0, 16),
          },
        },
      );
      return true;
    });
    if (!committed) await this.storage.delete('exports', key).catch(() => undefined);
  }

  private async sendTranscriptEmail(tenantId: string, job: Job): Promise<void> {
    const p = job.payload as unknown as TranscriptEmailPayload;
    const recipient = decrypt(p.recipientCiphertext);
    const renderedFrom = new Date().toISOString();
    const chats = await this.loadChats(tenantId, job, [p.chatId], p.audience, p.includeInternal);
    const chat = chats[0];
    if (!chat) throw new AppError(404, 'NOT_FOUND', 'Chat no longer exists');
    const doc: TranscriptDoc = {
      exportId: null,
      brand: env().BRAND_NAME,
      generatedAt: new Date(),
      timezone: p.timezone,
      audience: p.audience,
      includeInternal: p.includeInternal,
      chats,
    };
    const text = renderTxt(doc).toString('utf8');
    let url: string | null = null;
    let exportId: string | null = (job.result as { exportId?: string } | null)?.exportId ?? null;
    if (p.format === 'pdf') {
      // PDF is delivered as a 24 h link (MailService has no attachment support); the link is re-authorised on use.
      const existing = exportId
        ? await this.db.read(tenantId, (tx) => tx.export.findFirst({ where: { tenantId, id: exportId! } }))
        : null;
      let e = existing;
      if (!e) {
        exportId = randomUUID();
        const snapshot: ExportSnapshot = {
          mode: 'transcript_email',
          chatIds: [p.chatId],
          audience: p.audience,
        };
        e = await this.db.tx(tenantId, (tx) =>
          tx.export.create({
            data: {
              id: exportId!,
              tenantId,
              requestedBy: p.requestedByMembershipId,
              visitorGrantHash: p.visitorGrantHash,
              format: 'pdf',
              filters: snapshot as unknown as Prisma.InputJsonValue,
              includeInternal: p.includeInternal,
              timezone: p.timezone,
              jobId: job.id,
              itemCount: 1,
              expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
            },
          }),
        );
      }
      if (!e.objectKey) {
        const buf = await renderTranscript({ ...doc, exportId: e.id }, 'pdf');
        const { key, sha } = await this.storeArtifact(tenantId, e, buf);
        await this.db.tx(tenantId, (tx) =>
          tx.export.update({
            where: { id: e!.id },
            data: {
              objectKey: key,
              sha256: sha,
              sizeBytes: BigInt(buf.length),
              expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
            },
          }),
        );
        e = { ...e, objectKey: key };
      }
      await this.db.tx(tenantId, (tx) =>
        tx.job.update({ where: { id: job.id }, data: { result: { renderedFrom, exportId: e!.id } } }),
      );
      url = this.storage.signGrant(
        { tenantId, resourceId: e.id, scope: 'export:email', path: `/widget/v1/exports/${e.id}/content` },
        'download',
        e.objectKey!,
        EXPORT_TTL_MS / 1000,
      ).url;
    }
    const template = p.audience === 'public' && !url ? 'transcript' : 'transcript_export';
    const sent = await this.mail.sendTemplate(
      template,
      recipient,
      { site: chat.site.name, number: chat.number, transcript: text, internal: p.includeInternal, url },
      `job:${job.id}`,
      tenantId,
    );
    await this.db.tx(tenantId, (tx) =>
      tx.job.update({
        where: { id: job.id },
        data: {
          state: 'succeeded',
          progress: 100,
          completedAt: new Date(),
          leaseUntil: null,
          lastErrorCode: null,
          result: { renderedFrom, emailId: sent.id, ...(exportId ? { exportId } : {}) },
        },
      }),
    );
  }

  // ───────────────────────── Maintenance & erasure ─────────────────────────

  /** Expire artifacts (scrub keys + delete bytes) and re-queue jobs whose lease or queue entry was lost. */
  async sweep(): Promise<void> {
    const now = new Date();
    for (const tenantId of await this.db.activeTenantIds()) {
      const { expired, stuck } = await this.db.tx(tenantId, async (tx) => {
        const expired = await tx.export.findMany({
          where: {
            tenantId,
            objectKey: { not: null },
            OR: [{ expiresAt: { lt: now } }, { erasedAt: { not: null } }],
          },
          take: 200,
        });
        if (expired.length)
          await tx.export.updateMany({
            where: { tenantId, id: { in: expired.map((e) => e.id) } },
            data: { objectKey: null },
          });
        const stuck = await tx.job.findMany({
          where: {
            tenantId,
            kind: { in: ['export', 'transcript_email'] },
            OR: [
              { state: 'queued', updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
              { state: 'running', leaseUntil: { lt: now } },
            ],
          },
          select: { id: true },
          take: 100,
        });
        if (stuck.length)
          await tx.job.updateMany({
            where: { tenantId, id: { in: stuck.map((s) => s.id) } },
            data: { updatedAt: now },
          });
        return { expired, stuck };
      });
      for (const e of expired)
        if (e.objectKey) await this.storage.delete('exports', e.objectKey).catch(() => undefined);
      for (const j of stuck)
        await this.jobs
          .add(tenantId, j.id, `-r${Math.floor(now.getTime() / 120_000)}`)
          .catch(() => undefined);
    }
  }

  /** Erasure hook (privacy workflow): invalidate every export artifact that covers the given chats or visitor. */
  async invalidateFor(tenantId: string, target: { chatIds?: string[]; visitorId?: string }): Promise<number> {
    const rows = await this.db.tx(tenantId, async (tx) => {
      const chatIds = new Set(target.chatIds ?? []);
      if (target.visitorId)
        for (const c of await tx.chat.findMany({
          where: { tenantId, visitorId: target.visitorId },
          select: { id: true },
        }))
          chatIds.add(c.id);
      if (!chatIds.size) return [];
      const hits: Export[] = [];
      for (const id of chatIds) {
        hits.push(
          ...(await tx.export.findMany({
            where: { tenantId, erasedAt: null, filters: { path: ['chatIds'], array_contains: [id] } },
          })),
        );
      }
      const unique = [...new Map(hits.map((h) => [h.id, h])).values()];
      if (unique.length)
        await tx.export.updateMany({
          where: { tenantId, id: { in: unique.map((u) => u.id) } },
          data: { erasedAt: new Date(), objectKey: null },
        });
      return unique;
    });
    for (const e of rows)
      if (e.objectKey) await this.storage.delete('exports', e.objectKey).catch(() => undefined);
    return rows.length;
  }
}
