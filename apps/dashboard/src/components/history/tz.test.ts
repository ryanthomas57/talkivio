import { describe, expect, it } from 'vitest';
import { addDays, isIsoDate, startOfZonedDay, todayIn, zonedRange } from './tz';

/**
 * HIST01 / ch. 17: history date filters are calendar days in the workspace time zone, sent as half-open UTC
 * instants. Each bound is resolved on its own, so the request for a DST day covers exactly 23 or 25 hours.
 */
const hours = (r: { from: string; to: string }) => (Date.parse(r.to) - Date.parse(r.from)) / 3600_000;

describe('zonedRange', () => {
  it('spring-forward day in London is 23 hours: 00:00 GMT → 00:00 BST', () => {
    const r = zonedRange('2026-03-29', '2026-03-29', 'Europe/London');
    expect(r).toEqual({ from: '2026-03-29T00:00:00.000Z', to: '2026-03-29T23:00:00.000Z' });
    expect(hours(r)).toBe(23);
  });

  it('fall-back day in London is 25 hours: 00:00 BST → 00:00 GMT', () => {
    const r = zonedRange('2026-10-25', '2026-10-25', 'Europe/London');
    expect(r).toEqual({ from: '2026-10-24T23:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    expect(hours(r)).toBe(25);
  });

  it('a range spanning both changes covers the exact wall-clock days', () => {
    const r = zonedRange('2026-03-28', '2026-10-25', 'Europe/London');
    expect(r.from).toBe('2026-03-28T00:00:00.000Z');
    expect(r.to).toBe('2026-10-26T00:00:00.000Z');
    // 212 calendar days; the hour lost in March is given back in October.
    expect(hours(r)).toBe(212 * 24);
  });

  it('New York: 23-hour March day and 25-hour November day', () => {
    expect(zonedRange('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(zonedRange('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
  });

  it('a zone whose midnight is skipped starts the day at the first instant that exists (Havana, 00:00 → 01:00)', () => {
    // Cuba springs forward at midnight on the second Sunday of March: 2026-03-08 has no 00:00–00:59.
    const start = startOfZonedDay('2026-03-08', 'America/Havana');
    expect(new Date(start).toISOString()).toBe('2026-03-08T05:00:00.000Z'); // 01:00 CDT (UTC−4)
    const r = zonedRange('2026-03-08', '2026-03-08', 'America/Havana');
    expect(hours(r)).toBe(23);
    // The previous day still ends exactly where this one begins (no gap, no overlap).
    expect(zonedRange('2026-03-07', '2026-03-07', 'America/Havana').to).toBe(r.from);
  });

  it('zones without DST and with half-hour offsets', () => {
    expect(zonedRange('2026-03-29', '2026-03-29', 'Asia/Kolkata')).toEqual({ from: '2026-03-28T18:30:00.000Z', to: '2026-03-29T18:30:00.000Z' });
    expect(zonedRange('2026-03-29', '2026-03-29', 'UTC')).toEqual({ from: '2026-03-29T00:00:00.000Z', to: '2026-03-30T00:00:00.000Z' });
  });

  it('consecutive days tile the timeline without gaps or overlaps across a change', () => {
    let day = '2026-10-23';
    for (let i = 0; i < 4; i++) {
      const next = addDays(day, 1);
      expect(zonedRange(day, day, 'Europe/London').to).toBe(zonedRange(next, next, 'Europe/London').from);
      day = next;
    }
  });
});

describe('date helpers', () => {
  it('validates calendar dates', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });

  it('today in a zone follows the zone, not UTC', () => {
    const lateEvening = Date.parse('2026-10-24T23:30:00Z'); // 00:30 on the 25th in London (BST)
    expect(todayIn('Europe/London', lateEvening)).toBe('2026-10-25');
    expect(todayIn('America/New_York', lateEvening)).toBe('2026-10-24');
  });
});
