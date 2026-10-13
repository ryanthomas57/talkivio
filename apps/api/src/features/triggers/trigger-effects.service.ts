import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, TriggerEffect, TriggerRun } from '@prisma/client';
import { validateDslDefinition, type DslAction } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AppError } from '../../common/http';
import { OutboxService } from '../../outbox/outbox.service';
import { ChatCommandsService } from '../chats/chat-commands.service';
import { ChatStore } from '../chats/chat.store';
import { InvitationsService } from './invitations.service';
import type { ResolvedContext } from './trigger-snapshot.service';
import { trackSources } from '../visitors/custom-fields.service';

type Outcome = { status: 'applied' | 'skipped'; reason?: string };

interface RunContext extends ResolvedContext {
  eventId: string;
  eventType: string;
}

/**
 * Executes collected trigger effects exactly once per (run, action_index) (ch. 33).
 * Effects that write through our own transaction (messages, invitations,
 * notifications, webhook jobs, visitor fields/tags) lock the effect row and
 * commit the write together with the status change, so a retry can never send a
 * duplicate greeting. Routing/tag/close commands delegate to the chat engine,
 * whose operations are idempotent, and are marked after completion.
 */
@Injectable()
export class TriggerEffectsService {
  private readonly logger = new Logger('TriggerEffects');

  constructor(
    private readonly db: TenantDb,
    private readonly store: ChatStore,
    private readonly chats: ChatCommandsService,
    private readonly outbox: OutboxService,
    private readonly invitations: InvitationsService,
  ) {}

  /** Execute every pending effect of the given runs in deterministic collected order. */
  async executeRuns(tenantId: string, runIds: string[]): Promise<void> {
    if (!runIds.length) return;
    const { runs, effects, defs } = await this.db.read(tenantId, async (tx) => {
      const runs = await tx.triggerRun.findMany({ where: { tenantId, id: { in: runIds } } });
      const effects = await tx.triggerEffect.findMany({ where: { tenantId, runId: { in: runIds }, status: 'pending' } });
      const revs = runs.length
        ? await tx.triggerRevision.findMany({ where: { tenantId, OR: runs.map((r) => ({ triggerId: r.triggerId, revision: r.triggerRevision })) } })
        : [];
      return { runs, effects, defs: new Map(revs.map((r) => [`${r.triggerId}:${r.revision}`, r.definition])) };
    });
    const runById = new Map(runs.map((r) => [r.id, r]));
    const position = (r: TriggerRun) => Number((r.result as { position?: number } | null)?.position ?? 0);
    effects.sort((a, b) => position(runById.get(a.runId)!) - position(runById.get(b.runId)!) || a.actionIndex - b.actionIndex);

    let transient: unknown = null;
    for (const effect of effects) {
      const run = runById.get(effect.runId)!;
      const parsed = validateDslDefinition(defs.get(`${run.triggerId}:${run.triggerRevision}`));
      const action = parsed.ok ? parsed.definition.actions[effect.actionIndex] : undefined;
      try {
        if (!action || action.type !== effect.actionType) {
          await this.mark(tenantId, effect.id, 'failed', 'definition_unavailable');
          continue;
        }
        await this.execute(tenantId, effect, run, action);
      } catch (err) {
        if (err instanceof AppError && err.getStatus() < 500) {
          // Permanent (validation/state) failure: record it, keep going.
          await this.mark(tenantId, effect.id, 'failed', err.code.toLowerCase());
          await this.db.tx(tenantId, (tx) => tx.trigger.updateMany({ where: { tenantId, id: run.triggerId }, data: { errorCount: { increment: 1 } } }));
          continue;
        }
        this.logger.warn(`Effect ${effect.id} (${effect.actionType}) failed transiently: ${(err as Error).message}`);
        transient ??= err;
      }
    }
    // Leave pending effects for the retry (the job is redelivered at least once).
    if (transient) throw transient;
  }

  private ctx(run: TriggerRun): RunContext {
    const r = (run.result ?? {}) as { context?: Partial<ResolvedContext> };
    return {
      eventId: run.eventId,
      eventType: run.eventType,
      siteId: r.context?.siteId ?? null,
      visitorId: run.visitorId ?? r.context?.visitorId ?? null,
      sessionId: run.visitorSessionId ?? r.context?.sessionId ?? null,
      chatId: run.chatId ?? r.context?.chatId ?? null,
      departmentId: r.context?.departmentId ?? null,
    };
  }

  private async mark(tenantId: string, effectId: string, status: string, reason: string | null): Promise<void> {
    await this.db.tx(tenantId, (tx) =>
      tx.triggerEffect.updateMany({ where: { tenantId, id: effectId, status: 'pending' }, data: { status, reason, executedAt: new Date() } }),
    );
  }

