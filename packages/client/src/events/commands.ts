/**
 * Allowlisted socket commands (ch. 77). Each delegates to the same service method as
 * its REST twin; `payload` keys are snake_case on the wire (converted like REST bodies).
 *
 * Source of truth: `registry.registerAgent(...)` / `registry.registerVisitor(...)` in
 * `apps/api/src` (chat-socket.commands.ts, invitations.service.ts, offline.controller.ts).
 */
import { z } from 'zod';
import { Uuid } from '../schemas/common.ts';
import { MessageSchema, PublicChatSchema, StaffChatSchema } from '../schemas/chats.ts';
import { InvitationSchema } from '../schemas/widget.ts';
import { OfflineReceiptSchema } from '../schemas/operations.ts';

export interface CommandSpec {
  payload: z.ZodTypeAny;
  result: z.ZodTypeAny;
  /** Uses the command envelope's `expected_version`. */
  expectedVersion?: boolean;
  rest: string;
  summary: string;
}

const Ok = z.object({ ok: z.literal(true) });
const TypingResult = z.union([z.object({ ok: z.literal(true) }), z.object({ coalesced: z.literal(true) })]);

export const AgentCommands = {
  'message.send': {
    payload: z.object({
      chatId: Uuid,
      clientMessageId: z.string().min(1).max(64),
      visibility: z.enum(['public', 'internal']).default('public'),
      body: z.string().max(8000).nullable().optional(),
      attachmentIds: z.array(Uuid).max(5).default([]),
      replyId: Uuid.nullable().optional(),
      options: z.array(z.string().max(60)).max(8).default([]),
    }),
    result: MessageSchema,
    rest: 'POST /api/v1/chats/{id}/messages',
    summary: 'Send a message or internal note; the same client_message_id returns the original message.',
  },
  'message.read': { payload: z.object({ chatId: Uuid, lastReadSeq: z.number().int().min(0) }), result: z.object({ lastReadSeq: z.number().int() }), rest: 'PUT /api/v1/chats/{id}/read-cursor', summary: 'Advance the read cursor.' },
  'message.delivered': {
    payload: z.object({ chatId: Uuid, lastDeliveredSeq: z.number().int().min(0) }),
    result: z.object({ lastDeliveredSeq: z.number().int() }),
    rest: '—',
    summary: 'Advance the delivery cursor (emits ephemeral `message.delivered`).',
  },
  'offer.accept': { payload: z.object({ chatId: Uuid, offerId: Uuid.nullable().optional() }), result: StaffChatSchema, expectedVersion: true, rest: 'POST /api/v1/chats/{id}/accept', summary: 'Accept an offer or pick up a queued chat.' },
  'offer.decline': { payload: z.object({ offerId: Uuid, reason: z.string().max(200).optional() }), result: Ok, rest: 'POST /api/v1/offers/{id}/decline', summary: 'Decline an offer.' },
  'chat.close': { payload: z.object({ chatId: Uuid, reason: z.string().min(1).max(100).default('resolved') }), result: StaffChatSchema, expectedVersion: true, rest: 'POST /api/v1/chats/{id}/close', summary: 'Close a chat.' },
  'typing.set': { payload: z.object({ chatId: Uuid, isTyping: z.boolean(), mode: z.enum(['reply', 'note']).default('reply') }), result: TypingResult, rest: '—', summary: 'Typing indicator (rate limited; coalesced acks).' },
  'presence.set': {
    payload: z.object({ status: z.enum(['online', 'away', 'invisible']) }).strict(),
    result: z.object({ desiredStatus: z.enum(['online', 'away', 'invisible']), effectiveStatus: z.enum(['online', 'away', 'invisible', 'offline']), connected: z.boolean() }),
    rest: 'PUT /api/v1/agents/me/presence',
    summary: 'Set desired status (online / away / invisible); connection stays a separate property.',
  },
} satisfies Record<string, CommandSpec>;

export const VisitorCommands = {
  'message.send': {
    payload: z.object({ chatId: Uuid, clientMessageId: z.string().min(1).max(64), body: z.string().max(8000).nullable().optional(), attachmentIds: z.array(Uuid).max(5).default([]), visibility: z.literal('public').optional() }).strict(),
    result: MessageSchema,
    rest: 'POST /widget/v1/chats/{id}/messages',
    summary: 'Send a public message (no visibility override).',
  },
  'message.delivered': { payload: z.object({ chatId: Uuid, lastDeliveredSeq: z.number().int().min(0) }).strict(), result: z.object({ lastDeliveredSeq: z.number().int() }), rest: '—', summary: 'Advance the delivery cursor.' },
  'message.read': { payload: z.object({ chatId: Uuid, lastReadSeq: z.number().int().min(0) }), result: z.object({ lastReadSeq: z.number().int() }), rest: 'PUT /widget/v1/chats/{id}/read-cursor', summary: 'Advance the read cursor.' },
  'chat.close': { payload: z.object({ chatId: Uuid }), result: PublicChatSchema, rest: 'POST /widget/v1/chats/{id}/close', summary: 'End the chat (reason `visitor_ended`).' },
  'typing.set': { payload: z.object({ chatId: Uuid, isTyping: z.boolean() }), result: TypingResult, rest: '—', summary: 'Visitor typing indicator (staff rooms only).' },
  'invitation.ack': { payload: z.object({ invitationId: Uuid, displayedAtClient: z.string().max(40).optional() }).strict(), result: InvitationSchema, rest: 'POST /widget/v1/invitations/{id}/displayed', summary: 'Explicit display acknowledgement (server receipt time is recorded).' },
  'invitation.dismiss': { payload: z.object({ invitationId: Uuid }).strict(), result: Ok, rest: 'POST /widget/v1/invitations/{id}/dismiss', summary: 'Dismiss an invitation (durable cap).' },
  'offline.submit': {
    payload: z
      .object({
        clientRequestId: z.string().min(8).max(128).regex(/^[\w-]+$/),
        name: z.string().max(480).nullable().optional(),
        email: z.string().max(254).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        message: z.string().max(32_000),
        departmentId: Uuid.nullable().optional(),
        fields: z.record(z.string().max(64), z.unknown()).nullable().optional(),
        sourceChatId: Uuid.nullable().optional(),
      })
      .strict(),
    result: OfflineReceiptSchema,
    rest: 'POST /widget/v1/offline-submissions',
    summary: 'Submit the offline form over the socket.',
  },
} satisfies Record<string, CommandSpec>;

export type AgentCommandType = keyof typeof AgentCommands;
export type VisitorCommandType = keyof typeof VisitorCommands;
export type AgentCommandPayload<T extends AgentCommandType> = z.input<(typeof AgentCommands)[T]['payload']>;
export type VisitorCommandPayload<T extends VisitorCommandType> = z.input<(typeof VisitorCommands)[T]['payload']>;
