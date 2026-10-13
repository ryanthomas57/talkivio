import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantDb } from '../../db/tenant-db';
import { RedisService } from '../../common/redis.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { EventConsumers } from '../../outbox/event-consumers';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService, VISITOR_NS } from '../../realtime/realtime.service';
import { WorkerService } from '../../worker/worker.service';
import { ChatStore, queueScopeId } from '../chats/chat.store';
import { RoutingService } from '../chats/routing.service';

export const QUEUE_MAX_WAIT_TIMER = 'queue-max-wait';
const REEMIT_SECONDS = 120;
const FRAME_TTL_MS = 5 * 60_000;
const SWEEP_LIMIT = 200;

type CheckResult =
  | { kind: 'pending'; dueAt: number }
  | { kind: 'exceeded'; notify: boolean; waitedSeconds: number; thresholdSeconds: number; departmentId: string | null; fallbackTo: string | null; fallbackLabel: string | null };

/**
 * Queue overflow (ch. 23/31, ROUTE04). When a request has waited longer than its
 * department's `max_wait_seconds` (or the tenant's `chat.offerOfflineAfterSeconds`
 * for requests without a department), the visitor is offered the choice to keep
 * waiting or leave an offline message (`queue.wait_exceeded`, ephemeral, public
 * chat room) — the chat is never closed silently. A configured department
 * fallback is applied ONCE per chat (visited departments recorded in
 * assignment_history, no loops, `requested_at` unchanged) and the wait for the
 * new department starts at the fallback. Durable delayed timers drive it; a
 * one-minute sweep covers lost timers and routing changes made elsewhere.
 */
@Injectable()
export class QueueOverflowService implements OnModuleInit {
  private readonly logger = new Logger('QueueOverflow');

  constructor(
    private readonly db: TenantDb,
    private readonly store: ChatStore,
    private readonly routing: RoutingService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
    private readonly worker: WorkerService,
    private readonly consumers: EventConsumers,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.consumers.on('chat.requested', 'offline.queue-max-wait', async (e) => {
      await this.check(e.tenantId, e.aggregateId);
    });
    this.worker.onTimer(async (name, data) => {
      if (name !== QUEUE_MAX_WAIT_TIMER) return false;
      await this.check(data.tenantId, String(data.chatId));
      return true;
    });
    this.worker.onMaintenance('queue-overflow', () => this.sweep());
  }

  private async arm(tenantId: string, chatId: string, dueAt: number): Promise<void> {
    await this.queues.add(QUEUES.timers, QUEUE_MAX_WAIT_TIMER, { tenantId, chatId }, { jobId: `qwait-${chatId}-${dueAt}`, delay: Math.max(0, dueAt - Date.now()) + 250, removeOnComplete: true, removeOnFail: 100 });
  }

