import { TeamService } from '../features/workspace/team.service';
import { MetricsService } from '../core/metrics.service';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { TenantDb } from '../db/tenant-db';
import { RedisService } from '../common/redis.service';
import { reportError } from '../common/http';
import { MailService } from '../core/mail.service';
import { PresenceService } from '../core/presence.service';
import { QueueService, QUEUES } from '../core/queue.service';
import { EventConsumers } from '../outbox/event-consumers';
import { OutboxPublisher, type InternalEvent } from '../outbox/outbox.publisher';
import { ChatCommandsService } from '../features/chats/chat-commands.service';
import { RoutingService } from '../features/chats/routing.service';
import { AvailabilityBroadcaster } from '../features/availability/availability.broadcaster';

type TimerJob = { tenantId: string; offerId?: string; chatId?: string } & Record<string, unknown>;
export type TimerHandler = (name: string, data: TimerJob) => Promise<boolean>;

/** Repeatable maintenance (BullMQ job schedulers execute once per tick across the cluster). */
const SCHEDULES: Array<{ id: string; every: number }> = [
  { id: 'presence-sweep', every: 5_000 },
  { id: 'offer-sweep', every: 10_000 },
  { id: 'availability', every: 60_000 },
  { id: 'interval-reconcile', every: 60_000 },
  { id: 'queue-drain', every: 30_000 },
  { id: 'purge', every: 3600_000 },
];

/**
 * Worker process: outbox publisher, internal event consumers, durable timers,
 * email delivery and maintenance. All durable effects are keyed in PostgreSQL.
 */
