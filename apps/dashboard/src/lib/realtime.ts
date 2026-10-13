/**
 * Agent realtime client (ADR 0003, ch. 47). One Socket.IO connection per tab on the
 * `/agent` namespace at path `/realtime/v1`.
 *
 * - Authentication: a fresh single-use ticket is minted over REST (cookie + CSRF)
 *   for every (re)connect and sent in the CONNECT frame — never in the URL.
 * - Durable frames (`event`) are deduplicated by `event_id`; the newest cursor is
 *   kept and sent with `subscribe` after a reconnect so the server replays what was
 *   missed. An expired cursor yields `snapshot.required`, which listeners treat as
 *   "refetch over REST".
 * - Ephemeral frames (typing, presence, monitor deltas) are delivered as-is.
 * - Commands use acknowledgements with a timeout; failures surface as ApiError so
 *   callers handle REST and socket errors the same way.
 */
import { io, type Socket } from 'socket.io-client';
import { api, ApiError, ACCESS_REVOKED_EVENT } from './api';
import { uuid } from './ids';
import { fromWire, toWire } from './wire';
import { tStatic } from '@/i18n';

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';
export type ScopeKind = 'chat' | 'queue' | 'visitor' | 'config' | 'agent' | 'team';
export interface Scope {
  kind: ScopeKind;
  id: string;
}

export interface DurableEvent<P = Record<string, unknown>> {
  eventId: string;
  type: string;
  scope: Scope;
  cursor: string;
  occurredAt: string;
  aggregateVersion: number | null;
  causationId: string | null;
  payload: P;
}

export interface EphemeralEvent<P = Record<string, unknown>> {
  type: string;
  scope: Scope;
  payload: P;
  expiresAt: string | null;
}

type DurableHandler = (e: DurableEvent<any>) => void;
type EphemeralHandler = (e: EphemeralEvent<any>) => void;
type StateHandler = (s: ConnectionState) => void;
type ResyncHandler = (reason: 'snapshot_required' | 'reconnected') => void;

const COMMAND_TIMEOUT_MS = 10_000;
const SEEN_LIMIT = 4000;

function realtimeOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_REALTIME_ORIGIN;
  if (configured) return configured.replace(/\/$/, '');
  return typeof window === 'undefined' ? '' : window.location.origin;
}

const scopeKey = (s: Scope) => `${s.kind}:${s.id}`;

export class RealtimeClient {
  private socket: Socket | null = null;
  private state: ConnectionState = 'idle';
  private lastCursor: string | null = null;
  private readonly scopes = new Map<string, { scope: Scope; refs: number }>();
  private readonly seen = new Set<string>();
  private readonly durable = new Map<string, Set<DurableHandler>>();
  private readonly ephemeral = new Map<string, Set<EphemeralHandler>>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly resyncHandlers = new Set<ResyncHandler>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = 15_000;
  private hasConnectedOnce = false;
  private membershipId: string | null = null;

