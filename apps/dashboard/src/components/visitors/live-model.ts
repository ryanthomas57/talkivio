/**
 * Pure live-list model: filters, the server's sort order, and coalesced delta
 * application. Kept free of React so the rules are easy to read and test.
 */
import { HIGH_LOAD_GROUPS, LIVE_GROUPS, type LiveGroup, type LiveVisitor, type VisitorSessionLeftFrame, type VisitorUpdatedFrame } from './types';

export type LiveSort = 'queue' | 'arrival';

export interface LiveFilters {
  siteId: string;
  departmentId: string;
  country: string;
  tag: string;
  q: string;
  status: LiveGroup[];
  highLoad: boolean;
  sort: LiveSort;
}

export interface LiveRow {
  v: LiveVisitor;
  /** Server `as_of` (ms since epoch) the projection was computed at — orders frames, never compared to the client clock. */
  asOf: number;
  /** Monotonic receipt time used to tick durations forward. */
  recv: number;
}

const RANK: Record<LiveGroup, number> = { incoming: 0, served: 1, browsing: 2, idle: 3 };

const ms = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Same key the API paginates by: group, then queue age (oldest request first) or newest arrival. */
export function serverKey(v: LiveVisitor): [number, number, string] {
  const rank = RANK[v.group];
  if ((v.group === 'incoming' || v.group === 'served') && v.chat) return [rank, ms(v.chat.requestedAt), v.visitorId];
  return [rank, -ms(v.arrivedAt), v.visitorId];
}

export function cmpKey(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** Display order: server order, or newest arrival first inside each group. */
export function displayCompare(sort: LiveSort) {
  if (sort === 'queue') return (a: LiveVisitor, b: LiveVisitor) => cmpKey(serverKey(a), serverKey(b));
  return (a: LiveVisitor, b: LiveVisitor) => {
    const g = RANK[a.group] - RANK[b.group];
    if (g) return g;
    const ta = ms(a.arrivedAt) || ms(a.chat?.requestedAt);
    const tb = ms(b.arrivedAt) || ms(b.chat?.requestedAt);
    return tb - ta || (a.visitorId < b.visitorId ? -1 : a.visitorId > b.visitorId ? 1 : 0);
  };
}

export function effectiveGroups(f: Pick<LiveFilters, 'status' | 'highLoad'>): LiveGroup[] {
  const base = f.highLoad ? HIGH_LOAD_GROUPS : LIVE_GROUPS;
  return f.status.length ? base.filter((g) => f.status.includes(g)) : base;
}

/**
 * Client-side mirror of the server filters, used for realtime patches. Free-text
 * search can only be checked against the visible name and label (the API also
 * matches an exact email through a lookup hash, which the client cannot see), so
 * visitors already in the list keep their place and new ones must match by name.
 */
export function matches(v: LiveVisitor, f: LiveFilters, known: boolean): boolean {
  if (!effectiveGroups(f).includes(v.group)) return false;
  if (f.siteId && v.siteId !== f.siteId) return false;
  if (f.departmentId && v.chat?.departmentId !== f.departmentId) return false;
  if (f.country && (v.country ?? '').toUpperCase() !== f.country.toUpperCase()) return false;
  if (f.tag && !v.tags.some((t) => t.id === f.tag || t.slug === f.tag.toLowerCase())) return false;
  if (f.q && !known) {
    const n = f.q.trim().toLowerCase();
    if (!v.displayName.toLowerCase().includes(n) && !v.anonymousLabel.toLowerCase().includes(n)) return false;
  }
  return true;
}

export type LiveFrame = { kind: 'updated'; frame: VisitorUpdatedFrame; recv: number } | { kind: 'left'; frame: VisitorSessionLeftFrame; recv: number };

export interface ApplyResult {
  rows: Map<string, LiveRow>;
  /** Listed visitors that appeared, left or changed group (count bookkeeping between count refreshes). */
  transitions: Array<{ visitorId: string; from: LiveGroup | null; to: LiveGroup | null }>;
  changed: boolean;
}

/**
 * Apply a batch of frames. Frames from one server flush share an `as_of`; the
 * same visitor can arrive on the unscoped room (patch null for department chats)
 * and on a department queue room (full patch), in either order — so within the
 * newest `as_of` a real patch always beats a null one.
 */
export function applyFrames(
  prev: Map<string, LiveRow>,
  frames: LiveFrame[],
  f: LiveFilters,
  opts: { lastLoadedKey: [number, number, string] | null; hasMore: boolean },
): ApplyResult {
  const latest = new Map<string, { asOf: number; patch: LiveVisitor | null; recv: number }>();
  const left: VisitorSessionLeftFrame[] = [];
  for (const fr of frames) {
    if (fr.kind === 'left') {
      left.push(fr.frame);
      continue;
    }
    const { visitorId, allowedPatch } = fr.frame;
    const asOf = ms(fr.frame.asOf);
    const cur = latest.get(visitorId);
    if (!cur || asOf > cur.asOf) latest.set(visitorId, { asOf, patch: allowedPatch, recv: fr.recv });
    else if (asOf === cur.asOf && allowedPatch) latest.set(visitorId, { asOf, patch: allowedPatch, recv: fr.recv });
  }

  let rows = prev;
  let changed = false;
  const mutable = () => {
    if (rows === prev) rows = new Map(prev);
    changed = true;
    return rows;
  };
  const transitions: ApplyResult['transitions'] = [];

  for (const s of left) {
    const row = rows.get(s.visitorId);
    if (!row || !row.v.sessions.some((x) => x.sessionId === s.sessionId)) continue;
    mutable().set(s.visitorId, { ...row, v: { ...row.v, sessions: row.v.sessions.filter((x) => x.sessionId !== s.sessionId) } });
  }

  for (const [visitorId, u] of latest) {
    const row = rows.get(visitorId);
    if (row && u.asOf < row.asOf) continue; // stale frame
    const before = row?.v.group ?? null;
    if (!u.patch || !matches(u.patch, f, !!row)) {
      if (row) {
        mutable().delete(visitorId);
        transitions.push({ visitorId, from: before, to: null });
      }
      continue;
    }
    if (!row && opts.hasMore && opts.lastLoadedKey && cmpKey(serverKey(u.patch), opts.lastLoadedKey) > 0) continue; // will arrive with a later page
    mutable().set(visitorId, { v: u.patch, asOf: u.asOf, recv: u.recv });
    if (before !== u.patch.group) transitions.push({ visitorId, from: before, to: u.patch.group });
  }
  return { rows, transitions, changed };
}
