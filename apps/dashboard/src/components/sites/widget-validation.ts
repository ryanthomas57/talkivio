/**
 * Client-side mirror of `widgetConfigSchema` limits (packages/contracts/src/schemas.ts)
 * so problems show inline before saving; the API re-validates every draft.
 */
import type { WidgetConfig } from '@talkivio/contracts';
import { tStatic } from '@/i18n';
import { isApiError } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { toCamelKey } from '@/lib/wire';

export type Errors = Record<string, string>;

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Max lengths for every text field (trimmed). */
export const TEXT_MAX: Record<string, number> = {
  'appearance.launcherLabel': 40,
  'appearance.companyName': 60,
  'appearance.title': 60,
  'appearance.subtitle': 120,
  'content.welcomeMessage': 500,
  'content.inputPlaceholder': 80,
  'content.offlineTitle': 80,
  'content.offlineMessage': 500,
  'content.offlineThanks': 300,
  'content.prechatGreeting': 300,
  'content.waitingMessage': 300,
  'content.chatEndedMessage': 200,
  'content.ratingPrompt': 200,
  'behavior.greeting.message': 200,
};

export const NUM_RANGE: Record<string, [number, number]> = {
  'appearance.offsetX': [0, 200],
  'appearance.offsetY': [0, 200],
  'appearance.buttonRadius': [0, 40],
  'appearance.borderRadius': [0, 32],
  'appearance.width': [320, 480],
  'appearance.height': [420, 760],
  'behavior.greeting.delaySeconds': [0, 600],
};

const COLOR_PATHS = [
  'appearance.primaryColor',
  'appearance.secondaryColor',
  'appearance.headerBackground',
  'appearance.headerTextColor',
];
const URL_PATHS = ['appearance.launcherIconUrl', 'appearance.logoUrl'];
export const MAX_PATTERNS = 50;
export const PATTERN_MAX = 300;

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = (o: unknown): Record<string, unknown> | unknown[] =>
    Array.isArray(o) ? [...o] : { ...(o as Record<string, unknown>) };
  const root = clone(obj) as Record<string, unknown>;
  let cur: Record<string, unknown> = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      cur[k] = clone(cur[k] ?? {});
      cur = cur[k] as Record<string, unknown>;
    }
  });
  return root as T;
}

/** The API accepts only https:// image URLs (no http, data:, javascript: or mixed content). */
export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Messages use the active UI language (module-level helper, so tStatic). */
export function validateConfig(c: WidgetConfig): Errors {
  const e: Errors = {};
  for (const p of COLOR_PATHS) {
    const v = getPath(c, p);
    if (typeof v !== 'string' || !HEX_RE.test(v)) e[p] = tStatic('sites.widget.validation.hex', { example: '#07778A' });
  }
  for (const [p, [min, max]] of Object.entries(NUM_RANGE)) {
    const v = getPath(c, p);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
      e[p] = tStatic('sites.widget.validation.wholeNumber', { min, max });
  }
  for (const [p, max] of Object.entries(TEXT_MAX)) {
    const v = getPath(c, p);
    if (typeof v === 'string' && v.trim().length > max)
      e[p] = tStatic('sites.widget.validation.tooLongNow', { max, now: v.trim().length });
  }
  for (const p of URL_PATHS) {
    const v = getPath(c, p);
    if (typeof v === 'string' && v.trim()) {
      if (v.trim().length > 500) e[p] = tStatic('sites.widget.validation.urlTooLong', { max: 500 });
      else if (!isHttpsUrl(v.trim())) e[p] = tStatic('sites.widget.validation.https');
    }
  }
  const patterns = c.behavior.visibility.patterns;
  if (patterns.filter((x) => x.trim()).length > MAX_PATTERNS)
    e['behavior.visibility.patterns'] = tStatic('sites.widget.validation.maxPatterns', { count: MAX_PATTERNS });
  patterns.forEach((p, i) => {
    if (p.trim().length > PATTERN_MAX)
      e[`behavior.visibility.patterns.${i}`] = tStatic('sites.widget.validation.tooLong', { max: PATTERN_MAX });
  });
  if (c.behavior.visibility.mode === 'include' && !patterns.some((p) => p.trim()))
    e['behavior.visibility.patterns'] = tStatic('sites.widget.validation.needPattern');
  return e;
}

/** Normalised copy that is sent to the API (empty URLs → null, blank patterns removed). */
export function cleanForSave(c: WidgetConfig): WidgetConfig {
  const url = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    ...c,
    appearance: {
      ...c.appearance,
      launcherIconUrl: url(c.appearance.launcherIconUrl),
      logoUrl: url(c.appearance.logoUrl),
    },
    behavior: {
      ...c.behavior,
      visibility: {
        ...c.behavior.visibility,
        patterns: c.behavior.visibility.patterns.map((p) => p.trim()).filter(Boolean),
      },
    },
  };
}

/** For the live preview: invalid fields fall back to the last saved value so the frame never renders garbage. */
export function sanitizeForPreview(c: WidgetConfig, errors: Errors, fallback: WidgetConfig): WidgetConfig {
  let out = c;
  for (const p of Object.keys(errors)) {
    if (p.startsWith('behavior.visibility')) continue;
    const fb = getPath(fallback, p);
    if (fb !== undefined) out = setPath(out, p, fb);
  }
  return out;
}

/** `appearance.primary_color` (wire) → `appearance.primaryColor`. */
export function serverErrors(e: unknown): Errors {
  const out: Errors = {};
  if (!isApiError(e)) return out;
  for (const [k, v] of Object.entries(e.fieldErrors)) {
    const path = k
      .replace(/^config\./, '')
      .split('.')
      .map((s) => toCamelKey(s))
      .join('.');
    if (v[0]) out[path] = v[0];
  }
  return out;
}

/** Deterministic JSON for dirty checks (key order independent). */
export function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.keys(x as object)
          .sort()
          .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
      );
    if (typeof x === 'number' && !Number.isFinite(x)) return '__nan__';
    return x;
  };
  return JSON.stringify(norm(v));
}

// ───────── Contrast (WCAG 2.x) ─────────

function lum(hex: string): number | null {
  if (!HEX_RE.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrast(a: string, b: string): number | null {
  const la = lum(a);
  const lb = lum(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The widget's dark foreground (TOKENS.text in the widget theme). */
export const WIDGET_DARK_TEXT = '#17222E';
/** Contrast ratio such as "4.5:1" in the UI language's digits. */
export const formatRatio = (r: number) => `${formatNumber(Math.floor(r * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}:${formatNumber(1)}`;
