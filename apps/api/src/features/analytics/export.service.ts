import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { TenantDb } from '../../db/tenant-db';
import { AppError, badRequest, denied, notFound, type AuthContext } from '../../common/http';
import { AuditService } from '../../common/audit.service';
import { IdempotencyService } from '../../common/idempotency';
import { ROLE_PERMISSIONS, TENANT_WIDE_ROLES } from '../../common/permissions';
import { QueueService, QUEUES } from '../../core/queue.service';
import { OutboxService } from '../../outbox/outbox.service';
import { WorkerService } from '../../worker/worker.service';
import { AGENT_EXPORT_DAYS, AnalyticsService, EXPORT_LIMITS, type AgentsReport, type ChatsReport, type InvitationsReport } from './analytics.service';
import { toCsv, type Cell } from './csv';
import { MEASURE_DEFINITIONS, MEASURE_KEYS, type MeasureSet } from './measures';
import { assertDepartmentInScope, type AnalyticsActor, type ExportRequest } from './schemas';

export const EXPORT_JOB_KIND = 'analytics.export';
export const EXPORT_TIMER = 'analytics-export';
const EXPORT_TTL_MS = 24 * 3600_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_CSV_BYTES = 8 * 1024 * 1024;

interface ExportPayload {
  report: ExportRequest['report'];
  format: 'csv';
  filters: Record<string, unknown>;
  requestedBy: string;
}

interface ExportResult {
  csv?: string;
  filename: string;
  rowCount: number;
  bytes: number;
  sha256: string;
  sourceWatermark: string | null;
  totals: Record<string, number | null>;
  definitionsVersion: number;
  generatedAt: string;
  expiresAt: string;
  expired?: boolean;
}

export interface ExportResource {
  id: string;
  report: string;
  format: 'csv';
  state: string;
  progress: number | null;
  attempts: number;
  filters: Record<string, unknown>;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: string | null;
  rowCount: number | null;
  bytes: number | null;
  sha256: string | null;
  filename: string | null;
  sourceWatermark: string | null;
  totals: Record<string, number | null> | null;
  errorCode: string | null;
  downloadPath: string | null;
}

/**
 * Aggregate CSV exports (ch. 51): POST queues a `jobs` row (202), the worker
 * computes the same report the API would return (same definitions, same scope
 * re-derived at run time) and stores the RFC 4180 CSV in `jobs.result`. Exports
 * are aggregates only — no transcript content — and expire after 24 h.
 */
@Injectable()
export class AnalyticsExportService implements OnModuleInit {
  private readonly logger = new Logger('AnalyticsExport');

  constructor(
    private readonly db: TenantDb,
    private readonly queues: QueueService,
    private readonly worker: WorkerService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.worker.onTimer(async (name, data) => {
      if (name !== EXPORT_TIMER) return false;
      await this.run(String(data.tenantId), String(data['jobId']));
      return true;
    });
    this.worker.onMaintenance('analytics-exports', () => this.sweep());
  }

  // ───────── API ─────────

  async request(auth: AuthContext, input: ExportRequest, idempotencyKey: string | null): Promise<{ status: number; body: ExportResource }> {
    if (!auth.membershipId) throw denied('Analytics exports are requested by signed-in members');
    if (input.report === 'agents' && !auth.permissions.has('analytics.agents')) throw denied();
    const f = input.filters as Record<string, unknown>;
    assertDepartmentInScope(auth, f.departmentId as string | undefined);
    assertDepartmentInScope(auth, f.currentDepartmentId as string | undefined);
    // Validate the range now so the caller gets field errors instead of a failed job.
    const ctx = await this.analytics.tenantContext(auth.tenantId);
    const limits = input.report === 'agents' ? { ...EXPORT_LIMITS, dayDays: AGENT_EXPORT_DAYS } : EXPORT_LIMITS;
    this.analytics.resolveRange({ ...(input.filters as { from: string; to: string }), groupBy: (f.groupBy as 'day' | undefined) ?? 'day', compare: 'none' }, ctx, limits);
    const r = await this.idempotency.run(auth.tenantId, `member:${auth.membershipId}`, 'analytics.exports.create', idempotencyKey, input, async () => {
      const job = await this.db.tx(auth.tenantId, async (tx) => {
        const created = await tx.job.create({
          data: {
            tenantId: auth.tenantId,
            kind: EXPORT_JOB_KIND,
            dedupeKey: randomUUID(),
            state: 'queued',
            payload: { report: input.report, format: 'csv', filters: input.filters, requestedBy: auth.membershipId } as unknown as Prisma.InputJsonValue,
            requestedBy: auth.membershipId,
            progress: 0,
          },
        });
        await this.audit.inTx(tx, auth, { action: 'analytics.export_requested', objectType: 'job', objectId: created.id, safeDiff: { report: input.report, format: 'csv' } });
        return created;
      });
      await this.enqueue(auth.tenantId, job.id, 0, job.attempts);
      return { status: 202, body: this.resource(job) };
    });
    return { status: r.status, body: r.body };
  }

