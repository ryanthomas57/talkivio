import { describe, expect, it } from 'vitest';
import {
  boundariesBetween,
  canonicalTimezone,
  dstTransitionsBetween,
  isEffectiveScheduleOpen,
  isScheduleOpen,
  isValidTimezone,
  localDateTimeOf,
  nextScheduleBoundary,
  nextScheduleOpening,
  openIntervalsBetween,
  previewSchedule,
  resolveBoundary,
  resolveLocalTime,
  tzOffsetMs,
  validateDayIntervals,
  validateIntervals,
  validateWeeklyIntervals,
  zonedParts,
  type EffectiveSchedule,
  type TimeRange,
  type Weekday,
} from './hours';

const Z = (iso: string) => Date.parse(iso);
const wall = (iso: string) => Date.parse(`${iso}Z`); // local wall time encoded as UTC ms
const empty = (): Record<Weekday, TimeRange[]> => ({ sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
function sched(timezone: string, days: Partial<Record<Weekday, TimeRange[]>>, exceptions: EffectiveSchedule['exceptions'] = []): EffectiveSchedule {
  return { timezone, days: { ...empty(), ...days }, exceptions };
}
const NY = 'America/New_York';
const iso = (ms: number | Date | null) => (ms === null ? null : new Date(ms).toISOString());

describe('timezone primitives', () => {
  it('computes offsets from tzdata', () => {
    expect(tzOffsetMs(NY, Z('2026-01-15T12:00:00Z'))).toBe(-5 * 3600_000);
    expect(tzOffsetMs(NY, Z('2026-07-15T12:00:00Z'))).toBe(-4 * 3600_000);
    expect(tzOffsetMs('Asia/Kolkata', Z('2026-07-15T12:00:00Z'))).toBe(5.5 * 3600_000);
  });

  it('accepts IANA names only (no numeric offsets)', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Etc/GMT+5')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('+05:00')).toBe(false);
    expect(isValidTimezone('-0500')).toBe(false);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(canonicalTimezone('america/new_york')).toBe('America/New_York');
  });

  it('resolves exact, gap and fold local times', () => {
    expect(resolveLocalTime(NY, wall('2026-06-01T09:00:00'))).toEqual({ kind: 'exact', instant: Z('2026-06-01T13:00:00Z') });
    // 2026-03-08 02:30 does not exist in New York (02:00 EST → 03:00 EDT at 07:00Z).
    expect(resolveLocalTime(NY, wall('2026-03-08T02:30:00'))).toEqual({ kind: 'gap', instant: Z('2026-03-08T07:00:00Z') });
    // 2026-11-01 01:30 occurs twice (EDT then EST).
    expect(resolveLocalTime(NY, wall('2026-11-01T01:30:00'))).toEqual({ kind: 'fold', earlier: Z('2026-11-01T05:30:00Z'), later: Z('2026-11-01T06:30:00Z') });
  });

  it('handles a skipped calendar day (Samoa 2011-12-30)', () => {
    const r = resolveLocalTime('Pacific/Apia', wall('2011-12-30T12:00:00'));
    expect(r.kind).toBe('gap');
    expect(r.kind === 'gap' && iso(r.instant)).toBe('2011-12-30T10:00:00.000Z');
    expect(localDateTimeOf(Z('2011-12-30T10:00:00Z'), 'Pacific/Apia')).toBe('2011-12-31T00:00:00');
  });

  it('zonedParts keeps its legacy shape', () => {
    expect(zonedParts(new Date('2026-03-09T13:30:00Z'), NY)).toEqual({ weekday: 'mon', hour: 9, minutes: 570, date: '2026-03-09' });
  });
});

describe('DST boundary rules (HOURS01)', () => {
  it('spring forward: a non-existent OPENING resolves to the first valid instant after the gap', () => {
    const s = sched(NY, { sun: [{ start: '02:30', end: '10:00' }] });
    const b = resolveBoundary(NY, wall('2026-03-08T02:30:00'), 'open');
    expect(iso(b.instant)).toBe('2026-03-08T07:00:00.000Z');
    expect(b.note).toMatchObject({ kind: 'dst_gap', resolution: 'first_valid_after_gap' });
    expect(isEffectiveScheduleOpen(s, new Date('2026-03-08T06:59:59Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(s, new Date('2026-03-08T07:00:00Z'))).toBe(true); // 03:00 EDT
    expect(iso(nextScheduleOpening(s, new Date('2026-03-08T05:00:00Z')))).toBe('2026-03-08T07:00:00.000Z');
  });

  it('spring forward: a non-existent CLOSING resolves to the first valid instant after the gap', () => {
    const s = sched(NY, { sun: [{ start: '00:00', end: '02:30' }] });
    const [i] = openIntervalsBetween(s, Z('2026-03-08T00:00:00Z'), Z('2026-03-09T00:00:00Z'));
    expect(iso(i.start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(i.end)).toBe('2026-03-08T07:00:00.000Z');
    expect(i.endNote).toMatchObject({ kind: 'dst_gap' });
    expect(isEffectiveScheduleOpen(s, new Date('2026-03-08T06:59:59Z'))).toBe(true); // 01:59:59 EST
    expect(isEffectiveScheduleOpen(s, new Date('2026-03-08T07:00:00Z'))).toBe(false); // 03:00 EDT
  });

  it('spring forward: an interval entirely inside the gap never opens', () => {
    const s = sched(NY, { sun: [{ start: '02:10', end: '02:50' }] });
    expect(openIntervalsBetween(s, Z('2026-03-07T00:00:00Z'), Z('2026-03-10T00:00:00Z'))).toEqual([]);
  });

  it('fall back: an ambiguous OPENING uses the earlier instant', () => {
    const s = sched(NY, { sun: [{ start: '01:30', end: '05:00' }] });
    const b = resolveBoundary(NY, wall('2026-11-01T01:30:00'), 'open');
    expect(iso(b.instant)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(b.note).toMatchObject({ kind: 'dst_fold', resolution: 'earlier' });
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T05:29:59Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T05:30:00Z'))).toBe(true);
    // Still open during the repeated hour (01:00–01:30 EST).
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T06:10:00Z'))).toBe(true);
  });

  it('fall back: an ambiguous CLOSING uses the later instant', () => {
    const s = sched(NY, { sat: [{ start: '20:00', end: '01:30' }] }); // Sat 20:00 → Sun 01:30 (overnight)
    const b = resolveBoundary(NY, wall('2026-11-01T01:30:00'), 'close');
    expect(iso(b.instant)).toBe('2026-11-01T06:30:00.000Z'); // 01:30 EST
    expect(b.note).toMatchObject({ kind: 'dst_fold', resolution: 'later' });
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T05:45:00Z'))).toBe(true); // 01:45 EDT (first pass)
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T06:29:59Z'))).toBe(true); // 01:29:59 EST
    expect(isEffectiveScheduleOpen(s, new Date('2026-11-01T06:30:00Z'))).toBe(false);
  });

  it('fall back: a range fully inside the fold spans earlier open to later close', () => {
    const s = sched(NY, { sun: [{ start: '01:00', end: '01:30' }] });
    const [i] = openIntervalsBetween(s, Z('2026-10-31T00:00:00Z'), Z('2026-11-02T00:00:00Z'));
    expect([iso(i.start), iso(i.end)]).toEqual(['2026-11-01T05:00:00.000Z', '2026-11-01T06:30:00.000Z']);
  });

  it('30-minute DST shifts (Lord Howe) follow the same rules', () => {
    // Australia/Lord_Howe: 2026-04-05 02:00 (+11) → 01:30 (+10:30); 01:45 is ambiguous.
    const open = resolveBoundary('Australia/Lord_Howe', wall('2026-04-05T01:45:00'), 'open');
    const close = resolveBoundary('Australia/Lord_Howe', wall('2026-04-05T01:45:00'), 'close');
    expect(close.instant - open.instant).toBe(30 * 60_000);
  });
});

describe('half-open intervals, overnight and exceptions', () => {
  const office = sched('Europe/London', { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], fri: [{ start: '22:00', end: '02:00' }] });

  it('exact closing second is closed; opening second is open', () => {
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-05T08:59:59.999Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-05T09:00:00.000Z'))).toBe(true);
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-05T16:59:59.999Z'))).toBe(true);
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-05T17:00:00.000Z'))).toBe(false);
    // Summer time: 09:00 BST = 08:00Z.
    expect(isEffectiveScheduleOpen(office, new Date('2026-07-06T08:00:00Z'))).toBe(true);
    expect(isEffectiveScheduleOpen(office, new Date('2026-07-06T16:00:00Z'))).toBe(false);
  });

  it('overnight ranges continue into the next local date', () => {
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-09T21:59:59Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-09T22:00:00Z'))).toBe(true);
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-10T01:59:59Z'))).toBe(true); // Saturday
    expect(isEffectiveScheduleOpen(office, new Date('2026-01-10T02:00:00Z'))).toBe(false);
  });

  it('adjacent ranges across midnight merge (no boundary at midnight)', () => {
    const s = sched('UTC', { mon: [{ start: '20:00', end: '24:00' }], tue: [{ start: '00:00', end: '04:00' }] });
    const b = boundariesBetween(s, Z('2026-01-05T00:00:00Z'), Z('2026-01-07T00:00:00Z'));
    expect(b.map((x) => [x.kind, iso(x.at)])).toEqual([
      ['open', '2026-01-05T20:00:00.000Z'],
      ['close', '2026-01-06T04:00:00.000Z'],
    ]);
  });

  it('a holiday exception replaces the weekly ranges of that local date', () => {
    const s = { ...office, exceptions: [{ date: '2026-01-05', intervals: [] }] };
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-05T12:00:00Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-06T12:00:00Z'))).toBe(true);
    expect(iso(nextScheduleOpening(s, new Date('2026-01-05T12:00:00Z')))).toBe('2026-01-06T09:00:00.000Z');
  });

  it('special hours replace (not add to) weekly ranges', () => {
    const s = { ...office, exceptions: [{ date: '2026-01-05', intervals: [{ start: '12:00', end: '14:00' }] }] };
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-05T10:00:00Z'))).toBe(false);
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-05T13:00:00Z'))).toBe(true);
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-05T14:00:00Z'))).toBe(false);
  });

  it('an overnight range belongs to the date it starts on', () => {
    const s = { ...office, exceptions: [{ date: '2026-01-10', intervals: [] }] }; // Saturday closed
    expect(isEffectiveScheduleOpen(s, new Date('2026-01-10T01:00:00Z'))).toBe(true); // Friday's range still runs
    const s2 = { ...office, exceptions: [{ date: '2026-01-09', intervals: [] }] }; // Friday closed
    expect(isEffectiveScheduleOpen(s2, new Date('2026-01-10T01:00:00Z'))).toBe(false);
  });

  it('legacy holiday schedules close the whole date', () => {
    const legacy = { timezone: 'UTC', days: office.days, holidays: [{ date: '2026-01-05', name: 'Holiday' }] };
    expect(isScheduleOpen(legacy, new Date('2026-01-05T12:00:00Z'))).toBe(false);
    expect(isScheduleOpen(legacy, new Date('2026-01-06T12:00:00Z'))).toBe(true);
  });
});

describe('next opening / boundary', () => {
  it('finds the next opening across a weekend and a DST change', () => {
    const s = sched('Europe/London', { mon: [{ start: '09:00', end: '17:00' }] });
    // Clocks go forward Sun 2026-03-29; Monday 09:00 BST = 08:00Z.
    expect(iso(nextScheduleOpening(s, new Date('2026-03-27T18:00:00Z')))).toBe('2026-03-30T08:00:00.000Z');
  });

  it('returns the instant itself when open and null when never open', () => {
    const s = sched('UTC', { mon: [{ start: '09:00', end: '17:00' }] });
    const at = new Date('2026-01-05T10:00:00Z');
    expect(nextScheduleOpening(s, at)).toBe(at);
    expect(nextScheduleOpening(sched('UTC', {}), at)).toBeNull();
  });

  it('skips long closures declared as exceptions', () => {
    const exceptions = Array.from({ length: 21 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10), intervals: [] }));
    const s = sched('UTC', { mon: [{ start: '09:00', end: '17:00' }] }, exceptions);
    expect(iso(nextScheduleOpening(s, new Date('2026-01-04T00:00:00Z')))).toBe('2026-01-26T09:00:00.000Z');
  });

  it('next boundary is the close when open and the open when closed', () => {
    const s = sched('UTC', { mon: [{ start: '09:00', end: '17:00' }] });
    expect(nextScheduleBoundary(s, new Date('2026-01-05T10:00:00Z'))).toMatchObject({ kind: 'close', at: Z('2026-01-05T17:00:00Z') });
    expect(nextScheduleBoundary(s, new Date('2026-01-05T17:00:00Z'))).toMatchObject({ kind: 'open', at: Z('2026-01-12T09:00:00Z') });
  });
});

describe('preview', () => {
  it('lists UTC boundaries, local labels and DST transitions with resolution notes', () => {
    const s = sched(NY, { sun: [{ start: '02:30', end: '12:00' }], mon: [{ start: '09:00', end: '17:00' }] });
    const p = previewSchedule(s, new Date('2026-03-07T00:00:00Z'), 7);
    expect(p.transitions).toHaveLength(1);
    expect(p.transitions[0]).toMatchObject({ kind: 'forward', at: '2026-03-08T07:00:00.000Z', offsetBefore: '-05:00', offsetAfter: '-04:00' });
    const gapOpen = p.boundaries.find((b) => b.localDate === '2026-03-08' && b.kind === 'open')!;
    expect(gapOpen.at).toBe('2026-03-08T07:00:00.000Z');
    expect(gapOpen.local).toBe('2026-03-08T03:00:00');
    expect(gapOpen.utcOffset).toBe('-04:00');
    expect(gapOpen.note).toMatch(/does not exist/);
    const mon = p.boundaries.find((b) => b.localDate === '2026-03-09' && b.kind === 'open')!;
    expect(mon.at).toBe('2026-03-09T13:00:00.000Z');
    expect(mon.note).toBeNull();
    expect(p.intervals.length).toBe(2);
  });

  it('detects fall-back transitions', () => {
    const t = dstTransitionsBetween(NY, Z('2026-10-30T00:00:00Z'), Z('2026-11-03T00:00:00Z'));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'backward', at: Z('2026-11-01T06:00:00Z'), localBefore: '2026-11-01T02:00', localAfter: '2026-11-01T01:00' });
  });
});

describe('validation', () => {
  it('accepts well-formed, touching and overnight ranges', () => {
    expect(validateWeeklyIntervals({ mon: [{ start: '09:00', end: '12:00' }, { start: '12:00', end: '17:00' }], fri: [{ start: '22:00', end: '02:00' }], sat: [{ start: '02:00', end: '06:00' }] })).toEqual({});
    expect(validateWeeklyIntervals({ sun: [{ start: '00:00', end: '24:00' }] })).toEqual({});
  });

  it('rejects overlap within a day', () => {
    expect(validateWeeklyIntervals({ mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] })).toEqual({ 'mon.1': ['Intervals overlap'] });
    expect(validateIntervals([{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }])).toBe('Intervals overlap');
  });

  it('rejects overnight spill overlapping the next day and week wrap-around', () => {
    expect(Object.keys(validateWeeklyIntervals({ mon: [{ start: '22:00', end: '03:00' }], tue: [{ start: '02:00', end: '04:00' }] }))).toEqual(['tue.0']);
    expect(Object.keys(validateWeeklyIntervals({ sat: [{ start: '23:00', end: '02:00' }], sun: [{ start: '01:00', end: '05:00' }] })).length).toBe(1);
  });

  it('rejects malformed values, unknown weekdays and empty ranges', () => {
    const e = validateWeeklyIntervals({ mon: [{ start: '24:00', end: '25:00' }, { start: '10:00', end: '10:00' }], funday: [] } as never);
    expect(e['mon.0.start']).toBeDefined();
    expect(e['mon.0.end']).toBeDefined();
    expect(e['mon.1']).toEqual(['Start and end must differ']);
    expect(e.funday).toBeDefined();
    expect(validateDayIntervals([{ start: '9:00', end: '10:00' }])['0.start']).toBeDefined();
    expect(validateDayIntervals(Array.from({ length: 13 }, (_, i) => ({ start: `${String(i).padStart(2, '0')}:00`, end: `${String(i).padStart(2, '0')}:30` })))._).toBeDefined();
  });
});
