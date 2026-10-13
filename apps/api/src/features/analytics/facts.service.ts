import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantDb } from '../../db/tenant-db';
import { RedisService } from '../../common/redis.service';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { WorkerService } from '../../worker/worker.service';
import { deriveFact } from './facts';
import { FactLoader } from './fact-loader';

/** Domain events after which a chat's fact is recomputed from source rows. */
export const FACT_EVENTS = [
  'chat.requested',
  'chat.updated',
  'assignment.accepted',
  'chat.transferred',
  'message.created',
  'chat.closed',
  'rating.updated',
  'participant.joined',
  'participant.left',
] as const;

const BATCH = 500;
const RECENT_DAYS = 35;
const backfillKey = (tenantId: string) => `rd:analytics:facts-backfill:${tenantId}`;

/** Chat id from an internal event (payloads are stored in wire format). */
export function chatIdOf(e: InternalEvent): string | null {
  const p = e.payload ?? {};
  const direct = p['chat_id'];
  if (typeof direct === 'string') return direct;
  const chat = p['chat'] as Record<string, unknown> | undefined;
  if (chat && typeof chat['id'] === 'string') return chat['id'];
  return e.aggregateType === 'chat' ? e.aggregateId : null;
}

/**
 * Maintains `metric_chat_facts` (ch. 50/51): an idempotent outbox consumer
 * recomputes the chat's fact from source rows in one repeatable-read snapshot
 * and writes it only when its source version is greater than the stored one, so
 * at-least-once and out-of-order deliveries converge on the latest state, and a
 * late rating or transfer revises the fact exactly once. A maintenance job
 * reconciles anything a lost event left behind and backfills history.
 */
@Injectable()
export class FactsService implements OnModuleInit {
  private readonly logger = new Logger('AnalyticsFacts');

  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly consumers: EventConsumers,
    private readonly worker: WorkerService,
    private readonly loader: FactLoader,
  ) {}

  onModuleInit(): void {
    for (const type of FACT_EVENTS) {
      this.consumers.on(type, `analytics.facts:${type}`, async (e) => {
        const chatId = chatIdOf(e);
        if (chatId) await this.recompute(e.tenantId, chatId);
      });
    }
    this.worker.onMaintenance('analytics-facts', () => this.reconcileAll());
  }

  /**
   * Recompute one chat's fact. Recomputes of the same chat are serialized with a
   * transaction-scoped advisory lock. The chat row (which carries the source
   * version) is read before its messages/rating/history, so stored content is
   * never older than its version; any later change bumps the version and
   * triggers another recompute, and the conditional upsert never regresses.
   */
  async recompute(tenantId: string, chatId: string): Promise<'written' | 'unchanged' | 'missing' | 'preview'> {
    return this.db.tx(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rd:fact:${tenantId}:${chatId}`}, 0))`;
      const [input] = await this.loader.inputs(tx, tenantId, [chatId]);
      if (!input) return 'missing' as const;
      if (input.chat.isPreview) {
        await tx.metricChatFact.deleteMany({ where: { tenantId, chatId } });
        return 'preview' as const;
      }
      return (await this.loader.upsert(tx, tenantId, deriveFact(input))) ? ('written' as const) : ('unchanged' as const);
    });
  }

  /** Chats whose fact is missing or older than the chat's current source version. */
  private async staleChatIds(tenantId: string, opts: { recentDays?: number; after?: { at: Date; id: string } }): Promise<Array<{ id: string; requested_at: Date; stale: boolean }>> {
    return this.db.read(tenantId, (tx) =>
      opts.after
        ? tx.$queryRaw<Array<{ id: string; requested_at: Date; stale: boolean }>>`
            SELECT c.id, c.requested_at, (f.chat_id IS NULL OR f.source_version < c.version + c.next_seq) AS stale
              FROM chats c LEFT JOIN metric_chat_facts f ON f.tenant_id = c.tenant_id AND f.chat_id = c.id
             WHERE c.tenant_id = ${tenantId}::uuid AND c.is_preview = false
               AND (c.requested_at, c.id) > (${opts.after.at.toISOString()}::timestamptz, ${opts.after.id}::uuid)
             ORDER BY c.requested_at, c.id
             LIMIT ${BATCH}`
        : tx.$queryRaw<Array<{ id: string; requested_at: Date; stale: boolean }>>`
            SELECT c.id, c.requested_at, true AS stale
              FROM chats c LEFT JOIN metric_chat_facts f ON f.tenant_id = c.tenant_id AND f.chat_id = c.id
             WHERE c.tenant_id = ${tenantId}::uuid AND c.is_preview = false
               AND c.requested_at > now() - make_interval(days => ${opts.recentDays ?? RECENT_DAYS}::int)
               AND c.updated_at < now() - interval '5 seconds'
               AND (f.chat_id IS NULL OR f.source_version < c.version + c.next_seq)
             ORDER BY c.updated_at
             LIMIT ${BATCH}`,
    );
  }

  async reconcileTenant(tenantId: string): Promise<{ recent: number; backfilled: number }> {
    let recent = 0;
    for (const c of await this.staleChatIds(tenantId, {})) {
      if ((await this.recompute(tenantId, c.id)) === 'written') recent++;
    }
    let backfilled = 0;
    const cursorRaw = await this.redis.client.get(backfillKey(tenantId));
    if (cursorRaw !== 'done') {
      const cursor = cursorRaw ? (JSON.parse(cursorRaw) as { at: string; id: string }) : { at: '1970-01-01T00:00:00.000Z', id: '00000000-0000-0000-0000-000000000000' };
      const rows = await this.staleChatIds(tenantId, { after: { at: new Date(cursor.at), id: cursor.id } });
      for (const r of rows) if (r.stale && (await this.recompute(tenantId, r.id)) === 'written') backfilled++;
      const last = rows[rows.length - 1];
      if (rows.length < BATCH) await this.redis.client.set(backfillKey(tenantId), 'done', 'EX', 7 * 86400);
      else if (last) await this.redis.client.set(backfillKey(tenantId), JSON.stringify({ at: last.requested_at.toISOString(), id: last.id }), 'EX', 30 * 86400);
    }
    return { recent, backfilled };
  }

  async reconcileAll(): Promise<void> {
    for (const tenantId of await this.db.activeTenantIds()) {
      try {
        const r = await this.reconcileTenant(tenantId);
        if (r.recent || r.backfilled) this.logger.log(`Reconciled facts for ${tenantId}: ${r.recent} recent, ${r.backfilled} backfilled`);
      } catch (err) {
        this.logger.warn(`Fact reconciliation failed for ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}
