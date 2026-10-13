/**
 * Shared primitives for Talkivio resource schemas.
 *
 * Every schema in this package is written in **camelCase** (the TypeScript side of
 * the wire contract). The API speaks snake_case JSON; the contract generator
 * (`apps/api/scripts/contracts/openapi.mjs`) converts these schemas to snake_case
 * JSON Schema, leaving the inner keys of opaque maps (`customFields`, `fields`,
 * `attributes`, `metadata`, `safeDiff`, `fieldErrors`) untouched — exactly like
 * `apps/api/src/common/wire.ts`.
 */
import { z } from 'zod';

/** RFC 4122-shaped identifier. */
export const Uuid = z.string().uuid();
/** RFC 3339 UTC timestamp (`Date#toISOString()` on the server). */
export const DateTime = z.string().datetime({ offset: true });
/** Free-form JSON value (configuration snapshots, reports). */
export const Json = z.unknown();
/** String-keyed map whose values are free-form JSON. */
export const JsonObject = z.record(z.unknown());

export const RoleSchema = z.enum(['owner', 'admin', 'supervisor', 'agent', 'analyst']);
export const DepartmentScopeSchema = z.union([z.array(Uuid), z.literal('all')]);

export const OkSchema = z.object({ ok: z.boolean() });
export const OkTrueSchema = z.object({ ok: z.literal(true) });
export const AcceptedSchema = z.object({ accepted: z.boolean() });

/** Short-lived download grant for a stored object (exports). */
export const DownloadGrantSchema = z.object({
  url: z.string(),
  method: z.literal('GET'),
  expiresAt: DateTime,
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string().nullable(),
});

/** `{ data, meta }` envelope metadata. */
export const MetaSchema = z.object({ requestId: z.string().optional() });
/** `page` block of list envelopes (`page(...)` on the server). */
export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().optional(),
});

export type Ok = z.infer<typeof OkSchema>;
export type DownloadGrant = z.infer<typeof DownloadGrantSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
