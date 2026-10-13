'use client';
/**
 * Live visitor list (ch. 11/48): REST snapshot pages (cursor, 100 per page) plus
 * coalesced `visitor.updated` / `visitor.session.left` ephemeral frames from the
 * `visitor:all` scope (subscribed while the page is open) and the department
 * queue scopes the inbox already holds. Frames are buffered and applied in one
 * batch per tick; a resync or filter change refetches the snapshot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEphemeralEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { tStatic } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import {
  applyFrames,
  displayCompare,
  effectiveGroups,
  serverKey,
  type LiveFilters,
  type LiveFrame,
  type LiveRow,
} from './live-model';
import { mono } from './display';
import type {
  LiveGroup,
  LiveSnapshot,
  LiveVisitor,
  VisitorSessionLeftFrame,
  VisitorUpdatedFrame,
} from './types';

const PAGE = 100;
const FLUSH_MS = 250;
const COUNTS_REFRESH_MS = 20_000;
const RESYNC_MS = 60_000;

export interface LiveState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  rows: Map<string, LiveRow>;
  nextCursor: string | null;
  hasMore: boolean;
  lastKey: [number, number, string] | null;
  counts: Partial<Record<LiveGroup, number>>;
  omittedBrowsing: boolean;
  loadingMore: boolean;
  moreError: string | null;
  /** Bumped whenever rows change; the table uses it for scroll anchoring. */
  version: number;
}

const EMPTY: LiveState = {
  status: 'loading',
  error: null,
  rows: new Map(),
  nextCursor: null,
  hasMore: false,
  lastKey: null,
  counts: {},
  omittedBrowsing: false,
  loadingMore: false,
  moreError: null,
  version: 0,
};

function queryFor(f: LiveFilters, cursor?: string | null, limit = PAGE) {
  const groups = effectiveGroups(f);
  return {
    siteId: f.siteId || undefined,
    departmentId: f.departmentId || undefined,
    country: f.country || undefined,
    tag: f.tag || undefined,
    q: f.q.trim() ? f.q.trim().slice(0, 100) : undefined,
    status: f.status.length ? groups.join(',') : undefined,
    mode: f.highLoad ? 'high_load' : undefined,
    cursor: cursor ?? undefined,
    limit,
  };
}

function rowsFrom(
  items: LiveVisitor[],
  asOf: string,
  recv: number,
  into?: Map<string, LiveRow>,
): Map<string, LiveRow> {
  const out = new Map(into ?? []);
  const at = Date.parse(asOf);
  for (const v of items) {
    const cur = out.get(v.visitorId);
    if (!cur || cur.asOf <= at) out.set(v.visitorId, { v, asOf: at, recv });
  }
  return out;
}

