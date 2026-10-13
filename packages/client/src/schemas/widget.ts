/** Public widget API resources (ch. 46). Only public fields — never administrative data. */
import { z } from 'zod';
import { DateTime, Uuid } from './common.ts';
import { PublicChatSchema } from './chats.ts';
import { WidgetConfigSchema } from './sites.ts';

export const PublicAvailabilitySchema = z.object({
  state: z.enum(['available', 'busy', 'offline']),
  nextOpenAt: DateTime.nullable(),
  acceptsQueue: z.boolean(),
  departments: z.array(z.object({ id: Uuid, label: z.string(), state: z.string(), nextOpenAt: DateTime.nullable() })),
  asOf: DateTime,
});

export const WidgetBootstrapSchema = z.object({
  siteId: Uuid,
  configVersion: z.number().int(),
  config: WidgetConfigSchema,
  availability: PublicAvailabilitySchema,
  consent: z.object({ analyticsRequired: z.boolean() }),
  chat: z.object({ readReceipts: z.boolean(), reconnectGraceSeconds: z.number(), allowFiles: z.boolean(), maxFileMb: z.number() }),
  keyStatus: z.enum(['current', 'previous']),
});

const WidgetSessionShape = {
  visitor: z.object({ id: Uuid, displayName: z.string(), verified: z.boolean(), fieldsVerified: z.boolean(), hasName: z.boolean() }),
  sessionId: Uuid,
  sessionKey: z.string().nullable(),
  anonymousToken: z.string().nullable(),
  anonymousTokenExpiresAt: DateTime.nullable(),
  anonymousTokenPersistence: z.string(),
  /** Visitor capability (`rdv1.…`) — send as `Authorization: Bearer`. */
  capability: z.string(),
  capabilityExpiresAt: DateTime,
  consent: z.object({ analytics: z.enum(['unknown', 'granted', 'denied']) }),
  activeChat: PublicChatSchema.nullable(),
};

export const WidgetSessionSchema = z.object(WidgetSessionShape);
export const WidgetRedeemedSessionSchema = z.object({ ...WidgetSessionShape, handoff: z.object({ sourceSiteId: Uuid, purpose: z.string() }) });
export const WidgetResetSessionSchema = z.object({ ...WidgetSessionShape, ok: z.boolean(), reset: z.boolean() });

export const IdentityHandoffSchema = z.object({ handoffCode: z.string(), expiresAt: DateTime, destinationSiteId: Uuid, destinationOrigin: z.string(), purpose: z.literal('resume') });
export const WidgetIdentitySchema = z.object({ visitorId: Uuid, verified: z.boolean(), fieldsVerified: z.boolean(), displayName: z.string(), ignored: z.array(z.string()) });

/** Public visitor projection after SDK `setCustomFields` / `setTags`. */
export const PublicVisitorSchema = z.object({
  visitorId: Uuid,
  displayName: z.string(),
  verified: z.boolean(),
  customFields: z.record(z.union([z.string(), z.number(), z.boolean()])),
  tags: z.array(z.string()),
});

export const ConsentStateSchema = z.object({
  purpose: z.enum(['analytics', 'service']),
  state: z.enum(['granted', 'denied', 'withdrawn']),
  policyVersion: z.string(),
  recordedAt: DateTime,
  collection: z.string(),
  clientActions: z.array(z.string()),
  erasure: z.object({ state: z.string(), jobId: Uuid }).nullable(),
});

export const EventsIngestResultSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  ignored: z.number().int(),
  reason: z.enum(['consent', 'session_ended']).nullable(),
});

export const SocketTicketSchema = z.object({ ticket: z.string(), expiresAt: DateTime });
export const AgentSocketTicketSchema = z.object({ ticket: z.string(), expiresAt: DateTime, path: z.string(), namespace: z.string() });

export const InvitationSchema = z.object({
  id: Uuid,
  state: z.enum(['eligible', 'displayed', 'accepted', 'dismissed', 'expired']),
  message: z.string(),
  attribution: z.string(),
  expiresAt: DateTime,
  displayedAt: DateTime.nullable(),
  dismissedAt: DateTime.nullable(),
  acceptedChatId: Uuid.nullable(),
  version: z.number().int(),
});

export type PublicAvailability = z.infer<typeof PublicAvailabilitySchema>;
export type WidgetBootstrap = z.infer<typeof WidgetBootstrapSchema>;
export type WidgetSession = z.infer<typeof WidgetSessionSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;
