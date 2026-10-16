/**
 * Ephemeral frames (socket event `ephemeral`, ch. 47/48): typing, delivery receipts,
 * presence, availability, live-visitor monitoring, queue wait, monitor snapshots and
 * notification pushes. Never persisted or replayed; `expires_at` bounds their life.
 *
 * Source of truth: every `realtime.ephemeral(...)` call in `apps/api/src`.
 */
import { z } from 'zod';
import { DateTime, Uuid } from '../schemas/common.ts';
import { LiveVisitorItemSchema } from '../schemas/visitors.ts';
import { MonitorSnapshotSchema, NotificationSchema } from '../schemas/operations.ts';

export const TypingChangedStaffSchema = z.object({
  chatId: Uuid,
  actor: z.union([
    z.object({ type: z.literal('agent'), id: Uuid, displayName: z.string() }),
    z.object({ type: z.literal('visitor'), id: Uuid }),
  ]),
  isTyping: z.boolean(),
  /** `note` typing (internal note composer) never reaches the visitor. */
  mode: z.enum(['reply', 'note']).optional(),
  /** ch. 48: membership id (agent) or visitor id. */
  actorPublicId: Uuid,
  expiresAt: DateTime,
});
export const TypingChangedPublicSchema = z.object({
  chatId: Uuid,
  actor: z.object({ type: z.literal('agent'), displayName: z.string() }),
  actorPublicId: Uuid,
  isTyping: z.boolean(),
  expiresAt: DateTime,
});

/** ch. 48 {chat_id, participant_id, through_seq, at}; `participant_id` is null on public (visitor) scopes. */
export const MessageDeliveredSchema = z.object({
  chatId: Uuid,
  actorType: z.enum(['agent', 'visitor']),
  participantId: Uuid.nullable(),
  throughSeq: z.number().int(),
  at: DateTime,
});

export const AvailabilityChangedSchema = z.object({
  siteId: Uuid,
  /** ch. 48: null = site-level state (per-department states are in `departments`). */
  departmentId: Uuid.nullable(),
  configVersion: z.number().int(),
  state: z.enum(['available', 'busy', 'offline']),
  reason: z.enum([
    'open',
    'closed_hours',
    'emergency_closure',
    'no_agents',
    'at_capacity',
    'queue_full',
    'disabled',
  ]),
  nextOpenAt: DateTime.nullable(),
  departments: z.array(
    z.object({
      id: Uuid,
      label: z.string(),
      state: z.enum(['available', 'busy', 'offline']),
      nextOpenAt: DateTime.nullable(),
    }),
  ),
});

export const PresenceUpdatedSchema = z.object({
  membershipId: Uuid,
  effectiveStatus: z.enum(['online', 'away', 'invisible', 'offline']),
  desiredStatus: z.enum(['online', 'away', 'invisible']),
  connected: z.boolean(),
  activeCount: z.number().int(),
  capacity: z.number().int(),
  asOf: DateTime,
});

/** `allowed_patch` is null when the visitor left the room's scope (hidden department, gone). */
export const VisitorUpdatedSchema = z.object({
  visitorId: Uuid,
  allowedPatch: LiveVisitorItemSchema.nullable(),
  asOf: DateTime,
});
export const VisitorSessionLeftSchema = z.object({ visitorId: Uuid, sessionId: Uuid, lastSeenAt: DateTime });
/** A visitor first appeared in the live list (once per visit): the dashboard's arrival chime and notification. */
export const VisitorArrivedSchema = z.object({
  visitorId: Uuid,
  displayName: z.string(),
  country: z.string().nullable(),
  /** The page title, else its URL. */
  page: z.string().nullable(),
  asOf: DateTime,
});

export const QueueWaitExceededPublicSchema = z.object({
  chatId: Uuid,
  options: z.array(z.enum(['continue', 'offline_form'])),
  waitedSeconds: z.number(),
  departmentId: Uuid.nullable(),
  fallbackDepartmentId: Uuid.nullable(),
  fallbackLabel: z.string().nullable(),
});
export const QueueWaitExceededStaffSchema = QueueWaitExceededPublicSchema.extend({
  thresholdSeconds: z.number(),
});

