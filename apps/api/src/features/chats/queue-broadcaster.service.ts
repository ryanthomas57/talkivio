import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TenantDb } from '../../db/tenant-db';
import { EventConsumers } from '../../outbox/event-consumers';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService } from '../../realtime/realtime.service';
import { queueScopeId } from './chat.store';

/** Committed events after which a department's waiting count or oldest request may differ. */
const QUEUE_EVENTS = ['chat.requested', 'chat.queued', 'assignment.accepted', 'chat.closed', 'chat.transferred'] as const;
const COALESCE_MS = 500;

/**
 * `queue.updated` (ch. 48, coalesced): {department_id, waiting_count, oldest_requested_at, as_of}
 * on each department's queue scope, so subscribers only ever see their own department's counts.
 * Runs as an event consumer in the worker; recomputes a tenant's queues at most every
 * COALESCE_MS and emits only departments whose snapshot changed (including drops to zero).
 */
@Injectable()
export class QueueBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueueBroadcaster');
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** tenant → queue scope id → last emitted signature (non-empty queues only). */
  private readonly last = new Map<string, Map<string, string>>();

  constructor(
    private readonly db: TenantDb,
    private readonly realtime: RealtimeService,
    private readonly consumers: EventConsumers,
  ) {}

  onModuleInit(): void {
    for (const type of QUEUE_EVENTS) this.consumers.on(type, `queue.updated.${type}`, async (e) => this.schedule(e.tenantId));
  }

  onModuleDestroy(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  schedule(tenantId: string): void {
    if (this.pending.has(tenantId)) return;
    const t = setTimeout(() => {
      this.pending.delete(tenantId);
      void this.flush(tenantId).catch((err) => this.logger.warn(`queue.updated for ${tenantId} failed: ${(err as Error).message}`));
    }, COALESCE_MS);
    t.unref();
    this.pending.set(tenantId, t);
  }

  async flush(tenantId: string): Promise<number> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx.chat.groupBy({
        by: ['departmentId'],
        where: { tenantId, status: { in: ['queued', 'offered'] }, isPreview: false },
        _count: { _all: true },
        _min: { requestedAt: true },
      }),
    );
    const now = new Map(rows.map((r) => [queueScopeId(r.departmentId), { count: r._count._all, oldest: r._min.requestedAt }]));
    const prev = this.last.get(tenantId) ?? new Map<string, string>();
    const next = new Map<string, string>();
    const asOf = new Date();
    let emitted = 0;
    for (const id of new Set([...now.keys(), ...prev.keys()])) {
      const v = now.get(id) ?? { count: 0, oldest: null };
      const sig = `${v.count}|${v.oldest?.toISOString() ?? ''}`;
      if (v.count > 0) next.set(id, sig);
      if (prev.get(id) === sig) continue;
      this.realtime.ephemeral(
        AGENT_NS,
        roomFor(tenantId, 'queue', id, 'staff'),
        'queue.updated',
        { kind: 'queue', id },
        { departmentId: id === 'none' ? null : id, waitingCount: v.count, oldestRequestedAt: v.oldest, asOf },
        30_000,
      );
      emitted++;
    }
    if (next.size) this.last.set(tenantId, next);
    else this.last.delete(tenantId);
    return emitted;
  }
}
