/** Canned replies (shortcuts), triggers / campaigns and schedules (ch. 42/44/45). */
import { z } from 'zod';
import { DateTime, Json, Uuid } from './common.ts';
import { WeeklyIntervalsSchema } from './auth.ts';

// ───────── Shortcuts ─────────
export const ShortcutSchema = z.object({
  id: Uuid,
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  scopeType: z.enum(['tenant', 'department', 'personal']),
  scopeId: Uuid.nullable(),
  enabled: z.boolean(),
  options: z.array(z.string()),
  tags: z.array(z.string()),
  placeholders: z.array(z.string()),
  usageCount: z.number().int(),
  archivedAt: DateTime.nullable(),
  createdAt: DateTime,
  updatedAt: DateTime,
  version: z.number().int(),
  editable: z.boolean(),
});

export const ShortcutImportPreviewSchema = z.object({
  previewToken: z.string().nullable(),
  expiresAt: DateTime.nullable(),
  summary: z.object({ total: z.number().int(), valid: z.number().int(), rejected: z.number().int() }),
  capacityError: z.string().nullable(),
  rows: z.array(
    z.object({
      line: z.number().int(),
      slug: z.string(),
      title: z.string(),
      scopeType: z.string(),
      scopeId: Uuid.nullable(),
      status: z.enum(['valid', 'rejected']),
      action: z.enum(['create', 'restore']).nullable(),
      errors: z.array(z.string()),
    }),
  ),
});
export const ShortcutImportResultSchema = z.object({ committed: z.number().int(), restored: z.number().int(), items: z.array(ShortcutSchema) });
export const ShortcutRenderSchema = z.object({
  /** null for `POST /shortcuts/render-preview` (unsaved editor text). */
  replyId: Uuid.nullable(),
  text: z.string(),
  unresolved: z.array(z.enum(['visitor.name', 'agent.display_name', 'department.name', 'site.name'])),
  canSend: z.boolean(),
  options: z.array(z.string()),
});

// ───────── Triggers ─────────
export const TriggerEventSchema = z.enum(['chat.requested', 'chat.queued', 'chat.closed', 'message.created', 'offline.submitted', 'visitor.session.started', 'visitor.page.changed', 'visitor.timer.elapsed']);

const TriggerSummaryShape = {
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  event: z.string(),
  priority: z.number().int(),
  currentRevision: z.number().int(),
  publishedRevision: z.number().int().nullable(),
  draftPending: z.boolean(),
  lastMatchedAt: DateTime.nullable(),
  matchCount: z.number().int(),
  errorCount: z.number().int(),
  archivedAt: DateTime.nullable(),
  createdAt: DateTime,
  updatedAt: DateTime,
  version: z.number().int(),
};
export const TriggerSummarySchema = z.object(TriggerSummaryShape);
/** List row: summary plus the current definition (DSL keys are already snake_case). */
export const TriggerListItemSchema = z.object({ ...TriggerSummaryShape, definition: Json });

export const TriggerRevisionSchema = z.object({ revision: z.number().int(), dslVersion: z.number().int(), definition: Json, publishedAt: DateTime.nullable(), publishedBy: z.string().nullable(), createdAt: DateTime });
export const TriggerDetailSchema = z.object({
  ...TriggerSummaryShape,
  draft: TriggerRevisionSchema.nullable(),
  published: TriggerRevisionSchema.nullable(),
  revisions: z.array(z.object({ revision: z.number().int(), publishedAt: DateTime.nullable(), publishedBy: z.string().nullable(), createdAt: DateTime })),
});
export const TriggerDraftResultSchema = z.object({ trigger: TriggerSummarySchema, draft: z.object({ revision: z.number().int(), definition: Json, publishedAt: z.null() }) });

const ConditionTrace = z.object({
  index: z.number().int(),
  field: z.string(),
  op: z.string(),
  value: Json.optional(),
  result: z.boolean(),
  missing: z.boolean(),
  error: z.literal('type_mismatch').optional(),
});
export const TriggerSimulationSchema = z.object({
  event: TriggerEventSchema,
  triggerId: Uuid,
  /** null when the unsaved editor `definition` was simulated. */
  revision: z.number().int().nullable(),
  snapshot: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable()),
  triggers: z.array(
    z.object({
      name: z.string().nullable(),
      candidate: z.boolean(),
      triggerId: Uuid,
      revision: z.number().int(),
      priority: z.number().int(),
      position: z.number().int(),
      evaluated: z.boolean(),
      matched: z.boolean(),
      fired: z.boolean(),
      reason: z.enum(['fired', 'conditions_false', 'cooldown', 'recursion', 'depth_limit', 'event_mismatch', 'after_stop']),
      stopProcessing: z.boolean(),
      allResult: z.boolean(),
      anyResult: z.boolean(),
      all: z.array(ConditionTrace),
      any: z.array(ConditionTrace),
    }),
  ),
  effects: z.array(z.object({ triggerId: Uuid, revision: z.number().int(), actionIndex: z.number().int(), action: Json })),
  suppressed: z.array(z.object({ triggerId: Uuid, revision: z.number().int(), actionIndex: z.number().int(), type: z.string(), reason: z.string() })),
  stoppedBy: Uuid.nullable(),
  blocked: z.boolean(),
  writes: z.boolean(),
});