export const MonitorUpdatedSchema = z.object({
  snapshot: MonitorSnapshotSchema,
  asOf: DateTime,
  stale: z.boolean(),
});
export const NotificationCreatedSchema = z.object({
  notification: NotificationSchema,
  unreadCount: z.number().int(),
});
export const NotificationReadPushSchema = z.object({
  ids: z.array(Uuid).nullable(),
  all: z.boolean(),
  unreadCount: z.number().int(),
});

type Kind = 'chat' | 'queue' | 'visitor' | 'config' | 'agent' | 'team';
export interface EphemeralEventSpec {
  staff?: z.ZodTypeAny;
  public?: z.ZodTypeAny;
  staffScopes: Kind[];
  publicScopes: Kind[];
  summary: string;
}

/** Coalesced per department (≤ 1 per 500 ms per tenant); only that department's queue room receives it. */
export const QueueUpdatedSchema = z.object({
  departmentId: Uuid.nullable(),
  waitingCount: z.number().int().min(0),
  oldestRequestedAt: DateTime.nullable(),
  asOf: DateTime,
});

export const EphemeralEvents = {
  'typing.changed': {
    staff: TypingChangedStaffSchema,
    public: TypingChangedPublicSchema,
    staffScopes: ['chat'],
    publicScopes: ['chat'],
    summary: 'Typing indicator (≤ 1 per 2 s per connection; note-mode typing is staff-only).',
  },
  'message.delivered': {
    staff: MessageDeliveredSchema,
    public: MessageDeliveredSchema,
    staffScopes: ['chat'],
    publicScopes: ['chat'],
    summary: 'Delivery cursor advanced by the other side.',
  },
  'availability.changed': {
    staff: AvailabilityChangedSchema,
    public: AvailabilityChangedSchema,
    staffScopes: ['config'],
    publicScopes: ['config'],
    summary: 'Site availability changed (staff copy on the team room, scope kind `config`).',
  },
  'queue.updated': {
    staff: QueueUpdatedSchema,
    staffScopes: ['queue'],
    publicScopes: [],
    summary: 'Waiting count and oldest request for one department queue (`queue:none` = no department).',
  },
  'presence.updated': {
    staff: PresenceUpdatedSchema,
    staffScopes: ['team'],
    publicScopes: [],
    summary: 'Agent presence / load (team room).',
  },
  'visitor.updated': {
    staff: VisitorUpdatedSchema,
    staffScopes: ['visitor', 'queue'],
    publicScopes: [],
    summary: 'Coalesced live-visitor row (scope `visitor:all` or the department queue room).',
  },
  'visitor.session.left': {
    staff: VisitorSessionLeftSchema,
    staffScopes: ['visitor', 'queue'],
    publicScopes: [],
    summary: 'A browsing session ended (keep live chats).',
  },
  'visitor.arrived': {
    staff: VisitorArrivedSchema,
    staffScopes: ['visitor'],
    publicScopes: [],
    summary:
      'A visitor arrived on the website (first listed; page changes within a visit are not arrivals). Scope `visitor:all`.',
  },
  'queue.wait_exceeded': {
    staff: QueueWaitExceededStaffSchema,
    public: QueueWaitExceededPublicSchema,
    staffScopes: ['chat'],
    publicScopes: ['chat'],
    summary: 'Queue wait threshold passed; visitor may continue or leave a message.',
  },
  'monitor.updated': {
    staff: MonitorUpdatedSchema,
    staffScopes: ['agent'],
    publicScopes: [],
    summary: 'Supervisor monitor snapshot (≤ 5 s cadence, personal agent room).',
  },
  'notification.created': {
    staff: NotificationCreatedSchema,
    staffScopes: ['agent'],
    publicScopes: [],
    summary: 'In-app notification push with the new unread count.',
  },
  'notification.read': {
    staff: NotificationReadPushSchema,
    staffScopes: ['agent'],
    publicScopes: [],
    summary: 'Other tabs of the same agent mark notifications read.',
  },
} satisfies Record<string, EphemeralEventSpec>;

export type EphemeralEventType = keyof typeof EphemeralEvents;
