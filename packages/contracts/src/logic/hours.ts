/**
 * Operating hours (ch. 22). Schedules are expressed in an IANA timezone with
 * per-weekday local time ranges ("HH:MM" 24h, half open [start, end)). A range
 * whose end is before its start continues past midnight into the next local
 * date (e.g. 22:00–02:00); "24:00" as an end means the end of that local date
 * (all day = 00:00–24:00). Equal start and end is rejected.
 *
 * Boundaries are computed as UTC instants from the local wall times using the
 * runtime's ICU tzdata (Intl), with explicit daylight-saving rules:
 *  - a non-existent local boundary (spring-forward gap) resolves to the first
 *    valid instant after the gap (the transition instant);
 *  - an ambiguous local boundary (fall-back fold) resolves to the EARLIER
 *    instant when opening and to the LATER instant when closing;
 *  - the exact closing instant is closed (half-open intervals).
 * A dated exception replaces the weekly ranges that START on that local date
 * (an overnight range belongs to the date it starts on); empty = closed all day.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface TimeRange {
  start: string;
  end: string;
}

export interface Holiday {
  date: string; // YYYY-MM-DD in schedule timezone
  name: string;
}

export interface WeeklySchedule {
  timezone: string;
  days: Record<Weekday, TimeRange[]>;
  holidays: Holiday[];
}

export interface OperatingHoursSettings {
  enabled: boolean;
  /** 'account' uses one schedule; 'department' uses each department's own schedule. */
  mode: 'account' | 'department';
  schedule: WeeklySchedule;
}

export function defaultSchedule(timezone = 'UTC'): WeeklySchedule {
  const weekday: TimeRange[] = [{ start: '09:00', end: '17:00' }];
  return {
    timezone,
    days: { sun: [], mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [] },
    holidays: [],
  };
}

export const DEFAULT_OPERATING_HOURS: OperatingHoursSettings = {
  enabled: false,
  mode: 'account',
  schedule: defaultSchedule('UTC'),
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const HM_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))$/;
export const MAX_INTERVALS_PER_DAY = 12;

function parseHM(s: string): number {
  const [h, m] = s.split(':').map((x) => Number(x));
  return (h || 0) * 60 + (m || 0);
}

