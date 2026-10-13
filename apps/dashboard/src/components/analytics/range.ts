/**
 * Report ranges (ch. 51): presets are calendar days in the report timezone. The
 * API takes `from`/`to` as YYYY-MM-DD local dates interpreted in `timezone`, and
 * the interval is half-open, so a range "12 Oct – 13 Oct" is sent as
 * from=2026-10-12&to=2026-10-14. DST days (23/25 h) are handled server-side.
 */
import { intlLocale, tStatic, type MessageKey } from '@/i18n';
import type { GroupBy } from './types';

export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

/** `label` is a message key: render with t(). */
export const PRESETS: Array<{ value: RangePreset; label: MessageKey }> = [
  { value: 'today', label: 'analytics.range.today' },
  { value: 'yesterday', label: 'analytics.range.yesterday' },
  { value: '7d', label: 'analytics.range.last7' },
  { value: '30d', label: 'analytics.range.last30' },
  { value: 'custom', label: 'analytics.range.custom' },
];

/** Synchronous range caps by grouping (mirror of SYNC_LIMITS in analytics.service.ts). */
export const MAX_DAYS: Record<GroupBy, number> = { hour: 31, day: 400, week: 731 };
/** Agents report cap (AGENT_SYNC_DAYS). */
export const AGENT_MAX_DAYS = 93;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(v: string | null | undefined): v is string {
  if (!v || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's calendar date (YYYY-MM-DD) in an IANA timezone. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const p = (k: string) => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

export interface ResolvedRange {
  /** Inclusive first day. */
  first: string;
  /** Inclusive last day. */
  last: string;
  /** API `from` (inclusive) and `to` (exclusive). */
  from: string;
  to: string;
  days: number;
  error: string | null;
}

export function resolveRange(preset: RangePreset, tz: string, custom: { from?: string | null; to?: string | null }): ResolvedRange {
  const today = todayIn(tz);
  let first = today;
  let last = today;
  let error: string | null = null;
  switch (preset) {
    case 'yesterday':
      first = last = addDays(today, -1);
      break;
    case '7d':
      first = addDays(today, -6);
      break;
    case '30d':
      first = addDays(today, -29);
      break;
    case 'custom': {
      const f = isDateKey(custom.from) ? custom.from : null;
      const t = isDateKey(custom.to) ? custom.to : null;
      first = f ?? addDays(today, -6);
      last = t ?? today;
      if (!f || !t) error = tStatic('analytics.range.errMissing');
      else if (daysBetween(f, t) < 0) {
        error = tStatic('analytics.range.errOrder');
        last = first;
      }
      break;
    }
    default:
      break;
  }
  return { first, last, from: first, to: addDays(last, 1), days: daysBetween(first, last) + 1, error };
}

export function defaultGroup(preset: RangePreset, days: number): GroupBy {
  if (preset === 'today' || preset === 'yesterday' || days <= 2) return 'hour';
  if (days > 120) return 'week';
  return 'day';
}

/** "12 Oct 2026" from a YYYY-MM-DD key (calendar date, no timezone shift). */
export function formatDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function rangeLabel(r: Pick<ResolvedRange, 'first' | 'last'>): string {
  return r.first === r.last ? formatDayKey(r.first) : tStatic('analytics.range.span', { from: formatDayKey(r.first), to: formatDayKey(r.last) });
}
