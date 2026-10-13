import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { Emitter } from '@socket.io/redis-emitter';
import { RedisService } from '../common/redis.service';
import { toWire } from '../common/wire';

/** Revocation reasons after which the session is still valid (permissions or scopes changed). */
export const RESCOPE_REASONS = new Set(['tenant_switch', 'scope_changed', 'role_changed']);

export const AGENT_NS = '/agent';
export const VISITOR_NS = '/visitor';

/** Control rooms used for revocation (ch. 04: revoked access closes sockets within 60 s). */
export const controlRooms = {
  session: (sessionId: string) => `ctl:session:${sessionId}`,
  membership: (tenantId: string, membershipId: string) => `ctl:membership:${tenantId}:${membershipId}`,
  tenant: (tenantId: string) => `ctl:tenant:${tenantId}`,
  visitor: (tenantId: string, visitorId: string) => `ctl:visitor:${tenantId}:${visitorId}`,
  site: (tenantId: string, siteId: string) => `ctl:site:${tenantId}:${siteId}`,
};

export interface DurableFrame {
  v: 1;
  event_id: string;
  type: string;
  tenant_id: string;
  scope: { kind: string; id: string };
  cursor: string;
  occurred_at: string;
  aggregate_version: number;
  causation_id: string | null;
  payload: unknown;
}

/** Sockets whose outbound queue is backed up (gateway backpressure guard); ephemeral frames skip them. */
export const CONGESTED_ROOM = 'rt:congested';

interface RoomEmitter {
  emit(event: string, ...args: unknown[]): unknown;
  disconnectSockets?(close?: boolean): void;
  except?(room: string | string[]): RoomEmitter;
}

/**
 * Cross-process realtime emitter. Gateway processes attach their namespaces;
 * every other process (api, worker) publishes through the Redis emitter, which the
 * gateways' Redis adapter fans out to connected sockets.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  private namespaces = new Map<string, Namespace>();
  private emitter: Emitter | null = null;

  constructor(private readonly redis: RedisService) {}

  attach(ns: Namespace): void {
    this.namespaces.set(ns.name, ns);
  }

  private target(nsName: string, rooms: string[]): RoomEmitter | null {
    const ns = this.namespaces.get(nsName);
    if (ns) return ns.to(rooms) as unknown as RoomEmitter;
    if (!this.emitter) this.emitter = new Emitter(this.redis.create('emitter'));
    return this.emitter.of(nsName).to(rooms) as unknown as RoomEmitter;
  }

  /** Durable envelope frame (already in wire format). */
  durable(nsName: string, room: string, frame: DurableFrame): void {
    this.target(nsName, [room])?.emit('event', frame);
  }

  /** Ephemeral frame (typing, presence, monitoring deltas). Payload is converted to wire format. */
  ephemeral(
    nsName: string,
    rooms: string | string[],
    type: string,
    scope: { kind: string; id: string },
    payload: unknown,
    ttlMs = 6000,
  ): void {
    const list = Array.isArray(rooms) ? rooms : [rooms];
    if (!list.length) return;
    // Skipped for congested sockets (ephemeral goes first under backpressure, ch. 47); durable frames always flow
    // and are replayable by cursor. Not Socket.IO's `volatile`: it drops every frame of a burst after the first
    // whenever a write is still in flight, so most live visitor/typing updates would never arrive.
    const t = this.target(nsName, list);
    (t?.except?.(CONGESTED_ROOM) ?? t)?.emit('ephemeral', {
      v: 1,
      type,
      scope,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      payload: toWire(payload),
    });
  }

  /**
   * Control frame + forced disconnect. For re-scoping reasons the session stays valid:
   * clients reconnect with a fresh ticket (scopes are re-authorized) instead of signing out.
   */
  revoke(nsName: string, room: string, reason: string): void {
    const frame = {
      type: 'access.revoked',
      payload: { reason, relogin_required: !RESCOPE_REASONS.has(reason) },
    };
    const ns = this.namespaces.get(nsName);
    if (ns) {
      // Only the sockets in the room when the revocation happens: a client that reconnects inside the
      // grace window (fresh ticket, already re-scoped) must not be cut by this revocation. fetchSockets
      // spans every gateway node through the Redis adapter.
      void ns
        .in(room)
        .fetchSockets()
        .then((sockets) => {
          for (const s of sockets) s.emit('control', frame);
          setTimeout(() => {
            for (const s of sockets) s.disconnect(true);
          }, 50);
        })
        .catch((err) => this.logger.warn(`revoke ${room} failed: ${(err as Error).message}`));
      return;
    }
    // Processes without a gateway (worker) can only address the room through the Redis emitter.
    const t = this.target(nsName, [room]);
    t?.emit('control', frame);
    setTimeout(() => t?.disconnectSockets?.(true), 50);
  }

  revokeSession(sessionId: string): void {
    this.revoke(AGENT_NS, controlRooms.session(sessionId), 'session_revoked');
  }

  revokeMembership(tenantId: string, membershipId: string, reason = 'membership_changed'): void {
    this.revoke(AGENT_NS, controlRooms.membership(tenantId, membershipId), reason);
  }

  revokeVisitor(tenantId: string, visitorId: string, reason = 'visitor_reset'): void {
    this.revoke(VISITOR_NS, controlRooms.visitor(tenantId, visitorId), reason);
  }

  revokeTenant(tenantId: string): void {
    this.revoke(AGENT_NS, controlRooms.tenant(tenantId), 'tenant_unavailable');
    this.revoke(VISITOR_NS, controlRooms.tenant(tenantId), 'tenant_unavailable');
  }
}
