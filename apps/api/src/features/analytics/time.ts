/**
 * IANA timezone arithmetic for analytics cohorts (ch. 50/51) without external
 * dependencies. Local days derive from the timezone database through Intl, so a
 * local day can last 23 or 25 hours across DST transitions; boundaries are UTC
 * instants (milliseconds) and every report interval is half-open [start, end).
 */

export type GroupBy = 'hour' | 'day' | 'week';

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday (local). */
  weekday: number;
}

export interface Bucket {
  /** Stable key: YYYY-MM-DD (day/week start) or YYYY-MM-DDTHH:00±HH:MM (hour). */
  key: string;
  /** Inclusive UTC start (ms), clipped to the report range. */
  start: number;
  /** Exclusive UTC end (ms), clipped to the report range. */
  end: number;
  /** Unclipped local unit length in hours (23/24/25 for DST days). */
  unitHours: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Partial<ZonedParts> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
      case 'second':
        out.second = Number(p.value);
        break;
      case 'weekday':
        out.weekday = WEEKDAYS[p.value] ?? 0;
        break;
    }
  }
  return out as ZonedParts;
}

/** UTC offset in minutes at an instant (local wall time minus UTC). */
export function offsetMinutes(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function localDateKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function isDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Civil-date arithmetic (no timezone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function civilWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * First UTC instant whose local date is `date` (handles DST gaps at midnight).
 * Fast path: offset correction; fallback: binary search over whole seconds.
 */
export function startOfLocalDay(date: string, tz: string): number {
  const cacheKey = `${tz}|${date}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const [y, m, d] = date.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const isStart = (t: number) => localDateKey(t, tz) === date && localDateKey(t - 1000, tz) < date;
  let result: number | null = null;
  const t1 = utcMidnight - offsetMinutes(utcMidnight, tz) * 60000;
  const t2 = utcMidnight - offsetMinutes(t1, tz) * 60000;
  for (const t of [t2, t1]) {
    if (isStart(t)) {
      result = t;
      break;
    }
  }
  if (result === null) {
    let lo = Math.floor((utcMidnight - 16 * 3600_000) / 1000);
    let hi = Math.floor((utcMidnight + 16 * 3600_000) / 1000);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDateKey(mid * 1000, tz) >= date) hi = mid;
      else lo = mid + 1;
    }
    result = lo * 1000;
  }
  if (dayStartCache.size > 20_000) dayStartCache.clear();
  dayStartCache.set(cacheKey, result);
  return result;
}

/** Instant at which the local hour containing `ms` began. */
function hourStart(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return ms - (p.minute * 60 + p.second) * 1000 - (((ms % 1000) + 1000) % 1000);
}

function weekStartDate(date: string, weekStartsOn: number): string {
  return addDays(date, -((civilWeekday(date) - weekStartsOn + 7) % 7));
}

/**
 * Ordered buckets covering [from, to). Day/week buckets follow local midnight
 * (23/24/25-hour days); hour buckets follow local hour starts and carry the UTC
 * offset in their key so a repeated hour in a DST fold stays distinct.
 */
export function buildBuckets(from: number, to: number, tz: string, groupBy: GroupBy, weekStartsOn = 1): Bucket[] {
  const out: Bucket[] = [];
  if (!(to > from)) return out;
  if (groupBy === 'hour') {
    let s = hourStart(from, tz);
    let unitStart = s;
    let guard = 0;
    while (s < to && guard++ < 50_000) {
      let e = hourStart(s + 3600_000, tz);
      if (e <= s) e = s + 3600_000;
      const p = zonedParts(s, tz);
      const key = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:00${formatOffset(offsetMinutes(s, tz))}`;
      const last = out[out.length - 1];
      if (last && last.key === key) {
        // Exotic half-hour transitions can split one local hour; merge the pieces.
        last.end = Math.min(e, to);
        last.unitHours = (e - unitStart) / 3600_000;
      } else {
        unitStart = s;
        out.push({ key, start: Math.max(s, from), end: Math.min(e, to), unitHours: (e - s) / 3600_000 });
      }
      s = e;
    }
    return out;
  }
  let date = localDateKey(from, tz);
  if (groupBy === 'week') date = weekStartDate(date, weekStartsOn);
  const step = groupBy === 'week' ? 7 : 1;
  let guard = 0;
  while (guard++ < 10_000) {
    const s = startOfLocalDay(date, tz);
    if (s >= to) break;
    const next = addDays(date, step);
    const e = startOfLocalDay(next, tz);
    if (e > from) out.push({ key: date, start: Math.max(s, from), end: Math.min(e, to), unitHours: (e - s) / 3600_000 });
    date = next;
  }
  return out;
}

/** Returns a function mapping an instant to its bucket index (or -1 outside the range). */
export function bucketIndexer(buckets: Bucket[]): (ms: number) => number {
  const starts = buckets.map((b) => b.start);
  return (ms: number) => {
    if (!buckets.length || ms < starts[0] || ms >= buckets[buckets.length - 1].end) return -1;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    return ms < buckets[lo].end ? lo : -1;
  };
}

/**
 * Parse a range bound: `YYYY-MM-DD` means local midnight in `tz`; otherwise an
 * RFC 3339 timestamp with explicit offset. Returns null when invalid.
 */
export function parseBound(value: string, tz: string): number | null {
  if (isDateKey(value)) return startOfLocalDay(value, tz);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Human label such as "Europe/London (UTC+01:00 → UTC+00:00)". */
export function timezoneLabel(tz: string, from: number, to: number): { label: string; offsets: string[] } {
  const offsets: string[] = [];
  const step = Math.max(3600_000, Math.floor((to - from) / 400));
  for (let t = from; t < to; t += step) {
    const o = formatOffset(offsetMinutes(t, tz));
    if (offsets[offsets.length - 1] !== o) offsets.push(o);
  }
  const end = formatOffset(offsetMinutes(Math.max(from, to - 1), tz));
  if (offsets[offsets.length - 1] !== end) offsets.push(end);
  return { label: `${tz} (${offsets.map((o) => `UTC${o}`).join(' → ')})`, offsets };
}
