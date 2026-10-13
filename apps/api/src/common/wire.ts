/**
 * Wire format (ch. 40): REST/WebSocket JSON uses snake_case; internal TypeScript
 * uses camelCase. Conversion happens only at the transport boundary. Values under
 * opaque keys (tenant-defined maps such as custom fields) are passed through untouched.
 */

const OPAQUE_KEYS = new Set(['customFields', 'custom_fields', 'customFieldSources', 'custom_field_sources', 'fields', 'attributes', 'safeDiff', 'safe_diff', 'metadata', 'fieldErrors', 'field_errors']);

export const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function scalarOut(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

/** camelCase → snake_case (outbound). Dates become RFC3339 strings, bigints numbers. */
export function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const key = snake(k);
      out[key] = OPAQUE_KEYS.has(k) ? jsonSafe(v) : toWire(v);
    }
    return out;
  }
  return scalarOut(value);
}

/** snake_case → camelCase (inbound). */
export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = camel(k);
      out[key] = OPAQUE_KEYS.has(k) || OPAQUE_KEYS.has(key) ? v : fromWire(v);
    }
    return out;
  }
  return value;
}

function jsonSafe(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return scalarOut(v);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export const PAGE_BRAND = Symbol('page');
export function page<T>(items: T[], nextCursor: string | null, total?: number): Page<T> & { [PAGE_BRAND]: true } {
  return Object.assign({ items, nextCursor, hasMore: !!nextCursor, total }, { [PAGE_BRAND]: true as const });
}
export function isPage(v: unknown): v is Page<unknown> {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[PAGE_BRAND] === true;
}

/** Opaque, validated cursor: base64url JSON of sort keys + filter fingerprint. */
export function encodeCursor(keys: Record<string, unknown>, filterHash: string): string {
  return Buffer.from(JSON.stringify({ k: keys, f: filterHash })).toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined, filterHash: string): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k: T; f: string };
    if (parsed.f !== filterHash) return null;
    return parsed.k;
  } catch {
    return null;
  }
}
