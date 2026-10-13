import { describe, expect, it } from 'vitest';
import { addDays, bucketIndexer, buildBuckets, isValidTimeZone, localDateKey, offsetMinutes, parseBound, startOfLocalDay, timezoneLabel } from './time';

const H = 3600_000;

describe('startOfLocalDay', () => {
  it('handles fixed offsets and UTC', () => {
    expect(new Date(startOfLocalDay('2026-10-12', 'UTC')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(new Date(startOfLocalDay('2026-10-12', 'Asia/Kolkata')).toISOString()).toBe('2026-10-11T18:30:00.000Z');
  });

  it('gives 23- and 25-hour local days across European DST (MET02)', () => {
    const len = (d: string, tz: string) => (startOfLocalDay(addDays(d, 1), tz) - startOfLocalDay(d, tz)) / H;
    expect(len('2026-03-29', 'Europe/London')).toBe(23);
    expect(len('2026-10-25', 'Europe/London')).toBe(25);
    expect(len('2026-10-26', 'Europe/London')).toBe(24);
    expect(len('2026-03-08', 'America/New_York')).toBe(23);
    expect(len('2026-11-01', 'America/New_York')).toBe(25);
  });

  it('starts the day at the first existing instant when midnight is skipped', () => {
    // America/Santiago springs forward at 24:00 → the 6 Sep 2026 local day starts at 01:00 (-03:00).
    const start = startOfLocalDay('2026-09-06', 'America/Santiago');
    expect(new Date(start).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(localDateKey(start - 1000, 'America/Santiago')).toBe('2026-09-05');
    expect(localDateKey(start, 'America/Santiago')).toBe('2026-09-06');
  });
});

describe('buildBuckets', () => {
  it('day buckets follow local midnight including DST days', () => {
    const tz = 'Europe/London';
    const b = buildBuckets(startOfLocalDay('2026-03-28', tz), startOfLocalDay('2026-03-31', tz), tz, 'day');
    expect(b.map((x) => x.key)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(b.map((x) => x.unitHours)).toEqual([24, 23, 24]);
    expect(b.map((x) => (x.end - x.start) / H)).toEqual([24, 23, 24]);
  });

  it('hour buckets keep the repeated hour of a fold distinct (25 buckets)', () => {
    const tz = 'America/New_York';
    const b = buildBuckets(startOfLocalDay('2026-11-01', tz), startOfLocalDay('2026-11-02', tz), tz, 'hour');
    expect(b).toHaveLength(25);
    const ones = b.filter((x) => x.key.startsWith('2026-11-01T01:00'));
    expect(ones.map((x) => x.key)).toEqual(['2026-11-01T01:00-04:00', '2026-11-01T01:00-05:00']);
    expect(new Set(b.map((x) => x.key)).size).toBe(25);
  });

  it('hour buckets skip the missing hour of a gap (23 buckets)', () => {
    const tz = 'America/New_York';
    const b = buildBuckets(startOfLocalDay('2026-03-08', tz), startOfLocalDay('2026-03-09', tz), tz, 'hour');
    expect(b).toHaveLength(23);
    expect(b.some((x) => x.key.startsWith('2026-03-08T02:00'))).toBe(false);
  });

  it('hour buckets in half-hour offset zones start at local :00', () => {
    const tz = 'Asia/Kolkata';
    const b = buildBuckets(startOfLocalDay('2026-10-12', tz), startOfLocalDay('2026-10-12', tz) + 3 * H, tz, 'hour');
    expect(b.map((x) => x.key)).toEqual(['2026-10-12T00:00+05:30', '2026-10-12T01:00+05:30', '2026-10-12T02:00+05:30']);
  });

  it('week buckets start on the configured weekday and clip to the range', () => {
    const tz = 'UTC';
    // 2026-10-14 is a Wednesday; Monday-start week → 2026-10-12.
    const b = buildBuckets(Date.parse('2026-10-14T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'), tz, 'week', 1);
    expect(b.map((x) => x.key)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(new Date(b[0].start).toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(new Date(b[2].end).toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('bucketIndexer maps instants into half-open buckets', () => {
    const tz = 'Europe/London';
    const b = buildBuckets(startOfLocalDay('2026-10-24', tz), startOfLocalDay('2026-10-27', tz), tz, 'day');
    const idx = bucketIndexer(b);
    expect(idx(b[0].start)).toBe(0);
    expect(idx(b[1].start - 1)).toBe(0);
    expect(idx(b[1].start)).toBe(1);
    // 23:30 local on the 25-hour day is still that day.
    expect(idx(Date.parse('2026-10-25T23:30:00Z'))).toBe(1);
    expect(idx(b[2].end)).toBe(-1);
    expect(idx(b[0].start - 1)).toBe(-1);
  });
});

describe('parsing and labels', () => {
  it('parses dates as local midnight and timestamps with explicit offsets only', () => {
    expect(parseBound('2026-10-25', 'Europe/London')).toBe(Date.parse('2026-10-24T23:00:00Z'));
    expect(parseBound('2026-10-25T12:00:00+02:00', 'UTC')).toBe(Date.parse('2026-10-25T10:00:00Z'));
    expect(parseBound('2026-10-25T12:00:00', 'UTC')).toBeNull();
    expect(parseBound('2026-02-30', 'UTC')).toBeNull();
  });

  it('validates IANA zones and reports offset changes in the label', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(offsetMinutes(Date.parse('2026-07-01T00:00:00Z'), 'Europe/London')).toBe(60);
    const l = timezoneLabel('Europe/London', startOfLocalDay('2026-10-24', 'Europe/London'), startOfLocalDay('2026-10-27', 'Europe/London'));
    expect(l.offsets).toEqual(['+01:00', '+00:00']);
    expect(l.label).toBe('Europe/London (UTC+01:00 → UTC+00:00)');
  });
});
