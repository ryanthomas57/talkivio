/**
 * Inclusive calendar dates in the workspace time zone → half-open UTC instants
 * (ch. 17): `from` is the first instant of the start date, `to` the first
 * instant of the day after the end date. Each boundary is resolved on its own,
 * so 23- and 25-hour DST days (and zones whose midnight is skipped) are exact.
 */
import { intlLocale } from '@/i18n';

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
export function zonedParts(instant: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = dtf(tz).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** Offset of `tz` from UTC at an instant, in ms (wall clock − UTC). */
export function offsetAt(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string | null | undefined): s is string {
  if (!s) return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** Calendar arithmetic on YYYY-MM-DD (no time zone involved). */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date)!;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + days));
  return d.toISOString().slice(0, 10);
}

/** First instant (UTC ms) whose wall-clock date in `tz` is `date`. */
export function startOfZonedDay(date: string, tz: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date ${date}`);
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const wall = Date.UTC(y, mo - 1, d);
  // Candidates from the offsets in force shortly before and after local midnight.
  const candidates = [wall - offsetAt(wall - 14 * 3600_000, tz), wall - offsetAt(wall + 14 * 3600_000, tz), wall - offsetAt(wall, tz)];
  const valid = candidates.filter((t) => {
    const p = zonedParts(t, tz);
    return p.y === y && p.m === mo && p.d === d;
  });
  if (valid.length) {
    let best = Math.min(...valid);
    // A skipped midnight (DST gap) starts the day later; walk back to the first instant still on this date.
    const prev = zonedParts(best - 1000, tz);
    if (prev.y === y && prev.m === mo && prev.d === d) {
      // Not the first instant: step back by whole hours, then minutes, while the date matches.
      for (const step of [3600_000, 60_000, 1000]) {
        while (true) {
          const p = zonedParts(best - step, tz);
          if (p.y === y && p.m === mo && p.d === d) best -= step;
          else break;
        }
      }
    }
    return best;
  }
  return wall - offsetAt(wall, tz);
}

/** Inclusive [fromDate, toDate] in `tz` → half-open [from, to) UTC ISO strings. */
export function zonedRange(fromDate: string, toDate: string, tz: string): { from: string; to: string } {
  return { from: new Date(startOfZonedDay(fromDate, tz)).toISOString(), to: new Date(startOfZonedDay(addDays(toDate, 1), tz)).toISOString() };
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz: string, now = Date.now()): string {
  const p = zonedParts(now, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Absolute date-time in the workspace time zone with its abbreviation. */
export function formatInZone(v: string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(intlLocale(), { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
}
