'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { realtime, type ConnectionState, type DurableEvent, type EphemeralEvent, type Scope } from '@/lib/realtime';

/** Current transport state for banners and indicators. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (cb) => realtime.onState(() => cb()),
    () => realtime.connectionState,
    () => 'idle',
  );
}

/** Subscribe to scopes for the lifetime of the component (reference counted). */
export function useScopes(scopes: Scope[] | null): void {
  const key = scopes ? scopes.map((s) => `${s.kind}:${s.id}`).sort().join('|') : '';
  useEffect(() => {
    if (!scopes || !scopes.length) return;
    return realtime.subscribe(scopes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Durable event listener; the handler ref is kept fresh without resubscribing. */
export function useRealtimeEvent<P = Record<string, unknown>>(types: string | string[], handler: (e: DurableEvent<P>) => void): void {
  const [ref] = useState(() => ({ current: handler }));
  ref.current = handler;
  const key = Array.isArray(types) ? types.join('|') : types;
  useEffect(() => {
    const list = Array.isArray(types) ? types : [types];
    const offs = list.map((t) => realtime.on<P>(t, (e) => ref.current(e)));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useEphemeralEvent<P = Record<string, unknown>>(types: string | string[], handler: (e: EphemeralEvent<P>) => void): void {
  const [ref] = useState(() => ({ current: handler }));
  ref.current = handler;
  const key = Array.isArray(types) ? types.join('|') : types;
  useEffect(() => {
    const list = Array.isArray(types) ? types : [types];
    const offs = list.map((t) => realtime.onEphemeral<P>(t, (e) => ref.current(e)));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Refetch hook after reconnect or an expired replay cursor. */
export function useResync(handler: () => void): void {
  const [ref] = useState(() => ({ current: handler }));
  ref.current = handler;
  useEffect(() => realtime.onResync(() => ref.current()), [ref]);
}
