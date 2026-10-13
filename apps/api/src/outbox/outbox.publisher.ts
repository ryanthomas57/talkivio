import { MetricsService } from '../core/metrics.service';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { TenantDb } from '../db/tenant-db';
import { RedisService } from '../common/redis.service';
import { QueueService, QUEUES } from '../core/queue.service';
import { AGENT_NS, RealtimeService, VISITOR_NS, type DurableFrame } from '../realtime/realtime.service';
import { encodeEventCursor, OUTBOX_NUDGE_CHANNEL, roomFor, type Audience, type ScopeKind } from './outbox.service';
import { inSpan, inSpanSync, type SpanAttributes } from '../common/tracing';

interface ClaimedRow {
  seq: bigint;
  event_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  scope_kind: string;
  scope_id: string;
  audience: string;
  payload: unknown;
  causation_id: string | null;
  occurred_at: Date;
  attempt_count: number;
  trace_parent: string | null;
}

export { OUTBOX_NUDGE_CHANNEL };
const LEADER_KEY = 'rd:outbox:leader';
const LEASE_MS = 10_000;

/** Internal consumers notified for each committed domain event (tenant scope rows). */
export interface InternalEvent {
  eventId: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
  causationId: string | null;
  occurredAt: string;
}

/**
 * Leased outbox publisher (worker process). One leader at a time (Redis lease);
 * rows are claimed in sequence order through a SECURITY DEFINER function (a durable
 * per-row lease in PostgreSQL), emitted to socket rooms, and marked published.
 * Uncommitted work is never visible; a crash after commit is recovered on the next
 * claim (at-least-once delivery). Rows whose emit or dispatch fails are deferred
 * individually with backoff, so they never hold the rest of their batch back.
 */
