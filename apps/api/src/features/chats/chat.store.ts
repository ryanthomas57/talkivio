import { Injectable } from '@nestjs/common';
import type { Chat, Prisma } from '@prisma/client';
import { maskCreditCards, mergeOrgSettings, type OrgSettings } from '@talkivio/contracts';
import type { Tx } from '../../db/tenant-db';
import { conflict, notFound } from '../../common/http';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import {
  messageInclude,
  messageResource,
  previewOf,
  publicMessage,
  staffChat,
  staffChatInclude,
  type MessageResource,
  type PublicAgentProfile,
  type PublicChat,
  type StaffChat,
  type TagRef,
} from './chat.projections';

/**
 * Idempotent replay (same client_message_id) returns the stored message only to the principal
 * that sent it. Anyone else reusing the id gets IDEMPOTENCY_MISMATCH without content, so a
 * guessed or leaked id can never disclose another sender's message or internal note.
 */
export function assertSameSender(
  existing: { senderType: string; senderMembershipId: string | null; senderVisitorId: string | null },
  sender: { senderType: string; senderMembershipId?: string | null; senderVisitorId?: string | null },
): void {
  const same =
    existing.senderType === sender.senderType &&
    (existing.senderMembershipId ?? null) === (sender.senderMembershipId ?? null) &&
    (existing.senderVisitorId ?? null) === (sender.senderVisitorId ?? null);
  if (!same) throw conflict('IDEMPOTENCY_MISMATCH', 'This message id was already used for a different message');
}

export interface AppendMessageInput {
  senderType: 'visitor' | 'agent' | 'system';
  senderMembershipId?: string | null;
  senderVisitorId?: string | null;
  senderName: string;
  visibility?: 'public' | 'internal';
  type?: 'text' | 'attachment' | 'system';
  body?: string | null;
  clientMessageId?: string | null;
  options?: string[];
  systemEvent?: { kind: string; data?: Record<string, unknown>; params?: Record<string, string> } | null;
  attachmentIds?: string[];
  automated?: boolean;
  replyId?: string | null;
  causationId?: string | null;
}

/** Queue scope id for a department (or the no-department queue). */
export const queueScopeId = (departmentId: string | null | undefined) => departmentId ?? 'none';

/**
 * Low-level chat persistence helpers used inside command transactions.
 * Lock order (ch. 31): chat row first, then agent capacity rows in UUID order.
 */
@Injectable()
export class ChatStore {
  constructor(private readonly outbox: OutboxService) {}

  async lockChat(tx: Tx, tenantId: string, chatId: string): Promise<Chat> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM chats WHERE tenant_id = ${tenantId}::uuid AND id = ${chatId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound('Chat');
    return tx.chat.findUniqueOrThrow({ where: { id: chatId } });
  }

  /** Lock capacity rows for agents in a consistent (UUID) order. */
  async lockCapacity(tx: Tx, tenantId: string, membershipIds: string[]): Promise<void> {
    const ids = [...new Set(membershipIds)].sort();
    for (const id of ids) {
      await tx.$executeRaw`INSERT INTO agent_capacity (tenant_id, membership_id) VALUES (${tenantId}::uuid, ${id}::uuid) ON CONFLICT DO NOTHING`;
      await tx.$queryRaw`SELECT 1 FROM agent_capacity WHERE tenant_id = ${tenantId}::uuid AND membership_id = ${id}::uuid FOR UPDATE`;
    }
  }

  /** Capacity usage for one agent within the current transaction. */
  async usage(tx: Tx, tenantId: string, membershipId: string, excludeOfferId?: string): Promise<{ active: number; collaborations: number; reserved: number }> {
    const [active, collaborations, reserved] = await Promise.all([
      tx.chat.count({ where: { tenantId, ownerMembershipId: membershipId, status: 'active' } }),
      tx.chatParticipant.count({ where: { tenantId, membershipId, role: 'collaborator', leftAt: null, chat: { status: { not: 'closed' } } } }),
      tx.assignmentOffer.count({
        where: {
          tenantId,
          membershipId,
          status: 'pending',
          mode: { in: ['assigned', 'transfer'] },
          expiresAt: { gt: new Date() },
          ...(excludeOfferId ? { id: { not: excludeOfferId } } : {}),
        },
      }),
    ]);
    return { active, collaborations, reserved };
  }

  async settings(tx: Tx, tenantId: string): Promise<OrgSettings> {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    return mergeOrgSettings(t.settings);
  }

  async tagsOf(tx: Tx, tenantId: string, chatId: string): Promise<TagRef[]> {
    const rows = await tx.chatTag.findMany({ where: { tenantId, chatId }, select: { tagId: true } });
    if (!rows.length) return [];
    const tags = await tx.tag.findMany({ where: { tenantId, id: { in: rows.map((r) => r.tagId) } } });
    return tags.map((t) => ({ id: t.id, slug: t.slug, label: t.label }));
  }

