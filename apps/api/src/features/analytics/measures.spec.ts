import { describe, expect, it } from 'vitest';
import type { FactView } from './facts';
import { aggregate, describe as describeMeasures, MEASURE_DEFINITIONS, MEASURE_KEYS } from './measures';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const s = (n: number) => T0 + n * 1000;

function fact(over: Partial<FactView>): FactView {
  return {
    chatId: Math.random().toString(36),
    siteId: 'site',
    departmentId: 'd',
    acquisitionDepartmentId: 'd',
    requestedAt: s(0),
    firstAssignedAt: null,
    firstResponseAt: null,
    closedAt: null,
    served: false,
    missed: false,
    abandoned: false,
    quickCancel: false,
    rating: null,
    ownerMembershipId: null,
    startedBy: 'visitor',
    agentIds: [],
    tagIds: [],
    invitationId: null,
    ...over,
  };
}

/** Fixture A (ch. 51): 3 requested, 2 assigned, 1 served, 1 good rating, 1 offline submission. */
const fixtureA = [
  fact({ firstAssignedAt: s(10), firstResponseAt: s(25), closedAt: s(300), served: true, rating: 'good', agentIds: ['a'] }),
  fact({ firstAssignedAt: s(40), closedAt: s(200), missed: true, agentIds: ['b'] }),
  fact({ closedAt: s(6), missed: true, abandoned: true, quickCancel: true }),
];

describe('aggregate (Fixture A)', () => {
  const m = aggregate(fixtureA, 1, 0, { excludeQuickCancellations: false });

  it('reports served 1, CSAT 100 % with n 1 and offline separately', () => {
    expect(m.requested.value).toBe(3);
    expect(m.assigned.value).toBe(2);
    expect(m.served.value).toBe(1);
    expect(m.csat).toMatchObject({ value: 100, numerator: 1, denominator: 1, n: 1 });
    expect(m.offline_submissions.value).toBe(1);
    expect(m.response_rate).toMatchObject({ value: 100, numerator: 1, denominator: 1 });
  });

  it('assigned-but-unreplied is not served; missed and abandoned overlap', () => {
    expect(m.missed.value).toBe(2);
    expect(m.abandoned.value).toBe(1);
    expect(m.quick_cancellations.value).toBe(1);
    expect(m.missed_rate).toMatchObject({ value: 66.67, numerator: 2, denominator: 3 });
  });

  it('durations use explicit sample sizes', () => {
    expect(m.wait_to_assignment).toMatchObject({ n: 2, median: 10, p90: 40, p95: 40 });
    expect(m.first_response_time).toMatchObject({ n: 1, median: 25 });
    expect(m.service_response_time).toMatchObject({ n: 1, median: 15 });
    expect(m.chat_duration).toMatchObject({ n: 3, median: 200 });
  });

  it('quick cancellations are excluded from missed only when configured', () => {
    expect(aggregate(fixtureA, 1, 0, { excludeQuickCancellations: true }).missed.value).toBe(1);
  });

  it('empty populations: zero counts, null rates and null percentiles', () => {
    const e = aggregate([], null, null, { excludeQuickCancellations: false });
    expect(e.requested.value).toBe(0);
    expect(e.csat.value).toBeNull();
    expect(e.wait_to_assignment).toMatchObject({ n: 0, median: null, p90: null, p95: null });
    expect(e.offline_submissions.value).toBeNull();
  });

  it('every measure is documented and compared against the previous period', () => {
    const d = describeMeasures(m, aggregate([], 0, 0, { excludeQuickCancellations: false }));
    for (const k of MEASURE_KEYS) {
      expect(MEASURE_DEFINITIONS[k].definition.length).toBeGreaterThan(10);
      expect(d[k].comparison).not.toBeNull();
    }
    expect(d.requested.comparison).toMatchObject({ value: 0, label: 'new', changePct: null });
    expect(d.csat.comparison).toMatchObject({ value: null, label: 'new' });
    expect(d.wait_to_assignment.percentileMethod).toBe('nearest_rank');
  });
});