@Injectable()
export class OutboxPublisher implements OnModuleDestroy {
  private readonly logger = new Logger('OutboxPublisher');
  private readonly instanceId = randomUUID();
  private running = false;
  private wake: (() => void) | null = null;
  private sub: Redis | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private isLeader = false;

  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.sub = this.redis.create('outbox-sub');
    await this.sub.subscribe(OUTBOX_NUDGE_CHANNEL);
    this.sub.on('message', () => this.wake?.());
    this.leaseTimer = setInterval(() => void this.renewLease(), 3000);
    await this.renewLease();
    void this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.isLeader) await this.redis.client.del(LEADER_KEY).catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
  }

  private async renewLease(): Promise<void> {
    try {
      const r = this.redis.client;
      const current = await r.get(LEADER_KEY);
      if (current === this.instanceId) {
        await r.pexpire(LEADER_KEY, LEASE_MS);
        this.isLeader = true;
      } else {
        this.isLeader = (await r.set(LEADER_KEY, this.instanceId, 'PX', LEASE_MS, 'NX')) === 'OK';
      }
    } catch {
      this.isLeader = false;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let published = 0;
      if (this.isLeader) {
        try {
          published = await this.publishBatch();
        } catch (err) {
          this.logger.error(`Publish batch failed: ${(err as Error).message}`);
        }
      }
      if (published === 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 250);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  async publishBatch(limit = 200): Promise<number> {
    let mark = process.hrtime.bigint();
    const stage = (name: string) => {
      const now = process.hrtime.bigint();
      this.metrics.outboxStage.observe(this.metrics.labels({ stage: name }), Number(now - mark) / 1e9);
      mark = now;
    };
    const rows = await this.db.root.$queryRaw<ClaimedRow[]>`SELECT * FROM rd_claim_outbox(${limit}::int, 30::int)`;
    if (!rows.length) return 0;
    stage('claim');
    this.metrics.outboxBatchRows.observe(this.metrics.labels(), rows.length);
    rows.sort((a, b) => (a.seq < b.seq ? -1 : 1));
    // Socket frames go out first (synchronous emits, in sequence order); internal consumers are queued in one
    // BullMQ round trip afterwards. Rows are marked published only after both, so a crash still redelivers.
    const internal: ClaimedRow[] = [];
    const done: ClaimedRow[] = [];
    const failed: ClaimedRow[] = [];
    for (const row of rows) {
      if (row.audience === 'internal') {
        internal.push(row);
        continue;
      }
      try {
        // Continues the trace of the request that wrote the event (commit → socket fan-out).
        inSpanSync(`outbox.publish ${row.event_type}`, row.trace_parent, this.spanAttributes(row), () => this.emit(row));
        done.push(row);
      } catch (err) {
        failed.push(row);
        this.logger.error(`Outbox emit failed for ${row.event_type} #${row.seq}: ${(err as Error).message}`);
      }
    }
    stage('emit');
    if (internal.length) {
      try {
        await this.dispatchInternal(internal);
        done.push(...internal);
      } catch (err) {
        failed.push(...internal);
        this.logger.warn(`Outbox dispatch of ${internal.length} internal events failed: ${(err as Error).message}`);
      }
    }
    stage('dispatch');
    if (done.length) await this.db.root.$executeRaw`SELECT rd_mark_outbox_published(${done.map((r) => r.seq)}::bigint[])`;
    if (failed.length) await this.defer(failed);
    stage('mark');
    return done.length;
  }

  private emit(row: ClaimedRow): void {
    const frame: DurableFrame = {
      v: 1,
      event_id: row.event_id,
      type: row.event_type,
      tenant_id: row.tenant_id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      cursor: encodeEventCursor(row.seq),
      occurred_at: row.occurred_at.toISOString(),
      aggregate_version: row.aggregate_version,
      causation_id: row.causation_id,
      payload: row.payload,
    };
    const ns = row.audience === 'public' ? VISITOR_NS : AGENT_NS;
    this.realtime.durable(ns, roomFor(row.tenant_id, row.scope_kind as ScopeKind, row.scope_id, row.audience as Audience), frame);
    if (row.event_type === 'message.created') this.metrics.messageDelivery.observe({ audience: row.audience }, (Date.now() - row.occurred_at.getTime()) / 1000);
  }

  /** Retry failed rows after 1 s, 2 s, 4 s … (capped at 60 s; the claim counts attempts) instead of the 30 s lease. */
  private async defer(rows: ClaimedRow[]): Promise<void> {
    const seconds = Math.min(60, 2 ** Math.max(0, Math.max(...rows.map((r) => r.attempt_count)) - 1));
    await this.db.root.$executeRaw`SELECT rd_defer_outbox(${rows.map((r) => r.seq)}::bigint[], ${seconds}::int)`;
    this.metrics.outboxDeferred.inc(this.metrics.labels(), rows.length);
  }

  /** Identifiers, types and timing only (no payload). */
  private spanAttributes(row: ClaimedRow): SpanAttributes {
    return {
      'messaging.system': 'talkivio.outbox',
      'messaging.operation': 'publish',
      'talkivio.event_type': row.event_type,
      'talkivio.event_id': row.event_id,
      'talkivio.tenant_id': row.tenant_id,
      'talkivio.scope_kind': row.scope_kind,
      'talkivio.audience': row.audience,
      'talkivio.outbox.seq': Number(row.seq),
      'talkivio.outbox.attempt': row.attempt_count,
      'talkivio.outbox.lag_ms': Date.now() - row.occurred_at.getTime(),
    };
  }

  private async dispatchInternal(rows: ClaimedRow[]): Promise<void> {
    // One queue round trip for the batch: its span joins the first event's trace and links every other one.
    const [first, ...rest] = rows;
    await inSpan(
      'outbox.dispatch internal',
      first?.trace_parent ?? null,
      { 'messaging.system': 'talkivio.outbox', 'messaging.operation': 'dispatch', 'messaging.batch.message_count': rows.length },
      () => this.enqueueInternal(rows),
      rest.map((r) => r.trace_parent),
    );
  }

  private async enqueueInternal(rows: ClaimedRow[]): Promise<void> {
    await this.queues.queue(QUEUES.events).addBulk(rows.map((row) => ({ name: row.event_type, data: this.internalEvent(row), opts: { jobId: `ev-${row.event_id}`, attempts: 8, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: { age: 24 * 3600, count: 5000 } } })));
  }

  private internalEvent(row: ClaimedRow): InternalEvent {
    return {
      eventId: row.event_id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      payload: row.payload as Record<string, unknown>,
      causationId: row.causation_id,
      occurredAt: row.occurred_at.toISOString(),
    };
  }
}
