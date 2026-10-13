/**
 * Durable domain events (outbox, ch. 03/48). Each event is appended inside the command
 * transaction with one row per scope; `staff` rows are delivered on `/agent`, `public`
 * rows on `/visitor`, and an `internal` (`tenant`) row feeds workers, triggers and
 * webhooks. Staff and internal rows carry the base payload; public rows carry the
 * per-scope public projection.
 *
 * Source of truth: every `outbox.append(...)` in `apps/api/src`.
 */
import { z } from 'zod';
import { DateTime, Uuid } from '../schemas/common.ts';
import { MessageSchema, OfferSchema, PublicAgentProfileSchema, PublicChatSchema, StaffChatSchema } from '../schemas/chats.ts';
import { AttachmentStateSchema } from '../schemas/files.ts';
import { EmergencyClosureSchema } from '../schemas/automation.ts';

const Version = z.number().int();
const QueueScopeNote = 'queue scope id = department id or `none`';

// ───────── chat lifecycle ─────────
export const MessageCreatedSchema = z.object({
  message: MessageSchema,
  chatId: Uuid,
  visibility: z.enum(['public', 'internal']),
  senderType: z.enum(['visitor', 'agent', 'system']),
  automated: z.boolean(),
});
export const MessageCreatedPublicSchema = z.object({ message: MessageSchema });

export const ChatUpdatedSchema = z.object({ chat: StaffChatSchema });
export const ChatUpdatedPublicSchema = z.object({ chat: PublicChatSchema });

export const ChatRequestedSchema = z.object({ chat: StaffChatSchema, initialMessage: MessageSchema.nullable(), routeReason: z.string().nullable(), invitationId: Uuid.nullable() });
export const ChatRequestedPublicSchema = z.object({ chat: PublicChatSchema });

export const ChatQueuedSchema = z.object({ chatId: Uuid, departmentId: Uuid.nullable(), mode: z.enum(['manual', 'broadcast', 'assigned']), requestedAt: DateTime });

export const MessageReadSchema = z.object({ chatId: Uuid, participantId: Uuid, actorType: z.enum(['visitor', 'agent']), throughSeq: z.number().int(), at: DateTime });
export const MessageReadPublicSchema = z.object({ chatId: Uuid, actorType: z.enum(['visitor', 'agent']), throughSeq: z.number().int(), at: DateTime });

export const ChatTransferredSchema = z.object({
  chatId: Uuid,
  previousOwner: Uuid.nullable(),
  nextOwner: Uuid.nullable(),
  departmentId: Uuid.nullable(),
  version: Version,
  forced: z.boolean().optional(),
  previousDepartmentId: Uuid.nullable().optional(),
  /** Present for system re-queues: queue max-wait fallback or a suspended owner (`next_owner` null). */
  reason: z.enum(['max_wait_fallback', 'agent_suspended']).optional(),
});
/** Visitor projection: the next owner's public profile only (never the private handoff note). */
export const ChatTransferredPublicSchema = z.object({ chatId: Uuid, nextOwner: PublicAgentProfileSchema.nullable().optional(), version: Version });

export const ParticipantJoinedSchema = z.object({
  chatId: Uuid,
  participant: PublicAgentProfileSchema.extend({ membershipId: Uuid }),
  role: z.enum(['primary', 'collaborator']),
  joinedAt: DateTime,
});
export const ParticipantJoinedPublicSchema = z.object({ chatId: Uuid, participant: PublicAgentProfileSchema.optional(), role: z.enum(['primary', 'collaborator']), joinedAt: DateTime });
/** Visitor-facing projection of an accepted assignment (ch. 48 `assignment.accepted` → public `chat.started`). */
export const ChatStartedPublicSchema = z.object({ chatId: Uuid, ownerPublicProfile: PublicAgentProfileSchema.nullable(), startedAt: DateTime, version: Version });
/** Message body removed (erasure): drop cached body and attachment grants, keep a tombstone. Ids and seq only. */
export const MessageRedactedSchema = z.object({ chatId: Uuid, messageId: Uuid, seq: z.number().int(), reason: z.literal('redacted') });

