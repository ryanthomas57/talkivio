/**
 * Chats, messages and offers (ch. 40 shared shapes, ch. 44/46). Staff projections
 * include internal context; public projections are the visitor's view.
 * Source: `apps/api/src/features/chats/chat.projections.ts`.
 */
import { z } from 'zod';
import { DateTime, JsonObject, Uuid } from './common.ts';

export const ChatStatusSchema = z.enum(['queued', 'offered', 'active', 'closed']);
export const TagRefSchema = z.object({ id: Uuid, slug: z.string(), label: z.string() });

export const VisitorSummarySchema = z.object({
  id: Uuid,
  displayName: z.string(),
  verified: z.boolean(),
  countryCode: z.string().nullable(),
  avatarColor: z.string(),
  online: z.boolean().optional(),
});

export const StaffChatSchema = z.object({
  id: Uuid,
  number: z.number().int(),
  siteId: Uuid,
  visitorId: Uuid,
  departmentId: Uuid.nullable(),
  status: ChatStatusSchema,
  ownerMembershipId: Uuid.nullable(),
  collaboratorIds: z.array(Uuid),
  requestedAt: DateTime,
  firstAssignedAt: DateTime.nullable(),
  firstResponseAt: DateTime.nullable(),
  closedAt: DateTime.nullable(),
  closeReason: z.string().nullable(),
  priority: z.number().int(),
  version: z.number().int(),
  lastSeq: z.number().int(),
  startedBy: z.string(),
  routeReason: z.string().nullable(),
  lastMessageAt: DateTime,
  lastMessagePreview: z.string(),
  lastPublicSenderType: z.string().nullable(),
  awaitingReply: z.boolean(),
  pageUrl: z.string().nullable(),
  tags: z.array(TagRefSchema),
  rating: z
    .object({ rating: z.enum(['good', 'bad']), comment: z.string().nullable(), submittedAt: DateTime })
    .nullable(),
  visitor: VisitorSummarySchema,
  unreadCount: z.number().int().optional(),
});

/**
 * History search row: a staff chat plus the matching snippet (plain text, no markers) and
 * `snippetHighlights` — `[start, end)` ranges in Unicode code points.
 */
export const HistoryChatSchema = StaffChatSchema.extend({
  snippet: z.string().nullable(),
  snippetHighlights: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])),
});

export const PublicAgentProfileSchema = z.object({
  id: Uuid,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  title: z.string().nullable(),
});

export const PublicChatSchema = z.object({
  id: Uuid,
  status: ChatStatusSchema,
  version: z.number().int(),
  lastSeq: z.number().int(),
  requestedAt: DateTime,
  closedAt: DateTime.nullable(),
  closeReason: z.string().nullable(),
  agents: z.array(PublicAgentProfileSchema),
  rating: z.object({ rating: z.enum(['good', 'bad']), comment: z.string().nullable() }).nullable(),
  queue: z.object({ position: z.number().int(), approximate: z.literal(true) }).nullable(),
});

export const AttachmentRefSchema = z.object({
  id: Uuid,
  name: z.string(),
  sizeBytes: z.number().int(),
  mime: z.string(),
  state: z.string(),
  isImage: z.boolean(),
});

export const MessageSchema = z.object({
  id: Uuid,
  chatId: Uuid,
  seq: z.number().int(),
  clientMessageId: z.string().nullable(),
  sender: z.object({
    type: z.enum(['visitor', 'agent', 'system']),
    id: Uuid.nullable(),
    displayName: z.string(),
  }),
  automated: z.boolean(),
  visibility: z.enum(['public', 'internal']),
  type: z.enum(['text', 'attachment', 'system']),
  body: z.string().nullable(),
  options: z.array(z.string()),
  /** params: public-safe display values (name, department, variant, by) for rendering the line in the reader's language. */
  systemEvent: z
    .object({ kind: z.string(), data: JsonObject, params: z.record(z.string(), z.string()).optional() })
    .nullable(),
  attachments: z.array(AttachmentRefSchema),
  sentAt: DateTime,
  redacted: z.boolean(),
});

/** Ascending message page; `throughSeq` is the coverage cursor (public seq gaps are legitimate). */
export const MessagePageSchema = z.object({
  items: z.array(MessageSchema),
  throughSeq: z.number().int(),
  lastSeq: z.number().int(),
  hasMore: z.boolean(),
});

export const OfferSchema = z.object({
  id: Uuid,
  chatId: Uuid,
  mode: z.enum(['assigned', 'broadcast', 'transfer']),
  targetMembershipId: Uuid.nullable(),
  fromMembershipId: Uuid.nullable(),
  targetDepartmentId: Uuid.nullable(),
  note: z.string().nullable(),
  expiresAt: DateTime,
  status: z.enum(['pending', 'accepted', 'declined', 'expired', 'withdrawn']),
  version: z.number().int(),
});

/** Actionable offer for the signed-in agent (`GET /chats/offers`). */
export const PendingOfferSchema = z.object({
  offer: z.object({
    id: Uuid,
    chatId: Uuid,
    mode: z.enum(['assigned', 'broadcast', 'transfer']),
    expiresAt: DateTime,
    note: z.string().nullable(),
    fromMembershipId: Uuid.nullable(),
    version: z.number().int(),
  }),
  chatPreview: StaffChatSchema,
});

export const TransferResultSchema = z.object({ offer: OfferSchema.optional(), chat: StaffChatSchema });
export const ChatCountsSchema = z.record(z.number().int());
export const ReadCursorSchema = z.object({ lastReadSeq: z.number().int() });

/** Admission result (ch. 76): `{chat, initial_message}`, `initial_message` null when the visitor sent no text. */
export const ChatAdmissionSchema = z.object({
  chat: PublicChatSchema,
  initialMessage: MessageSchema.nullable(),
});
/** Agent-started chat (POST /visitors/{id}/chats): the active chat owned by the agent and their first message. */
export const AgentStartedChatSchema = z.object({ chat: StaffChatSchema, message: MessageSchema });
export const ChatRatingSchema = z.object({
  rating: z.enum(['good', 'bad']),
  comment: z.string().nullable(),
  revisionCount: z.number().int(),
});

export type StaffChat = z.infer<typeof StaffChatSchema>;
export type PublicChat = z.infer<typeof PublicChatSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessagePage = z.infer<typeof MessagePageSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type PendingOffer = z.infer<typeof PendingOfferSchema>;
export type ChatAdmission = z.infer<typeof ChatAdmissionSchema>;
