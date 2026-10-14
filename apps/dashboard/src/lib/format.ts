/** Display formatting in the viewer's timezone and UI language (ch. 13: absolute timestamps on focus/hover; ch. 29). */
import { intlLocale, tStatic as t } from '@/i18n';

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(): Intl.RelativeTimeFormat {
  const loc = intlLocale();
  let f = rtfCache.get(loc);
  if (!f) rtfCache.set(loc, (f = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' })));
  return f;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

export function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "4:05 PM" */
export function formatTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  return d ? d.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit' }) : '';
}

/** "12 Oct 2026, 4:05:12 PM" — the absolute form used in titles and tooltips. */
export function formatDateTime(v: string | Date | null | undefined, timeZone?: string): string {
  const d = toDate(v);
  if (!d) return '';
  return d.toLocaleString(intlLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  });
}

export function formatDate(v: string | Date | null | undefined, timeZone?: string): string {
  const d = toDate(v);
  return d
    ? d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone })
    : '';
}

/** Date separator label: Today / Yesterday / weekday + date. */
export function dayLabel(v: string | Date): string {
  const d = toDate(v)!;
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return t('format.today');
  if (diff === 1) return t('format.yesterday');
  return d.toLocaleDateString(intlLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function sameDay(a: string | Date, b: string | Date): boolean {
  const x = toDate(a)!;
  const y = toDate(b)!;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Compact elapsed duration: 45s, 3m 05s, 1h 12m, 2d 4h. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return t('format.duration.s', { s: String(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t('format.duration.ms', { m: String(m), s: pad2(s % 60) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('format.duration.hm', { h: String(h), m: pad2(m % 60) });
  const d = Math.floor(h / 24);
  return t('format.duration.dh', { d: String(d), h: String(h % 24) });
}

/** Spoken form for screen readers: "3 minutes 5 seconds". */
export function formatDurationLong(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) parts.push(t('format.durationLong.hours', { n: h }));
  if (m) parts.push(t('format.durationLong.minutes', { n: m }));
  if (!h && (sec || !parts.length)) parts.push(t('format.durationLong.seconds', { n: sec }));
  return parts.join(t('format.durationLong.joiner'));
}

export function formatRelative(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return t('format.justNow');
  if (abs < 3600) return rtf().format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf().format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf().format(Math.round(diff / 86_400), 'day');
  return formatDate(d);
}

export function formatBytes(n: number): string {
  const num = (v: number, digits: number) =>
    v.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n < 1024) return t('format.bytes.b', { n: num(n, 0) });
  if (n < 1024 * 1024) return t('format.bytes.kb', { n: num(n / 1024, n < 10 * 1024 ? 1 : 0) });
  return t('format.bytes.mb', { n: num(n / (1024 * 1024), 1) });
}

export function formatNumber(n: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return t('common.notAvailable');
  return n.toLocaleString(intlLocale(), opts);
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return t('common.notAvailable');
  return n.toLocaleString(intlLocale(), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Badge text capped at 99+ (the accessible label carries the full number). */
export function badgeCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

/** Regional-indicator flag for an ISO country code ("DE" → 🇩🇪); null for anything else. */
export function flagEmoji(code: string | null | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(intlLocale(), { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