  private async enqueue(tenantId: string, jobId: string, delay: number, attempt: number): Promise<void> {
    await this.queues.add(QUEUES.timers, EXPORT_TIMER, { tenantId, jobId }, { delay, jobId: `analytics-export-${jobId}-${attempt}`, removeOnComplete: true, removeOnFail: 100 });
  }

  private async load(auth: AuthContext, id: string): Promise<Job> {
    const job = await this.db.read(auth.tenantId, (tx) => tx.job.findFirst({ where: { tenantId: auth.tenantId, id, kind: EXPORT_JOB_KIND } }));
    if (!job) throw notFound('Export');
    const own = !!auth.membershipId && job.requestedBy === auth.membershipId;
    if (!own && !auth.permissions.has('tenant.manage')) throw notFound('Export');
    const payload = job.payload as unknown as ExportPayload;
    if (payload.report === 'agents' && !auth.permissions.has('analytics.agents')) throw notFound('Export');
    return job;
  }

  async status(auth: AuthContext, id: string): Promise<ExportResource> {
    return this.resource(await this.load(auth, id));
  }

  async download(auth: AuthContext, id: string): Promise<{ filename: string; csv: string; sha256: string }> {
    const job = await this.load(auth, id);
    if (job.state !== 'succeeded') throw new AppError(409, 'CONFLICT', job.state === 'failed' ? 'This export failed; request a new one' : 'This export is not ready yet', { retryable: job.state !== 'failed' });
    const result = job.result as unknown as ExportResult | null;
    if (!result?.csv || result.expired || new Date(result.expiresAt).getTime() < Date.now()) throw new AppError(410, 'EXPORT_EXPIRED', 'This export has expired; request a new one');
    await this.db.tx(auth.tenantId, (tx) => this.audit.inTx(tx, auth, { action: 'analytics.export_downloaded', objectType: 'job', objectId: job.id, safeDiff: { report: (job.payload as unknown as ExportPayload).report } }));
    return { filename: result.filename, csv: result.csv, sha256: result.sha256 };
  }

  resource(job: Job): ExportResource {
    const payload = job.payload as unknown as ExportPayload;
    const result = job.result as unknown as ExportResult | null;
    const ready = job.state === 'succeeded' && !!result && !result.expired;
    return {
      id: job.id,
      report: payload.report,
      format: 'csv',
      state: ready && new Date(result!.expiresAt).getTime() < Date.now() ? 'expired' : job.state,
      progress: job.progress,
      attempts: job.attempts,
      filters: payload.filters,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: result?.expiresAt ?? null,
      rowCount: result?.rowCount ?? null,
      bytes: result?.bytes ?? null,
      sha256: result?.sha256 ?? null,
      filename: result?.filename ?? null,
      sourceWatermark: result?.sourceWatermark ?? null,
      totals: result?.totals ?? null,
      errorCode: job.lastErrorCode,
      downloadPath: ready ? `/api/v1/analytics/exports/${job.id}/download` : null,
    };
  }

  // ───────── Worker ─────────

  /** Requester's current permissions and scope (re-derived; revoked access fails the job). */
  private async actorFor(tenantId: string, membershipId: string): Promise<AnalyticsActor | null> {
    const m = await this.db.read(tenantId, (tx) =>
      tx.membership.findFirst({ where: { tenantId, id: membershipId }, include: { departments: { select: { departmentId: true, canServe: true, canMonitor: true } } } }),
    );
    if (!m || !m.enabled || m.archivedAt) return null;
    const permissions = ROLE_PERMISSIONS[m.role];
    if (!permissions.has('analytics.view')) return null;
    return {
      tenantId,
      membershipId,
      permissions,
      departmentScope: TENANT_WIDE_ROLES.has(m.role) ? 'all' : [...new Set(m.departments.filter((d) => d.canServe || d.canMonitor).map((d) => d.departmentId))],
    };
  }

