'use client';
/**
 * Live monitor snapshot (ch. 49). GET /monitor returns the snapshot and registers
 * this member for `monitor.updated` pushes (to their own agent room) for 5
 * minutes, so the query re-runs every 4 minutes while mounted. A snapshot is
 * stale when the server says so or when nothing refreshed it for 15 s; a stale
 * view re-registers immediately (throttled).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useConnectionState, useEphemeralEvent, useResync } from '@/hooks/use-realtime';
import { useNow } from '@/hooks/use-media';
import { api } from '@/lib/api';
import type { MonitorSnapshot, WaitLevel } from './types';

export const REREGISTER_MS = 4 * 60_000;
const DEFAULT_STALE_MS = 15_000;

export const monitorKey = (departmentId: string | null) => ['monitor', departmentId ?? 'all'] as const;

export function useMonitor(departmentId: string | null, enabled = true) {
  const qc = useQueryClient();
  const key = monitorKey(departmentId);
  const conn = useConnectionState();
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<MonitorSnapshot>('/monitor', { departmentId }),
    enabled,
    refetchInterval: REREGISTER_MS,
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  });

  useEphemeralEvent<{ snapshot?: MonitorSnapshot; asOf?: string; stale?: boolean }>('monitor.updated', (e) => {
    const s = e.payload?.snapshot;
    if (!s || !enabled) return;
    // Pushes carry the filter of this member's latest registration; ignore other views.
    if ((s.scope.departmentId ?? null) !== (departmentId ?? null) || s.scope.siteId) return;
    const current = qc.getQueryData<MonitorSnapshot>(key);
    if (current && new Date(current.asOf).getTime() > new Date(s.asOf).getTime()) return;
    qc.setQueryData(key, { ...s, stale: !!e.payload.stale });
  });

  useResync(() => void q.refetch());

  const now = useNow(1000);
  const staleAfter = q.data?.thresholds.staleAfterMs ?? DEFAULT_STALE_MS;
  const ageMs = q.dataUpdatedAt ? Math.max(0, now - q.dataUpdatedAt) : 0;
  const silent = !!q.data && ageMs > staleAfter;
  const stale = !!q.data && (q.data.stale || silent);

  // Recover from missed pushes (watch expired, worker restart, another tab changed the filter).
  const lastRecover = useRef(0);
  useEffect(() => {
    if (!enabled || !silent || q.isFetching) return;
    if (Date.now() - lastRecover.current < staleAfter) return;
    lastRecover.current = Date.now();
    void q.refetch();
  }, [enabled, silent, q, staleAfter]);

  return { ...q, snapshot: q.data, stale, silent, ageMs, now, conn, receivedAt: q.dataUpdatedAt };
}

/** Seconds elapsed since the snapshot, added to a server-computed age (no client clock skew). */
export function tickingSeconds(base: number | null, receivedAt: number, now: number): number | null {
  if (base === null) return null;
  return base + Math.max(0, now - receivedAt) / 1000;
}

export function levelFor(seconds: number | null, warning = 60, critical = 180): WaitLevel {
  if (seconds === null) return 'none';
  if (seconds >= critical) return 'critical';
  if (seconds >= warning) return 'warning';
  return 'ok';
}
