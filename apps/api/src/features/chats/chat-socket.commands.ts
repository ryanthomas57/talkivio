import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { badRequest, denied, zodError } from '../../common/http';
import { RealtimeService, AGENT_NS, VISITOR_NS } from '../../realtime/realtime.service';
import { CommandRegistry } from '../../realtime/command-registry';
import { roomFor } from '../../outbox/outbox.service';
import { TenantDb } from '../../db/tenant-db';
import { RateLimitService } from '../../core/rate-limit.service';
import { ChatCommandsService } from './chat-commands.service';
import { RoutingService } from './routing.service';

const uuid = z.string().uuid();

function parse<T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw zodError(r.error);
  return r.data;
}

/**
 * Socket command parity (ch. 77): each command delegates to the REST service.
 * Typing is ephemeral and never persisted; note-mode typing stays on staff rooms.
 */
@Injectable()
export class ChatSocketCommands implements OnModuleInit {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly commands: ChatCommandsService,
    private readonly routing: RoutingService,
    private readonly realtime: RealtimeService,
    private readonly db: TenantDb,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit(): void {
    // ───────── Agent ─────────
    this.registry.registerAgent('message.send', (ctx, cmd) => {
      const p = parse(
        z.object({ chatId: uuid, clientMessageId: z.string().min(1).max(64), visibility: z.enum(['public', 'internal']).default('public'), body: z.string().max(8000).nullable().optional(), attachmentIds: z.array(uuid).max(5).default([]), replyId: uuid.nullable().optional(), options: z.array(z.string().max(60)).max(8).default([]) }),
        cmd.payload,
      );
      return this.commands.agentSend(ctx.auth, p.chatId, p);
    });
    this.registry.registerAgent('message.read', (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, lastReadSeq: z.number().int().min(0) }), cmd.payload);
      return this.commands.readCursor({ auth: ctx.auth }, p.chatId, p.lastReadSeq);
    });
    this.registry.registerAgent('message.delivered', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, lastDeliveredSeq: z.number().int().min(0) }), cmd.payload);
      const r = await this.commands.deliveredCursor({ auth: ctx.auth }, p.chatId, p.lastDeliveredSeq);
      if (r.advanced) {
        // Visitors learn that the team received their messages; staff copies keep other agents in sync.
        // ch. 48 fields {chat_id, participant_id, through_seq, at}; the visitor copy does not identify the agent.
        const frame = { chatId: p.chatId, actorType: 'agent', throughSeq: r.throughSeq, at: new Date() };
        this.realtime.ephemeral(VISITOR_NS, roomFor(ctx.auth.tenantId, 'chat', p.chatId, 'public'), 'message.delivered', { kind: 'chat', id: p.chatId }, { ...frame, participantId: null }, 60_000);
        this.realtime.ephemeral(AGENT_NS, roomFor(ctx.auth.tenantId, 'chat', p.chatId, 'staff'), 'message.delivered', { kind: 'chat', id: p.chatId }, { ...frame, participantId: ctx.auth.membershipId }, 60_000);
      }
      return { lastDeliveredSeq: r.throughSeq };
    });
    this.registry.registerAgent('offer.accept', (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, offerId: uuid.nullable().optional() }), cmd.payload);
      return this.routing.accept(ctx.auth, p.chatId, { offerId: p.offerId, expectedVersion: cmd.expectedVersion ?? null });
    });
    this.registry.registerAgent('offer.decline', (ctx, cmd) => {
      const p = parse(z.object({ offerId: uuid, reason: z.string().max(200).optional() }), cmd.payload);
      return this.routing.decline(ctx.auth, p.offerId, p.reason);
    });
    this.registry.registerAgent('chat.close', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, reason: z.string().min(1).max(100).default('resolved') }), cmd.payload);
      return (await this.commands.close({ kind: 'agent', auth: ctx.auth }, p.chatId, { reason: p.reason, expectedVersion: cmd.expectedVersion ?? null })).chat;
    });
    this.registry.registerAgent('typing.set', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, isTyping: z.boolean(), mode: z.enum(['reply', 'note']).default('reply') }), cmd.payload);
      if (!(await this.rateLimit.hit(`typing:${ctx.connectionId}`, 1, 2)) && p.isTyping) return { coalesced: true };
      const chat = await this.db.read(ctx.auth.tenantId, (tx) =>
        tx.chat.findFirst({ where: { tenantId: ctx.auth.tenantId, id: p.chatId, participants: { some: { membershipId: ctx.auth.membershipId ?? '__none__', leftAt: null } } } }),
      );
      if (!chat) throw denied();
      const expiresAt = new Date(Date.now() + 6000);
      // actor_public_id = the agent's public profile id (membership id), as in public agent profiles.
      const payload = { chatId: p.chatId, actor: { type: 'agent', id: ctx.auth.membershipId, displayName: ctx.auth.actorName.split(' ')[0] }, actorPublicId: ctx.auth.membershipId, isTyping: p.isTyping, mode: p.mode, expiresAt };
      this.realtime.ephemeral(AGENT_NS, roomFor(ctx.auth.tenantId, 'chat', p.chatId, 'staff'), 'typing.changed', { kind: 'chat', id: p.chatId }, payload, 6000);
      if (p.mode === 'reply') {
        this.realtime.ephemeral(VISITOR_NS, roomFor(ctx.auth.tenantId, 'chat', p.chatId, 'public'), 'typing.changed', { kind: 'chat', id: p.chatId }, { chatId: p.chatId, actor: { type: 'agent', displayName: payload.actor.displayName }, actorPublicId: ctx.auth.membershipId, isTyping: p.isTyping, expiresAt }, 6000);
      }
      return { ok: true };
    });

    // ───────── Visitor ─────────
    this.registry.registerVisitor('message.send', (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, clientMessageId: z.string().min(1).max(64), body: z.string().max(8000).nullable().optional(), attachmentIds: z.array(uuid).max(5).default([]), visibility: z.literal('public').optional() }).strict(), cmd.payload);
      return this.commands.visitorSend(ctx.visitor, p.chatId, p);
    });
    this.registry.registerVisitor('message.delivered', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, lastDeliveredSeq: z.number().int().min(0) }).strict(), cmd.payload);
      const r = await this.commands.deliveredCursor({ visitor: ctx.visitor }, p.chatId, p.lastDeliveredSeq);
      if (r.advanced) {
        this.realtime.ephemeral(AGENT_NS, roomFor(ctx.visitor.tenantId, 'chat', p.chatId, 'staff'), 'message.delivered', { kind: 'chat', id: p.chatId }, { chatId: p.chatId, actorType: 'visitor', participantId: ctx.visitor.visitorId, throughSeq: r.throughSeq, at: new Date() }, 60_000);
      }
      return { lastDeliveredSeq: r.throughSeq };
    });
    this.registry.registerVisitor('message.read', (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, lastReadSeq: z.number().int().min(0) }), cmd.payload);
      return this.commands.readCursor({ visitor: ctx.visitor }, p.chatId, p.lastReadSeq);
    });
    this.registry.registerVisitor('chat.close', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid }), cmd.payload);
      return (await this.commands.close({ kind: 'visitor', visitor: ctx.visitor }, p.chatId, { reason: 'visitor_ended' })).chat;
    });
    this.registry.registerVisitor('typing.set', async (ctx, cmd) => {
      const p = parse(z.object({ chatId: uuid, isTyping: z.boolean() }), cmd.payload);
      if (!(await this.rateLimit.hit(`vtyping:${ctx.connectionId}`, 1, 2)) && p.isTyping) return { coalesced: true };
      const chat = await this.db.read(ctx.visitor.tenantId, (tx) => tx.chat.findFirst({ where: { tenantId: ctx.visitor.tenantId, id: p.chatId, visitorId: ctx.visitor.visitorId, status: { not: 'closed' } } }));
      if (!chat) throw badRequest('Chat not active');
      this.realtime.ephemeral(AGENT_NS, roomFor(ctx.visitor.tenantId, 'chat', p.chatId, 'staff'), 'typing.changed', { kind: 'chat', id: p.chatId }, { chatId: p.chatId, actor: { type: 'visitor', id: ctx.visitor.visitorId }, actorPublicId: ctx.visitor.visitorId, isTyping: p.isTyping, expiresAt: new Date(Date.now() + 6000) }, 6000);
      return { ok: true };
    });
  }
}
