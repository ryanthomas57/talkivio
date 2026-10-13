/**
 * Client side of the wire contract (ch. 40): the API speaks snake_case JSON, the
 * dashboard uses camelCase. Values under tenant-defined maps (custom fields,
 * attributes, metadata, safe diffs, field errors) keep their keys untouched — the
 * same opaque-key list the server uses.
 */
const OPAQUE_KEYS = new Set(['customFields', 'custom_fields', 'customFieldSources', 'custom_field_sources', 'fields', 'attributes', 'safeDiff', 'safe_diff', 'metadata', 'fieldErrors', 'field_errors']);

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

/** camelCase (client) → snake_case (wire). Dates become RFC 3339 strings. */
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
