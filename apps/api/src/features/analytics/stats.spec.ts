import { describe, expect, it } from 'vitest';
import { compare, distribution, percent, percentileNearestRank } from './stats';

describe('percentiles from ordered durations', () => {
  it('uses nearest rank on the sorted samples', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileNearestRank(xs, 0.5)).toBe(5);
    expect(percentileNearestRank(xs, 0.9)).toBe(9);
    expect(percentileNearestRank(xs, 0.95)).toBe(10);
    expect(percentileNearestRank([42], 0.95)).toBe(42);
  });

  it('returns null (not zero) when there are no samples (MET02)', () => {
    expect(percentileNearestRank([], 0.5)).toBeNull();
    expect(distribution([])).toEqual({ n: 0, median: null, p90: null, p95: null, min: null, max: null });
  });

  it('sorts input, ignores invalid values and exposes the sample size', () => {
    const d = distribution([30, 10, Number.NaN, 20, -1]);
    expect(d).toMatchObject({ n: 3, median: 20, p90: 30, p95: 30, min: 10, max: 30 });
  });

  it('never averages bucket medians: the merged median comes from all raw samples', () => {
    const a = [1, 1, 1];
    const b = [10, 100];
    const avgOfMedians = ((distribution(a).median ?? 0) + (distribution(b).median ?? 0)) / 2;
    expect(distribution([...a, ...b]).median).toBe(1);
    expect(avgOfMedians).not.toBe(1);
  });
});

describe('rates and comparison', () => {
  it('percent is null for an empty denominator', () => {
    expect(percent(1, 1)).toBe(100);
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(0, 0)).toBeNull();
  });

  it('shows percent change only for a non-zero previous base', () => {
    expect(compare(15, 10, 10, 15)).toEqual({ change: 5, changePct: 50, label: 'comparable' });
    expect(compare(3, 0, 0, 3)).toEqual({ change: 3, changePct: null, label: 'new' });
    expect(compare(0, 0, 0, 0)).toEqual({ change: 0, changePct: null, label: 'not_comparable' });
    // Rate with a previous denominator but a 0 % value: change in points only.
    expect(compare(50, 0, 4, 2)).toEqual({ change: 50, changePct: null, label: 'not_comparable' });
    expect(compare(null, null, 0, 0)).toEqual({ change: null, changePct: null, label: 'not_comparable' });
  });
});