  async staff(tx: Tx, tenantId: string, chatId: string): Promise<StaffChat> {
    const c = await tx.chat.findUniqueOrThrow({ where: { id: chatId }, include: staffChatInclude });
    const v = await tx.visitor.findUniqueOrThrow({ where: { id: c.visitorId } });
    return staffChat(c, v, await this.tagsOf(tx, tenantId, chatId));
  }

  async agentProfiles(tx: Tx, tenantId: string, membershipIds: string[]): Promise<PublicAgentProfile[]> {
    if (!membershipIds.length) return [];
    const members = await tx.membership.findMany({
      where: { tenantId, id: { in: membershipIds } },
      include: { user: { select: { displayName: true, avatarUrl: true } } },
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    return membershipIds
      .map((id) => byId.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ id: m.id, displayName: (m.displayName || m.user.displayName).split(' ')[0], avatarUrl: m.user.avatarUrl, title: m.title }));
  }

  async queuePosition(tx: Tx, c: Chat): Promise<number | null> {
    if (c.status !== 'queued' && c.status !== 'offered') return null;
    const ahead = await tx.chat.count({
      where: {
        tenantId: c.tenantId,
        status: { in: ['queued', 'offered'] },
        isPreview: false,
        OR: [{ priority: { gt: c.priority } }, { priority: c.priority, requestedAt: { lt: c.requestedAt } }],
        ...(c.departmentId ? { departmentId: { in: [c.departmentId] } } : {}),
      },
    });
    const noDeptAhead = c.departmentId
      ? await tx.chat.count({ where: { tenantId: c.tenantId, status: { in: ['queued', 'offered'] }, departmentId: null, requestedAt: { lt: c.requestedAt } } })
      : 0;
    return ahead + noDeptAhead + 1;
  }