export const ParticipantLeftSchema = z.object({ chatId: Uuid, participantId: Uuid, membershipId: Uuid, leftAt: DateTime, reason: z.string() });
export const ParticipantLeftPublicSchema = z.object({ chatId: Uuid, participantId: Uuid, leftAt: DateTime });

export const ChatClosedSchema = z.object({ chatId: Uuid, closedAt: DateTime, reason: z.string(), closedBy: z.enum(['agent', 'visitor', 'system']), version: Version, chat: StaffChatSchema });
export const ChatClosedPublicSchema = z.object({ chatId: Uuid, closedAt: DateTime, publicReason: z.string().nullable(), version: Version, chat: PublicChatSchema });

export const RatingUpdatedSchema = z.object({ chatId: Uuid, rating: z.enum(['good', 'bad']), comment: z.string().nullable(), submittedAt: DateTime, revisedAt: DateTime.nullable() });
export const RatingUpdatedPublicSchema = z.object({ chatId: Uuid, rating: z.enum(['good', 'bad']), comment: z.string().nullable() });

// ───────── routing ─────────
export const AssignmentOfferedSchema = z.object({ offer: OfferSchema, chatPreview: StaffChatSchema, expiresAt: DateTime, from: z.string().optional() });
export const AssignmentAcceptedSchema = z.object({ chatId: Uuid, offerId: Uuid.nullable(), ownerMembershipId: Uuid, version: Version });
export const AssignmentWithdrawnSchema = z.object({ offerId: Uuid, chatId: Uuid, reason: z.string() });
export const TransferDeclinedSchema = z.object({ offerId: Uuid, chatId: Uuid, reason: z.string() });
export const TransferExpiredSchema = z.object({ offerId: Uuid, chatId: Uuid });

// ───────── files, exports, offline, privacy ─────────
export const AttachmentUpdatedSchema = z.object({
  attachmentId: Uuid,
  chatId: Uuid,
  state: AttachmentStateSchema,
  sizeBytes: z.number().int(),
  mime: z.string(),
  errorCode: z.string().optional(),
  deleted: z.literal(true).optional(),
});
export const ExportReadySchema = z.union([
  z.object({ exportId: Uuid, format: z.enum(['csv', 'txt', 'json', 'pdf']), state: z.literal('ready'), expiresAt: DateTime, sizeBytes: z.number().int(), itemCount: z.number().int() }),
  z.object({ exportId: Uuid, kind: z.literal('analytics'), report: z.string(), expiresAt: DateTime }),
]);
export const ExportFailedSchema = z.object({ exportId: Uuid, format: z.enum(['csv', 'txt', 'json', 'pdf']), state: z.literal('failed'), errorCode: z.string() });

const OfflineEventSubmission = z.object({
  id: Uuid,
  reference: z.string(),
  siteId: Uuid,
  departmentId: Uuid.nullable(),
  visitorId: Uuid.nullable(),
  name: z.string().nullable(),
  status: z.string(),
  sourceChatId: Uuid.nullable(),
  conversionReason: z.string().nullable(),
  handledAt: DateTime.nullable(),
  handledById: Uuid.nullable(),
  createdAt: DateTime,
  version: Version,
});
/** Staff payload omits the e-mail mask and message preview (fetch the submission instead). */
export const OfflineSubmittedSchema = z.object({ submission: OfflineEventSubmission });
export const OfflineSubmittedPublicSchema = z.object({ reference: z.string(), status: z.string(), createdAt: DateTime, sourceChatId: Uuid.nullable() });
export const OfflineUpdatedSchema = z.object({ submission: OfflineEventSubmission });

export const PrivacyUpdatedSchema = z.object({ requestId: Uuid, kind: z.enum(['access', 'erase']), state: z.enum(['pending_verification', 'queued', 'running', 'completed', 'failed']), completedAt: DateTime.nullable(), progress: z.number().int().nullable().optional() });
export const PrivacyErasedSchema = z.object({ requestId: Uuid, visitorId: Uuid, completedAt: DateTime });