/** Strict "HH:MM" parser (00:00–23:59, plus "24:00" when `allow24`). Returns minutes or null. */
export function parseTimeOfDay(s: unknown, allow24 = false): number | null {
  if (typeof s !== 'string') return null;
  const m = HM_RE.exec(s);
  if (!m) return null;
  if (m[3]) return allow24 ? 1440 : null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ───────────────────────── Timezone primitives (Intl / ICU tzdata) ─────────────────────────

const OFFSET_LIKE = /^[+\-\d]/;

/** IANA timezone name accepted by the runtime tz database. Numeric offsets are rejected (persist names, ch. 22). */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || OFFSET_LIKE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Canonical capitalization of a valid IANA name ("america/new_york" → "America/New_York"); aliases are kept as given. */
export function canonicalTimezone(tz: string): string {
  if (!isValidTimezone(tz)) return tz;
  const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  return resolved.toLowerCase() === tz.toLowerCase() ? resolved : tz;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

function safeTz(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallParts(tz: string, utcMs: number): WallParts {
  const p: Record<string, string> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** UTC offset (ms, local − UTC) in effect at an instant. */
export function tzOffsetMs(tz: string, utcMs: number): number {
  const floored = utcMs - (((utcMs % 1000) + 1000) % 1000);
  const w = wallParts(tz, floored);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

/** Local wall time encoded as if it were UTC (ms). */
function wallMs(tz: string, utcMs: number): number {
  return utcMs + tzOffsetMs(tz, utcMs);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDateOf(utcMs: number, timezone: string): string {
  const w = wallParts(safeTz(timezone), utcMs);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Local wall time "YYYY-MM-DDTHH:MM:SS" of an instant. */
export function localDateTimeOf(utcMs: number, timezone: string): string {
  const w = wallParts(safeTz(timezone), utcMs);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

/** "+HH:MM" / "-HH:MM" offset label at an instant. */
export function utcOffsetLabel(utcMs: number, timezone: string): string {
  const off = Math.round(tzOffsetMs(safeTz(timezone), utcMs) / MINUTE);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const labelFormatters = new Map<string, Intl.DateTimeFormat>();
/** Human local label, e.g. "Sun, Mar 8, 2026, 03:00 EDT". */
export function localLabel(utcMs: number, timezone: string, locale = 'en-US'): string {
  const tz = safeTz(timezone);
  const key = `${locale}|${tz}`;
  let f = labelFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
    labelFormatters.set(key, f);
  }
  return f.format(new Date(utcMs));
}

function dateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

export function addLocalDays(date: string, n: number): string {
  const [y, m, d] = dateParts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOfDate(date: string): Weekday {
  const [y, m, d] = dateParts(date);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = dateParts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export type LocalResolution =
  | { kind: 'exact'; instant: number }
  /** Non-existent wall time; `instant` is the first valid instant after the gap (the transition). */
  | { kind: 'gap'; instant: number }
  /** Wall time occurs twice; both instants. */
  | { kind: 'fold'; earlier: number; later: number };

/** Resolve a local wall time (encoded as UTC ms) in `tz` to the instant(s) it denotes. */
export function resolveLocalTime(timezone: string, localWallMs: number): LocalResolution {
  const tz = safeTz(timezone);
  const before = tzOffsetMs(tz, localWallMs - DAY);
  const after = tzOffsetMs(tz, localWallMs + DAY);
  const valid = [...new Set([before, after])]
    .map((o) => localWallMs - o)
    .filter((t) => wallMs(tz, t) === localWallMs)
    .sort((a, b) => a - b);
  if (valid.length === 1) return { kind: 'exact', instant: valid[0] };
  if (valid.length > 1) return { kind: 'fold', earlier: valid[0], later: valid[valid.length - 1] };
  // Gap: binary search the transition between the two candidate instants.
  let lo = Math.min(localWallMs - before, localWallMs - after);
  let hi = Math.max(localWallMs - before, localWallMs - after);
  const loOffset = tzOffsetMs(tz, lo);
  if (lo === hi || tzOffsetMs(tz, hi) === loOffset) return { kind: 'gap', instant: hi };
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (tzOffsetMs(tz, mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return { kind: 'gap', instant: hi };
}

export type BoundaryRole = 'open' | 'close';

export interface DstResolutionNote {
  kind: 'dst_gap' | 'dst_fold';
  /** Requested local wall time "YYYY-MM-DDTHH:MM". */
  requestedLocal: string;
  resolution: 'first_valid_after_gap' | 'earlier' | 'later';
}

function wallLabel(localWallMs: number): string {
  return new Date(localWallMs).toISOString().slice(0, 16);
}

/** Resolve a schedule boundary with the ch. 22 DST rules. */
export function resolveBoundary(timezone: string, localWallMs: number, role: BoundaryRole): { instant: number; note: DstResolutionNote | null } {
  const r = resolveLocalTime(timezone, localWallMs);
  if (r.kind === 'exact') return { instant: r.instant, note: null };
  if (r.kind === 'gap') return { instant: r.instant, note: { kind: 'dst_gap', requestedLocal: wallLabel(localWallMs), resolution: 'first_valid_after_gap' } };
  return role === 'open'
    ? { instant: r.earlier, note: { kind: 'dst_fold', requestedLocal: wallLabel(localWallMs), resolution: 'earlier' } }
    : { instant: r.later, note: { kind: 'dst_fold', requestedLocal: wallLabel(localWallMs), resolution: 'later' } };
}

/** Local date/hour/minute of an instant (kept for compatibility). */
export interface ZonedParts {
  weekday: Weekday;
  minutes: number;
  date: string;
  hour: number;
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const tz = safeTz(timezone);
  const w = wallParts(tz, date.getTime());
  const d = `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
  return { weekday: weekdayOfDate(d), hour: w.h, minutes: w.h * 60 + w.mi, date: d };
}

// ───────────────────────── Schedules with dated exceptions ─────────────────────────

export interface ScheduleException {
  /** Local date YYYY-MM-DD in the schedule timezone. Empty intervals = closed all day. */
  date: string;
  intervals: TimeRange[];
}

export interface EffectiveSchedule {
  timezone: string;
  days: Record<Weekday, TimeRange[]>;
  exceptions: ScheduleException[];
}

export interface OpenInterval {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. */
  end: number;
  /** Local date whose range produced the opening. */
  localDate: string;
  source: 'weekly' | 'exception';
  startNote: DstResolutionNote | null;
  endNote: DstResolutionNote | null;
}

const exceptionIndexes = new WeakMap<ScheduleException[], { len: number; idx: Map<string, TimeRange[]> }>();
function exceptionIndex(s: EffectiveSchedule): Map<string, TimeRange[]> {
  const list = s.exceptions ?? [];
  let entry = exceptionIndexes.get(list);
  if (!entry || entry.len !== list.length) {
    entry = { len: list.length, idx: new Map(list.map((e) => [e.date, e.intervals])) };
    exceptionIndexes.set(list, entry);
  }
  return entry.idx;
}

function rangesFor(s: EffectiveSchedule, date: string): { ranges: TimeRange[]; source: 'weekly' | 'exception' } {
  const ex = exceptionIndex(s).get(date);
  if (ex) return { ranges: ex, source: 'exception' };
  return { ranges: s.days[weekdayOfDate(date)] ?? [], source: 'weekly' };
}

/** Raw (unmerged) intervals produced by one local date's ranges. */
export function intervalsForLocalDate(s: EffectiveSchedule, date: string): OpenInterval[] {
  const tz = safeTz(s.timezone);
  const [y, m, d] = dateParts(date);
  const { ranges, source } = rangesFor(s, date);
  const out: OpenInterval[] = [];
  for (const r of ranges) {
    const st = parseTimeOfDay(r.start);
    let en = parseTimeOfDay(r.end, true);
    if (st === null || en === null || en === st) continue;
    if (en < st) en += 1440; // overnight: ends on the next local date
    const open = resolveBoundary(tz, Date.UTC(y, m - 1, d, 0, st), 'open');
    const close = resolveBoundary(tz, Date.UTC(y, m - 1, d, 0, en), 'close');
    if (close.instant <= open.instant) continue; // vanished inside a DST gap
    out.push({ start: open.instant, end: close.instant, localDate: date, source, startNote: open.note, endNote: close.note });
  }
  return out;
}

function mergeIntervals(list: OpenInterval[]): OpenInterval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: OpenInterval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) {
        last.end = i.end;
        last.endNote = i.endNote;
      }
    } else out.push({ ...i });
  }
  return out;
}

/** Merged open intervals intersecting [fromMs, toMs). Touching intervals merge (no boundary between them). */
export function openIntervalsBetween(s: EffectiveSchedule, fromMs: number, toMs: number): OpenInterval[] {
  const tz = safeTz(s.timezone);
  const firstDate = addLocalDays(localDateOf(fromMs, tz), -2);
  const lastDate = addLocalDays(localDateOf(toMs, tz), 1);
  const raw: OpenInterval[] = [];
  for (let date = firstDate; date <= lastDate; date = addLocalDays(date, 1)) raw.push(...intervalsForLocalDate(s, date));
  return mergeIntervals(raw).filter((i) => i.end > fromMs && i.start < toMs);
}

/** Merged open interval containing the instant, if any. */
export function openIntervalAt(s: EffectiveSchedule, at: Date | number = Date.now()): OpenInterval | null {
  const t = typeof at === 'number' ? at : at.getTime();
  return openIntervalsBetween(s, t, t + 1).find((i) => i.start <= t && t < i.end) ?? null;
}

/** Half-open [start, end) evaluation with DST boundary rules. */
export function isEffectiveScheduleOpen(s: EffectiveSchedule, at: Date = new Date()): boolean {
  return openIntervalAt(s, at) !== null;
}

function hasAnyRanges(s: EffectiveSchedule, from: string): boolean {
  return WEEKDAYS.some((d) => (s.days[d] ?? []).length > 0) || s.exceptions.some((e) => e.date >= from && e.intervals.length > 0);
}

/**
 * Next instant at which the schedule opens (boundary computation, not scanning).
 * Returns `from` when already open and null when nothing opens within `horizonDays`.
 */
export function nextScheduleOpening(s: EffectiveSchedule, from: Date = new Date(), horizonDays = 366): Date | null {
  const t = from.getTime();
  if (isEffectiveScheduleOpen(s, from)) return from;
  const tz = safeTz(s.timezone);
  const startDate = localDateOf(t, tz);
  if (!hasAnyRanges(s, addLocalDays(startDate, -1))) return null;
  const windowDays = 8;
  for (let offset = -1; offset <= horizonDays; offset += windowDays) {
    const a = addLocalDays(startDate, offset);
    const raw: OpenInterval[] = [];
    for (let i = 0; i < windowDays + 1; i++) raw.push(...intervalsForLocalDate(s, addLocalDays(a, i)));
    const next = mergeIntervals(raw)
      .filter((i) => i.start > t)
      .sort((x, y) => x.start - y.start)[0];
    if (next) return new Date(next.start);
  }
  return null;
}

export interface ScheduleBoundary {
  kind: 'open' | 'close';
  at: number;
  localDate: string;
  source: 'weekly' | 'exception';
  note: DstResolutionNote | null;
}

/** Open/close boundaries strictly after `fromMs` and before `toMs`, in time order. */
export function boundariesBetween(s: EffectiveSchedule, fromMs: number, toMs: number): ScheduleBoundary[] {
  const out: ScheduleBoundary[] = [];
  for (const i of openIntervalsBetween(s, fromMs, toMs)) {
    if (i.start > fromMs && i.start < toMs) out.push({ kind: 'open', at: i.start, localDate: i.localDate, source: i.source, note: i.startNote });
    if (i.end > fromMs && i.end < toMs) out.push({ kind: 'close', at: i.end, localDate: i.localDate, source: i.source, note: i.endNote });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Next open/close transition after `from` (for availability timers), or null within the horizon. */
export function nextScheduleBoundary(s: EffectiveSchedule, from: Date = new Date(), horizonDays = 35): ScheduleBoundary | null {
  const t = from.getTime();
  const tz = safeTz(s.timezone);
  if (!hasAnyRanges(s, addLocalDays(localDateOf(t, tz), -1))) return null;
  for (let w = 0; w < horizonDays; w += 7) {
    const b = boundariesBetween(s, t + w * DAY, t + (w + 7) * DAY + MINUTE)[0];
    if (b && b.at > t) return b;
  }
  return null;
}

// ───────────────────────── DST transitions & preview ─────────────────────────

export interface DstTransition {
  at: number;
  offsetBefore: string;
  offsetAfter: string;
  kind: 'forward' | 'backward';
  /** Local wall time just before the transition and the wall time it becomes. */
  localBefore: string;
  localAfter: string;
}

/** Offset transitions in [fromMs, toMs) (scan + binary search). */
export function dstTransitionsBetween(timezone: string, fromMs: number, toMs: number): DstTransition[] {
  const tz = safeTz(timezone);
  const step = 3 * 3600_000;
  const out: DstTransition[] = [];
  let prevT = fromMs;
  let prevO = tzOffsetMs(tz, prevT);
  for (let t = fromMs + step; prevT < toMs; t += step) {
    const cur = Math.min(t, toMs);
    const o = tzOffsetMs(tz, cur);
    if (o !== prevO) {
      let lo = prevT;
      let hi = cur;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (tzOffsetMs(tz, mid) === prevO) lo = mid;
        else hi = mid;
      }
      out.push({
        at: hi,
        offsetBefore: utcOffsetLabel(hi - 1000, tz),
        offsetAfter: utcOffsetLabel(hi, tz),
        kind: o > prevO ? 'forward' : 'backward',
        localBefore: wallLabel(hi + prevO),
        localAfter: wallLabel(hi + o),
      });
    }
    prevT = cur;
    prevO = o;
    if (cur >= toMs) break;
  }
  return out;
}

export interface PreviewBoundary {
  kind: 'open' | 'close';
  /** RFC3339 UTC instant. */
  at: string;
  /** Local wall time "YYYY-MM-DDTHH:MM:SS". */
  local: string;
  localLabel: string;
  utcOffset: string;
  localDate: string;
  source: 'weekly' | 'exception';
  dst: DstResolutionNote | null;
  note: string | null;
}

export interface PreviewInterval {
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
  localDate: string;
  source: 'weekly' | 'exception';
}

export interface SchedulePreview {
  timezone: string;
  from: string;
  to: string;
  openAtFrom: boolean;
  nextOpenAt: string | null;
  boundaries: PreviewBoundary[];
  intervals: PreviewInterval[];
  transitions: Array<{ at: string; offsetBefore: string; offsetAfter: string; kind: 'forward' | 'backward'; localBefore: string; localAfter: string; note: string }>;
}

function describeNote(n: DstResolutionNote, actualLocal: string): string {
  const req = n.requestedLocal.replace('T', ' ');
  if (n.kind === 'dst_gap') return `Local time ${req} does not exist (daylight saving gap); resolved to the first valid instant after the gap, ${actualLocal.replace('T', ' ').slice(0, 16)}.`;
  return `Local time ${req} occurs twice (daylight saving fold); the ${n.resolution} instant is used.`;
}

/** Preview of local and UTC intervals/boundaries for `days` days from `from` (ch. 42 preview). */
export function previewSchedule(s: EffectiveSchedule, from: Date, days: number): SchedulePreview {
  const tz = safeTz(s.timezone);
  const fromMs = from.getTime();
  const toMs = fromMs + Math.max(1, Math.min(days, 366)) * DAY;
  const intervals = openIntervalsBetween(s, fromMs, toMs);
  const boundaries = boundariesBetween(s, fromMs - 1, toMs).map((b): PreviewBoundary => {
    const local = localDateTimeOf(b.at, tz);
    return {
      kind: b.kind,
      at: new Date(b.at).toISOString(),
      local,
      localLabel: localLabel(b.at, tz),
      utcOffset: utcOffsetLabel(b.at, tz),
      localDate: b.localDate,
      source: b.source,
      dst: b.note,
      note: b.note ? describeNote(b.note, local) : null,
    };
  });
  const next = nextScheduleOpening(s, from);
  return {
    timezone: tz,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    openAtFrom: isEffectiveScheduleOpen(s, from),
    nextOpenAt: next ? next.toISOString() : null,
    boundaries,
    intervals: intervals.map((i) => ({
      start: new Date(i.start).toISOString(),
      end: new Date(i.end).toISOString(),
      startLocal: localDateTimeOf(i.start, tz),
      endLocal: localDateTimeOf(i.end, tz),
      localDate: i.localDate,
      source: i.source,
    })),
    transitions: dstTransitionsBetween(tz, fromMs, toMs).map((t) => ({
      at: new Date(t.at).toISOString(),
      offsetBefore: t.offsetBefore,
      offsetAfter: t.offsetAfter,
      kind: t.kind,
      localBefore: t.localBefore,
      localAfter: t.localAfter,
      note:
        t.kind === 'forward'
          ? `Clocks move forward at ${t.localBefore.replace('T', ' ')} to ${t.localAfter.replace('T', ' ')} (UTC${t.offsetBefore} → UTC${t.offsetAfter}); local times in between do not exist.`
          : `Clocks move back at ${t.localBefore.replace('T', ' ')} to ${t.localAfter.replace('T', ' ')} (UTC${t.offsetBefore} → UTC${t.offsetAfter}); local times in between occur twice.`,
    })),
  };
}

// ───────────────────────── Validation ─────────────────────────

/** Validate that intervals within a day are well-formed and non-overlapping (legacy helper). */
export function validateIntervals(ranges: TimeRange[]): string | null {
  const errs = validateDayIntervals(ranges);
  const first = Object.values(errs)[0];
  return first ? first[0] : null;
}

function rangeSpan(r: TimeRange): [number, number] | null {
  const st = parseTimeOfDay(r?.start);
  const en = parseTimeOfDay(r?.end, true);
  if (st === null || en === null) return null;
  return [st, en < st ? en + 1440 : en];
}

function checkRangeShape(r: TimeRange, path: string, errors: Record<string, string[]>): [number, number] | null {
  if (!r || typeof r !== 'object') {
    (errors[path] ??= []).push('Expected {start, end}');
    return null;
  }
  if (parseTimeOfDay(r.start) === null) (errors[`${path}.start`] ??= []).push('Use HH:MM between 00:00 and 23:59');
  if (parseTimeOfDay(r.end, true) === null) (errors[`${path}.end`] ??= []).push('Use HH:MM between 00:00 and 24:00');
  const span = rangeSpan(r);
  if (span && span[0] === span[1]) (errors[path] ??= []).push('Start and end must differ');
  return span && span[0] !== span[1] ? span : null;
}

/** Flags every span that starts before an earlier span (in start order) has ended; `cycle` wraps around (weekly). */
function flagOverlaps(spans: Array<{ s: number; e: number; path: string }>, errors: Record<string, string[]>, cycle: number | null): void {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  let maxEnd = -Infinity;
  for (const sp of sorted) {
    if (sp.s < maxEnd) (errors[sp.path] ??= []).push('Intervals overlap');
    maxEnd = Math.max(maxEnd, sp.e);
  }
  if (cycle !== null && sorted.length > 1 && maxEnd - cycle > sorted[0].s) (errors[sorted[0].path] ??= []).push('Intervals overlap');
}

function shapeErrors(ranges: unknown, prefix: string, errors: Record<string, string[]>, offset: number): Array<{ s: number; e: number; path: string }> {
  const spans: Array<{ s: number; e: number; path: string }> = [];
  if (!Array.isArray(ranges)) {
    (errors[prefix || '_'] ??= []).push('Expected a list of intervals');
    return spans;
  }
  if (ranges.length > MAX_INTERVALS_PER_DAY) (errors[prefix || '_'] ??= []).push(`At most ${MAX_INTERVALS_PER_DAY} intervals per day`);
  ranges.forEach((r, i) => {
    const path = prefix ? `${prefix}.${i}` : String(i);
    const span = checkRangeShape(r as TimeRange, path, errors);
    if (span) spans.push({ s: offset + span[0], e: offset + span[1], path });
  });
  return spans;
}

/** Field errors for one local date's ranges (exceptions): well-formed, bounded, non-overlapping. */
export function validateDayIntervals(ranges: TimeRange[], prefix = ''): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  flagOverlaps(shapeErrors(ranges, prefix, errors, 0), errors, null);
  return errors;
}

/**
 * Field errors for a weekly schedule: known weekday keys only, bounded
 * well-formed ranges, and no overlap anywhere on the 7-day cycle (including
 * overnight ranges spilling into the next day).
 */
export function validateWeeklyIntervals(weekly: Record<string, TimeRange[]>): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (!weekly || typeof weekly !== 'object' || Array.isArray(weekly)) return { _: ['Expected an object keyed by weekday (sun…sat)'] };
  const spans: Array<{ s: number; e: number; path: string }> = [];
  for (const [key, ranges] of Object.entries(weekly)) {
    const di = WEEKDAYS.indexOf(key as Weekday);
    if (di < 0) {
      (errors[key] ??= []).push('Unknown weekday; use sun, mon, tue, wed, thu, fri, sat');
      continue;
    }
    spans.push(...shapeErrors(ranges, key, errors, di * 1440));
  }
  flagOverlaps(spans, errors, 7 * 1440);
  return errors;
}

/** Normalize stored/input weekly intervals to all seven days, sorted by start. */
export function normalizeWeeklyIntervals(raw: unknown): Record<Weekday, TimeRange[]> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    WEEKDAYS.map((d) => {
      const list = Array.isArray(src[d]) ? (src[d] as TimeRange[]) : [];
      return [d, list.map((r) => ({ start: String(r.start), end: String(r.end) })).sort((a, b) => parseHM(a.start) - parseHM(b.start))];
    }),
  ) as Record<Weekday, TimeRange[]>;
}

// ───────────────────────── Legacy weekly schedule (tenant settings.operatingHours) ─────────────────────────

/** Is the legacy weekly schedule (holidays close the whole local date) open at the instant? */
export function isScheduleOpen(schedule: WeeklySchedule, at: Date = new Date()): boolean {
  return isEffectiveScheduleOpen({ timezone: schedule.timezone, days: schedule.days, exceptions: (schedule.holidays ?? []).map((h) => ({ date: h.date, intervals: [] })) }, at);
}
