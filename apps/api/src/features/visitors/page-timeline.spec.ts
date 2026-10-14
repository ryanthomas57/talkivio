import { describe, expect, it } from 'vitest';
import {
  buildSessionTimeline,
  exclusiveVisibleMs,
  mergeIntervals,
  uncoveredLength,
  unionLength,
  type TimelineEvent,
} from './page-timeline';

const ev = (kind: TimelineEvent['kind'], at: number, url = 'https://a.test/x'): TimelineEvent => ({
  kind,
  at,
  url,
  title: null,
});

describe('buildSessionTimeline', () => {
  it('accrues dwell per page from server receipt times (SPA navigation)', () => {
    const t = buildSessionTimeline(
      [
        ev('entered', 0, 'https://a.test/a'),
        ev('entered', 10_000, 'https://a.test/b'),
        ev('left', 25_000, 'https://a.test/b'),
      ],
      30_000,
    );
    expect(t.pages.map((p) => [p.url, p.dwellMs])).toEqual([
      ['https://a.test/a', 10_000],
      ['https://a.test/b', 15_000],
    ]);
    expect(t.visibleMs).toBe(25_000);
  });

  it('pauses while hidden and resumes when visible', () => {
    const t = buildSessionTimeline(
      [ev('entered', 0), ev('hidden', 5_000), ev('visible', 20_000), ev('left', 30_000)],
      40_000,
    );
    expect(t.pages[0].dwellMs).toBe(15_000);
  });

  it('does not duplicate a visit when the same page is entered again (bfcache)', () => {
    const t = buildSessionTimeline(
      [ev('entered', 0), ev('hidden', 4_000), ev('entered', 10_000), ev('left', 12_000)],
      20_000,
    );
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].dwellMs).toBe(6_000);
  });

  it('clamps an open interval and closes at the session end', () => {
    const t = buildSessionTimeline([ev('entered', 0)], 3 * 3600_000, 30 * 60_000);
    expect(t.pages[0].dwellMs).toBe(30 * 60_000);
    const u = buildSessionTimeline([ev('entered', 0)], 7_000);
    expect(u.pages[0].dwellMs).toBe(7_000);
  });

  it('ignores events out of order by sorting on receipt time', () => {
    const t = buildSessionTimeline([ev('left', 9_000), ev('entered', 1_000)], 20_000);
    expect(t.pages[0].dwellMs).toBe(8_000);
  });
});

describe('interval math', () => {
  it('merges and measures unions', () => {
    expect(
      mergeIntervals([
        [5, 10],
        [0, 6],
        [20, 30],
      ]),
    ).toEqual([
      [0, 10],
      [20, 30],
    ]);
    expect(
      unionLength([
        [0, 10],
        [5, 15],
      ]),
    ).toBe(15);
  });

  it('measures uncovered length', () => {
    expect(
      uncoveredLength(
        [[0, 10]],
        [
          [2, 4],
          [6, 7],
        ],
      ),
    ).toBe(7);
    expect(uncoveredLength([[0, 10]], [])).toBe(10);
    expect(uncoveredLength([[0, 10]], [[-5, 20]])).toBe(0);
  });

  it('counts overlapping visible tabs once', () => {
    const tabA = buildSessionTimeline([ev('entered', 0), ev('left', 60_000)], 60_000);
    const tabB = buildSessionTimeline([ev('entered', 30_000), ev('left', 90_000)], 90_000);
    const ex = exclusiveVisibleMs([
      { id: 'b', startedAt: 30_000, intervals: tabB.intervals },
      { id: 'a', startedAt: 0, intervals: tabA.intervals },
    ]);
    expect(ex.get('a')).toBe(60_000);
    expect(ex.get('b')).toBe(30_000);
    expect((ex.get('a') ?? 0) + (ex.get('b') ?? 0)).toBe(unionLength([...tabA.intervals, ...tabB.intervals]));
  });
});
