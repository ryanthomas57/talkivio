/**
 * Realtime protocol envelopes (ch. 47, ADR 0003). Socket.IO path `/realtime/v1`,
 * namespaces `/agent` and `/visitor`. All frames are snake_case on the wire; these
 * schemas are camelCase like the rest of the package (the generator converts them).
 */
import { z } from 'zod';
import { DateTime, Uuid } from '../schemas/common.ts';

/** Scope kinds (ADR 0003): spec kinds plus the documented `agent` / `team` extensions. */
export const ScopeKindSchema = z.enum(['chat', 'queue', 'visitor', 'config', 'agent', 'team']);
/** Scope ids are UUIDs except `queue:none` (no department), `team:all` and `visitor:all`. */
export const ScopeSchema = z.object({ kind: ScopeKindSchema, id: z.string().max(64) });

/** CONNECT auth payload: `io(url + ns, { path: '/realtime/v1', auth: { ticket } })`. */
export const HandshakeAuthSchema = z.object({ ticket: z.string().max(200) }).strict();

/** `auth.ok` — first server frame after a successful handshake. */
export const AuthOkSchema = z.object({
  connectionId: Uuid,
  heartbeatIntervalMs: z.number().int(),
  capabilityExpiry: DateTime.nullable(),
  resumableScopes: z.array(ScopeKindSchema),
  membershipId: Uuid.optional(),
  serverTime: DateTime,
});

/** Durable frame (socket event `event`). `payload` is typed per event type and audience. */
export const DurableFrameSchema = z.object({
  v: z.literal(1),
  eventId: Uuid,
  type: z.string(),
  tenantId: Uuid,
  scope: ScopeSchema,
  /** Opaque, monotonic within the stream (`c1.<base36 seq>`). */
  cursor: z.string(),
  occurredAt: DateTime,
  aggregateVersion: z.number().int(),
  causationId: Uuid.nullable(),
  payload: z.unknown(),
});

/** Ephemeral frame (socket event `ephemeral`): no cursor, never replayed. */
export const EphemeralFrameSchema = z.object({
  v: z.literal(1),
  type: z.string(),
  scope: ScopeSchema,
  expiresAt: DateTime,
  payload: z.unknown(),
});

/**
 * Control frame (socket event `control`), followed by a server-side disconnect.
 * `reloginRequired` is false for re-scope reasons (`RESCOPE_REASONS`: the session stays
 * valid — mint a fresh ticket and reconnect) and true otherwise (`session_revoked`,
 * `membership_suspended`, `tenant_unavailable`, …).
 */
export const RESCOPE_REASONS = ['scope_changed', 'role_changed', 'tenant_switch'] as const;
export const ControlFrameSchema = z.union([
  z.object({
    type: z.literal('access.revoked'),
    payload: z.object({ reason: z.string(), reloginRequired: z.boolean() }),
  }),
  /** Slow consumer (outbound buffer > 1000 events or 1 MiB): the transport closes next; reconnect and resume from the cursor. */
  z.object({
    type: z.literal('overload'),
    payload: z.object({ reason: z.literal('slow_consumer'), resumable: z.literal(true) }),
  }),
]);

// ───────── client → server ─────────
export const SubscribeSchema = z.object({ scopes: z.array(ScopeSchema).max(200), lastCursor: z.string().nullable().optional() });
/** `unsubscribe {scope_ids: ['kind:id']}` (ch. 77) or `{scopes: [{kind, id}]}`. */
export const UnsubscribeSchema = z.object({ scopes: z.array(ScopeSchema).max(200).optional(), scopeIds: z.array(z.string().max(80)).max(200).optional() });
export const HeartbeatSchema = z.object({ visible: z.boolean().optional(), focused: z.boolean().optional() });

export const SubscriptionOkSchema = z.object({
  type: z.literal('subscription.ok'),
  snapshotCursor: z.string(),
  granted: z.number().int(),
  /** Scopes the server refused (never joined). */
  denied: z.array(ScopeSchema),
});
export const SnapshotRequiredSchema = z.object({
  type: z.literal('snapshot.required'),
  snapshotCursor: z.string(),
  denied: z.array(ScopeSchema).optional(),
});
export const UnsubscribeAckSchema = z.object({ type: z.literal('unsubscribe.ok'), ok: z.literal(true), scopeIds: z.array(z.string()) });
export const HeartbeatAckSchema = z.object({ ok: z.literal(true), serverTime: DateTime });

/** Client command (socket event `command`). Tenant authority is never accepted from the client. */
export const CommandSchema = z.object({
  v: z.literal(1).optional(),
  commandId: z.string().min(1).max(64),
  type: z.string(),
  scope: ScopeSchema.optional(),
  expectedVersion: z.number().int().optional(),
  payload: z.record(z.unknown()),
});
export const CommandAckSchema = z.object({ type: z.literal('command.ack'), commandId: z.string(), result: z.unknown(), committedAt: DateTime });

/**
 * Every command.ack `result` carries `{resource_id, seq?, version?}` (ch. 47) alongside the full
 * resource, so clients can reconcile without a refetch. `resource_id` is null for cursor/typing acks.
 */
export const AckResultFields = { resourceId: z.string().nullable(), seq: z.number().int().optional(), version: z.number().int().optional() };
export function withAckFields(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, unknown>;
    return schema.extend(Object.fromEntries(Object.entries(AckResultFields).filter(([k]) => !(k in shape))));
  }
  if (schema instanceof z.ZodUnion) return z.union((schema.options as z.ZodTypeAny[]).map(withAckFields) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  return schema;
}
export const CommandErrorSchema = z.object({ type: z.literal('command.error'), commandId: z.string().nullable(), code: z.string(), message: z.string(), retryable: z.boolean() });

/** Socket.IO `connect_error` messages emitted by the namespace middleware. */
export const CONNECT_ERRORS = ['ORIGIN_NOT_ALLOWED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'SERVICE_UNAVAILABLE'] as const;

export type Scope = z.infer<typeof ScopeSchema>;
export type AuthOk = z.infer<typeof AuthOkSchema>;
export type DurableFrame<P = unknown> = Omit<z.infer<typeof DurableFrameSchema>, 'payload'> & { payload: P };
export type EphemeralFrame<P = unknown> = Omit<z.infer<typeof EphemeralFrameSchema>, 'payload'> & { payload: P };
export type ControlFrame = z.infer<typeof ControlFrameSchema>;
export type Command<P = Record<string, unknown>> = Omit<z.infer<typeof CommandSchema>, 'payload'> & { payload: P };
export type CommandAck<R = unknown> = Omit<z.infer<typeof CommandAckSchema>, 'result'> & { result: R };
export type CommandError = z.infer<typeof CommandErrorSchema>;