export const TriggerRunSchema = z.object({
  id: Uuid,
  triggerId: Uuid,
  triggerRevision: z.number().int(),
  eventId: Uuid,
  eventType: z.string(),
  visitorSessionId: Uuid.nullable(),
  chatId: Uuid.nullable(),
  matched: z.boolean(),
  causationId: Uuid.nullable(),
  depth: z.number().int(),
  executedAt: DateTime,
  result: Json,
  effects: z.array(z.object({ id: Uuid, actionIndex: z.number().int(), actionType: z.string(), status: z.string(), reason: z.string().nullable(), executedAt: DateTime.nullable() })),
});
export const TriggerFunnelSchema = z.object({
  campaignId: Uuid,
  from: DateTime.nullable(),
  to: DateTime.nullable(),
  eligible: z.number().int(),
  displayed: z.number().int(),
  accepted: z.number().int(),
  /** Chats with first_assigned_at set (assigned is not served). */
  assigned: z.number().int(),
  /** Chats with at least one human agent public message (same definition as analytics). */
  served: z.number().int(),
  dismissed: z.number().int(),
  expired: z.number().int(),
});

// ───────── Schedules ─────────
const TimeRange = z.object({ start: z.string(), end: z.string() });
export const ScheduleSchema = z.object({
  id: Uuid,
  name: z.string(),
  timezone: z.string(),
  weeklyIntervals: WeeklyIntervalsSchema,
  exceptionCount: z.number().int(),
  isTenantDefault: z.boolean(),
  archivedAt: DateTime.nullable(),
  version: z.number().int(),
  createdAt: DateTime,
  updatedAt: DateTime,
  state: z.object({ open: z.boolean(), nextBoundary: z.object({ kind: z.enum(['open', 'close']), at: DateTime, local: z.string(), localLabel: z.string() }).nullable() }).nullable(),
});
export const ScheduleExceptionSchema = z.object({ date: z.string(), intervals: z.array(TimeRange), closed: z.boolean(), reason: z.string().nullable(), createdAt: DateTime });
const ScheduleImpact = z.object({ inUse: z.boolean(), openBefore: z.boolean(), openAfter: z.boolean(), closesServiceNow: z.boolean() });
export const ScheduleDetailSchema = ScheduleSchema.extend({
  exceptions: z.array(ScheduleExceptionSchema),
  usage: z.object({ departments: z.array(z.object({ id: Uuid, name: z.string() })), sites: z.array(z.object({ id: Uuid, name: z.string() })), tenantDefault: z.boolean() }),
});
export const ScheduleUpdateResultSchema = z.object({ schedule: ScheduleSchema, impact: ScheduleImpact, applied: z.boolean() });
export const ScheduleExceptionResultSchema = z.object({ exception: ScheduleExceptionSchema, scheduleVersion: z.number().int(), impact: ScheduleImpact, applied: z.boolean() });
export const SchedulePreviewSchema = z.object({
  scheduleId: Uuid,
  version: z.number().int(),
  name: z.string(),
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
  openAtFrom: z.boolean(),
  nextOpenAt: z.string().nullable(),
  boundaries: z.array(
    z.object({
      kind: z.enum(['open', 'close']),
      at: z.string(),
      local: z.string(),
      localLabel: z.string(),
      utcOffset: z.string(),
      localDate: z.string(),
      source: z.enum(['weekly', 'exception']),
      dst: z.object({ kind: z.enum(['dst_gap', 'dst_fold']), requestedLocal: z.string(), resolution: z.enum(['first_valid_after_gap', 'earlier', 'later']) }).nullable(),
      note: z.string().nullable(),
    }),
  ),
  intervals: z.array(z.object({ start: z.string(), end: z.string(), startLocal: z.string(), endLocal: z.string(), localDate: z.string(), source: z.enum(['weekly', 'exception']) })),
  transitions: z.array(z.object({ at: z.string(), offsetBefore: z.string(), offsetAfter: z.string(), kind: z.enum(['forward', 'backward']), localBefore: z.string(), localAfter: z.string(), note: z.string() })),
});
export const EmergencyClosureSchema = z.object({
  id: Uuid,
  scope: z.enum(['tenant', 'department', 'site']),
  siteId: Uuid.nullable(),
  departmentId: Uuid.nullable(),
  startsAt: DateTime,
  endsAt: DateTime.nullable(),
  reason: z.string(),
  createdBy: Uuid,
  revokedAt: DateTime.nullable(),
  createdAt: DateTime,
  state: z.enum(['scheduled', 'active', 'expired', 'revoked']),
});

export type Shortcut = z.infer<typeof ShortcutSchema>;
export type TriggerSummary = z.infer<typeof TriggerSummarySchema>;
export type TriggerDetail = z.infer<typeof TriggerDetailSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type EmergencyClosure = z.infer<typeof EmergencyClosureSchema>;
