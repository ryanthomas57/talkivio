/**
 * Offline submissions, notifications, analytics reports, monitoring, integrations
 * (tokens, webhooks, connectors), audit events and privacy (ch. 23, 45, 49–54).
 */
import { z } from 'zod';
import { DateTime, DepartmentScopeSchema, JsonObject, RoleSchema, Uuid } from './common.ts';

// ───────── Offline submissions ─────────
export const OfflineReceiptSchema = z.object({
  id: Uuid,
  reference: z.string(),
  status: z.literal('received'),
  createdAt: DateTime,
  departmentId: Uuid.nullable(),
  sourceChatId: Uuid.nullable(),
  conversionReason: z.string().nullable(),
  notifications: z.object({ confirmation: z.enum(['pending', 'disabled']), team: z.enum(['pending', 'disabled']) }),
});
const OfflineSummaryShape = {
  id: Uuid,
  reference: z.string(),
  siteId: Uuid,
  departmentId: Uuid.nullable(),
  visitorId: Uuid.nullable(),
  name: z.string().nullable(),
  emailMasked: z.string(),
  messagePreview: z.string(),
  status: z.string(),
  sourceChatId: Uuid.nullable(),
  conversionReason: z.string().nullable(),
  handledAt: DateTime.nullable(),
  handledById: Uuid.nullable(),
  createdAt: DateTime,
  version: z.number().int(),
};
export const OfflineSubmissionSchema = z.object(OfflineSummaryShape);
const { messagePreview: _preview, ...OfflineDetailBase } = OfflineSummaryShape;
export const OfflineSubmissionDetailSchema = z.object({
  ...OfflineDetailBase,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  message: z.string(),
  customFields: JsonObject,
  handledBy: z.object({ id: Uuid, displayName: z.string() }).nullable(),
  /** `emailText` is the exact text e-mailed to the submitter ("[erased]" after privacy erasure). */
  replies: z.array(z.object({ id: Uuid, status: z.string(), createdAt: DateTime, acceptedAt: DateTime.nullable(), emailText: z.string().nullable() })),
});

