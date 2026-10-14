import { describe, expect, it } from 'vitest';
import { addPeriod, formatUsd, periodAmountCents, planFor, prorateCents, unitPriceCents } from './plans';

describe('plans', () => {
  it('prices a period per agent, with yearly as twelve discounted months', () => {
    expect(periodAmountCents(unitPriceCents('team', 'monthly'), 'monthly', 3)).toBe(8700);
    expect(periodAmountCents(unitPriceCents('team', 'yearly'), 'yearly', 3)).toBe(86400);
    expect(periodAmountCents(unitPriceCents('starter', 'monthly'), 'monthly', 1)).toBe(1500);
  });

  it('ends a period one calendar month or year later, clamped to the last day of a short month', () => {
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addPeriod(new Date('2026-03-15T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-04-15T00:00:00.000Z',
    );
    expect(addPeriod(new Date('2028-02-29T00:00:00Z'), 'yearly').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
    expect(addPeriod(new Date('2026-12-31T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2027-01-31T00:00:00.000Z',
    );
  });

  it('prorates the time left in the period, rounding up to the cent', () => {
    const start = new Date('2026-04-01T00:00:00Z');
    const end = new Date('2026-05-01T00:00:00Z');
    expect(prorateCents(3000, start, end, new Date('2026-04-16T00:00:00Z'))).toBe(1500);
    expect(prorateCents(2900, start, end, new Date('2026-04-21T00:00:00Z'))).toBe(967);
    expect(prorateCents(2900, start, end, end)).toBe(0);
    expect(prorateCents(2900, start, end, new Date('2026-03-01T00:00:00Z'))).toBe(2900);
  });

  it('names the lowest plan with a feature and formats dollars', () => {
    expect(planFor('triggers')).toBe('team');
    expect(planFor('integrations')).toBe('business');
    expect(formatUsd(2900)).toBe('$29');
    expect(formatUsd(123450)).toBe('$1,234.50');
  });
});
