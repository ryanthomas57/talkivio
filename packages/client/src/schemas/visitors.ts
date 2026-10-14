/** Visitors (staff projections), live monitoring, bans and custom fields (ch. 43). */
import { z } from 'zod';
import { DateTime, JsonObject, Uuid } from './common.ts';

export const VisitorTagRefSchema = z.object({
  source: z.string(),
  id: Uuid,
  slug: z.string(),
  label: z.string(),
});

const ContactField = z.object({ value: z.string().nullable(), verified: z.boolean() });
const Device = z.object({
  category: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
});

/** Staff visitor profile (`GET /visitors/{id}`). `fields` is an opaque map (keys kept verbatim). */
export const StaffVisitorSchema = z.object({
  id: Uuid,
  siteId: Uuid,
  displayName: z.string(),
  anonymousLabel: z.string(),
  verified: z.boolean(),
  identityVerified: z.boolean(),
  identities: z.array(z.object({ issuerSiteId: Uuid, verificationMethod: z.string(), linkedAt: DateTime })),
  fields: z.object({ name: ContactField, email: ContactField, phone: ContactField }),
  allowedContactFields: z.array(z.string()),
  tags: z.array(VisitorTagRefSchema),
  customFields: JsonObject,
  /** Per custom-field key: who set the value — `visitor` (the site's page via the SDK, unverified), `agent` (membership id) or `trigger` (trigger id). */
  customFieldSources: z.record(
    z.object({ source: z.enum(['visitor', 'agent', 'trigger']), by: Uuid.nullable(), at: DateTime }),
  ),
  firstSeenAt: DateTime,
  lastSeenAt: DateTime,
  visitCount: z.number().int(),
  chatCount: z.number().int(),
  location: z
    .object({
      countryCode: z.string().nullable(),
      region: z.string().nullable(),
      city: z.string().nullable(),
      approximate: z.boolean(),
    })
    .nullable(),
  device: Device,
  language: z.string().nullable(),
  timezone: z.string().nullable(),
  online: z.boolean(),
  sessionSummary: z.object({
    total: z.number().int(),
    open: z.number().int(),
    lastStartedAt: DateTime.nullable(),
  }),
  erased: z.boolean(),
  version: z.number().int(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const VisitorListItemSchema = z.object({
  id: Uuid,
  siteId: Uuid,
  displayName: z.string(),
  anonymousLabel: z.string(),
  verified: z.boolean(),
  identityVerified: z.boolean(),
  email: z.string().nullable(),
  tags: z.array(VisitorTagRefSchema),
  firstSeenAt: DateTime,
  lastSeenAt: DateTime,
  visitCount: z.number().int(),
  chatCount: z.number().int(),
  countryCode: z.string().nullable(),
  online: z.boolean(),
});

export const VisitorSessionSchema = z.object({
  id: Uuid,
  siteId: Uuid,
  startedAt: DateTime,
  lastSeenAt: DateTime,
  endedAt: DateTime.nullable(),
  live: z.boolean(),
  analyticsConsent: z.string(),
  browsingHidden: z.boolean(),
  device: Device,
  country: z.string().nullable(),
  /** Present only while the workspace stores visitor IP addresses (settings.tracking.retainIp). */
  ipAddress: z.string().nullable(),
  network: z.string().nullable(),
  referrerOrigin: z.string().nullable(),
  landingUrl: z.string().nullable(),
  pageViewCount: z.number().int().nullable(),
  pages: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      enteredAt: DateTime,
      leftAt: DateTime.nullable(),
      dwellMs: z.number(),
    }),
  ),
  pagesTruncated: z.boolean(),
  visibleMs: z.number().nullable(),
  exclusiveVisibleMs: z.number().nullable(),
  isPreview: z.boolean(),
});

/** `version` is the visitor's new entity version (keeps the profile If-Match token current). */
export const VisitorTagsSchema = z.object({
  visitorId: Uuid,
  tags: z.array(VisitorTagRefSchema),
  version: z.number().int(),
});

export const LiveSessionItemSchema = z.object({
  sessionId: Uuid,
  siteId: Uuid,
  connections: z.number().int(),
  visible: z.boolean(),
  mostRecent: z.boolean(),
  browsingHidden: z.boolean(),
  startedAt: DateTime.nullable(),
  currentUrl: z.string().nullable(),
  currentTitle: z.string().nullable(),
  referrerOrigin: z.string().nullable(),
  pageEnteredAt: DateTime.nullable(),
  pageDwellMs: z.number().nullable(),
});

