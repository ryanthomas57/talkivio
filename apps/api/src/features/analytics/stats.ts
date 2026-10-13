/**
 * Distribution and comparison helpers (ch. 50/51). Percentiles always come from
 * the ordered raw durations of the population being reported (nearest-rank
 * method) — bucket medians are never averaged. No samples → null, never zero.
 */

export interface Distribution {
  n: number;
  median: number | null;
  p90: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export const PERCENTILE_METHOD = 'nearest_rank';

/** Nearest-rank percentile of an ascending array: value at rank ceil(p·n). */
export function percentileNearestRank(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  if (!(p > 0 && p <= 1)) throw new RangeError('percentile must be in (0, 1]');
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

/** Summarise raw durations (seconds). Values must be finite and ≥ 0; others are ignored. */
export function distribution(values: readonly number[]): Distribution {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: round3(percentileNearestRank(sorted, 0.5)),
    p90: round3(percentileNearestRank(sorted, 0.9)),
    p95: round3(percentileNearestRank(sorted, 0.95)),
    min: sorted.length ? round3(sorted[0]) : null,
    max: sorted.length ? round3(sorted[sorted.length - 1]) : null,
  };
}

/** Percentage with two decimals; null when the denominator is zero (unknown, not 0 %). */
export function percent(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export type ChangeLabel = 'comparable' | 'new' | 'not_comparable';

export interface Change {
  /** Absolute difference (percentage points for percent measures). */
  change: number | null;
  /** Relative change in percent; only when the previous base is non-zero. */
  changePct: number | null;
  label: ChangeLabel;
}

/**
 * Period-over-period change (ch. 51): percent change only when the previous
 * denominator (for counts: the previous count) is non-zero; otherwise the
 * period is labelled "new" (current has data) or "not_comparable".
 */
export function compare(current: number | null, previous: number | null, previousBase: number, currentBase: number): Change {
  const change = current !== null && previous !== null ? Math.round((current - previous) * 1000) / 1000 : null;
  if (previousBase > 0 && previous !== null && current !== null) {
    if (previous === 0) return { change, changePct: null, label: 'not_comparable' };
    return { change, changePct: Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100, label: 'comparable' };
  }
  return { change, changePct: null, label: currentBase > 0 ? 'new' : 'not_comparable' };
}