  get connectionState(): ConnectionState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === 'live';
  }

  /** Open the connection for the active tenant. Safe to call repeatedly. */
  start(): void {
    if (this.socket || typeof window === 'undefined') return;
    this.setState('connecting');
    const socket = io(`${realtimeOrigin()}/agent`, {
      path: '/realtime/v1',
      transports: ['websocket', 'polling'],
      withCredentials: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15_000,
      randomizationFactor: 0.5,
      // Fresh single-use ticket for every connection attempt.
      auth: (cb) => {
        api
          .post<{ ticket: string }>('/socket-ticket')
          .then((r) => cb({ ticket: r.ticket }))
          .catch(() => cb({ ticket: '' }));
      },
    });
    this.socket = socket;

    socket.on('auth.ok', (raw: unknown) => {
      const ok = fromWire<{ heartbeatIntervalMs?: number; membershipId?: string }>(raw);
      this.heartbeatMs = ok.heartbeatIntervalMs ?? 15_000;
      this.membershipId = ok.membershipId ?? null;
      this.startHeartbeat();
      void this.resubscribeAll();
    });
    socket.on('event', (raw: unknown) => this.handleDurable(raw));
    socket.on('ephemeral', (raw: unknown) => this.handleEphemeral(raw));
    socket.on('control', (raw: unknown) => {
      const c = fromWire<{ type: string; payload?: { reason?: string; reloginRequired?: boolean } }>(raw);
      if (c.type === 'access.revoked') {
        window.dispatchEvent(new CustomEvent(ACCESS_REVOKED_EVENT, { detail: c.payload ?? {} }));
        // Role or department change: the session is still valid, so reconnect with a fresh
        // ticket and let the server re-authorize every scope (cursor replay fills the gap).
        if (c.payload?.reloginRequired === false && c.payload.reason !== 'tenant_switch') this.rescopePending = true;
        else this.stop();
      }
    });
    socket.on('disconnect', (reason) => {
      this.stopHeartbeat();
      if (reason === 'io client disconnect') return;
      if (reason === 'io server disconnect' && this.rescopePending) {
        // Server-initiated disconnects are not retried by socket.io; reconnect once ourselves.
        this.rescopePending = false;
        this.setState('reconnecting');
        setTimeout(() => this.socket?.connect(), 300);
        return;
      }
      this.setState(navigator.onLine ? 'reconnecting' : 'offline');
    });
    socket.on('connect_error', () => {
      this.setState(navigator.onLine ? 'reconnecting' : 'offline');
    });
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  /** Close the connection and forget every subscription (logout / tenant switch). */
  stop(): void {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    this.stopHeartbeat();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.scopes.clear();
    this.seen.clear();
    this.lastCursor = null;
    this.hasConnectedOnce = false;
    this.membershipId = null;
    this.setState('idle');
  }

  /** Set by a re-scoping `access.revoked` frame; the following server disconnect reconnects. */
  private rescopePending = false;

  get currentMembershipId(): string | null {
    return this.membershipId;
  }

  // ───────── Subscriptions ─────────

  /** Reference-counted scope subscription; returns the release function. */
  subscribe(scopes: Scope[]): () => void {
    const added: Scope[] = [];
    for (const s of scopes) {
      const key = scopeKey(s);
      const hit = this.scopes.get(key);
      if (hit) hit.refs += 1;
      else {
        this.scopes.set(key, { scope: s, refs: 1 });
        added.push(s);
      }
    }
    if (added.length && this.socket?.connected) void this.sendSubscribe(added);
    return () => {
      const removed: Scope[] = [];
      for (const s of scopes) {
        const key = scopeKey(s);
        const hit = this.scopes.get(key);
        if (!hit) continue;
        hit.refs -= 1;
        if (hit.refs <= 0) {
          this.scopes.delete(key);
          removed.push(s);
        }
      }
      if (removed.length && this.socket?.connected) this.socket.emit('unsubscribe', toWire({ scopes: removed }));
    };
  }

  private async resubscribeAll(): Promise<void> {
    const all = [...this.scopes.values()].map((x) => x.scope);
    const reconnect = this.hasConnectedOnce;
    this.hasConnectedOnce = true;
    const result = all.length ? await this.sendSubscribe(all) : 'ok';
    this.setState('live');
    if (reconnect && result !== 'snapshot_required') this.resyncHandlers.forEach((h) => h('reconnected'));
  }

  private sendSubscribe(scopes: Scope[]): Promise<'ok' | 'snapshot_required' | 'error'> {
    const socket = this.socket;
    if (!socket) return Promise.resolve('error');
    return new Promise((resolve) => {
      socket.timeout(COMMAND_TIMEOUT_MS).emit('subscribe', toWire({ scopes, lastCursor: this.lastCursor }), (err: unknown, raw: unknown) => {
        if (err) return resolve('error');
        const ack = fromWire<{ type: string; snapshotCursor?: string | null }>(raw);
        if (ack.type === 'snapshot.required') {
          if (ack.snapshotCursor) this.lastCursor = ack.snapshotCursor;
          this.resyncHandlers.forEach((h) => h('snapshot_required'));
          return resolve('snapshot_required');
        }
        if (!this.lastCursor && ack.snapshotCursor) this.lastCursor = ack.snapshotCursor;
        resolve(ack.type === 'subscription.ok' ? 'ok' : 'error');
      });
    });
  }

  // ───────── Commands ─────────

  /** Send a command and await its acknowledgement (throws ApiError on failure). */
  command<T = unknown>(type: string, payload: Record<string, unknown>, opts: { scope?: Scope; expectedVersion?: number | null } = {}): Promise<T> {
    const socket = this.socket;
    if (!socket?.connected) return Promise.reject(new ApiError({ status: 0, code: 'SERVICE_UNAVAILABLE', message: tStatic('common.error.notConnected'), retryable: true }));
    const commandId = uuid();
    return new Promise<T>((resolve, reject) => {
      socket.timeout(COMMAND_TIMEOUT_MS).emit(
        'command',
        toWire({ v: 1, commandId, type, scope: opts.scope, expectedVersion: opts.expectedVersion ?? undefined, payload }),
        (err: unknown, raw: unknown) => {
          if (err) return reject(new ApiError({ status: 0, code: 'SERVICE_UNAVAILABLE', message: tStatic('common.error.noAck'), retryable: true }));
          const ack = fromWire<{ type: string; result?: T; code?: string; message?: string; retryable?: boolean }>(raw);
          if (ack.type === 'command.ack') return resolve(ack.result as T);
          reject(new ApiError({ status: 0, code: ack.code ?? 'UNKNOWN', message: ack.message ?? tStatic('common.error.commandFailed'), retryable: ack.retryable ?? false }));
        },
      );
    });
  }

  // ───────── Listeners ─────────

  on<P = Record<string, unknown>>(type: string, handler: (e: DurableEvent<P>) => void): () => void {
    const set = this.durable.get(type) ?? new Set();
    set.add(handler as DurableHandler);
    this.durable.set(type, set);
    return () => set.delete(handler as DurableHandler);
  }

  onEphemeral<P = Record<string, unknown>>(type: string, handler: (e: EphemeralEvent<P>) => void): () => void {
    const set = this.ephemeral.get(type) ?? new Set();
    set.add(handler as EphemeralHandler);
    this.ephemeral.set(type, set);
    return () => set.delete(handler as EphemeralHandler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  /** Called after a reconnect or an expired cursor: stores should refetch over REST. */
  onResync(handler: ResyncHandler): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  // ───────── Internals ─────────

  private handleDurable(raw: unknown): void {
    const frame = raw as { event_id?: string; type?: string; cursor?: string };
    if (!frame?.event_id || !frame.type) return;
    if (this.seen.has(frame.event_id)) return;
    this.seen.add(frame.event_id);
    if (this.seen.size > SEEN_LIMIT) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
    if (frame.cursor) this.lastCursor = frame.cursor;
    const e = fromWire<DurableEvent>(raw);
    this.durable.get(e.type)?.forEach((h) => safe(() => h(e)));
    this.durable.get('*')?.forEach((h) => safe(() => h(e)));
  }

  private handleEphemeral(raw: unknown): void {
    const e = fromWire<EphemeralEvent>(raw);
    if (!e?.type) return;
    if (e.expiresAt && Date.parse(e.expiresAt) < Date.now() - 1000) return;
    this.ephemeral.get(e.type)?.forEach((h) => safe(() => h(e)));
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateHandlers.forEach((h) => safe(() => h(s)));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.socket?.emit('heartbeat', {}), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private readonly onOnline = () => {
    if (this.socket && !this.socket.connected) {
      this.setState('reconnecting');
      this.socket.connect();
    }
  };

  private readonly onOffline = () => this.setState('offline');
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[realtime] listener failed', err);
  }
}

export const realtime = new RealtimeClient();
