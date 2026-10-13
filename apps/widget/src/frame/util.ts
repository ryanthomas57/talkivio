/** Small helpers: ids, storage, formatting. */
import { formatNumber, type Locale, type Translator } from './i18n';

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Storage that never throws (third-party storage may be blocked or partitioned). */
export const store = {
  get(area: 'local' | 'session', key: string): string | null {
    try {
      return (area === 'local' ? localStorage : sessionStorage).getItem(key);
    } catch {
      return null;
    }
  },
  set(area: 'local' | 'session', key: string, value: string | null): void {
    try {
      const s = area === 'local' ? localStorage : sessionStorage;
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  json<T>(area: 'local' | 'session', key: string): T | null {
    const raw = store.get(area, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
};

export const VISITOR_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export const keys = (siteKey: string) => ({
  visitor: `talkivio:${siteKey}:visitor`,
  session: `talkivio:${siteKey}:session`,
  read: `talkivio:${siteKey}:read`,
  tab: `talkivio:${siteKey}:tab`,
  prefs: `talkivio:${siteKey}:prefs`,
  consent: `talkivio:${siteKey}:consent`,
  ui: `talkivio:${siteKey}:ui`,
});

/** Anonymous visitor token: localStorage when persistent, sessionStorage without analytics consent. */
export function readVisitorToken(key: string, now = Date.now()): string | null {
  for (const area of ['local', 'session'] as const) {
    const v = store.json<{ v: number; token: string; expiresAt: number }>(area, key);
    if (!v || v.v !== 1 || typeof v.token !== 'string' || !v.token) continue;
    if (typeof v.expiresAt === 'number' && v.expiresAt < now) {
      store.set(area, key, null);
      continue;
    }
    return v.token;
  }
  return null;
}

export function writeVisitorToken(key: string, token: string | null, opts: { persistence?: 'persistent' | 'session'; expiresAt?: string | null } = {}, now = Date.now()): void {
  store.set('local', key, null);
  store.set('session', key, null);
  if (!token) return;
  const exp = opts.expiresAt ? new Date(opts.expiresAt).getTime() : NaN;
  const value = JSON.stringify({ v: 1, token, expiresAt: Number.isFinite(exp) ? exp : now + VISITOR_TOKEN_TTL_MS });
  store.set(opts.persistence === 'session' ? 'session' : 'local', key, value);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = locale + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, opts);
    } catch {
      f = new Intl.DateTimeFormat('en', opts);
    }
    fmtCache.set(k, f);
  }
  return f;
}

export function formatTime(locale: Locale, iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dtf(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
}

export function formatFull(locale: Locale, iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dtf(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(t: Translator, iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return t('today');
  if (diff === 1) return t('yesterday');
  return dtf(t.locale, { weekday: diff < 7 ? 'long' : undefined, month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).format(d);
}

export function formatBytes(locale: Locale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const n = i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${formatNumber(locale, n)} ${units[i]}`;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^[+()\d\s.-]{5,40}$/;

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}
