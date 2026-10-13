/**
 * Wire-case conversion (ch. 40), identical to `apps/dashboard/src/lib/wire.ts` and the
 * server's `apps/api/src/common/wire.ts`: the API speaks snake_case JSON, SDK callers
 * use camelCase. Values under opaque keys (tenant-defined maps) keep their keys.
 */
export const OPAQUE_KEYS: ReadonlySet<string> = new Set(['customFields', 'custom_fields', 'customFieldSources', 'custom_field_sources', 'fields', 'attributes', 'safeDiff', 'safe_diff', 'metadata', 'fieldErrors', 'field_errors']);

export const toSnakeKey = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const toCamelKey = (k: string): string => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** snake_case (wire) → camelCase (client). */
export function fromWire<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => fromWire(v)) as T;
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = toCamelKey(k);
      out[key] = OPAQUE_KEYS.has(k) || OPAQUE_KEYS.has(key) ? v : fromWire(v);
    }
    return out as T;
  }
  return value as T;
}

/** camelCase (client) → snake_case (wire). Dates become RFC 3339 strings; `undefined` keys are dropped. */
export function toWire(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toWire);
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[toSnakeKey(k)] = OPAQUE_KEYS.has(k) ? v : toWire(v);
    }
    return out;
  }
  return value;
}

// ───────── type-level mirrors ─────────
type OpaqueKey = 'customFields' | 'custom_fields' | 'fields' | 'attributes' | 'metadata' | 'safeDiff' | 'safe_diff' | 'fieldErrors' | 'field_errors';

/** `first_response_time` → `firstResponseTime` (matches `toCamelKey`). */
export type CamelCase<S extends string> = S extends `${infer H}_${infer T}` ? `${H}${Capitalize<CamelCase<T>>}` : S;
/** `firstResponseTime` → `first_response_time` (matches `toSnakeKey`). */
export type SnakeCase<S extends string> = S extends `${infer C}${infer R}` ? `${C extends Uppercase<C> ? (C extends Lowercase<C> ? C : `_${Lowercase<C>}`) : C}${SnakeCase<R>}` : S;

/** Deep snake_case → camelCase of a wire type (opaque maps untouched). */
export type Camelize<T> = T extends readonly unknown[]
  ? { [I in keyof T]: Camelize<T[I]> }
  : T extends object
    ? { [K in keyof T as K extends string ? CamelCase<K> : K]: K extends OpaqueKey ? T[K] : Camelize<T[K]> }
    : T;

/** Deep camelCase → snake_case (for typing values before `toWire`). */
export type Snakify<T> = T extends Date
  ? string
  : T extends readonly unknown[]
    ? { [I in keyof T]: Snakify<T[I]> }
    : T extends object
      ? { [K in keyof T as K extends string ? SnakeCase<K> : K]: K extends OpaqueKey ? T[K] : Snakify<T[K]> }
      : T;