// ───────── Notifications ─────────
export const NotificationSchema = z.object({ id: Uuid, type: z.string(), title: z.string(), body: z.string(), link: z.string().nullable(), read: z.boolean(), readAt: DateTime.nullable(), createdAt: DateTime });
export const NotificationListSchema = z.object({ items: z.array(NotificationSchema), unreadCount: z.number().int(), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const NotificationsReadAllSchema = z.object({ updated: z.number().int(), unreadCount: z.number().int() });
export const NotificationReadSchema = z.object({ id: Uuid, readAt: DateTime, unreadCount: z.number().int() });

// ───────── Analytics ─────────
/** Measure shape (ch. 50): value with numerator, denominator, n and percentiles where defined. */
export const MeasureValueSchema = z.object({
  value: z.number().nullable(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  n: z.number().int(),
  median: z.number().nullable().optional(),
  p90: z.number().nullable().optional(),
  p95: z.number().nullable().optional(),
});
export const MeasureKeySchema = z.enum([
  'requested',
  'assigned',
  'served',
  'missed',
  'abandoned',
  'quick_cancellations',
  'missed_rate',
  'abandoned_rate',
  'wait_to_assignment',
  'first_response_time',
  'service_response_time',
  'chat_duration',
  'ratings_good',
  'ratings_bad',
  'csat',
  'response_rate',
  'invitations_displayed',
  'invitations_accepted',
  'offline_submissions',
]);
export const ReportedMeasureSchema = MeasureValueSchema.extend({
  key: MeasureKeySchema,
  label: z.string(),
  kind: z.enum(['count', 'rate', 'duration']),
  unit: z.enum(['chats', 'ratings', 'invitations', 'submissions', 'percent', 'seconds']),
  population: z.string(),
  definition: z.string(),
  nullPolicy: z.string(),
  percentileMethod: z.string().optional(),
  comparison: MeasureValueSchema.extend({ change: z.number().nullable(), changePct: z.number().nullable(), label: z.enum(['comparable', 'new', 'not_comparable']) }).nullable(),
});
const Range = { from: DateTime, to: DateTime, timezone: z.string(), timezoneLabel: z.string() };
const RawFreshness = z.object({ asOf: DateTime, source: z.literal('raw'), sourceWatermark: DateTime, lagMs: z.number(), stale: z.boolean() });

export const ChatsReportSchema = z.object({
  report: z.literal('chats'),
  definitionsVersion: z.number().int(),
  range: z.object({ ...Range, utcOffsets: z.array(z.string()), groupBy: z.enum(['hour', 'day', 'week']), halfOpen: z.literal(true) }),
  comparisonRange: z.object({ from: DateTime, to: DateTime }).nullable(),
  filters: z.record(z.string().nullable()),
  scope: z.object({ departmentIds: DepartmentScopeSchema }),
  measureKeys: z.array(MeasureKeySchema),
  measures: z.record(ReportedMeasureSchema),
  series: z.array(z.object({ key: z.string(), start: DateTime, end: DateTime, unitHours: z.number(), measures: z.record(MeasureValueSchema) })),
  freshness: z.object({
    asOf: DateTime,
    updatedAt: DateTime.nullable(),
    sourceWatermark: DateTime,
    lagMs: z.number(),
    pendingFacts: z.number().int(),
    status: z.enum(['fresh', 'lagging']),
    stale: z.boolean(),
    source: z.enum(['facts', 'raw']),
    cached: z.boolean(),
  }),
});

const Distribution = z.object({
  n: z.number().int(),
  median: z.number().nullable(),
  p90: z.number().nullable(),
  p95: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.literal('seconds'),
  nullPolicy: z.string(),
});
export const AgentsReportSchema = z.object({
  report: z.literal('agents'),
  definitionsVersion: z.number().int(),
  range: z.object({ ...Range, halfOpen: z.boolean() }),
  filters: z.object({ departmentId: Uuid.nullable(), agentId: Uuid.nullable(), siteId: Uuid.nullable() }),
  scope: z.object({ departmentIds: DepartmentScopeSchema }),
  definitions: z.object({
    handledChats: z.string(),
    ownedSeconds: z.string(),
    replies: z.string(),
    firstResponseTime: z.string(),
    responseTime: z.string(),
    utilization: z.string(),
    percentileMethod: z.string(),
    capacity: z.string(),
  }),
  agents: z.array(
    z.object({
      membershipId: Uuid,
      displayName: z.string(),
      role: RoleSchema,
      enabled: z.boolean(),
      capacity: z.number().int(),
      departmentIds: z.array(Uuid),
      handledChats: z.number().int(),
      ownedSeconds: z.number(),
      replies: z.number().int(),
      repliedChats: z.number().int(),
      transfersIn: z.number().int(),
      transfersOut: z.number().int(),
      firstResponses: z.number().int(),
      firstResponseTime: Distribution,
      responseTime: Distribution,
      onlineSeconds: z.number(),
      availableSlotSeconds: z.number(),
      occupiedSlotSeconds: z.number(),
      utilization: z.object({ value: z.number().nullable(), raw: z.number().nullable(), numerator: z.number(), denominator: z.number(), unit: z.string(), cappedForReporting: z.boolean(), invariantViolation: z.boolean() }),
      ratings: z.object({ good: z.number().int(), bad: z.number().int(), csat: z.object({ value: z.number().nullable(), numerator: z.number(), denominator: z.number(), n: z.number().int() }) }),
    }),
  ),
  totals: z.object({
    agents: z.number().int(),
    distinctChatsHandled: z.number().int(),
    handledChatsSum: z.number().int(),
    replies: z.number().int(),
    firstResponses: z.number().int(),
    ownedSeconds: z.number(),
    onlineSeconds: z.number(),
    availableSlotSeconds: z.number(),
    occupiedSlotSeconds: z.number(),
    utilization: z.number().nullable(),
  }),
  freshness: RawFreshness,
});

const Funnel = { eligible: z.number().int(), displayed: z.number().int(), accepted: z.number().int(), served: z.number().int(), displayRate: z.number().nullable(), acceptanceRate: z.number().nullable(), serveRate: z.number().nullable() };
export const InvitationsReportSchema = z.object({
  report: z.literal('invitations'),
  definitionsVersion: z.number().int(),
  range: z.object({ ...Range, halfOpen: z.boolean() }),
  filters: z.object({ siteId: Uuid.nullable(), campaignId: Uuid.nullable(), departmentId: Uuid.nullable() }),
  scope: z.object({ departmentIds: DepartmentScopeSchema }),
  definitions: z.object({ population: z.string(), displayed: z.string(), accepted: z.string(), served: z.string(), rates: z.string() }),
  totals: z.object(Funnel),
  campaigns: z.array(z.object({ ...Funnel, campaignId: Uuid, name: z.string().nullable() })),
  freshness: RawFreshness,
});

export const AnalyticsExportSchema = z.object({
  id: Uuid,
  report: z.string(),
  format: z.literal('csv'),
  state: z.string(),
  progress: z.number().nullable(),
  attempts: z.number().int(),
  filters: JsonObject,
  createdAt: DateTime,
  completedAt: DateTime.nullable(),
  expiresAt: DateTime.nullable(),
  rowCount: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  filename: z.string().nullable(),
  sourceWatermark: DateTime.nullable(),
  totals: z.record(z.number().nullable()).nullable(),
  errorCode: z.string().nullable(),
  downloadPath: z.string().nullable(),
});

// ───────── Monitor ─────────
const WaitLevel = z.enum(['none', 'ok', 'warning', 'critical']);
export const DepartmentLoadSchema = z.object({
  departmentId: Uuid.nullable(),
  name: z.string(),
  queued: z.number().int(),
  oldestWaitSeconds: z.number().nullable(),
  oldestWaitLevel: WaitLevel,
  active: z.number().int(),
  offeredReservations: z.number().int(),
  responseBacklog: z.number().int(),
  onlineAgents: z.number().int(),
  availableAgents: z.number().int(),
  busy: z.boolean(),
});
export const MonitorSnapshotSchema = z.object({
  asOf: DateTime,
  sourceWatermark: DateTime.nullable(),
  freshnessMs: z.number(),
  stale: z.boolean(),
  scope: z.object({ departmentIds: DepartmentScopeSchema, departmentId: Uuid.nullable(), siteId: Uuid.nullable() }),
  thresholds: z.object({ queueWarningSeconds: z.number(), queueCriticalSeconds: z.number(), staleAfterMs: z.number() }),
  counters: z.object({
    queued: z.number().int(),
    oldestWaitSeconds: z.number().nullable(),
    oldestRequestedAt: DateTime.nullable(),
    oldestWaitLevel: WaitLevel,
    oldestWaitWarning: z.boolean(),
    oldestWaitCritical: z.boolean(),
    active: z.number().int(),
    availableAgents: z.number().int(),
    onlineAgents: z.number().int(),
    offeredReservations: z.number().int(),
    responseBacklog: z.number().int(),
    csat: z.object({ value: z.number().nullable(), numerator: z.number(), denominator: z.number(), n: z.number().int(), window: z.literal('today'), windowStart: DateTime, timezone: z.string() }),
  }),
  busyDepartments: z.array(DepartmentLoadSchema),
  departments: z.array(DepartmentLoadSchema),
  agents: z.array(
    z.object({
      membershipId: Uuid,
      displayName: z.string(),
      role: RoleSchema,
      effectiveStatus: z.enum(['online', 'away', 'invisible', 'offline']),
      desiredStatus: z.enum(['online', 'away', 'invisible']),
      connected: z.boolean(),
      capacity: z.number().int(),
      activeChats: z.number().int(),
      collaborations: z.number().int(),
      reservedOffers: z.number().int(),
      loadPct: z.number().nullable(),
      atCapacity: z.boolean(),
      available: z.boolean(),
      responseBacklog: z.number().int(),
      oldestUnansweredAt: DateTime.nullable(),
      oldestUnansweredSeconds: z.number().nullable(),
      departmentIds: z.array(Uuid),
    }),
  ),
});

// ───────── Integrations ─────────
const TokenShape = {
  id: Uuid,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked']),
  createdBy: Uuid.nullable(),
  createdByName: z.string().nullable(),
  createdAt: DateTime,
  expiresAt: DateTime,
  lastUsedAt: DateTime.nullable(),
  rotatedAt: DateTime.nullable(),
  revokedAt: DateTime.nullable(),
};
export const IntegrationTokenSchema = z.object(TokenShape);
/** `GET /integration-tokens/scopes`: what each scope grants and whether the caller may grant it. */
export const IntegrationTokenScopeSchema = z.object({ scope: z.string(), permissions: z.array(z.string()), grantable: z.boolean() });
/** Create / rotate result: the bearer `rdt_…` secret is returned once (null on an idempotent replay). */
export const IntegrationTokenSecretSchema = z.object({ ...TokenShape, token: z.string().nullable(), tokenShownOnce: z.boolean() });

const WebhookShape = {
  id: Uuid,
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  secretHint: z.string(),
  signingGeneration: z.number().int(),
  previousSecretExpiresAt: DateTime.nullable(),
  lastSuccessAt: DateTime.nullable(),
  failureCount: z.number().int(),
  createdAt: DateTime,
  updatedAt: DateTime,
  version: z.number().int(),
};
/** List items also carry the latest delivery attempt (no N+1 calls). */
export const WebhookEndpointSchema = z.object({
  ...WebhookShape,
  lastDelivery: z.object({ eventType: z.string(), status: z.string(), responseStatus: z.number().int().nullable(), error: z.string().nullable(), at: DateTime }).nullable().optional(),
});
/** Create / rotate-secret result: the signing secret is returned once (null on an idempotent replay). */
export const WebhookEndpointSecretSchema = z.object({ ...WebhookShape, secret: z.string().nullable(), secretShownOnce: z.boolean() });
export const WebhookEventTypesSchema = z.object({
  eventTypes: z.array(z.string()),
  signature: z.object({ header: z.string(), scheme: z.string(), timestampHeader: z.string(), toleranceSeconds: z.number().int() }),
  retryScheduleSeconds: z.array(z.number().int()),
});
export const WebhookDeliverySchema = z.object({
  id: Uuid,
  endpointId: Uuid,
  eventId: Uuid,
  eventType: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  nextAttemptAt: DateTime.nullable(),
  responseStatus: z.number().int().nullable(),
  responseExcerpt: z.string().nullable(),
  lastError: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  deliveredAt: DateTime.nullable(),
  createdAt: DateTime,
});
export const ConnectorSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  category: z.string(),
  capabilities: z.array(z.string()),
  status: z.enum(['disabled', 'configured_unverified', 'healthy', 'unhealthy']),
  statusReason: z.enum(['no_credentials', 'adapter_not_available', 'awaiting_health_check', 'health_check_passed', 'health_check_failed']),
  adapterAvailable: z.boolean(),
  credentialFields: z.array(z.string()),
  transmits: z.array(z.string()),
  note: z.string(),
  /** Present on a health-check result. */
  checkedAt: DateTime.optional(),
  detail: z.string().optional(),
});

// ───────── Audit & privacy ─────────
/** Append-only audit record; `safeDiff` is an opaque map (keys kept verbatim). */
export const AuditEventSchema = z.object({
  id: Uuid,
  occurredAt: DateTime,
  actor: z.object({ type: z.string(), id: z.string().nullable(), name: z.string().nullable() }),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string().nullable(),
  outcome: z.string(),
  safeDiff: z.unknown(),
  requestId: z.string().nullable(),
});
export const PrivacyRequestSchema = z.object({
  id: Uuid,
  kind: z.enum(['access', 'erase']),
  visitorId: Uuid.nullable(),
  state: z.enum(['pending_verification', 'queued', 'running', 'completed', 'failed']),
  requestedBy: Uuid.nullable(),
  hasProof: z.boolean(),
  verifiedAt: DateTime.nullable(),
  completedAt: DateTime.nullable(),
  createdAt: DateTime,
  updatedAt: DateTime,
  job: z.object({ id: Uuid, state: z.string(), attempts: z.number().int(), progress: z.number().nullable(), errorCode: z.string().nullable() }).nullable(),
  report: JsonObject,
  /** The subject's display name (null once erased); on list items and GET detail. */
  subject: z.object({ displayName: z.string().nullable(), erased: z.boolean() }).optional(),
});
export const RetentionReportSchema = z.object({
  dryRun: z.boolean(),
  generatedAt: DateTime,
  policy: z.object({ transcriptRetentionDays: z.number().int(), pageEventRetentionDays: z.number().int(), webhookDeliveryRetentionDays: z.number().int(), verificationEvidenceRetentionDays: z.number().int(), batchSize: z.number().int() }),
  cutoffs: z.object({ transcripts: DateTime, pageEvents: DateTime, webhookDeliveries: DateTime, verificationEvidence: DateTime }),
  targets: z.object({
    closedChats: z.number().int(),
    messages: z.number().int(),
    attachments: z.number().int(),
    transcriptExports: z.number().int(),
    pageEvents: z.number().int(),
    expiredPrivacyExports: z.number().int(),
    webhookDeliveries: z.number().int(),
    verificationEvidence: z.number().int(),
  }),
  remainingAfterBatch: z.boolean(),
  legalHolds: z.object({ modeled: z.literal(false), note: z.string() }),
  failures: z.array(z.string()),
});

// ───────── Health ─────────
export const HealthLiveSchema = z.object({ status: z.string(), uptime: z.number(), process: z.string() });

export type OfflineSubmission = z.infer<typeof OfflineSubmissionSchema>;
export type OfflineSubmissionDetail = z.infer<typeof OfflineSubmissionDetailSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type ChatsReport = z.infer<typeof ChatsReportSchema>;
export type MeasureValue = z.infer<typeof MeasureValueSchema>;
export type MonitorSnapshot = z.infer<typeof MonitorSnapshotSchema>;
export type IntegrationToken = z.infer<typeof IntegrationTokenSchema>;
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type PrivacyRequest = z.infer<typeof PrivacyRequestSchema>;
