/**
 * Small transport helpers for the automation features (triggers, invitations,
 * shortcuts): a wire pipe that keeps DSL documents verbatim, entity-version
 * preconditions and deterministic event ids.
 */
import { Injectable, type PipeTransform } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ZodTypeAny, z } from 'zod';
import { AppError, conflict, zodError } from '../../common/http';
import { fromWire } from '../../common/wire';

/**
 * Like `body()` but leaves the listed top-level keys untouched. DSL definitions and
 * snapshots are snake_case documents whose keys (`stop_processing`, `page.path`,
 * `department_id` …) must not be camelCased by the transport.
 */
@Injectable()
export class VerbatimKeysPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(
    private readonly schema: T,
    private readonly verbatim: readonly string[],
  ) {}

  transform(value: unknown): z.infer<T> {
    const raw = (value ?? {}) as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(422, 'VALIDATION_FAILED', 'Expected a JSON object');
    const kept: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) (this.verbatim.includes(k) ? kept : rest)[k] = v;
    const merged = { ...(fromWire(rest) as Record<string, unknown>), ...kept };
    const r = this.schema.safeParse(merged);
    if (!r.success) throw zodError(r.error);
    return r.data;
  }
}
export const verbatimBody = <T extends ZodTypeAny>(schema: T, keys: readonly string[]) => new VerbatimKeysPipe(schema, keys);

/** Parse an entity version from `If-Match` (`3`, `"3"`, `W/"3"`) or a body `expected_version`. */
export function entityVersion(ifMatch: string | undefined, bodyVersion?: number | null): number | null {
  if (bodyVersion !== undefined && bodyVersion !== null) return bodyVersion;
  if (!ifMatch) return null;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(ifMatch.trim());
  if (!m) throw new AppError(422, 'VALIDATION_FAILED', 'If-Match must be the entity version', { fieldErrors: { if_match: ['Use the version number returned by GET'] } });
  return Number(m[1]);
}

/** PATCH/destructive configuration commands require a precondition (ch. 40). */
export function requireVersion(ifMatch: string | undefined, bodyVersion?: number | null): number {
  const v = entityVersion(ifMatch, bodyVersion);
  if (v === null) throw new AppError(428, 'PRECONDITION_REQUIRED', 'Send If-Match (or expected_version) with the version you edited');
  return v;
}

export function assertVersion(expected: number | null, current: number, what: string, current_resource?: unknown): void {
  if (expected !== null && expected !== current) {
    throw conflict('VERSION_CONFLICT', `${what} was changed by someone else. Reload or merge your changes.`, false, { currentVersion: current, current: current_resource });
  }
}

/** Deterministic RFC 4122-shaped (v5-style) id from a name: same input → same event id. */
export function stableUuid(name: string): string {
  const h = createHash('sha256').update(`talkivio:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } };
  return e?.code === 'P2002' || e?.meta?.code === '23505';
}