// ───────── configuration ─────────
export const ConfigPublishedSchema = z.object({ siteId: Uuid, configVersion: z.number().int(), etag: z.string() });
export const ScheduleUpdatedSchema = z.object({ scheduleId: Uuid, version: Version, change: z.enum(['created', 'updated', 'archived', 'exception_set', 'exception_removed']), date: z.string().optional() });
export const EmergencyClosureEventSchema = z.object({ closure: EmergencyClosureSchema });
export const ShortcutChangedSchema = z.union([
  z.object({ id: Uuid, action: z.enum(['created', 'updated', 'archived', 'restored']), scopeType: z.enum(['tenant', 'department', 'personal']), scopeId: Uuid.nullable(), version: Version }),
  z.object({ id: z.null(), action: z.literal('imported'), count: z.number().int() }),
]);
export const NotificationCreatedDurableSchema = z.object({
  notification: z.object({ id: Uuid, type: z.string(), title: z.string(), body: z.string(), link: z.string().nullable(), createdAt: DateTime, readAt: DateTime.nullable() }),
});

// ───────── automation (internal) ─────────
export const InvitationOfferedSchema = z.object({
  invitationId: Uuid,
  message: z.string(),
  attribution: z.string(),
  expiresAt: DateTime,
  version: Version,
  campaignId: Uuid,
  sessionId: Uuid,
  visitorId: Uuid,
  siteId: Uuid,
  departmentId: Uuid.nullable(),
  stage: z.literal('eligible'),
});
/** Exactly the target visitor session receives the grant (no campaign internals). */
export const InvitationOfferedPublicSchema = z.object({ invitationId: Uuid, message: z.string(), attribution: z.string(), expiresAt: DateTime, version: Version });
const InvitationStage = { invitationId: Uuid, campaignId: Uuid, sessionId: Uuid, state: z.enum(['eligible', 'displayed', 'accepted', 'dismissed', 'expired']) };
export const InvitationDisplayedSchema = z.object({ ...InvitationStage, displayedAt: DateTime });
export const InvitationDismissedSchema = z.object({ ...InvitationStage, dismissedAt: DateTime });
export const InvitationAcceptedSchema = z.object({ ...InvitationStage, chatId: Uuid });
export const TriggerPublishedSchema = z.object({ triggerId: Uuid, revision: z.number().int().nullable(), enabled: z.boolean(), event: z.string(), priority: z.number().int() });
export const TriggerUpdatedSchema = z.object({ triggerId: Uuid, change: z.enum(['created', 'details', 'draft_saved', 'restored']), currentRevision: z.number().int(), version: z.number().int() });
export const TriggerWebhookSchema = z.object({
  eventName: z.string(),
  triggerId: Uuid,
  triggerRevision: z.number().int(),
  sourceEventId: Uuid,
  sourceEventType: z.string(),
  siteId: Uuid.nullable(),
  chatId: Uuid.nullable(),
  visitorId: Uuid.nullable(),
  sessionId: Uuid.nullable(),
  departmentId: Uuid.nullable(),
});
export const VisitorSessionStartedSchema = z.object({ visitorId: Uuid, sessionId: Uuid, siteId: Uuid, returning: z.boolean(), pageUrl: z.string().nullable(), referrerOrigin: z.string().nullable(), startedAt: DateTime });
export const VisitorPageChangedSchema = z.object({ visitorId: Uuid, sessionId: Uuid, siteId: Uuid, url: z.string().nullable(), title: z.string().nullable(), receivedAt: DateTime });

type Kind = 'chat' | 'queue' | 'visitor' | 'config' | 'agent' | 'team';
export interface DurableEventSpec {
  /** Base payload: staff rows and the internal (tenant) row. */
  payload: z.ZodTypeAny;
  /** Public projection (visitor namespace), when the event has public scopes. */
  public?: z.ZodTypeAny;
  staffScopes: Kind[];
  publicScopes: Kind[];
  aggregate: string;
  summary: string;
}

