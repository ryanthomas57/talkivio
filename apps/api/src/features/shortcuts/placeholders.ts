/**
 * Canned-reply placeholders (ch. 18): allowlisted, deterministic, single-pass
 * interpolation. No expressions, no nested evaluation — a value that itself looks
 * like `{{agent.display_name}}` is inserted literally. Output is plain text.
 *
 * Grammar:  {{ key }}  or  {{ key | fallback text }}
 * Keys:     visitor.name, agent.display_name, department.name, site.name
 */

export const CANNED_PLACEHOLDERS = ['visitor.name', 'agent.display_name', 'department.name', 'site.name'] as const;
export type CannedPlaceholder = (typeof CANNED_PLACEHOLDERS)[number];
export type PlaceholderValues = Partial<Record<CannedPlaceholder, string | null | undefined>>;

export interface PlaceholderToken {
  raw: string;
  key: CannedPlaceholder;
  fallback: string | null;
  start: number;
  end: number;
}

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const INNER_RE = /^\s*([a-z_]+\.[a-z_]+)\s*(?:\|\s*([^{}|\r\n]{0,100}?)\s*)?$/;
const MAX_VALUE = 200;

/** Parse placeholders; unknown keys or malformed tokens are errors (saved replies must be valid). */
export function parsePlaceholders(body: string): { tokens: PlaceholderToken[]; errors: string[] } {
  const tokens: PlaceholderToken[] = [];
  const errors: string[] = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const inner = INNER_RE.exec(m[1]);
    if (!inner || !(CANNED_PLACEHOLDERS as readonly string[]).includes(inner[1])) {
      errors.push(`Unknown placeholder ${m[0].slice(0, 60)}. Allowed: ${CANNED_PLACEHOLDERS.map((k) => `{{${k}}}`).join(', ')}`);
      continue;
    }
    tokens.push({ raw: m[0], key: inner[1] as CannedPlaceholder, fallback: inner[2]?.trim() ? inner[2].trim() : null, start: m.index!, end: m.index! + m[0].length });
  }
  // A lone "{{" that never closes is almost certainly a typo; reject rather than send it.
  const stripped = body.replace(TOKEN_RE, '');
  if (stripped.includes('{{')) errors.push('Unclosed placeholder: every "{{" needs a matching "}}"');
  return { tokens, errors };
}

/** Make a value safe to place in plain text: no control characters, single line, bounded. */
export function sanitizeValue(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
  return clean || null;
}

/**
 * Render a body. Missing values use the token's fallback; tokens with neither stay
 * in the text verbatim and are reported in `unresolved` so the composer can
 * highlight them and block sending.
 */
export function renderPlaceholders(body: string, values: PlaceholderValues): { text: string; unresolved: CannedPlaceholder[] } {
  const { tokens } = parsePlaceholders(body);
  const unresolved = new Set<CannedPlaceholder>();
  let out = '';
  let at = 0;
  for (const t of tokens) {
    out += body.slice(at, t.start);
    const v = sanitizeValue(values[t.key]) ?? t.fallback;
    if (v === null) {
      unresolved.add(t.key);
      out += `{{${t.key}}}`;
    } else out += v;
    at = t.end;
  }
  out += body.slice(at);
  return { text: out, unresolved: [...unresolved] };
}

export function placeholderKeys(body: string): CannedPlaceholder[] {
  return [...new Set(parsePlaceholders(body).tokens.map((t) => t.key))];
}
