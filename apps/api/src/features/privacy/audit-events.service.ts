import { Injectable } from '@nestjs/common';
import type { AuditEvent, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { type AuthContext, badRequest } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { TenantDb } from '../../db/tenant-db';
import { csvRow } from './csv';

export interface AuditQuery {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  objectType?: string;
  outcome?: 'success' | 'failure' | 'denied';
  cursor?: string;
  limit?: number;
}

export interface AuditEventResource {
  id: string;
  occurredAt: Date;
  actor: { type: string; id: string | null; name: string | null };
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  safeDiff: unknown;
  requestId: string | null;
}

const REDACT = /pass|token|secret|code|key|email|phone|body|message|comment/i;

/** Defence in depth: diffs are sanitized at write time; re-apply on read in case of legacy rows. */
export function safeDiffOut(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => safeDiffOut(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[k] = REDACT.test(k) && typeof x !== 'object' ? '[changed]' : safeDiffOut(x, depth + 1);
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return `${v.slice(0, 500)}…`;
  return v;
}

export function auditResource(e: AuditEvent): AuditEventResource {
  return {
    id: e.id,
    occurredAt: e.occurredAt,
    actor: { type: e.actorType, id: e.actorId, name: e.actorName },
    action: e.action,
    objectType: e.objectType,
    objectId: e.objectId,
    outcome: e.outcome,
    safeDiff: safeDiffOut(e.safeDiff ?? null),
    requestId: e.requestId,
  };
}

const EXPORT_MAX_ROWS = 50_000;

/** Audit administration (ch. 54): filtered, cursor-paged, append-only trail and CSV export. */
@Injectable()
export class AuditEventsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private where(auth: AuthContext, q: AuditQuery): Prisma.AuditEventWhereInput {
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if (from && to && from > to) throw badRequest('from must be before to', { from: ['Must be before to'] });
    const where: Prisma.AuditEventWhereInput = { tenantId: auth.tenantId };
    if (from || to) where.occurredAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = q.action.endsWith('.*') ? { startsWith: q.action.slice(0, -1) } : q.action;
    if (q.objectType) where.objectType = q.objectType;
    if (q.outcome) where.outcome = q.outcome;
    return where;
  }

  private filterHash(q: AuditQuery): string {
    return sha256(JSON.stringify({ ...q, cursor: undefined, limit: undefined })).slice(0, 16);
  }

  async list(auth: AuthContext, q: AuditQuery) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const fh = this.filterHash(q);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, fh);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    const base = this.where(auth, q);
    const where: Prisma.AuditEventWhereInput = cur
      ? {
          AND: [
            base,
            {
              OR: [
                { occurredAt: { lt: new Date(cur.t) } },
                { occurredAt: new Date(cur.t), id: { lt: cur.id } },
              ],
            },
          ],
        }
      : base;
    const rows = await this.db.read(auth.tenantId, (tx) =>
      tx.auditEvent.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1 }),
    );
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    return page(
      slice.map(auditResource),
      rows.length > limit && last
        ? encodeCursor({ t: last.occurredAt.toISOString(), id: last.id }, fh)
        : null,
    );
  }

  /** Stream CSV in pages (same filters and permission as the list); the export itself is audited. */
  async exportCsv(auth: AuthContext, q: AuditQuery, write: (chunk: string) => void): Promise<number> {
    const base = this.where(auth, q);
    write(
      csvRow([
        'occurred_at',
        'actor_type',
        'actor_id',
        'actor_name',
        'action',
        'object_type',
        'object_id',
        'outcome',
        'request_id',
        'safe_diff',
      ]),
    );
    let cursor: { t: Date; id: string } | null = null;
    let total = 0;
    while (total < EXPORT_MAX_ROWS) {
      const c = cursor;
      const where: Prisma.AuditEventWhereInput = c
        ? { AND: [base, { OR: [{ occurredAt: { lt: c.t } }, { occurredAt: c.t, id: { lt: c.id } }] }] }
        : base;
      const rows = await this.db.read(auth.tenantId, (tx) =>
        tx.auditEvent.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 1000 }),
      );
      for (const e of rows) {
        const r = auditResource(e);
        write(
          csvRow([
            r.occurredAt,
            r.actor.type,
            r.actor.id,
            r.actor.name,
            r.action,
            r.objectType,
            r.objectId,
            r.outcome,
            r.requestId,
            r.safeDiff ?? '',
          ]),
        );
      }
      total += rows.length;
      if (rows.length < 1000) break;
      const last = rows[rows.length - 1];
      cursor = { t: last.occurredAt, id: last.id };
    }
    await this.audit.log(auth, {
      action: 'audit.exported',
      objectType: 'audit_log',
      safeDiff: {
        rows: total,
        filters: {
          from: q.from ?? null,
          to: q.to ?? null,
          actor_id: q.actorId ?? null,
          action: q.action ?? null,
          object_type: q.objectType ?? null,
          outcome: q.outcome ?? null,
        },
      },
    });
    return total;
  }
}