export function useLiveVisitors(filters: LiveFilters, enabled = true) {
  const [state, setState] = useState<LiveState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const gen = useRef(0);
  const buffer = useRef<LiveFrame[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Everything except the client-side sort changes the server query.
  const key = JSON.stringify({ ...queryFor(filters), cursor: undefined, limit: undefined });

  /** `soft` keeps the current rows on screen while the fresh snapshot loads (resync). */
  const load = useCallback(async (soft = false) => {
    const my = ++gen.current;
    if (!soft) {
      buffer.current = [];
      setState((s) => ({ ...EMPTY, version: s.version + 1 }));
    }
    if (!effectiveGroups(filtersRef.current).length) {
      setState((s) => ({ ...s, status: 'ready', omittedBrowsing: filtersRef.current.highLoad }));
      return;
    }
    try {
      const snap = await api.get<LiveSnapshot>('/visitors/live', queryFor(filtersRef.current));
      if (my !== gen.current) return;
      const recv = mono();
      const last = snap.items[snap.items.length - 1];
      setState((s) => ({
        ...s,
        status: 'ready',
        error: null,
        rows: rowsFrom(snap.items, snap.asOf, recv),
        loadingMore: false,
        moreError: null,
        nextCursor: snap.nextCursor,
        hasMore: snap.hasMore,
        lastKey: last ? serverKey(last) : null,
        counts: snap.counts ?? {},
        omittedBrowsing: snap.omittedBrowsing,
        version: s.version + 1,
      }));
    } catch (e) {
      if (my !== gen.current) return;
      setState((s) =>
        soft && s.status === 'ready'
          ? s
          : { ...s, status: 'error', error: errorMessage(e, tStatic('visitors.live.loadError')) },
      );
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    if (!s.hasMore || !s.nextCursor || s.loadingMore || s.status !== 'ready') return;
    const my = gen.current;
    setState((x) => ({ ...x, loadingMore: true, moreError: null }));
    try {
      const snap = await api.get<LiveSnapshot>('/visitors/live', queryFor(filtersRef.current, s.nextCursor));
      if (my !== gen.current) return;
      const recv = mono();
      const last = snap.items[snap.items.length - 1];
      setState((x) => ({
        ...x,
        rows: rowsFrom(snap.items, snap.asOf, recv, x.rows),
        nextCursor: snap.nextCursor,
        hasMore: snap.hasMore,
        lastKey: last ? serverKey(last) : x.lastKey,
        counts: snap.counts ?? x.counts,
        loadingMore: false,
        version: x.version + 1,
      }));
    } catch (e) {
      if (my !== gen.current) return;
      // A stale cursor (the list changed under it) restarts from the first page.
      if ((e as { code?: string }).code === 'VALIDATION_FAILED') return void load(true);
      setState((x) => ({
        ...x,
        loadingMore: false,
        moreError: errorMessage(e, tStatic('visitors.live.loadMoreError')),
      }));
    }
  }, [load]);

  // ── Realtime ──
  useScopes(enabled ? [{ kind: 'visitor', id: 'all' }] : null);

  const flush = useCallback(() => {
    timer.current = null;
    const s = stateRef.current;
    if (s.status !== 'ready' || !buffer.current.length) return;
    const frames = buffer.current;
    buffer.current = [];
    const r = applyFrames(s.rows, frames, filtersRef.current, {
      lastLoadedKey: s.lastKey,
      hasMore: s.hasMore,
    });
    if (!r.changed) return;
    setState((x) => {
      const counts = { ...x.counts };
      for (const t of r.transitions) {
        if (t.from && counts[t.from] !== undefined) counts[t.from] = Math.max(0, (counts[t.from] ?? 0) - 1);
        if (t.to && (counts[t.to] !== undefined || !x.omittedBrowsing))
          counts[t.to] = (counts[t.to] ?? 0) + 1;
      }
      return { ...x, rows: r.rows, counts, version: x.version + 1 };
    });
  }, []);

  const push = useCallback(
    (f: LiveFrame) => {
      buffer.current.push(f);
      if (buffer.current.length > 20_000) buffer.current.splice(0, buffer.current.length - 20_000);
      if (!timer.current) timer.current = setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  useEphemeralEvent<VisitorUpdatedFrame>('visitor.updated', (e) => {
    if (!enabled || !e.payload?.visitorId) return;
    push({ kind: 'updated', frame: e.payload, recv: mono() });
  });
  useEphemeralEvent<VisitorSessionLeftFrame>('visitor.session.left', (e) => {
    if (!enabled || !e.payload?.visitorId) return;
    push({ kind: 'left', frame: e.payload, recv: mono() });
  });

  // Snapshot replaced after a reconnect / expired replay window.
  useResync(() => {
    if (enabled) void load(true);
  });

  // Buffered frames received while the first page loads are applied once it lands.
  useEffect(() => {
    if (state.status === 'ready' && buffer.current.length && !timer.current)
      timer.current = setTimeout(flush, FLUSH_MS);
  }, [state.status, flush]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Visitor deltas are ephemeral: a socket that was congested skips them. A periodic soft snapshot (and one when
  // the tab comes back) keeps a skipped update from leaving a stale row — only while the whole list fits one page,
  // so rows loaded with "Show more" are never thrown away.
  useEffect(() => {
    if (!enabled) return;
    let hiddenAt = 0;
    const resync = () => {
      const s = stateRef.current;
      if (s.status === 'ready' && !s.hasMore && !s.loadingMore) void load(true);
    };
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') resync();
    }, RESYNC_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 15_000) resync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, key, load]);

  // Group totals drift for visitors outside the loaded rows; refresh them cheaply.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      const s = stateRef.current;
      if (
        s.status !== 'ready' ||
        document.visibilityState === 'hidden' ||
        !effectiveGroups(filtersRef.current).length
      )
        return;
      const my = gen.current;
      api
        .get<LiveSnapshot>('/visitors/live', queryFor(filtersRef.current, null, 1))
        .then((snap) => {
          if (my === gen.current) setState((x) => ({ ...x, counts: snap.counts ?? x.counts }));
        })
        .catch(() => undefined);
    }, COUNTS_REFRESH_MS);
    return () => clearInterval(t);
  }, [enabled, key]);

  const sorted = useMemo(() => {
    const list = [...state.rows.values()];
    const cmp = displayCompare(filters.sort);
    list.sort((a, b) => cmp(a.v, b.v));
    return list;
  }, [state.rows, filters.sort]);

  return { state, sorted, reload: () => load(false), loadMore };
}