  async run(tenantId: string, jobId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.db.tx(tenantId, (tx) =>
      tx.job.updateMany({
        where: { tenantId, id: jobId, kind: EXPORT_JOB_KIND, runAfter: { lte: now }, OR: [{ state: 'queued' }, { state: 'running', leaseUntil: { lt: now } }] },
        data: { state: 'running', attempts: { increment: 1 }, leaseUntil: new Date(now.getTime() + LEASE_MS), progress: 5 },
      }),
    );
    if (!claimed.count) return;
    const job = await this.db.read(tenantId, (tx) => tx.job.findUniqueOrThrow({ where: { id: jobId } }));
    const payload = job.payload as unknown as ExportPayload;
    try {
      const actor = await this.actorFor(tenantId, payload.requestedBy);
      if (!actor) throw new AppError(403, 'PERMISSION_DENIED', 'The requester no longer has analytics access');
      const built = await this.build(actor, payload);
      const bytes = Buffer.byteLength(built.csv, 'utf8');
      if (bytes > MAX_CSV_BYTES) throw badRequest('The export is too large; narrow the range or grouping');
      const completedAt = new Date();
      const result: ExportResult = {
        csv: built.csv,
        filename: built.filename,
        rowCount: built.rowCount,
        bytes,
        sha256: createHash('sha256').update(built.csv).digest('hex'),
        sourceWatermark: built.sourceWatermark,
        totals: built.totals,
        definitionsVersion: built.definitionsVersion,
        generatedAt: completedAt.toISOString(),
        expiresAt: new Date(completedAt.getTime() + EXPORT_TTL_MS).toISOString(),
      };
      await this.db.tx(tenantId, async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: { state: 'succeeded', result: result as unknown as Prisma.InputJsonValue, progress: 100, completedAt, leaseUntil: null, lastErrorCode: null },
        });
        await this.outbox.append(tx, tenantId, {
          aggregateType: 'job',
          aggregateId: jobId,
          aggregateVersion: job.attempts,
          eventType: 'export.ready',
          payload: { exportId: jobId, kind: 'analytics', report: payload.report, expiresAt: result.expiresAt },
          scopes: [{ kind: 'agent', id: payload.requestedBy, audience: 'staff' }],
        });
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      const permanent = err instanceof AppError && err.getStatus() < 500;
      const retry = !permanent && job.attempts < MAX_ATTEMPTS;
      this.logger.warn(`Analytics export ${jobId} attempt ${job.attempts} failed (${code}): ${(err as Error).message}`);
      const delay = 5_000 * 2 ** (job.attempts - 1);
      await this.db.tx(tenantId, (tx) =>
        tx.job.update({
          where: { id: jobId },
          data: retry
            ? { state: 'queued', runAfter: new Date(Date.now() + delay), leaseUntil: null, lastErrorCode: code }
            : { state: 'failed', leaseUntil: null, lastErrorCode: code, completedAt: new Date() },
        }),
      );
      if (retry) await this.enqueue(tenantId, jobId, delay, job.attempts);
    }
  }

  private async build(actor: AnalyticsActor, p: ExportPayload): Promise<{ csv: string; filename: string; rowCount: number; sourceWatermark: string | null; totals: Record<string, number | null>; definitionsVersion: number }> {
    if (p.report === 'chats') {
      const report = await this.analytics.chatsReport(actor, p.filters as unknown as Parameters<AnalyticsService['chatsReport']>[1], EXPORT_LIMITS);
      return chatsCsv(report);
    }
    if (p.report === 'agents') {
      const report = await this.analytics.agentsReport(actor, p.filters as unknown as Parameters<AnalyticsService['agentsReport']>[1], EXPORT_LIMITS);
      return agentsCsv(report);
    }
    const report = await this.analytics.invitationsReport(actor, p.filters as unknown as Parameters<AnalyticsService['invitationsReport']>[1], EXPORT_LIMITS);
    return invitationsCsv(report);
  }

  /** Recover lost timers and scrub expired CSV payloads (the result keeps only metadata). */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const tenantId of await this.db.activeTenantIds()) {
      try {
        const jobs = await this.db.read(tenantId, (tx) =>
          tx.job.findMany({
            where: {
              tenantId,
              kind: EXPORT_JOB_KIND,
              OR: [
                { state: 'queued', runAfter: { lt: new Date(now - 15_000) } },
                { state: 'running', leaseUntil: { lt: new Date(now) } },
                { state: 'succeeded', completedAt: { lt: new Date(now - EXPORT_TTL_MS) } },
              ],
            },
            take: 200,
          }),
        );
        for (const j of jobs) {
          if (j.state === 'succeeded') {
            const result = j.result as unknown as ExportResult | null;
            if (result && !result.expired) {
              const { csv: _drop, ...meta } = result;
              void _drop;
              await this.db.tx(tenantId, (tx) => tx.job.update({ where: { id: j.id }, data: { result: { ...meta, expired: true } as unknown as Prisma.InputJsonValue } }));
            }
          } else {
            await this.enqueue(tenantId, j.id, 0, j.attempts + 100);
          }
        }
      } catch (err) {
        this.logger.warn(`Export sweep failed for ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}

// ───────── CSV layouts (aggregate only) ─────────

const isoOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
/** Calendar date in the report timezone (YYYY-MM-DD); `end` dates use the last instant of the half-open range. */
const dateOf = (d: Date | string, timeZone = 'UTC', end = false) => {
  const t = new Date(d).getTime() - (end ? 1 : 0);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
};

function measureColumns(): Array<{ key: string; header: string; pick: (m: MeasureSet) => Cell; def: (k: string) => Cell }> {
  const cols: Array<{ key: string; header: string; pick: (m: MeasureSet) => Cell; def: (k: string) => Cell }> = [];
  for (const key of MEASURE_KEYS) {
    const def = MEASURE_DEFINITIONS[key];
    const text = `${def.label}: ${def.definition} Population: ${def.population}. Null policy: ${def.nullPolicy}.`;
    if (def.kind === 'count') cols.push({ key, header: key, pick: (m) => m[key].value, def: () => text });
    else if (def.kind === 'rate') {
      cols.push({ key, header: `${key}_pct`, pick: (m) => m[key].value, def: () => text });
      cols.push({ key, header: `${key}_numerator`, pick: (m) => m[key].numerator, def: () => '' });
      cols.push({ key, header: `${key}_denominator`, pick: (m) => m[key].denominator, def: () => '' });
    } else {
      cols.push({ key, header: `${key}_n`, pick: (m) => m[key].n, def: () => text });
      cols.push({ key, header: `${key}_median_s`, pick: (m) => m[key].median ?? null, def: () => '' });
      cols.push({ key, header: `${key}_p90_s`, pick: (m) => m[key].p90 ?? null, def: () => '' });
      cols.push({ key, header: `${key}_p95_s`, pick: (m) => m[key].p95 ?? null, def: () => '' });
    }
  }
  return cols;
}

export function chatsCsv(report: ChatsReport) {
  const cols = measureColumns();
  const header = ['row_type', 'bucket_key', 'bucket_start_utc', 'bucket_end_utc', 'timezone', 'source_watermark', ...cols.map((c) => c.header)];
  const totals = Object.fromEntries(MEASURE_KEYS.map((k) => [k, report.measures[k]])) as unknown as MeasureSet;
  const watermark = isoOf(report.freshness.sourceWatermark);
  const rows: Cell[][] = [
    ['definition', `definitions_v${report.definitionsVersion}`, null, null, report.range.timezone, null, ...cols.map((c) => c.def(c.key))],
    ['filters', JSON.stringify({ ...report.filters, group_by: report.range.groupBy, scope: report.scope.departmentIds }), null, null, report.range.timezone, null, ...cols.map(() => null)],
    ['total', 'total', isoOf(report.range.from), isoOf(report.range.to), report.range.timezone, watermark, ...cols.map((c) => c.pick(totals))],
  ];
  if (report.comparisonRange) {
    const prev = Object.fromEntries(MEASURE_KEYS.map((k) => [k, report.measures[k].comparison ?? { value: null, numerator: null, denominator: null, n: 0 }])) as unknown as MeasureSet;
    rows.push(['comparison_total', 'comparison', isoOf(report.comparisonRange.from), isoOf(report.comparisonRange.to), report.range.timezone, watermark, ...cols.map((c) => c.pick(prev))]);
  }
  for (const b of report.series) rows.push(['bucket', b.key, isoOf(b.start), isoOf(b.end), report.range.timezone, watermark, ...cols.map((c) => c.pick(b.measures))]);
  return {
    csv: toCsv(header, rows),
    filename: `talkivio-chats-${dateOf(report.range.from, report.range.timezone)}-${dateOf(report.range.to, report.range.timezone, true)}.csv`,
    rowCount: rows.length,
    sourceWatermark: watermark,
    totals: Object.fromEntries(MEASURE_KEYS.map((k) => [k, report.measures[k].value])),
    definitionsVersion: report.definitionsVersion,
  };
}

export function agentsCsv(report: AgentsReport) {
  const header = [
    'row_type',
    'membership_id',
    'display_name',
    'role',
    'handled_chats',
    'distinct_chats_handled',
    'owned_seconds',
    'replies',
    'replied_chats',
    'transfers_in',
    'transfers_out',
    'first_responses',
    'first_response_n',
    'first_response_median_s',
    'first_response_p90_s',
    'first_response_p95_s',
    'response_time_n',
    'response_time_median_s',
    'response_time_p90_s',
    'response_time_p95_s',
    'online_seconds',
    'available_slot_seconds',
    'occupied_slot_seconds',
    'utilization_pct',
    'utilization_raw_pct',
    'utilization_invariant_violation',
    'ratings_good',
    'ratings_bad',
    'csat_pct',
    'range_from_utc',
    'range_to_utc',
    'timezone',
  ];
  const from = isoOf(report.range.from);
  const to = isoOf(report.range.to);
  const t = report.totals;
  const rows: Cell[][] = [
    ['total', null, null, null, t.handledChatsSum, t.distinctChatsHandled, t.ownedSeconds, t.replies, null, null, null, t.firstResponses, null, null, null, null, null, null, null, null, t.onlineSeconds, t.availableSlotSeconds, t.occupiedSlotSeconds, t.utilization, null, null, null, null, null, from, to, report.range.timezone],
    ...report.agents.map((a): Cell[] => [
      'agent',
      a.membershipId,
      a.displayName,
      a.role,
      a.handledChats,
      null,
      a.ownedSeconds,
      a.replies,
      a.repliedChats,
      a.transfersIn,
      a.transfersOut,
      a.firstResponses,
      a.firstResponseTime.n,
      a.firstResponseTime.median,
      a.firstResponseTime.p90,
      a.firstResponseTime.p95,
      a.responseTime.n,
      a.responseTime.median,
      a.responseTime.p90,
      a.responseTime.p95,
      a.onlineSeconds,
      a.availableSlotSeconds,
      a.occupiedSlotSeconds,
      a.utilization.value,
      a.utilization.raw,
      a.utilization.invariantViolation,
      a.ratings.good,
      a.ratings.bad,
      a.ratings.csat.value,
      from,
      to,
      report.range.timezone,
    ]),
  ];
  return {
    csv: toCsv(header, rows),
    filename: `talkivio-agents-${dateOf(report.range.from, report.range.timezone)}-${dateOf(report.range.to, report.range.timezone, true)}.csv`,
    rowCount: rows.length,
    sourceWatermark: isoOf(report.freshness.sourceWatermark),
    totals: { agents: t.agents, handled_chats: t.handledChatsSum, distinct_chats_handled: t.distinctChatsHandled, replies: t.replies, first_responses: t.firstResponses },
    definitionsVersion: report.definitionsVersion,
  };
}

export function invitationsCsv(report: InvitationsReport) {
  const header = ['row_type', 'campaign_id', 'campaign_name', 'eligible', 'displayed', 'accepted', 'served', 'display_rate_pct', 'acceptance_rate_pct', 'serve_rate_pct', 'range_from_utc', 'range_to_utc', 'timezone'];
  const from = isoOf(report.range.from);
  const to = isoOf(report.range.to);
  const line = (type: string, id: string | null, name: string | null, f: InvitationsReport['totals']): Cell[] => [
    type,
    id,
    name,
    f.eligible,
    f.displayed,
    f.accepted,
    f.served,
    f.displayRate,
    f.acceptanceRate,
    f.serveRate,
    from,
    to,
    report.range.timezone,
  ];
  const rows: Cell[][] = [line('total', null, null, report.totals), ...report.campaigns.map((c) => line('campaign', c.campaignId, c.name, c))];
  return {
    csv: toCsv(header, rows),
    filename: `talkivio-invitations-${dateOf(report.range.from, report.range.timezone)}-${dateOf(report.range.to, report.range.timezone, true)}.csv`,
    rowCount: rows.length,
    sourceWatermark: isoOf(report.freshness.sourceWatermark),
    totals: { eligible: report.totals.eligible, displayed: report.totals.displayed, accepted: report.totals.accepted, served: report.totals.served },
    definitionsVersion: report.definitionsVersion,
  };
}