/** Live visitor list row (also the `allowed_patch` of `visitor.updated` frames). */
export const LiveVisitorItemSchema = z.object({
  visitorId: Uuid,
  group: z.enum(['served', 'incoming', 'browsing', 'idle']),
  displayName: z.string(),
  anonymousLabel: z.string(),
  identity: z.object({ verified: z.boolean(), identified: z.boolean() }),
  siteId: Uuid.nullable(),
  online: z.boolean(),
  connections: z.number().int(),
  browsingHidden: z.boolean(),
  currentUrl: z.string().nullable(),
  currentTitle: z.string().nullable(),
  referrerOrigin: z.string().nullable(),
  mostRecentSessionId: Uuid.nullable(),
  pageEnteredAt: DateTime.nullable(),
  pageDwellMs: z.number().nullable(),
  arrivedAt: DateTime.nullable(),
  timeOnSiteMs: z.number().nullable(),
  country: z.string().nullable(),
  /** Most recent visit's IP address and network owner, while the workspace stores them (settings.tracking.retainIp). */
  ipAddress: z.string().nullable(),
  network: z.string().nullable(),
  deviceCategory: z.string().nullable(),
  sessionCount: z.number().int().nullable(),
  lastActivityAt: DateTime.nullable(),
  idle: z.boolean(),
  tags: z.array(z.object({ id: Uuid, slug: z.string(), label: z.string() })),
  chat: z
    .object({
      id: Uuid,
      status: z.string(),
      departmentId: Uuid.nullable(),
      departmentName: z.string().nullable(),
      ownerMembershipId: Uuid.nullable(),
      requestedAt: DateTime,
      waitMs: z.number(),
    })
    .nullable(),
  sessions: z.array(LiveSessionItemSchema),
});

export const LiveVisitorsSchema = z.object({
  items: z.array(LiveVisitorItemSchema),
  asOf: DateTime,
  snapshotCursor: z.string(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  mode: z.string(),
  omittedBrowsing: z.boolean(),
  counts: z.union([
    z.object({
      served: z.number().int(),
      incoming: z.number().int(),
      browsing: z.number().int(),
      idle: z.number().int(),
    }),
    z.object({ incoming: z.number().int(), served: z.number().int() }),
  ]),
  idleAfterMs: z.number(),
  realtime: z.object({
    unscopedRoom: z.object({ kind: z.string(), id: z.string() }),
    departmentRooms: z.string(),
  }),
});

export const VisitorMergeJobSchema = z.object({
  id: Uuid,
  kind: z.string(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  reviewState: z.string(),
  sourceId: Uuid,
  targetId: Uuid,
  createdAt: DateTime,
  completedAt: DateTime.nullable(),
  errorCode: z.string().nullable(),
});

export const BanSchema = z.object({
  id: Uuid,
  target: z.union([
    z.object({ kind: z.literal('visitor'), visitorId: Uuid, displayName: z.string().nullable() }),
    z.object({ kind: z.literal('ip'), masked: z.string() }),
  ]),
  siteId: Uuid.nullable(),
  reason: z.string(),
  expiresAt: DateTime.nullable(),
  revokedAt: DateTime.nullable(),
  active: z.boolean(),
  createdAt: DateTime,
  createdBy: z.string(),
  revokedBy: z.string().nullable(),
  collateralWarning: z.string().optional(),
  closedChatIds: z.array(Uuid).optional(),
});

export const CustomFieldSchema = z.object({
  id: Uuid,
  key: z.string(),
  label: z.string(),
  dataType: z.string(),
  publicWritable: z.boolean(),
  visibleToVisitor: z.boolean(),
  validation: JsonObject,
  archivedAt: DateTime.nullable(),
  createdAt: DateTime,
  updatedAt: DateTime,
  version: z.number().int(),
});

export type StaffVisitor = z.infer<typeof StaffVisitorSchema>;
export type VisitorListItem = z.infer<typeof VisitorListItemSchema>;
export type LiveVisitorItem = z.infer<typeof LiveVisitorItemSchema>;
export type Ban = z.infer<typeof BanSchema>;
export type CustomField = z.infer<typeof CustomFieldSchema>;
