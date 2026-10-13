import { Injectable } from '@nestjs/common';
import { Prisma, type Job, type PrivacyRequest } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { type AuthContext, AppError, badRequest, conflict } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { sha256 } from '../../common/crypto';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { OutboxService } from '../../outbox/outbox.service';
import { PrivacyObjectStore } from './object-store';
import { displayNameOf } from '../visitors/visitor-common';
import { ROLE_PERMISSIONS } from '../../common/permissions';
import type { Role } from '@prisma/client';

export const PRIVACY_JOB_KINDS = { access: 'privacy.access', erase: 'privacy.erase' } as const;

export interface PrivacyRequestResource {
  id: string;
  kind: 'access' | 'erase';
  visitorId: string | null;
  state: PrivacyRequest['state'];
  requestedBy: string | null;
  hasProof: boolean;
  verifiedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  job: {
    id: string;
    state: string;
    attempts: number;
    progress: number | null;
    errorCode: string | null;
  } | null;
  report: Record<string, unknown>;
}

export function privacyResource(r: PrivacyRequest, job: Job | null): PrivacyRequestResource {
  return {
    id: r.id,
    kind: r.kind,
    visitorId: r.visitorId,
    state: r.state,
    requestedBy: r.requestedBy,
    hasProof: !!r.proofReference,
    verifiedAt: r.verifiedAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    job: job
      ? {
          id: job.id,
          state: job.state,
          attempts: job.attempts,
          progress: job.progress,
          errorCode: job.lastErrorCode,
        }
      : null,
    report: (r.report ?? {}) as Record<string, unknown>,
  };
}

const STATE_VERSION: Record<PrivacyRequest['state'], number> = {
  pending_verification: 1,
  queued: 2,
  running: 3,
  completed: 4,
  failed: 5,
};

const PRIVACY_ROLES = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].has('privacy.manage'));

/**
 * Staff progress event for privacy administrators only (ch. 48 `privacy.updated`): every enabled member
 * whose role has privacy.manage (plus the requester), on their personal agent scope. Ids and state only.
 */
export async function emitPrivacyUpdated(
  outbox: OutboxService,
  tx: Tx,
  r: PrivacyRequest,
  membershipId: string | null,
  progress: number | null = null,
): Promise<void> {
  const admins = await tx.membership.findMany({ where: { tenantId: r.tenantId, enabled: true, archivedAt: null, role: { in: PRIVACY_ROLES } }, select: { id: true } });
  const recipients = [...new Set([...admins.map((m) => m.id), ...(membershipId ? [membershipId] : [])])];
  await outbox.append(tx, r.tenantId, {
    aggregateType: 'privacy_request',
    aggregateId: r.id,
    // Monotonic across the lifecycle and across step progress: state × 1000 + percent.
    aggregateVersion: STATE_VERSION[r.state] * 1000 + Math.max(0, Math.min(100, progress ?? 0)),
    eventType: 'privacy.updated',
    payload: { requestId: r.id, kind: r.kind, state: r.state, completedAt: r.completedAt, progress },
    scopes: recipients.map((id) => ({ kind: 'agent' as const, id, audience: 'staff' as const })),
  });
}