  async publicChat(tx: Tx, chatId: string): Promise<PublicChat> {
    const c = await tx.chat.findUniqueOrThrow({ where: { id: chatId }, include: { rating: true } });
    const parts = await tx.chatParticipant.findMany({
      where: { tenantId: c.tenantId, chatId, leftAt: null, actorType: 'agent' },
      orderBy: { joinedAt: 'asc' },
    });
    const ids = parts.sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0)).map((p) => p.membershipId!).filter(Boolean);
    const position = await this.queuePosition(tx, c);
    return {
      id: c.id,
      status: c.status,
      version: c.version,
      lastSeq: Number(c.nextSeq) - 1,
      requestedAt: c.requestedAt,
      closedAt: c.closedAt,
      closeReason: c.closeReason ? publicCloseReason(c.closeReason) : null,
      agents: await this.agentProfiles(tx, c.tenantId, ids),
      rating: c.rating ? { rating: c.rating.rating, comment: c.rating.comment } : null,
      queue: position ? { position, approximate: true } : null,
    };
  }

  /** Allocate the next sequence number and persist a message (chat row must be locked). A reused client_message_id replays the original only to its own sender. */
  async appendMessage(tx: Tx, chat: Chat, input: AppendMessageInput, settings: OrgSettings): Promise<{ message: MessageResource; created: boolean }> {
    if (input.clientMessageId) {
      const existing = await tx.message.findUnique({
        where: { tenantId_chatId_clientMessageId: { tenantId: chat.tenantId, chatId: chat.id, clientMessageId: input.clientMessageId } },
        include: messageInclude,
      });
      if (existing) {
        assertSameSender(existing, input);
        return { message: messageResource(existing), created: false };
      }
    }
    if (chat.status === 'closed' && input.senderType !== 'system') throw conflict('CHAT_CLOSED', 'This chat has ended');
    const seq = chat.nextSeq;
    const visibility = input.visibility ?? 'public';
    const body = input.body == null ? null : visibility === 'public' && settings.chat.maskCreditCards ? maskCreditCards(input.body) : input.body;
    const attachmentIds = input.attachmentIds ?? [];
    const m = await tx.message.create({
      data: {
        tenantId: chat.tenantId,
        chatId: chat.id,
        seq,
        clientMessageId: input.clientMessageId ?? null,
        senderType: input.senderType,
        senderMembershipId: input.senderType === 'agent' ? (input.senderMembershipId ?? null) : null,
        senderVisitorId: input.senderType === 'visitor' ? (input.senderVisitorId ?? null) : null,
        senderNameSnapshot: input.senderName,
        automated: input.automated ?? false,
        visibility,
        type: input.type ?? (attachmentIds.length && !body ? 'attachment' : 'text'),
        body,
        options: input.options ?? [],
        systemEvent: (input.systemEvent ? { kind: input.systemEvent.kind, data: input.systemEvent.data ?? {}, params: input.systemEvent.params ?? {} } : undefined) as Prisma.InputJsonValue | undefined,
        replyId: input.replyId ?? null,
        attachments: attachmentIds.length
          ? { create: attachmentIds.map((attachmentId, ordinal) => ({ attachmentId, ordinal })) } // tenant_id comes from the message relation
          : undefined,
      },
      include: messageInclude,
    });
    const now = m.sentAt;
    const data: Prisma.ChatUpdateInput = { nextSeq: seq + 1n };
    if (visibility === 'public' && input.senderType !== 'system') {
      data.lastMessageAt = now;
      data.lastMessagePreview = previewOf(body, attachmentIds.length);
      data.lastPublicSenderType = input.senderType;
      if (input.senderType === 'visitor') data.lastVisitorMessageAt = now;
      if (input.senderType === 'agent' && !input.automated) {
        data.lastAgentReplyAt = now;
        if (!chat.firstResponseAt) data.firstResponseAt = now;
      }
    }
    const updated = await tx.chat.update({ where: { id: chat.id }, data });
    Object.assign(chat, updated);
    const resource = messageResource(m);
    await this.emitMessage(tx, chat, resource, input.causationId ?? null);
    return { message: resource, created: true };
  }

  /**
   * A system line in the transcript. `text` is the English rendering kept for exports and old clients;
   * `params` are public-safe display values (names, department labels, a variant) from which the widget
   * and dashboard render the line in the reader's language (ch. 29). `data` (ids, reasons) stays staff-only.
   */
  async systemEvent(tx: Tx, chat: Chat, kind: string, text: string, data: Record<string, unknown>, settings: OrgSettings, params: Record<string, string> = {}) {
    return this.appendMessage(
      tx,
      chat,
      { senderType: 'system', senderName: 'Talkivio', type: 'system', body: text, systemEvent: { kind, data, params }, visibility: 'public' },
      settings,
    ).then((r) => r.message);
  }

  async emitMessage(tx: Tx, chat: Chat, message: MessageResource, causationId: string | null): Promise<void> {
    const pub = publicMessage(message);
    const scopes: OutboxScope[] = [{ kind: 'chat', id: chat.id, audience: 'staff' }];
    if (pub) scopes.push({ kind: 'chat', id: chat.id, audience: 'public', payload: { message: pub } });
    await this.outbox.append(tx, chat.tenantId, {
      aggregateType: 'chat',
      aggregateId: chat.id,
      aggregateVersion: chat.version,
      eventType: 'message.created',
      payload: { message, chatId: chat.id, visibility: message.visibility, senderType: message.sender.type, automated: message.automated },
      scopes,
      causationId,
    });
  }

  /** Emit chat.updated to staff (chat + queue + owner) and the visitor's public projection. */
  async emitChatUpdated(tx: Tx, chat: Chat, causationId: string | null = null, extraAgentIds: string[] = []): Promise<void> {
    const staff = await this.staff(tx, chat.tenantId, chat.id);
    const pub = await this.publicChat(tx, chat.id);
    const scopes: OutboxScope[] = [
      { kind: 'chat', id: chat.id, audience: 'staff' },
      { kind: 'queue', id: queueScopeId(chat.departmentId), audience: 'staff' },
      { kind: 'chat', id: chat.id, audience: 'public', payload: { chat: pub } },
    ];
    const agentIds = new Set([...(chat.ownerMembershipId ? [chat.ownerMembershipId] : []), ...staff.collaboratorIds, ...extraAgentIds]);
    for (const id of agentIds) scopes.push({ kind: 'agent', id, audience: 'staff' });
    await this.outbox.append(tx, chat.tenantId, {
      aggregateType: 'chat',
      aggregateId: chat.id,
      aggregateVersion: chat.version,
      eventType: 'chat.updated',
      payload: { chat: staff },
      scopes,
      causationId,
    });
  }

  async bumpVersion(tx: Tx, chat: Chat, data: Prisma.ChatUpdateInput): Promise<Chat> {
    const updated = await tx.chat.update({ where: { id: chat.id }, data: { ...data, version: { increment: 1 } } });
    Object.assign(chat, updated);
    return chat;
  }

  outboxService(): OutboxService {
    return this.outbox;
  }
}

export function publicCloseReason(reason: string): string {
  if (reason === 'visitor_ended') return 'visitor_ended';
  if (reason === 'converted_offline') return 'converted_offline';
  if (reason.startsWith('inactivity') || reason === 'visitor_disconnected') return 'inactivity';
  return 'ended';
}