/** Every durable event type emitted by the API (`eventType:` in `outbox.append`). */
export const DurableEvents = {
  'chat.requested': { payload: ChatRequestedSchema, public: ChatRequestedPublicSchema, staffScopes: ['queue'], publicScopes: ['visitor'], aggregate: 'chat', summary: `New chat admitted (${QueueScopeNote}); the visitor's own session gets the public snapshot.` },
  'chat.updated': { payload: ChatUpdatedSchema, public: ChatUpdatedPublicSchema, staffScopes: ['chat', 'queue', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Chat snapshot changed (status, owner, collaborators, tags, version).' },
  'chat.queued': { payload: ChatQueuedSchema, staffScopes: [], publicScopes: [], aggregate: 'chat', summary: 'Internal: once per queued chat version (trigger DSL event).' },
  'chat.transferred': { payload: ChatTransferredSchema, public: ChatTransferredPublicSchema, staffScopes: ['chat', 'queue', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Ownership or department changed (transfer, forced transfer, max-wait fallback).' },
  'chat.closed': { payload: ChatClosedSchema, public: ChatClosedPublicSchema, staffScopes: ['chat', 'queue', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Terminal close; composers stop sending.' },
  'message.created': { payload: MessageCreatedSchema, public: MessageCreatedPublicSchema, staffScopes: ['chat'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Committed message. Internal notes never reach public scopes; public system events carry no data.' },
  'message.read': { payload: MessageReadSchema, public: MessageReadPublicSchema, staffScopes: ['chat'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Monotonic read cursor (only when read receipts are enabled).' },
  'participant.joined': { payload: ParticipantJoinedSchema, public: ParticipantJoinedPublicSchema, staffScopes: ['chat', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Agent joined as primary owner or collaborator.' },
  'chat.started': { payload: ChatStartedPublicSchema, public: ChatStartedPublicSchema, staffScopes: [], publicScopes: ['chat'], aggregate: 'chat', summary: 'The visitor’s chat was accepted by an agent (public profile only, no selection trace).' },
  'message.redacted': { payload: MessageRedactedSchema, public: MessageRedactedSchema, staffScopes: ['chat'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Message redacted (privacy erasure). Internal notes are announced on staff scopes only.' },
  'participant.left': { payload: ParticipantLeftSchema, public: ParticipantLeftPublicSchema, staffScopes: ['chat', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Collaborator left (internal reason never reaches the visitor).' },
  'rating.updated': { payload: RatingUpdatedSchema, public: RatingUpdatedPublicSchema, staffScopes: ['chat', 'agent'], publicScopes: ['chat'], aggregate: 'chat', summary: 'Visitor rating submitted or revised.' },
  'assignment.offered': { payload: AssignmentOfferedSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'offer', summary: 'Offer to the target agent only (assigned/broadcast routing or transfer).' },
  'assignment.accepted': { payload: AssignmentAcceptedSchema, staffScopes: ['queue', 'agent'], publicScopes: [], aggregate: 'chat', summary: 'Offer accepted / chat picked up; competing offers are withdrawn.' },
  'assignment.withdrawn': { payload: AssignmentWithdrawnSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'offer', summary: 'Offer expired, declined or accepted elsewhere — remove the actionable button.' },
  'transfer.declined': { payload: TransferDeclinedSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'offer', summary: 'Transfer target declined (sent to the requesting agent).' },
  'transfer.expired': { payload: TransferExpiredSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'offer', summary: 'Transfer offer expired (sent to the requesting agent).' },
  'attachment.updated': { payload: AttachmentUpdatedSchema, public: AttachmentUpdatedSchema, staffScopes: ['chat'], publicScopes: ['chat'], aggregate: 'attachment', summary: 'Upload / scan state change (public only for visitor uploads); never an object key or scanner output.' },
  'export.ready': { payload: ExportReadySchema, public: ExportReadySchema, staffScopes: ['agent'], publicScopes: ['chat'], aggregate: 'export', summary: 'Export finished; download requires a fresh grant.' },
  'export.failed': { payload: ExportFailedSchema, public: ExportFailedSchema, staffScopes: ['agent'], publicScopes: ['chat'], aggregate: 'export', summary: 'Export failed permanently.' },
  'offline.submitted': { payload: OfflineSubmittedSchema, public: OfflineSubmittedPublicSchema, staffScopes: ['queue'], publicScopes: ['visitor'], aggregate: 'offline_submission', summary: 'Offline form received.' },
  'offline.updated': { payload: OfflineUpdatedSchema, staffScopes: ['queue'], publicScopes: [], aggregate: 'offline_submission', summary: 'Offline submission handled / reopened / replied.' },
  'privacy.updated': { payload: PrivacyUpdatedSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'privacy_request', summary: 'Privacy request progress (requesting administrator only).' },
  'privacy.erased': { payload: PrivacyErasedSchema, staffScopes: [], publicScopes: [], aggregate: 'privacy_request', summary: 'Internal: subject erasure completed (webhook source).' },
  'config.published': { payload: ConfigPublishedSchema, public: ConfigPublishedSchema, staffScopes: ['config'], publicScopes: ['config'], aggregate: 'site', summary: 'Widget configuration published; refetch (no secret config in the frame).' },
  'schedule.updated': { payload: ScheduleUpdatedSchema, staffScopes: ['team'], publicScopes: [], aggregate: 'schedule', summary: 'Schedule or exception changed.' },
  'emergency_closure.created': { payload: EmergencyClosureEventSchema, staffScopes: ['team'], publicScopes: [], aggregate: 'emergency_closure', summary: 'Emergency closure started.' },
  'emergency_closure.revoked': { payload: EmergencyClosureEventSchema, staffScopes: ['team'], publicScopes: [], aggregate: 'emergency_closure', summary: 'Emergency closure revoked.' },
  'shortcut.changed': { payload: ShortcutChangedSchema, staffScopes: ['team', 'agent'], publicScopes: [], aggregate: 'canned_reply', summary: 'Canned reply changed (refresh signal; no body/title). Personal replies only reach their owner.' },
  'notification.created': { payload: NotificationCreatedDurableSchema, staffScopes: ['agent'], publicScopes: [], aggregate: 'notification', summary: 'Durable automation notification (trigger `notify_department`).' },
  'invitation.offered': { payload: InvitationOfferedSchema, public: InvitationOfferedPublicSchema, staffScopes: [], publicScopes: ['visitor'], aggregate: 'invitation', summary: 'Proactive invitation for exactly the target visitor session.' },
  'invitation.displayed': { payload: InvitationDisplayedSchema, staffScopes: [], publicScopes: [], aggregate: 'invitation', summary: 'Internal: explicit display acknowledgement (server receipt time).' },
  'invitation.dismissed': { payload: InvitationDismissedSchema, staffScopes: [], publicScopes: [], aggregate: 'invitation', summary: 'Internal: invitation dismissed.' },
  'invitation.accepted': { payload: InvitationAcceptedSchema, staffScopes: [], publicScopes: [], aggregate: 'invitation', summary: 'Internal: invitation accepted (chat created once).' },
  'trigger.published': { payload: TriggerPublishedSchema, staffScopes: ['team'], publicScopes: [], aggregate: 'trigger', summary: 'Trigger revision published / activation changed (refresh signal on `team:all`; no definition).' },
  'trigger.updated': { payload: TriggerUpdatedSchema, staffScopes: ['team'], publicScopes: [], aggregate: 'trigger', summary: 'Trigger created, renamed, draft saved or revision restored (refresh signal on `team:all`; no definition).' },
  'trigger.webhook': { payload: TriggerWebhookSchema, staffScopes: [], publicScopes: [], aggregate: 'trigger', summary: 'Internal: named webhook job from a trigger effect.' },
  'visitor.session.started': { payload: VisitorSessionStartedSchema, staffScopes: [], publicScopes: [], aggregate: 'visitor_session', summary: 'Internal: visitor session started (trigger DSL event).' },
  'visitor.page.changed': { payload: VisitorPageChangedSchema, staffScopes: [], publicScopes: [], aggregate: 'visitor_session', summary: 'Internal: page navigation (trigger DSL event; consent-gated).' },
} satisfies Record<string, DurableEventSpec>;

export type DurableEventType = keyof typeof DurableEvents;
/** Staff / internal payload of a durable event (camelCase). */
export type DurablePayload<T extends DurableEventType> = z.infer<(typeof DurableEvents)[T]['payload']>;
/** Public (visitor namespace) payload of a durable event (camelCase). */
export type PublicDurablePayload<T extends DurableEventType> = (typeof DurableEvents)[T] extends { public: infer S extends z.ZodTypeAny } ? z.infer<S> : never;
