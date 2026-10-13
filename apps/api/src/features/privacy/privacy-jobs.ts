import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Job, type PrivacyRequest } from '@prisma/client';
import { AuditService, type AuditActor } from '../../common/audit.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { TenantDb } from '../../db/tenant-db';
import { OutboxService } from '../../outbox/outbox.service';
import { WorkerService } from '../../worker/worker.service';
import { ConnectorService } from '../integrations/connectors/connectors.service';
import { AccessExportService } from './access-export.service';
import { privacyConfig } from './config';
import { ERASURE_STEPS, type ErasureCounts, ErasureService } from './erasure.service';
import { emitPrivacyUpdated, PRIVACY_JOB_KINDS } from './privacy.service';
import { RetentionService } from './retention.service';
import { TombstoneService, visitorHash } from './tombstones.service';

const TIMER_NAME = 'privacy.run';
const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

class ErasureIncomplete extends Error {
  constructor(readonly targets: string[]) {
    super(`Erasure not confirmed for: ${targets.join(', ')}`);
  }
}

const SYSTEM: Omit<AuditActor, 'tenantId'> = {
  userId: null,
  tokenId: null,
  actorName: 'System (privacy worker)',
  requestId: '',
  ipHash: null,
};

interface JobResult {
  context?: { email_hash: string | null; subjects: string[] };
  counts?: ErasureCounts;
  export_id?: string;
}

/**
 * Privacy job execution (ch. 53, JOB01): `jobs` rows are the durable state; BullMQ
 * (timers queue via WorkerService.onTimer) only schedules. A row is claimed with a
 * lease; a crash before or after the lease is recovered by the sweep, and every step
 * is idempotent, so a retry continues to a single result. Requests complete only
 * after every store confirms removal; otherwise they retry and finally fail with the
 * unconfirmed targets listed in the report.
 */
@Injectable()
export class PrivacyJobRunner implements OnModuleInit {
  private readonly logger = new Logger('PrivacyJobs');

  constructor(
    private readonly db: TenantDb,
    private readonly queues: QueueService,
    private readonly worker: WorkerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly erasure: ErasureService,
    private readonly exports: AccessExportService,
    private readonly tombstones: TombstoneService,
    private readonly connectors: ConnectorService,
    private readonly retention: RetentionService,
  ) {}

  onModuleInit(): void {
    this.worker.onTimer(async (name, data) => {
      if (name !== TIMER_NAME) return false;
      await this.run(String(data.tenantId), String(data.jobId));
      return true;
    });
    this.worker.onMaintenance('privacy-sweep', () => this.sweep());
    this.worker.onMaintenance('retention', () => this.retention.scheduled());
  }