@Injectable()
export class WorkerService implements OnModuleDestroy {
  private readonly logger = new Logger('Worker');
  private workers: Worker[] = [];
  private schedulerTimer: NodeJS.Timeout | null = null;
  private readonly timerHandlers: TimerHandler[] = [];
  private readonly maintenanceHandlers = new Map<string, () => Promise<void>>();
  private readonly maintenanceEvery = new Map<string, number>();

  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly mail: MailService,
    private readonly presence: PresenceService,
    private readonly publisher: OutboxPublisher,
    private readonly consumers: EventConsumers,
    private readonly chats: ChatCommandsService,
    private readonly routing: RoutingService,
    private readonly broadcaster: AvailabilityBroadcaster,
    private readonly metrics: MetricsService,
    private readonly team: TeamService,
  ) {}

  /** Feature modules can add timer job handlers (return true when handled). */
  onTimer(handler: TimerHandler): void {
    this.timerHandlers.push(handler);
  }

  /** Feature maintenance, run once per `everyMs` across the cluster (default once a minute). */
  onMaintenance(id: string, fn: () => Promise<void>, everyMs = 60_000): void {
    this.maintenanceHandlers.set(id, fn);
    this.maintenanceEvery.set(id, everyMs);
  }

  async start(): Promise<void> {
    const make = <T>(name: string, concurrency: number, fn: (job: Job<T>) => Promise<void>) => {
      const timed = async (job: Job<T>) => {
        const started = process.hrtime.bigint();
        try {
          await fn(job);
        } finally {
          this.metrics.jobDuration.observe(
            this.metrics.labels({ queue: name }),
            Number(process.hrtime.bigint() - started) / 1e9,
          );
        }
      };
      const w = new Worker<T>(name, timed, {
        connection: this.redis.create(`worker:${name}`, { forBullMQ: true }),
        prefix: 'rd',
        concurrency,
      });
      w.on('failed', (job, err) => {
        this.metrics.jobFailures.inc(this.metrics.labels({ queue: name }));
        this.logger.warn(`${name}/${job?.name} failed (attempt ${job?.attemptsMade}): ${err.message}`);
        if (name !== QUEUES.webhooks) reportError(err);
      });
      w.on('error', (err) => this.logger.error(`${name} worker error: ${err.message}`));
      this.workers.push(w);
    };
    make<InternalEvent>(QUEUES.events, 8, (job) => this.consumers.dispatch(job.data));
    make<{ emailId: string }>(QUEUES.email, 5, (job) =>
      this.mail.deliver(job.data.emailId, { finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }),
    );
    make<TimerJob>(QUEUES.timers, 10, (job) => this.timer(job.name, job.data));
    make<Record<string, never>>(QUEUES.maintenance, 1, (job) => this.maintenance(job.name));

    await this.ensureSchedulers();
    // Schedulers live in Redis: re-assert them so maintenance resumes after a Redis restart or failover
    // without restarting the worker (upserts are idempotent).
    this.schedulerTimer = setInterval(
      () =>
        void this.ensureSchedulers().catch((err) =>
          this.logger.warn(`scheduler upsert failed: ${(err as Error).message}`),
        ),
      60_000,
    );
    this.schedulerTimer.unref();
    await this.publisher.start();
    this.logger.log(`Worker started: ${this.workers.length} queues, outbox publisher running`);
  }

  private async ensureSchedulers(): Promise<void> {
    const q = this.queues.queue(QUEUES.maintenance);
    for (const s of SCHEDULES)
      await q.upsertJobScheduler(
        s.id,
        { every: s.every },
        { name: s.id, data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
      );
    for (const id of this.maintenanceHandlers.keys()) {
      if (!SCHEDULES.some((s) => s.id === id))
        await q.upsertJobScheduler(
          id,
          { every: this.maintenanceEvery.get(id) ?? 60_000 },
          { name: id, data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
        );
    }
  }

  /** Graceful drain: release the outbox lease, stop taking jobs and let active ones finish (DB/Redis still up). */
  async stop(): Promise<void> {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    await this.publisher.onModuleDestroy();
    await Promise.allSettled(this.workers.map((w) => w.close()));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
  }

  private async timer(name: string, data: TimerJob): Promise<void> {
    switch (name) {
      case 'offer-expiry':
        return this.routing.expireOffer(data.tenantId, String(data.offerId));
      case 'visitor-grace':
        return this.chats.graceExpired(data.tenantId, String(data.chatId));
    }
    for (const h of this.timerHandlers) if (await h(name, data)) return;
    this.logger.warn(`Unhandled timer ${name}`);
  }

  private async maintenance(name: string): Promise<void> {
    const custom = this.maintenanceHandlers.get(name);
    if (custom) return custom();
    switch (name) {
      case 'presence-sweep':
        await this.presence.sweepVisitors();
        await this.presence.sweepAgents();
        return;
      case 'offer-sweep':
        // Backup for lost timer jobs (e.g. Redis restart): expire overdue offers per tenant.
        for (const tenantId of await this.db.activeTenantIds()) {
          const due = await this.db.read(tenantId, (tx) =>
            tx.assignmentOffer.findMany({
              where: { tenantId, status: 'pending', expiresAt: { lt: new Date() } },
              select: { id: true },
              take: 200,
            }),
          );
          for (const o of due) await this.routing.expireOffer(tenantId, o.id).catch(() => undefined);
        }
        return;
      case 'availability':
        for (const tenantId of await this.db.activeTenantIds())
          await this.broadcaster.refresh(tenantId).catch(() => undefined);
        return;
      case 'interval-reconcile':
        for (const tenantId of await this.db.activeTenantIds())
          await this.team.reconcileIntervals(tenantId).catch(() => undefined);
        return;
      case 'queue-drain':
        for (const tenantId of await this.presence.agentTenants())
          await this.routing.drainQueue(tenantId, 50).catch(() => undefined);
        return;
      case 'purge': {
        const purged = await this.db.root.$queryRaw<
          Array<{ rd_purge_outbox: bigint }>
        >`SELECT rd_purge_outbox(interval '24 hours')`;
        for (const tenantId of await this.db.activeTenantIds()) {
          await this.db.tx(tenantId, (tx) =>
            tx.commandIdempotency.deleteMany({ where: { tenantId, expiresAt: { lt: new Date() } } }),
          );
        }
        await this.db.root.authToken.deleteMany({
          where: { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
        });
        await this.db.root.authSession.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: new Date() } },
              { revokedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
            ],
          },
        });
        this.logger.log(`Purged ${purged[0]?.rd_purge_outbox ?? 0} outbox rows`);
        return;
      }
    }
  }
}
