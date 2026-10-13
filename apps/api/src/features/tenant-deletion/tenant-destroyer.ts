import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { RedisService } from '../../common/redis.service';
import { env } from '../../config/env';
import { QueueService, QUEUES, type QueueName } from '../../core/queue.service';
import { StorageService, type StorageArea } from '../../core/storage.service';
import { lockForUpdate } from '../../db/row-lock';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { RealtimeService } from '../../realtime/realtime.service';
import { SessionService } from '../../auth/session.service';
import { WorkerService } from '../../worker/worker.service';
import { ExportJobsQueue } from '../exports/exports.service';
import { PrivacyObjectStore } from '../privacy/object-store';
import { batchableTables, isTenantRedisKey, quoteIdent, slugHash, TENANT_DELETION_KIND, TENANT_REGISTRY_SETS, TIMER_NAME } from './policy';

const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 6;
const BATCH_ROWS = 2000;
const FINAL_TX_TIMEOUT_MS = 120_000;
const DISCONNECT_SETTLE_MS = 1500;
/** Pending BullMQ states whose jobs can still be removed (active jobs finish against a disabled tenant). */
const PENDING_STATES = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'] as const;
/**
 * External deletion ledger (object storage, outside the database backup scope — like the privacy
 * erasure ledger). One pseudonymous entry per deleted workspace, so a restore from a backup taken
 * before the deletion is destroyed again before it takes traffic (scripts/replay-tombstones.mjs).
 */
export const TENANT_LEDGER_AREA = 'exports' as const;
export const TENANT_LEDGER_PREFIX = 'tenant-deletion-ledger/';
const ledgerKey = (tenantId: string) => `${TENANT_LEDGER_PREFIX}${tenantId}.json`;

export interface TenantLedgerReplay {
  dryRun: boolean;
  entries: number;
  resurrected: string[];
  destroyed: string[];
  failures: string[];
}

class DestructionIncomplete extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

type Counts = Record<string, unknown> & { rows?: Record<string, number> };

/**
 * Staged tenant destruction (worker). The `jobs` row (kind `tenant_deletion`) is the durable
 * request; BullMQ only schedules it (delayed timer at `run_after`, plus the `tenant-deletion-sweep`
 * maintenance fallback). Once claimed, the tenant is disabled and a `tenant_tombstones` row (not
 * tenant-owned) tracks progress, so every step is idempotent and a crashed run resumes:
 *
 *   claim → inventory → revoke access → drop queued jobs → delete objects → delete Redis keys →
 *   batch-delete high-volume tables → final transaction (non-cascading tables, DELETE tenants ⇒
 *   ON DELETE CASCADE, verify zero rows, stamp tombstone) → second queue/object/Redis pass →
 *   tombstone completed.
 */
@Injectable()
export class TenantDestroyer implements OnModuleInit {
  private readonly logger = new Logger('TenantDeletion');

  constructor(
    private readonly db: TenantDb,
    private readonly queues: QueueService,
    private readonly exportQueue: ExportJobsQueue,
    private readonly worker: WorkerService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly objects: PrivacyObjectStore,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.worker.onTimer(async (name, data) => {
      if (name !== TIMER_NAME) return false;
      await this.run(String(data.tenantId), String(data.jobId));
      return true;
    });
    this.worker.onMaintenance('tenant-deletion-sweep', () => this.sweep());
  }

  // ───────────────────────── Scheduling ─────────────────────────

  async schedule(tenantId: string, jobId: string, attempt: number, delayMs: number): Promise<void> {
    await this.queues.add(QUEUES.timers, TIMER_NAME, { tenantId, jobId }, { jobId: `tenant-deletion-${jobId}-${attempt}`, delay: Math.max(0, delayMs), removeOnComplete: true, removeOnFail: true });
  }