/** Privacy request lifecycle (ch. 45/53/75): pending_verification → queued → running → completed | failed. */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly objects: PrivacyObjectStore,
  ) {}

  private async withJob(tx: Tx, r: PrivacyRequest): Promise<PrivacyRequestResource> {
    const job = await tx.job.findFirst({
      where: { tenantId: r.tenantId, kind: PRIVACY_JOB_KINDS[r.kind], dedupeKey: r.id },
    });
    return privacyResource(r, job);
  }

  async create(
    auth: AuthContext,
    input: { kind: 'access' | 'erase'; visitorId: string; proofReference: string },
  ): Promise<PrivacyRequestResource | null> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const visitor = await tx.visitor.findFirst({
        where: { tenantId: auth.tenantId, id: input.visitorId },
        select: { id: true, erasedAt: true },
      });
      if (!visitor) return null;
      if (visitor.erasedAt)
        throw conflict('CONFLICT', 'This visitor has already been erased', false, {
          visitor_state: 'erased',
        });
      const open = await tx.privacyRequest.findFirst({
        where: {
          tenantId: auth.tenantId,
          visitorId: input.visitorId,
          kind: input.kind,
          state: { in: ['pending_verification', 'queued', 'running'] },
        },
        select: { id: true, state: true },
      });
      if (open)
        throw conflict('CONFLICT', `An open ${input.kind} request already exists for this visitor`, false, {
          request_id: open.id,
          state: open.state,
        });
      const r = await tx.privacyRequest.create({
        data: {
          tenantId: auth.tenantId,
          visitorId: input.visitorId,
          kind: input.kind,
          requestedBy: auth.userId,
          state: 'pending_verification',
          proofReference: input.proofReference,
          report: { kind: input.kind, state: 'pending_verification' } as Prisma.InputJsonValue,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'privacy.request_created',
        objectType: 'privacy_request',
        objectId: r.id,
        safeDiff: { kind: input.kind, visitor_ref: sha256(input.visitorId).slice(0, 12) },
      });
      await emitPrivacyUpdated(this.outbox, tx, r, auth.membershipId);
      return this.withJob(tx, r);
    });
  }

  /**
   * Record verification and queue the job (pending_verification → queued only after proof).
   * Evidence itself stays outside Talkivio; only an opaque reference is stored and it is
   * cleared after TALKIVIO_PROOF_RETENTION_DAYS by the retention job.
   */
  async verify(
    auth: AuthContext,
    id: string,
    input: { method: string; proofReference?: string | null },
  ): Promise<{ resource: PrivacyRequestResource; jobId: string; attempts: number } | null> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const r = await tx.privacyRequest.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!r) return null;
      if (r.state !== 'pending_verification')
        throw conflict('CONFLICT', 'Only requests pending verification can be verified', false, {
          state: r.state,
        });
      if (!r.visitorId)
        throw conflict('CONFLICT', 'The visitor for this request no longer exists', false, {
          state: r.state,
        });
      const proof = input.proofReference?.trim() || r.proofReference;
      if (!proof)
        throw badRequest('Record the verification evidence reference', { proof_reference: ['Required'] });
      const updated = await tx.privacyRequest.update({
        where: { id },
        data: {
          state: 'queued',
          verifiedAt: new Date(),
          proofReference: proof,
          report: {
            ...(r.report as object),
            state: 'queued',
            verification: { method: input.method, verified_by: auth.userId },
          } as Prisma.InputJsonValue,
        },
      });
      const job = await tx.job.upsert({
        where: {
          tenantId_kind_dedupeKey: {
            tenantId: auth.tenantId,
            kind: PRIVACY_JOB_KINDS[r.kind],
            dedupeKey: r.id,
          },
        },
        create: {
          tenantId: auth.tenantId,
          kind: PRIVACY_JOB_KINDS[r.kind],
          dedupeKey: r.id,
          state: 'queued',
          payload: {
            request_id: r.id,
            visitor_id: r.visitorId,
            membership_id: auth.membershipId,
          } as Prisma.InputJsonValue,
          requestedBy: auth.userId,
        },
        update: { state: 'queued', runAfter: new Date(), leaseUntil: null, lastErrorCode: null },
      });
      await this.audit.inTx(tx, auth, {
        action: 'privacy.request_verified',
        objectType: 'privacy_request',
        objectId: r.id,
        safeDiff: { kind: r.kind, method: input.method },
      });
      await emitPrivacyUpdated(this.outbox, tx, updated, auth.membershipId);
      return { resource: privacyResource(updated, job), jobId: job.id, attempts: job.attempts };
    });
  }

  /** Explicit resume of a failed request (safe: every step is idempotent). */
  async resume(
    auth: AuthContext,
    id: string,
  ): Promise<{ resource: PrivacyRequestResource; jobId: string; attempts: number } | null> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const r = await tx.privacyRequest.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!r) return null;
      if (r.state !== 'failed')
        throw conflict('CONFLICT', 'Only failed requests can be resumed', false, { state: r.state });
      const job = await tx.job.findFirst({
        where: { tenantId: auth.tenantId, kind: PRIVACY_JOB_KINDS[r.kind], dedupeKey: r.id },
      });
      if (!job) throw conflict('CONFLICT', 'This request was never queued', false, { state: r.state });
      const updated = await tx.privacyRequest.update({
        where: { id },
        data: {
          state: 'queued',
          report: { ...(r.report as object), state: 'queued', error_code: null } as Prisma.InputJsonValue,
        },
      });
      const j = await tx.job.update({
        where: { id: job.id },
        data: { state: 'queued', runAfter: new Date(), leaseUntil: null, lastErrorCode: null, attempts: 0 },
      });
      await this.audit.inTx(tx, auth, {
        action: 'privacy.request_resumed',
        objectType: 'privacy_request',
        objectId: r.id,
        safeDiff: { kind: r.kind },
      });
      await emitPrivacyUpdated(this.outbox, tx, updated, auth.membershipId);
      return { resource: privacyResource(updated, j), jobId: j.id, attempts: j.attempts };
    });
  }

  /**
   * Who each request is about, in two queries. A subject is erased once any erasure for that visitor
   * completed (the visitor row may survive pseudonymised) or the row is gone; erased subjects have no name.
   */
  private async subjects(tx: Tx, tenantId: string, rows: PrivacyRequest[]): Promise<Map<string, { displayName: string | null; erased: boolean }>> {
    const visitorIds = [...new Set(rows.map((r) => r.visitorId).filter((x): x is string => !!x))];
    const [visitors, erasures] = visitorIds.length
      ? await Promise.all([
          tx.visitor.findMany({ where: { tenantId, id: { in: visitorIds } }, select: { id: true, name: true, anonymousLabel: true } }),
          tx.privacyRequest.findMany({ where: { tenantId, kind: 'erase', state: 'completed', visitorId: { in: visitorIds } }, select: { visitorId: true } }),
        ])
      : [[], []];
    const names = new Map(visitors.map((v) => [v.id, displayNameOf(v)]));
    const erased = new Set(erasures.map((e) => e.visitorId));
    return new Map(
      rows.map((r) => {
        const gone = !!r.visitorId && (erased.has(r.visitorId) || !names.has(r.visitorId));
        return [r.id, { displayName: r.visitorId && !gone ? (names.get(r.visitorId) ?? null) : null, erased: gone }];
      }),
    );
  }

  async get(auth: AuthContext, id: string): Promise<PrivacyRequestResource | null> {
    return this.db.read(auth.tenantId, async (tx) => {
      const r = await tx.privacyRequest.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!r) return null;
      return { ...(await this.withJob(tx, r)), subject: (await this.subjects(tx, auth.tenantId, [r])).get(r.id) };
    });
  }

  async list(
    auth: AuthContext,
    q: { state?: PrivacyRequest['state']; kind?: 'access' | 'erase'; cursor?: string; limit?: number },
  ) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const filterHash = sha256(JSON.stringify({ state: q.state ?? null, kind: q.kind ?? null })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const where: Prisma.PrivacyRequestWhereInput = {
        tenantId: auth.tenantId,
        ...(q.state ? { state: q.state } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
      };
      if (cur)
        where.OR = [
          { createdAt: { lt: new Date(cur.t) } },
          { createdAt: new Date(cur.t), id: { lt: cur.id } },
        ];
      const rows = await tx.privacyRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const slice = rows.slice(0, limit);
      const subjects = await this.subjects(tx, auth.tenantId, slice);
      const items = [];
      for (const r of slice) items.push({ ...(await this.withJob(tx, r)), subject: subjects.get(r.id) });
      const last = slice[slice.length - 1];
      return page(
        items,
        rows.length > limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, filterHash)
          : null,
      );
    });
  }

  /** Access export download for privacy administrators; rechecked on every call. */
  async openExport(auth: AuthContext, id: string) {
    const exp = await this.db.read(auth.tenantId, async (tx) => {
      const r = await tx.privacyRequest.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!r) return null;
      if (r.kind !== 'access') throw conflict('CONFLICT', 'Only access requests produce an export');
      if (r.state !== 'completed')
        throw conflict('CONFLICT', 'The export is not ready yet', true, { state: r.state });
      const job = await tx.job.findFirst({
        where: { tenantId: auth.tenantId, kind: PRIVACY_JOB_KINDS.access, dedupeKey: r.id },
        select: { id: true },
      });
      const e = job
        ? await tx.export.findFirst({
            where: { tenantId: auth.tenantId, jobId: job.id },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      return { r, e };
    });
    if (!exp) return null;
    const e = exp.e;
    if (!e || e.erasedAt || !e.objectKey || e.expiresAt < new Date())
      throw new AppError(410, 'EXPORT_EXPIRED', 'This export has expired or was invalidated');
    const file = await this.objects.openRead('exports', e.objectKey);
    if (!file) throw new AppError(410, 'EXPORT_EXPIRED', 'This export is no longer available');
    await this.audit.log(auth, {
      action: 'privacy.export_downloaded',
      objectType: 'privacy_request',
      objectId: id,
      safeDiff: { export_id: e.id, size_bytes: Number(e.sizeBytes ?? 0) },
    });
    return { ...file, filename: `subject-access-${id}.json` };
  }
}