  /** Lock the effect row, run `fn` and record its outcome in the same transaction (exactly once). */
  private async inTx(tenantId: string, effectId: string, fn: (tx: Tx) => Promise<Outcome>): Promise<void> {
    await this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM trigger_effects WHERE tenant_id = ${tenantId}::uuid AND id = ${effectId}::uuid FOR UPDATE`;
      if (!rows.length || rows[0].status !== 'pending') return;
      const out = await fn(tx);
      await tx.triggerEffect.update({ where: { id: effectId }, data: { status: out.status, reason: out.reason ?? null, executedAt: new Date() } });
    });
  }

  /** Delegate to an idempotent chat command, then record the outcome. */
  private async viaCommand(tenantId: string, effectId: string, fn: () => Promise<Outcome>): Promise<void> {
    const cur = await this.db.read(tenantId, (tx) => tx.triggerEffect.findFirst({ where: { tenantId, id: effectId }, select: { status: true } }));
    if (cur?.status !== 'pending') return;
    const out = await fn();
    await this.mark(tenantId, effectId, out.status, out.reason ?? null);
  }

  private async execute(tenantId: string, effect: TriggerEffect, run: TriggerRun, action: DslAction): Promise<void> {
    const c = this.ctx(run);
    switch (action.type) {
      case 'set_department':
      case 'set_priority':
        return this.viaCommand(tenantId, effect.id, async () => {
          if (!c.chatId) return { status: 'skipped', reason: 'no_chat' };
          const chat = await this.db.read(tenantId, (tx) => tx.chat.findFirst({ where: { tenantId, id: c.chatId! }, select: { status: true } }));
          if (!chat) return { status: 'skipped', reason: 'chat_missing' };
          // ch. 32: only before assignment; an active chat is never rerouted by automation.
          if (chat.status !== 'queued' && chat.status !== 'offered') return { status: 'skipped', reason: 'chat_assigned' };
          if (action.type === 'set_department') {
            const dept = await this.db.read(tenantId, (tx) => tx.department.findFirst({ where: { tenantId, id: action.department_id, enabled: true, archivedAt: null }, select: { id: true } }));
            if (!dept) return { status: 'skipped', reason: 'department_unavailable' };
          }
          const r = await this.chats.setRoutingFields(tenantId, c.chatId, action.type === 'set_department' ? { departmentId: action.department_id } : { priority: action.priority }, effect.id);
          return r === 'applied' ? { status: 'applied' } : { status: 'skipped', reason: 'chat_assigned' };
        });

      case 'add_tag':
      case 'remove_tag':
        if (action.target === 'chat') {
          return this.viaCommand(tenantId, effect.id, async () => {
            if (!c.chatId) return { status: 'skipped', reason: 'no_chat' };
            if (action.type === 'add_tag') await this.chats.addTagBySlug(tenantId, c.chatId, action.tag, 'trigger', effect.id);
            else await this.chats.removeTagBySlug(tenantId, c.chatId, action.tag, effect.id);
            return { status: 'applied' };
          });
        }
        return this.inTx(tenantId, effect.id, async (tx) => {
          if (!c.visitorId) return { status: 'skipped', reason: 'no_visitor' };
          const visitor = await tx.visitor.findFirst({ where: { tenantId, id: c.visitorId, erasedAt: null }, select: { id: true } });
          if (!visitor) return { status: 'skipped', reason: 'no_visitor' };
          if (action.type === 'add_tag') {
            const tag = await tx.tag.upsert({ where: { tenantId_slug: { tenantId, slug: action.tag } }, create: { tenantId, slug: action.tag, label: action.tag }, update: {} });
            if (tag.archivedAt) return { status: 'skipped', reason: 'tag_archived' };
            await tx.visitorTag.upsert({
              where: { tenantId_visitorId_tagId: { tenantId, visitorId: visitor.id, tagId: tag.id } },
              create: { tenantId, visitorId: visitor.id, tagId: tag.id, source: 'trigger' },
              update: {},
            });
          } else {
            const tag = await tx.tag.findUnique({ where: { tenantId_slug: { tenantId, slug: action.tag } } });
            if (tag) await tx.visitorTag.deleteMany({ where: { tenantId, visitorId: visitor.id, tagId: tag.id } });
          }
          return { status: 'applied' };
        });

      case 'send_public_message':
        return this.inTx(tenantId, effect.id, async (tx) => {
          if (!c.chatId) return { status: 'skipped', reason: 'no_chat' };
          const exists = await tx.chat.findFirst({ where: { tenantId, id: c.chatId }, select: { id: true } });
          if (!exists) return { status: 'skipped', reason: 'chat_missing' };
          const chat = await this.store.lockChat(tx, tenantId, c.chatId);
          if (chat.status === 'closed') return { status: 'skipped', reason: 'chat_closed' };
          const settings = await this.store.settings(tx, tenantId);
          // Automated system message: plain text, team attribution; never a visitor message event.
          await this.store.appendMessage(
            tx,
            chat,
            { senderType: 'system', senderName: action.attribution, type: 'text', body: action.text, automated: true, causationId: effect.id },
            settings,
          );
          return { status: 'applied' };
        });

      case 'display_invitation':
        return this.inTx(tenantId, effect.id, async (tx) => {
          const r = await this.invitations.offer(tx, { tenantId, campaignId: run.triggerId, siteId: c.siteId, visitorId: c.visitorId, sessionId: c.sessionId, action, effectId: effect.id });
          return { status: r.status, reason: r.reason };
        });

      case 'set_visitor_field':
        return this.inTx(tenantId, effect.id, async (tx) => {
          if (!c.visitorId) return { status: 'skipped', reason: 'no_visitor' };
          const v = await tx.visitor.findFirst({ where: { tenantId, id: c.visitorId, erasedAt: null } });
          if (!v) return { status: 'skipped', reason: 'no_visitor' };
          const def = await tx.customFieldDefinition.findFirst({ where: { tenantId, key: action.key, archivedAt: null } });
          if (!def) return { status: 'skipped', reason: 'field_unavailable' };
          const fields = { ...((v.customFields ?? {}) as Record<string, unknown>) };
          if (action.value === null) delete fields[action.key];
          else fields[action.key] = action.value;
          const sources = trackSources(v.customFieldSources, [action.key], fields, 'trigger', run.triggerId);
          await tx.visitor.update({ where: { id: v.id }, data: { customFields: fields as Prisma.InputJsonValue, customFieldSources: sources as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
          return { status: 'applied' };
        });

      case 'notify_department':
        return this.inTx(tenantId, effect.id, async (tx) => {
          const dept = await tx.department.findFirst({ where: { tenantId, id: action.department_id, archivedAt: null } });
          if (!dept) return { status: 'skipped', reason: 'department_unavailable' };
          // Notifications never consume chat capacity (ch. 32).
          const members = await tx.departmentMember.findMany({
            where: { tenantId, departmentId: dept.id, canServe: true, membership: { enabled: true, archivedAt: null } },
            select: { membershipId: true },
            take: 200,
          });
          const link = c.chatId ? `/inbox/${c.chatId}` : null;
          for (const m of members) {
            const n = await tx.notification.create({ data: { tenantId, membershipId: m.membershipId, type: 'trigger.notify', title: `Automation · ${dept.name}`, body: action.text, link } });
            await this.outbox.append(tx, tenantId, {
              aggregateType: 'notification',
              aggregateId: n.id,
              aggregateVersion: 1,
              eventType: 'notification.created',
              payload: { notification: { id: n.id, type: n.type, title: n.title, body: n.body, link, createdAt: n.createdAt, readAt: null } },
              scopes: [{ kind: 'agent', id: m.membershipId, audience: 'staff' }],
              causationId: effect.id,
            });
          }
          return members.length ? { status: 'applied' } : { status: 'skipped', reason: 'no_members' };
        });

      case 'create_webhook_job':
        return this.inTx(tenantId, effect.id, async (tx) => {
          // Named event only: the integrations worker delivers to configured, SSRF-checked endpoints (no arbitrary target).
          await this.outbox.append(tx, tenantId, {
            aggregateType: 'trigger',
            aggregateId: run.triggerId,
            aggregateVersion: run.triggerRevision,
            eventType: 'trigger.webhook',
            payload: {
              eventName: action.event_name,
              triggerId: run.triggerId,
              triggerRevision: run.triggerRevision,
              sourceEventId: c.eventId,
              sourceEventType: c.eventType,
              siteId: c.siteId,
              chatId: c.chatId,
              visitorId: c.visitorId,
              sessionId: c.sessionId,
              departmentId: c.departmentId,
            },
            scopes: [],
            causationId: effect.id,
          });
          return { status: 'applied' };
        });

      case 'block_admission':
        return this.viaCommand(tenantId, effect.id, async () => {
          if (!c.chatId) return { status: 'skipped', reason: 'no_chat' };
          const r = await this.chats.close({ kind: 'system', tenantId, causationId: effect.id }, c.chatId, { reason: 'blocked_by_trigger' });
          return r.alreadyClosed ? { status: 'skipped', reason: 'chat_closed' } : { status: 'applied' };
        });
    }
  }
}