  /** Best effort: the claim re-checks the job state, so a stale timer is harmless. */
  async unschedule(jobId: string): Promise<void> {
    const q = this.queues.queue(QUEUES.timers);
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
      const j = await q.getJob(`tenant-deletion-${jobId}-${attempt}`).catch(() => undefined);
      if (j && !(await j.isActive())) await j.remove().catch(() => undefined);
    }
  }

  /** Lost timers and crashed runs: due requests in active tenants, and unfinished tombstones. */
  async sweep(): Promise<void> {
    const now = new Date();
    for (const tenantId of await this.db.activeTenantIds()) {
      const due = await this.db.read(tenantId, (tx) => tx.job.findMany({ where: { tenantId, kind: TENANT_DELETION_KIND, state: 'queued', runAfter: { lte: now } }, select: { id: true, attempts: true }, take: 5 }));
      for (const j of due) await this.schedule(tenantId, j.id, j.attempts, 0).catch(() => undefined);
    }
    // Disabled tenants (status `deleting`) are no longer "active": the tombstone is their index.
    const open = await this.db.root.tenantTombstone.findMany({ where: { completedAt: null }, orderBy: { startedAt: 'asc' }, take: 20 });
    for (const t of open) {
      if (!t.deletedAt) {
        const job = await this.db.read(t.tenantId, (tx) => tx.job.findFirst({ where: { tenantId: t.tenantId, id: t.deletionJobId } }));
        const resumable = job && ((job.state === 'queued' && job.runAfter <= now) || (job.state === 'running' && (!job.leaseUntil || job.leaseUntil < now)));
        if (job && resumable) await this.schedule(t.tenantId, job.id, job.attempts, 0).catch(() => undefined);
      } else if (now.getTime() - t.deletedAt.getTime() > 60_000) {
        await this.finalize(t.tenantId).catch((err) => this.logger.warn(`Finalize ${t.tenantId} failed: ${(err as Error).message}`));
      }
    }
  }

  // ───────────────────────── Ledger (backup-restore safety) ─────────────────────────

  /** Written once destruction is claimed (before anything is removed); idempotent. No personal data. */
  private async writeLedger(tenantId: string, jobId: string): Promise<void> {
    const tomb = await this.db.root.tenantTombstone.findUnique({ where: { tenantId } });
    const entry = { kind: 'tenant_deletion', v: 1, tenant_id: tenantId, slug_hash: tomb?.slugHash ?? null, deletion_job_id: jobId, recorded_at: new Date().toISOString() };
    await this.storage.write(TENANT_LEDGER_AREA, ledgerKey(tenantId), Buffer.from(JSON.stringify(entry)), 'application/json');
  }

  /**
   * Re-apply recorded workspace deletions after a database restore, before the restored system takes
   * traffic. Any ledgered tenant that the restore brought back is disabled and destroyed again
   * synchronously; already-absent tenants are left alone. Idempotent.
   */
  async replayLedger(opts: { dryRun?: boolean; tenantId?: string } = {}): Promise<TenantLedgerReplay> {
    const report: TenantLedgerReplay = { dryRun: !!opts.dryRun, entries: 0, resurrected: [], destroyed: [], failures: [] };
    for (const key of await this.objects.list(TENANT_LEDGER_AREA, TENANT_LEDGER_PREFIX)) {
      const raw = await this.storage.read(TENANT_LEDGER_AREA, key, 64 * 1024);
      const entry = raw ? (JSON.parse(raw.toString('utf8')) as { tenant_id?: string }) : null;
      const tenantId = entry?.tenant_id;
      if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId) || (opts.tenantId && opts.tenantId !== tenantId)) continue;
      report.entries++;
      const present = await this.db.read(tenantId, (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true } }));
      if (!present) continue;
      report.resurrected.push(tenantId);
      if (opts.dryRun) continue;
      try {
        // The restored database predates the deletion: reopen a due request and run it now.
        const job = await this.db.tx(tenantId, async (tx) => {
          const existing = await tx.job.findFirst({ where: { tenantId, kind: TENANT_DELETION_KIND, state: { in: ['queued', 'running'] } } });
          if (existing) return tx.job.update({ where: { id: existing.id }, data: { state: 'queued', runAfter: new Date(), leaseUntil: null } });
          return tx.job.create({ data: { tenantId, kind: TENANT_DELETION_KIND, dedupeKey: `replay:${Date.now()}`, state: 'queued', runAfter: new Date(), payload: { replay: true } } });
        });
        await this.run(tenantId, job.id);
        const tomb = await this.db.root.tenantTombstone.findUnique({ where: { tenantId } });
        if (tomb?.completedAt) report.destroyed.push(tenantId);
        else report.failures.push(`tenant_deletion:${tenantId}`);
      } catch (err) {
        this.logger.error(`Tenant deletion replay ${tenantId} failed: ${(err as Error).message}`);
        report.failures.push(`tenant_deletion:${tenantId}`);
      }
    }
    return report;
  }

  // ───────────────────────── Run ─────────────────────────

  async run(tenantId: string, jobId: string): Promise<void> {
    const job = await this.claim(tenantId, jobId);
    if (!job) return;
    try {
      await this.writeLedger(tenantId, jobId);
      await this.destroy(tenantId, job);
    } catch (err) {
      await this.fail(tenantId, job, err);
    }
  }

  /** Lease the job, disable the tenant and open its tombstone — one transaction, serialised with cancel by the tenant row lock. */
  private async claim(tenantId: string, jobId: string): Promise<Job | null> {
    return this.db.tx(tenantId, async (tx) => {
      await lockForUpdate(tx, 'tenants', tenantId, tenantId);
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, status: true } });
      if (!tenant) return null;
      const now = new Date();
      const won = await tx.job.updateMany({
        where: {
          tenantId,
          id: jobId,
          kind: TENANT_DELETION_KIND,
          OR: [
            { state: 'queued', runAfter: { lte: new Date(now.getTime() + 2000) } },
            { state: 'running', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          ],
        },
        data: { state: 'running', leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
      });
      if (won.count !== 1) return null;
      if (tenant.status !== 'deleting') await tx.tenant.update({ where: { id: tenantId }, data: { status: 'deleting', version: { increment: 1 } } });
      await tx.tenantTombstone.upsert({ where: { tenantId }, create: { tenantId, slugHash: slugHash(tenant.slug, env().APP_SECRET), deletionJobId: jobId }, update: {} });
      return tx.job.findUniqueOrThrow({ where: { id: jobId } });
    });
  }

  private async destroy(tenantId: string, job: Job): Promise<void> {
    const started = Date.now();
    const tomb = await this.db.root.tenantTombstone.findUniqueOrThrow({ where: { tenantId } });
    if (!(tomb.counts as Counts).rows) {
      // Counted once, after the tenant was disabled and before anything is removed (survives retries).
      const rows = await this.db.read(tenantId, async (tx) => this.countRows(tx, tenantId, (await this.tenantTables(tx)).map((t) => t.name)));
      await this.db.root.tenantTombstone.update({ where: { tenantId }, data: { counts: { ...(tomb.counts as object), rows } as Prisma.InputJsonValue } });
    }
    await this.heartbeat(tenantId, job.id, 10);
    await this.addCounts(tenantId, { sessions_revoked: await this.revokeAccess(tenantId) });
    // Gateways handle the forced disconnects asynchronously (and may queue e.g. visitor-grace
    // timers while doing so); let them settle before collecting queued jobs. `finalize` re-checks.
    await new Promise((r) => setTimeout(r, DISCONNECT_SETTLE_MS));
    await this.heartbeat(tenantId, job.id, 20);
    await this.addCounts(tenantId, { queued_jobs_removed: await this.purgeQueuedJobs(tenantId) });
    await this.heartbeat(tenantId, job.id, 30);
    await this.addCounts(tenantId, { objects_deleted: await this.purgeObjects(tenantId) });
    await this.heartbeat(tenantId, job.id, 45);
    await this.addCounts(tenantId, { redis_keys_deleted: await this.purgeRedis(tenantId) });
    await this.heartbeat(tenantId, job.id, 55);
    await this.deleteHighVolume(tenantId, job.id);
    await this.heartbeat(tenantId, job.id, 90);
    await this.deleteTenantRows(tenantId);
    await this.finalize(tenantId);
    const final = await this.db.root.tenantTombstone.findUniqueOrThrow({ where: { tenantId } });
    const counts = final.counts as Counts;
    const rows = Object.values(counts.rows ?? {}).reduce((a, b) => a + b, 0);
    // `tenant.deleted`: the workspace audit trail is tenant-owned and went with the cascade, so the
    // durable record is the tombstone; this structured line is the operator-facing audit event.
    this.logger.log(
      `audit tenant.deleted ${JSON.stringify({ tenant_id: tenantId, deletion_job_id: job.id, deleted_at: final.deletedAt, rows_deleted: rows, objects_deleted: counts.objects_deleted ?? 0, redis_keys_deleted: counts.redis_keys_deleted ?? 0, sessions_revoked: counts.sessions_revoked ?? 0, duration_ms: Date.now() - started })}`,
    );
  }

  private async heartbeat(tenantId: string, jobId: string, progress: number): Promise<void> {
    await this.db.tx(tenantId, (tx) => tx.job.updateMany({ where: { tenantId, id: jobId, state: 'running' }, data: { progress, leaseUntil: new Date(Date.now() + LEASE_MS) } }));
  }

  /** Accumulate numeric counters on the tombstone (global table; no tenant context needed). */
  private async addCounts(tenantId: string, add: Record<string, number>): Promise<void> {
    const t = await this.db.root.tenantTombstone.findUniqueOrThrow({ where: { tenantId } });
    const counts = { ...(t.counts as Counts) };
    for (const [k, n] of Object.entries(add)) counts[k] = Number(counts[k] ?? 0) + n;
    await this.db.root.tenantTombstone.update({ where: { tenantId }, data: { counts: counts as Prisma.InputJsonValue } });
  }

  // ───────────────────────── Steps ─────────────────────────

  /** Sessions whose active workspace is this tenant are revoked; every agent and visitor socket of the tenant is closed. */
  private async revokeAccess(tenantId: string): Promise<number> {
    const sessions = await this.db.root.authSession.findMany({ where: { activeTenantId: tenantId, revokedAt: null }, select: { id: true } });
    for (const s of sessions) await this.sessions.revoke(s.id);
    this.realtime.revokeTenant(tenantId);
    return sessions.length;
  }

  /** Pending BullMQ jobs carrying this tenant (timers, events, webhooks, scans, exports) and its queued emails. */
  private async purgeQueuedJobs(tenantId: string): Promise<number> {
    let removed = 0;
    const queues = [...([QUEUES.events, QUEUES.timers, QUEUES.webhooks, QUEUES.scans, QUEUES.jobs] as QueueName[]).map((n) => this.queues.queue(n)), this.exportQueue.queue()];
    for (const q of queues) {
      const doomed = [];
      for (const state of PENDING_STATES) {
        for (let start = 0; ; start += 500) {
          const jobs = await q.getJobs([state], start, start + 499);
          for (const j of jobs) if (j && (j.data as { tenantId?: unknown } | null)?.tenantId === tenantId) doomed.push(j);
          if (jobs.length < 500) break;
        }
      }
      for (const j of doomed) {
        if (await j.remove().then(() => true).catch(() => false)) removed++;
      }
    }
    const emails = await this.db.root.outboundEmail.findMany({ where: { tenantId, status: { in: ['queued', 'failed'] } }, select: { id: true } });
    const mail = this.queues.queue(QUEUES.email);
    for (const e of emails) {
      const j = await mail.getJob(`email-${e.id}`).catch(() => undefined);
      if (j && !(await j.isActive()) && (await j.remove().then(() => true).catch(() => false))) removed++;
    }
    return removed;
  }

  /** Object storage under the tenant's prefixes, confirmed empty afterwards. The pseudonymous privacy ledger is retained on purpose. */
  private async purgeObjects(tenantId: string): Promise<number> {
    const prefixes: Array<[StorageArea, string]> = [
      ['quarantine', `t/${tenantId}/`],
      ['clean', `t/${tenantId}/`],
      ['exports', `t/${tenantId}/`],
      ['exports', `privacy/${tenantId}/`],
    ];
    let deleted = 0;
    for (const [area, prefix] of prefixes) {
      for (const key of await this.objects.list(area, prefix)) {
        await this.storage.delete(area, key);
        deleted++;
      }
      if (this.storage.driver === 'local') {
        // Remove the emptied directory tree (and any abandoned `.part-` upload temp files).
        const base = resolve(process.cwd(), env().STORAGE_LOCAL_DIR, area);
        const dir = resolve(base, prefix);
        if (dir.startsWith(base + sep)) await rm(dir, { recursive: true, force: true });
      }
      const left = await this.objects.list(area, prefix);
      if (left.length) throw new DestructionIncomplete('object_storage', `${left.length} objects remain in ${area}`);
    }
    return deleted;
  }

  /** Presence, live-monitor and other tenant-keyed Redis state (rate-limit counters expire on their own but are removed too when they embed the id). */
  private async purgeRedis(tenantId: string): Promise<number> {
    const r = this.redis.client;
    let deleted = 0;
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `*${tenantId}*`, 'COUNT', 1000);
      cursor = next;
      const mine = keys.filter((k) => isTenantRedisKey(k, tenantId));
      if (mine.length) deleted += await r.del(...mine);
    } while (cursor !== '0');
    for (const set of TENANT_REGISTRY_SETS) deleted += await r.srem(set, tenantId);
    return deleted;
  }

  /** Tables carrying `tenant_id` (from the live catalog) and whether they cascade from `tenants`. */
  private async tenantTables(tx: Tx): Promise<Array<{ name: string; cascades: boolean }>> {
    return tx.$queryRaw<Array<{ name: string; cascades: boolean }>>`
      SELECT cl.relname::text AS name,
             EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = cl.oid AND k.contype = 'f'
                        AND k.confrelid = 'public.tenants'::regclass AND k.confdeltype = 'c') AS cascades
        FROM pg_class cl
        JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       WHERE cl.relnamespace = 'public'::regnamespace AND cl.relkind IN ('r', 'p') AND cl.relname <> 'tenant_tombstones'
       ORDER BY 1`;
  }

  /** Tables referenced by RESTRICT / NO ACTION foreign keys from another table (live catalog). */
  private async restrictParents(tx: Tx): Promise<Set<string>> {
    const rows = await tx.$queryRaw<Array<{ parent: string }>>`
      SELECT DISTINCT p.relname::text AS parent
        FROM pg_constraint k
        JOIN pg_class p ON p.oid = k.confrelid
       WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND k.confdeltype IN ('r', 'a') AND k.conrelid <> k.confrelid`;
    return new Set(rows.map((r) => r.parent));
  }

  private async countRows(tx: Tx, tenantId: string, tables: string[]): Promise<Record<string, number>> {
    if (!tables.length) return {};
    const parts = tables.map((t) => Prisma.sql`SELECT ${t}::text AS t, count(*)::bigint AS n FROM ${Prisma.raw(quoteIdent(t))} WHERE tenant_id = ${tenantId}::uuid`);
    const rows = await tx.$queryRaw<Array<{ t: string; n: bigint }>>`${Prisma.join(parts, ' UNION ALL ')}`;
    const out: Record<string, number> = {};
    for (const r of rows) if (Number(r.n) > 0) out[r.t] = Number(r.n);
    return out;
  }

  /** Bounded batches (one short transaction each) so a large tenant never needs one huge transaction. */
  private async deleteHighVolume(tenantId: string, jobId: string): Promise<void> {
    const batched = await this.db.read(tenantId, async (tx) => batchableTables(new Set((await this.tenantTables(tx)).map((t) => t.name)), await this.restrictParents(tx)));
    for (const table of batched) {
      const ident = Prisma.raw(quoteIdent(table));
      for (;;) {
        const n = await this.db.tx(tenantId, (tx) => tx.$executeRaw`DELETE FROM ${ident} WHERE ctid IN (SELECT ctid FROM ${ident} WHERE tenant_id = ${tenantId}::uuid LIMIT ${BATCH_ROWS})`);
        if (n < BATCH_ROWS) break;
        await this.heartbeat(tenantId, jobId, 70);
      }
    }
  }

  /**
   * The approved destruction transaction (ch. 34). Tables that carry `tenant_id` without a
   * cascading FK (today outbound_emails, auth_tokens, billing_events — found from the catalog) are
   * deleted explicitly; then `DELETE FROM tenants` removes everything else through the per-table
   * `ON DELETE CASCADE` tenant FKs (including audit_events, which the application role cannot
   * delete directly). RESTRICT FKs between tenant tables (chats → departments/sites, sites →
   * schedules, tags, …) do not block it: every tenant table has its own cascading tenant FK, so
   * all of them are emptied before the RESTRICT checks run. Commits only when no row with this
   * tenant id remains anywhere, together with the tombstone's `deleted_at`; the tenant's own jobs
   * row (this request) goes with it.
   */
  private async deleteTenantRows(tenantId: string): Promise<void> {
    await this.db.tx(
      tenantId,
      async (tx) => {
        const tables = await this.tenantTables(tx);
        const names = new Set(tables.map((t) => t.name));
        for (const t of tables.filter((x) => !x.cascades)) {
          await tx.$executeRaw`DELETE FROM ${Prisma.raw(quoteIdent(t.name))} WHERE tenant_id = ${tenantId}::uuid`;
        }
        // Sessions keep no FK to tenants; drop the dangling active-workspace pointer (already revoked).
        await tx.authSession.updateMany({ where: { activeTenantId: tenantId }, data: { activeTenantId: null } });
        await tx.tenant.deleteMany({ where: { id: tenantId } });
        const left = await this.countRows(tx, tenantId, [...names]);
        if (Object.keys(left).length) throw new DestructionIncomplete('rows_remaining', Object.keys(left).join(', '));
        await tx.tenantTombstone.update({ where: { tenantId }, data: { deletedAt: new Date() } });
      },
      { timeoutMs: FINAL_TX_TIMEOUT_MS, retries: 2 },
    );
  }

  /** Second queue/object/Redis pass (catches work queued or written by in-flight requests during the run), then close the tombstone. Idempotent. */
  async finalize(tenantId: string): Promise<void> {
    const queued = await this.purgeQueuedJobs(tenantId);
    const objects = await this.purgeObjects(tenantId);
    const keys = await this.purgeRedis(tenantId);
    await this.addCounts(tenantId, { queued_jobs_removed: queued, objects_deleted: objects, redis_keys_deleted: keys });
    await this.db.root.tenantTombstone.updateMany({ where: { tenantId, deletedAt: { not: null }, completedAt: null }, data: { completedAt: new Date() } });
  }

  private async fail(tenantId: string, job: Job, err: unknown): Promise<void> {
    const code = err instanceof DestructionIncomplete ? err.code : 'worker_error';
    const attempts = job.attempts;
    const retry = attempts < MAX_ATTEMPTS;
    const delay = Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 1));
    this.logger.error(`Tenant ${tenantId} destruction attempt ${attempts} failed (${code}): ${(err as Error).message}`);
    // The tenant stays disabled: a destruction that started is never silently abandoned.
    const updated = await this.db
      .tx(tenantId, (tx) =>
        tx.job.updateMany({
          where: { tenantId, id: job.id, state: 'running' },
          data: retry ? { state: 'queued', runAfter: new Date(Date.now() + delay), leaseUntil: null, lastErrorCode: code } : { state: 'failed', leaseUntil: null, lastErrorCode: code, completedAt: new Date() },
        }),
      )
      .catch(() => ({ count: 0 }));
    if (updated.count && retry) await this.schedule(tenantId, job.id, attempts, delay).catch(() => undefined);
  }
}
