/**
 * Page timeline and dwell computation (ch. 11/26). Pure functions.
 *
 * Rules:
 *  - Server receipt time (`at`) governs every interval; client clocks are never trusted.
 *  - Dwell accrues only while the page is visible: `hidden` pauses, `visible` resumes.
 *  - A repeated `entered` for the page that is already open (bfcache pageshow, SPA
 *    re-render) continues the same visit instead of creating a duplicate.
 *  - Every open interval is clamped to `maxGapMs` (lost `hidden`/`left` events, crashed
 *    tabs) and closed at the session end (ended_at / last_seen_at / now).
 *  - Across concurrent tabs, overlapping visible time is counted once: the overlap is
 *    attributed to the session that started first (`exclusiveVisibleMs`).
 */

export type PageEventKind = 'entered' | 'left' | 'visible' | 'hidden';

export interface TimelineEvent {
  kind: PageEventKind;
  /** Server receipt time in ms. */
  at: number;
  url: string;
  title: string | null;
}

export interface PageVisit {
  url: string;
  title: string | null;
  enteredAt: number;
  leftAt: number | null;
  /** Visible dwell attributed to this visit (ms). */
  dwellMs: number;
}

export type Interval = [number, number];

export interface SessionTimeline {
  pages: PageVisit[];
  intervals: Interval[];
  visibleMs: number;
}

export const DEFAULT_MAX_GAP_MS = 30 * 60_000;

export function buildSessionTimeline(
  events: TimelineEvent[],
  endAt: number,
  maxGapMs = DEFAULT_MAX_GAP_MS,
): SessionTimeline {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const pages: PageVisit[] = [];
  const intervals: Interval[] = [];
  let current: PageVisit | null = null;
  let visible = true;
  let openAt: number | null = null;

  const close = (t: number) => {
    if (current && visible && openAt !== null) {
      const end = Math.max(openAt, Math.min(t, openAt + maxGapMs));
      if (end > openAt) {
        intervals.push([openAt, end]);
        current.dwellMs += end - openAt;
      }
    }
    openAt = null;
  };

  for (const e of sorted) {
    switch (e.kind) {
      case 'entered':
        if (current && current.leftAt === null && current.url === e.url) {
          // Same page again (bfcache restore / duplicate SPA signal): resume, never duplicate.
          if (!visible || openAt === null) {
            visible = true;
            openAt = e.at;
          }
          break;
        }
        close(e.at);
        if (current && current.leftAt === null) current.leftAt = e.at;
        current = { url: e.url, title: e.title, enteredAt: e.at, leftAt: null, dwellMs: 0 };
        pages.push(current);
        visible = true;
        openAt = e.at;
        break;
      case 'hidden':
        close(e.at);
        visible = false;
        break;
      case 'visible':
        if (current && current.leftAt === null && (!visible || openAt === null)) {
          visible = true;
          openAt = e.at;
        } else if (!current) {
          visible = true;
        }
        break;
      case 'left':
        close(e.at);
        if (current && current.leftAt === null) current.leftAt = e.at;
        current = null;
        break;
    }
  }
  const lastAt = sorted.length ? sorted[sorted.length - 1].at : endAt;
  close(Math.max(endAt, lastAt));
  return { pages, intervals, visibleMs: unionLength(intervals) };
}

/** Merge overlapping intervals (sorted, non-overlapping output). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function unionLength(list: Interval[]): number {
  return mergeIntervals(list).reduce((s, [a, b]) => s + (b - a), 0);
}

/** Length of `a` not covered by `covered` (both arbitrary interval lists). */
export function uncoveredLength(a: Interval[], covered: Interval[]): number {
  const A = mergeIntervals(a);
  const C = mergeIntervals(covered);
  let total = 0;
  let j = 0;
  for (const [s, e] of A) {
    let cursor = s;
    while (j < C.length && C[j][1] <= cursor) j++;
    let k = j;
    while (k < C.length && C[k][0] < e) {
      if (C[k][0] > cursor) total += C[k][0] - cursor;
      cursor = Math.max(cursor, C[k][1]);
      if (cursor >= e) break;
      k++;
    }
    if (cursor < e) total += e - cursor;
  }
  return total;
}

/**
 * Visible time per session with cross-tab overlap counted once: sessions are
 * processed by start time and each only keeps time not already covered by an
 * earlier session. The values therefore sum to the union across all tabs.
 */
export function exclusiveVisibleMs(
  sessions: Array<{ id: string; startedAt: number; intervals: Interval[] }>,
): Map<string, number> {
  const out = new Map<string, number>();
  let covered: Interval[] = [];
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))) {
    out.set(s.id, uncoveredLength(s.intervals, covered));
    covered = mergeIntervals([...covered, ...s.intervals]);
  }
  return out;
}