  /** Evaluate one chat; idempotent (markers in assignment_history) and safe to call at any time. */
  async check(tenantId: string, chatId: string, opts: { reemit?: boolean } = {}): Promise<CheckResult | null> {
    const now = Date.now();
    const result = await this.db.tx(tenantId, async (tx): Promise<CheckResult | null> => {
      const exists = await tx.chat.findFirst({ where: { tenantId, id: chatId }, select: { id: true } });
      if (!exists) return null;
      const chat = await this.store.lockChat(tx, tenantId, chatId);
      if (chat.isPreview || (chat.status !== 'queued' && chat.status !== 'offered') || chat.ownerMembershipId || chat.firstAssignedAt) return null;
      const settings = await this.store.settings(tx, tenantId);
      const dept = chat.departmentId ? await tx.department.findFirst({ where: { tenantId, id: chat.departmentId } }) : null;
      const threshold = dept ? dept.maxWaitSeconds : settings.chat.offerOfflineAfterSeconds;
      if (!threshold || threshold <= 0) return null;
      const history = await tx.assignmentHistory.findMany({ where: { tenantId, chatId, reason: { in: ['max_wait_exceeded', 'max_wait_fallback'] } }, orderBy: { occurredAt: 'asc' } });
      const fallbacks = history.filter((h) => h.reason === 'max_wait_fallback');
      const since = fallbacks.length ? fallbacks[fallbacks.length - 1].occurredAt : chat.requestedAt;
      const dueAt = since.getTime() + threshold * 1000;
      if (now < dueAt) return { kind: 'pending', dueAt };

      const waitedSeconds = Math.floor((now - chat.requestedAt.getTime()) / 1000);
      const departmentId = chat.departmentId;
      const notified = history.some((h) => h.reason === 'max_wait_exceeded' && h.occurredAt >= since && (h.previousDepartmentId ?? null) === departmentId);
      if (!notified) {
        await tx.assignmentHistory.create({
          data: { tenantId, chatId, reason: 'max_wait_exceeded', previousDepartmentId: departmentId, nextDepartmentId: departmentId, decision: { waitedSeconds, thresholdSeconds: threshold, options: ['continue', 'offline_form'] } },
        });
      }

      // Department fallback: once per chat, never into a department already visited.
      let fallbackTo: string | null = null;
      let fallbackLabel: string | null = null;
      if (!fallbacks.length && dept?.fallbackDepartmentId && chat.status === 'queued') {
        const visited = new Set([chat.acquisitionDepartmentId, chat.departmentId].filter((x): x is string => !!x));
        const moved = await tx.assignmentHistory.findMany({ where: { tenantId, chatId }, select: { previousDepartmentId: true, nextDepartmentId: true } });
        for (const h of moved) for (const d of [h.previousDepartmentId, h.nextDepartmentId]) if (d) visited.add(d);
        const target = await tx.department.findFirst({ where: { tenantId, id: dept.fallbackDepartmentId, enabled: true, archivedAt: null } });
        if (target && !visited.has(target.id)) {
          visited.add(target.id);
          await this.store.bumpVersion(tx, chat, { departmentId: target.id, routeReason: 'max_wait_fallback' });
          await tx.assignmentHistory.create({
            data: { tenantId, chatId, reason: 'max_wait_fallback', previousDepartmentId: departmentId, nextDepartmentId: target.id, decision: { visited: [...visited], waitedSeconds, thresholdSeconds: threshold } },
          });
          fallbackLabel = target.publicLabel || target.name;
          await this.store.systemEvent(tx, chat, 'chat.transferred', `You're being transferred to ${fallbackLabel}`, { departmentId: target.id, reason: 'max_wait_fallback' }, settings, { variant: 'department', department: fallbackLabel });
          await this.store.outboxService().append(tx, tenantId, {
            aggregateType: 'chat',
            aggregateId: chatId,
            aggregateVersion: chat.version,
            eventType: 'chat.transferred',
            payload: { chatId, previousOwner: null, nextOwner: null, departmentId: target.id, previousDepartmentId: departmentId, reason: 'max_wait_fallback', version: chat.version },
            scopes: [
              { kind: 'chat', id: chatId, audience: 'staff' },
              { kind: 'queue', id: queueScopeId(departmentId), audience: 'staff' },
              { kind: 'queue', id: queueScopeId(target.id), audience: 'staff' },
              { kind: 'chat', id: chatId, audience: 'public', payload: { chatId, nextOwner: null, version: chat.version } },
            ],
          });
          await this.store.emitChatUpdated(tx, chat);
          fallbackTo = target.id;
        }
      }
      return { kind: 'exceeded', notify: !notified, waitedSeconds, thresholdSeconds: threshold, departmentId, fallbackTo, fallbackLabel };
    });

    if (!result) return null;
    if (result.kind === 'pending') {
      await this.arm(tenantId, chatId, result.dueAt);
      return result;
    }
    const throttle = `qwait:reemit:${chatId}`;
    const emit = result.notify ? (await this.redis.client.set(throttle, '1', 'EX', REEMIT_SECONDS), true) : !!opts.reemit && (await this.redis.client.set(throttle, '1', 'EX', REEMIT_SECONDS, 'NX')) === 'OK';
    if (emit) {
      const payload = { chatId, options: ['continue', 'offline_form'], waitedSeconds: result.waitedSeconds, departmentId: result.fallbackTo ?? result.departmentId, fallbackDepartmentId: result.fallbackTo, fallbackLabel: result.fallbackLabel };
      this.realtime.ephemeral(VISITOR_NS, roomFor(tenantId, 'chat', chatId, 'public'), 'queue.wait_exceeded', { kind: 'chat', id: chatId }, payload, FRAME_TTL_MS);
      this.realtime.ephemeral(AGENT_NS, [roomFor(tenantId, 'queue', queueScopeId(result.departmentId), 'staff'), roomFor(tenantId, 'chat', chatId, 'staff')], 'queue.wait_exceeded', { kind: 'chat', id: chatId }, { ...payload, thresholdSeconds: result.thresholdSeconds }, FRAME_TTL_MS);
    }
    if (result.fallbackTo) {
      await this.routing.route(tenantId, chatId).catch((err) => this.logger.warn(`fallback route ${chatId} failed: ${(err as Error).message}`));
      await this.check(tenantId, chatId); // arms the timer for the fallback department's own wait
    }
    return result;
  }

  /** Backup pass: chats that may have crossed a threshold (lost timers, routing changes). */
  async sweep(): Promise<void> {
    for (const tenantId of await this.db.activeTenantIds()) {
      try {
        const candidates = await this.db.read(tenantId, async (tx) => {
          const [tenant, depts] = await Promise.all([
            this.store.settings(tx, tenantId),
            tx.department.findMany({ where: { tenantId, maxWaitSeconds: { gt: 0 } }, select: { maxWaitSeconds: true } }),
          ]);
          const thresholds = [...depts.map((d) => d.maxWaitSeconds), ...(tenant.chat.offerOfflineAfterSeconds > 0 ? [tenant.chat.offerOfflineAfterSeconds] : [])];
          if (!thresholds.length) return [];
          const min = Math.min(...thresholds);
          return tx.chat.findMany({
            where: { tenantId, status: { in: ['queued', 'offered'] }, isPreview: false, ownerMembershipId: null, firstAssignedAt: null, requestedAt: { lte: new Date(Date.now() - min * 1000) } },
            orderBy: { requestedAt: 'asc' },
            take: SWEEP_LIMIT,
            select: { id: true },
          });
        });
        for (const c of candidates) await this.check(tenantId, c.id, { reemit: true }).catch((err) => this.logger.warn(`max-wait check ${c.id} failed: ${(err as Error).message}`));
      } catch (err) {
        this.logger.warn(`queue overflow sweep for ${tenantId} failed: ${(err as Error).message}`);
      }
    }
  }
}