  async enqueue(tenantId: string, jobId: string, attempts: number, delayMs = 0): Promise<void> {
    await this.queues.add(
      QUEUES.timers,
      TIMER_NAME,
      { tenantId, jobId },
      { jobId: `privacy-${jobId}-${attempts}`, delay: delayMs, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** Re-enqueue due queued jobs and jobs whose lease expired (crashed worker). */
  async sweep(): Promise<void> {
    const now = new Date();
    for (const tenantId of await this.db.activeTenantIds()) {
      const due = await this.db.read(tenantId, (tx) =>
        tx.job.findMany({
          where: {
            tenantId,
            kind: { in: Object.values(PRIVACY_JOB_KINDS) },
            OR: [
              { state: 'queued', runAfter: { lte: now } },
              { state: 'running', leaseUntil: { lt: now } },
            ],
          },
          select: { id: true, attempts: true },
          take: 50,
        }),
      );
      for (const j of due) await this.enqueue(tenantId, j.id, j.attempts).catch(() => undefined);
    }
  }

  private async claim(
    tenantId: string,
    jobId: string,
  ): Promise<{ job: Job; request: PrivacyRequest } | null> {
    return this.db.tx(tenantId, async (tx) => {
      const now = new Date();
      const won = await tx.job.updateMany({
        where: {
          tenantId,
          id: jobId,
          OR: [
            { state: 'queued', runAfter: { lte: new Date(now.getTime() + 2000) } },
            { state: 'running', leaseUntil: { lt: now } },
          ],
        },
        data: {
          state: 'running',
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          attempts: { increment: 1 },
        },
      });
      if (won.count !== 1) return null;
      const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
      let request = await tx.privacyRequest.findFirst({ where: { tenantId, id: job.dedupeKey } });
      if (!request || request.state === 'completed') {
        await tx.job.update({
          where: { id: jobId },
          data: { state: request ? 'succeeded' : 'cancelled', leaseUntil: null },
        });
        return null;
      }
      if (request.state !== 'running') {
        request = await tx.privacyRequest.update({
          where: { id: request.id },
          data: {
            state: 'running',
            report: { ...(request.report as object), state: 'running' } as Prisma.InputJsonValue,
          },
        });
        await emitPrivacyUpdated(this.outbox, tx, request, this.membershipOf(job));
      }
      return { job, request };
    });
  }

  private membershipOf(job: Job): string | null {
    const m = (job.payload as Record<string, unknown> | null)?.membership_id;
    return typeof m === 'string' ? m : null;
  }

  async run(tenantId: string, jobId: string): Promise<void> {
    const claimed = await this.claim(tenantId, jobId);
    if (!claimed) return;
    const { job, request } = claimed;
    try {
      if (job.kind === PRIVACY_JOB_KINDS.erase) await this.runErasure(job, request);
      else await this.runAccess(job, request);
    } catch (err) {
      await this.fail(job, request, err);
    }
  }

  private async saveProgress(
    job: Job,
    request: PrivacyRequest,
    patch: { progress: number; result?: JobResult; report: Record<string, unknown> },
  ): Promise<void> {
    await this.db.tx(job.tenantId, async (tx) => {
      await tx.job.update({
        where: { id: job.id },
        data: {
          progress: patch.progress,
          leaseUntil: new Date(Date.now() + LEASE_MS),
          ...(patch.result ? { result: patch.result as Prisma.InputJsonValue } : {}),
        },
      });
      const current = await tx.privacyRequest.findUniqueOrThrow({ where: { id: request.id } });
      const updated = await tx.privacyRequest.update({
        where: { id: request.id },
        data: { report: { ...(current.report as object), ...patch.report } as Prisma.InputJsonValue },
      });
      // Step progress for open privacy screens (no polling needed).
      await emitPrivacyUpdated(this.outbox, tx, updated, this.membershipOf(job), patch.progress);
    });
  }

  private async runErasure(job: Job, request: PrivacyRequest): Promise<void> {
    const tenantId = job.tenantId;
    const visitorId = request.visitorId ?? String((job.payload as Record<string, unknown>).visitor_id ?? '');
    const prior = (job.result ?? {}) as JobResult;
    // Pseudonymous context is captured once, before identifiers are deleted, and survives retries.
    const context = prior.context ?? {
      email_hash: (await this.erasure.scope(tenantId, visitorId))?.emailHash ?? null,
      subjects: await this.tombstones.subjectHashes(tenantId, visitorId),
    };
    const scope = await this.erasure.scope(tenantId, visitorId, context.email_hash);
    if (!scope) throw new ErasureIncomplete(['subject_not_found']);
    const base: ErasureCounts = { ...(prior.counts ?? {}) };
    const merged = (c: ErasureCounts) => {
      const out = { ...base };
      for (const [k, n] of Object.entries(c)) out[k] = (out[k] ?? 0) + n;
      return out;
    };
    await this.saveProgress(job, request, {
      progress: 1,
      result: { context, counts: base },
      report: {
        state: 'running',
        progress: { step: 'started', completed_steps: 0, total_steps: ERASURE_STEPS.length },
      },
    });
    const outcome = await this.erasure.run(scope, {
      mode: 'request',
      onStep: async (step, counts) => {
        const done = ERASURE_STEPS.indexOf(step) + 1;
        await this.saveProgress(job, request, {
          progress: Math.round((done / (ERASURE_STEPS.length + 2)) * 100),
          result: { context, counts: merged(counts) },
          report: {
            progress: { step, completed_steps: done, total_steps: ERASURE_STEPS.length },
            counts: merged(counts),
          },
        });
      },
    });
    const counts = merged(outcome.counts);
    if (outcome.failures.length) {
      await this.saveProgress(job, request, {
        progress: 95,
        result: { context, counts },
        report: { stores: outcome.stores, counts },
      });
      throw new ErasureIncomplete([...new Set(outcome.failures)]);
    }
    const downstream = await this.connectors.eraseSubjectDownstream(
      tenantId,
      [visitorId, ...scope.ownedChatIds, ...scope.offlineIds],
      visitorHash(tenantId, visitorId),
    );
    const erasedAt = new Date().toISOString();
    const ledgerOk = await this.tombstones.writeLedger({
      version: 1,
      tenantId,
      requestId: request.id,
      erasedAt,
      subjects: context.subjects,
    });
    if (!ledgerOk) throw new ErasureIncomplete(['tombstone_ledger']);
    const tombstonesWritten = await this.tombstones.writeDbTombstones({
      version: 1,
      tenantId,
      requestId: request.id,
      erasedAt,
      subjects: context.subjects,
    });

    await this.db.tx(tenantId, async (tx) => {
      const subscribed = await tx.webhookEndpoint.count({
        where: { tenantId, enabled: true, eventTypes: { has: 'privacy.erased' } },
      });
      const done = await tx.privacyRequest.update({
        where: { id: request.id },
        data: {
          state: 'completed',
          completedAt: new Date(erasedAt),
          report: {
            ...((await tx.privacyRequest.findUniqueOrThrow({ where: { id: request.id } })).report as object),
            state: 'completed',
            progress: {
              step: 'completed',
              completed_steps: ERASURE_STEPS.length,
              total_steps: ERASURE_STEPS.length,
            },
            counts,
            stores: [
              ...outcome.stores,
              {
                store: 'tombstone_ledger',
                status: 'confirmed',
                detail: `${context.subjects.length} pseudonymous subject hashes recorded outside the database backup scope`,
              },
            ],
            policy: {
              transcript: outcome.policy.transcript,
              other_visitors: 'retained',
              system_events: 'retained',
              bans: 'retained (security interest)',
              audit_trail: 'retained (contains no personal values)',
            },
            downstream,
            webhook_notification: subscribed ? 'queued' : 'no_subscribed_endpoints',
            legal_hold: {
              modeled: false,
              note: 'Legal holds are not modeled in this release; no data was withheld from erasure.',
            },
            logs: 'Request bodies and message text are not written to application logs.',
            tombstones_written: tombstonesWritten,
            error_code: null,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.job.update({
        where: { id: job.id },
        data: {
          state: 'succeeded',
          progress: 100,
          leaseUntil: null,
          completedAt: new Date(),
          lastErrorCode: null,
          result: { counts } as Prisma.InputJsonValue,
        },
      });
      await this.audit.inTx(
        tx,
        { tenantId, ...SYSTEM },
        {
          action: 'privacy.erasure_completed',
          objectType: 'privacy_request',
          objectId: request.id,
          safeDiff: {
            kind: 'erase',
            rows_changed: Object.values(counts).reduce((a, b) => a + b, 0),
            stores_confirmed: outcome.stores.length + 1,
          },
        },
      );
      await emitPrivacyUpdated(this.outbox, tx, done, this.membershipOf(job));
      await this.outbox.append(tx, tenantId, {
        aggregateType: 'privacy_request',
        aggregateId: request.id,
        aggregateVersion: 4,
        eventType: 'privacy.erased',
        payload: { requestId: request.id, visitorId, completedAt: erasedAt },
        scopes: [],
      });
    });
  }

  private async runAccess(job: Job, request: PrivacyRequest): Promise<void> {
    const tenantId = job.tenantId;
    const visitorId = request.visitorId;
    if (!visitorId) throw new ErasureIncomplete(['subject_not_found']);
    const cfg = privacyConfig();
    await this.saveProgress(job, request, {
      progress: 10,
      report: { state: 'running', progress: { step: 'collecting' } },
    });
    const existing = await this.db.read(tenantId, (tx) =>
      tx.export.findFirst({ where: { tenantId, jobId: job.id, erasedAt: null, objectKey: { not: null } } }),
    );
    let exportRow = existing;
    let counts: Record<string, number> =
      ((request.report as Record<string, unknown>).counts as Record<string, number>) ?? {};
    if (!exportRow) {
      const built = await this.exports.build(tenantId, visitorId, request.id);
      counts = built.counts;
      exportRow = await this.db.tx(tenantId, (tx) =>
        tx.export.create({
          data: {
            tenantId,
            requestedBy: job.requestedBy,
            format: 'json',
            filters: { privacy_request_id: request.id, visitor_id: visitorId } as Prisma.InputJsonValue,
            includeInternal: cfg.accessExportIncludeNotes,
            jobId: job.id,
            objectKey: built.objectKey,
            sha256: built.sha256,
            sizeBytes: BigInt(built.sizeBytes),
            itemCount: built.counts.messages,
            expiresAt: new Date(Date.now() + cfg.exportTtlDays * 86_400_000),
          },
        }),
      );
    }
    await this.db.tx(tenantId, async (tx) => {
      const current = await tx.privacyRequest.findUniqueOrThrow({ where: { id: request.id } });
      const done = await tx.privacyRequest.update({
        where: { id: request.id },
        data: {
          state: 'completed',
          completedAt: new Date(),
          report: {
            ...(current.report as object),
            state: 'completed',
            progress: { step: 'completed' },
            counts,
            export: {
              id: exportRow!.id,
              format: 'json',
              size_bytes: Number(exportRow!.sizeBytes ?? 0),
              sha256: exportRow!.sha256,
              expires_at: exportRow!.expiresAt.toISOString(),
              includes_staff_notes: cfg.accessExportIncludeNotes,
            },
            error_code: null,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.job.update({
        where: { id: job.id },
        data: {
          state: 'succeeded',
          progress: 100,
          leaseUntil: null,
          completedAt: new Date(),
          result: { export_id: exportRow!.id } as Prisma.InputJsonValue,
        },
      });
      await this.audit.inTx(
        tx,
        { tenantId, ...SYSTEM },
        {
          action: 'privacy.access_export_ready',
          objectType: 'privacy_request',
          objectId: request.id,
          safeDiff: { kind: 'access', export_id: exportRow!.id },
        },
      );
      await emitPrivacyUpdated(this.outbox, tx, done, this.membershipOf(job));
    });
  }

  private async fail(job: Job, request: PrivacyRequest, err: unknown): Promise<void> {
    const incomplete = err instanceof ErasureIncomplete;
    const code = incomplete ? 'erasure_unconfirmed' : 'worker_error';
    // `job` was re-read after the claim, so attempts already includes this run.
    const attempts = job.attempts;
    this.logger.warn(`Privacy job ${job.id} attempt ${attempts} failed (${code}): ${(err as Error).message}`);
    if (attempts < MAX_ATTEMPTS) {
      const delay = Math.min(30 * 60_000, 15_000 * 2 ** (attempts - 1));
      await this.db.tx(job.tenantId, (tx) =>
        tx.job.update({
          where: { id: job.id },
          data: {
            state: 'queued',
            runAfter: new Date(Date.now() + delay),
            leaseUntil: null,
            lastErrorCode: code,
          },
        }),
      );
      await this.enqueue(job.tenantId, job.id, attempts, delay).catch(() => undefined);
      return;
    }
    await this.db.tx(job.tenantId, async (tx) => {
      const current = await tx.privacyRequest.findUniqueOrThrow({ where: { id: request.id } });
      const failed = await tx.privacyRequest.update({
        where: { id: request.id },
        data: {
          state: 'failed',
          report: {
            ...(current.report as object),
            state: 'failed',
            error_code: code,
            failed_targets: incomplete ? (err as ErasureIncomplete).targets : ['worker'],
          } as Prisma.InputJsonValue,
        },
      });
      await tx.job.update({
        where: { id: job.id },
        data: { state: 'failed', leaseUntil: null, lastErrorCode: code },
      });
      await this.audit.inTx(
        tx,
        { tenantId: job.tenantId, ...SYSTEM },
        {
          action: 'privacy.request_failed',
          objectType: 'privacy_request',
          objectId: request.id,
          outcome: 'failure',
          safeDiff: { kind: request.kind, error: code },
        },
      );
      await emitPrivacyUpdated(this.outbox, tx, failed, this.membershipOf(job));
    });
  }
}
