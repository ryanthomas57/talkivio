import { MetricsService } from '../core/metrics.service';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { TenantDb } from '../db/tenant-db';
import { containsNul, errorBody, type AuthContext, type VisitorContext } from '../common/http';
import { hashIp } from '../common/crypto';
import { visitorIpHash } from '../features/widget/capability';
import { socketClientIp } from '../common/client-ip';
import { fromWire, toWire } from '../common/wire';
import { permissionsForRole, TENANT_WIDE_ROLES } from '../common/permissions';
import { env, isProd } from '../config/env';
import { AuthGuard } from '../auth/auth.guard';
import { PresenceService } from '../core/presence.service';
import { RateLimitService } from '../core/rate-limit.service';
import { decodeEventCursor, encodeEventCursor, roomFor, type Audience, type ScopeKind } from '../outbox/outbox.service';
import { CommandRegistry, type SocketCommand } from './command-registry';
import { AGENT_NS, controlRooms, RealtimeService, VISITOR_NS, type DurableFrame } from './realtime.service';
import { ScopeAuthorizer } from './scope-authorizer';
import { TicketsService, type AgentTicketClaims, type VisitorTicketClaims } from './tickets.service';
import { isDraining } from '../common/graceful-shutdown';

export const REALTIME_PATH = '/realtime/v1';
export const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 1000;
/** Outbound buffer limits per socket (ch. 47): 1000 events or 1 MiB. */
export const OUTBOUND_MAX_PACKETS = 1000;
export const OUTBOUND_MAX_BYTES = 1024 * 1024;
/** Durable replay window (ch. 47): older cursors get snapshot.required. */
export const REPLAY_WINDOW_MS = 24 * 3600 * 1000;

interface EngineConn {
  writeBuffer?: unknown[];
  transport?: { socket?: { bufferedAmount?: number } };
}

/** True when a connection's pending outbound data exceeds the per-socket budget. */
export function isOverloaded(conn: EngineConn): boolean {
  const packets = conn.writeBuffer?.length ?? 0;
  const bytes = conn.transport?.socket?.bufferedAmount ?? 0;
  return packets > OUTBOUND_MAX_PACKETS || bytes > OUTBOUND_MAX_BYTES;
}

interface AgentData extends AgentTicketClaims {
  connectionId: string;
  subscriptions: Set<string>;
  /** Dashboard session expiry (ISO); the socket is revoked with the session. */
  capabilityExpiry: string;
}
interface VisitorData extends VisitorTicketClaims {
  connectionId: string;
  subscriptions: Set<string>;
}

function originOf(socket: Socket): string | null {
  const o = socket.handshake.headers.origin;
  return typeof o === 'string' ? o : null;
}

function dashboardOrigins(): string[] {
  const e = env();
  return [...new Set([...e.CORS_ORIGINS.split(','), e.APP_URL].map((o) => o.trim().replace(/\/$/, '')).filter(Boolean))];
}

function widgetOrigins(): string[] {
  const e = env();
  return [...new Set([new URL(e.API_URL).origin, ...(e.WIDGET_CDN_URL ? [new URL(e.WIDGET_CDN_URL).origin] : [])])];
}

/** Shared replay logic for both namespaces. */
abstract class BaseGateway {
  protected abstract readonly ns: string;
  protected abstract readonly audience: Audience;

  constructor(
    protected readonly db: TenantDb,
    protected readonly rateLimit: RateLimitService,
    protected readonly metrics: MetricsService,
  ) {}

  protected socketOpened(): void {
    const ns = this.ns.replace('/', '');
    this.metrics.socketsConnected.inc(this.metrics.labels({ namespace: ns }));
    this.metrics.socketReconnects.inc(this.metrics.labels({ namespace: ns }));
  }

  /**
   * Slow-consumer guard (ch. 47): a socket whose outbound queue exceeds 1000 packets or 1 MiB is closed at
   * the transport level. Ephemeral frames are already volatile; the client sees a transport close,
   * reconnects with a fresh ticket and replays durable events from its cursor (resumable, nothing lost).
   * The queue is discarded: a plain engine.io close() waits for it to drain first, which a stalled reader never
   * does, so the connection (and its growing queue) would stay open forever.
   */
  protected startBackpressureGuard(ns: Namespace): NodeJS.Timeout {
    const labels = this.metrics.labels({ namespace: this.ns.replace('/', '') });
    const t = setInterval(() => {
      let packets = 0;
      let bytes = 0;
      for (const s of ns.sockets.values()) {
        const conn = s.conn as unknown as EngineConn & { close(discard?: boolean): void; readyState?: string };
        if (conn.readyState === 'closing' || conn.readyState === 'closed') continue;
        if (!isOverloaded(conn)) {
          packets += conn.writeBuffer?.length ?? 0;
          bytes += conn.transport?.socket?.bufferedAmount ?? 0;
          continue;
        }
        this.metrics.socketOverloads.inc(labels);
        conn.close(true);
      }
      // Pending outbound data of the connections that stay open: it returns to ~0 once a slow consumer is cut off.
      this.metrics.socketOutboundPackets.set(labels, packets);
      this.metrics.socketOutboundBytes.set(labels, bytes);
    }, 1000);
    t.unref();
    return t;
  }

  protected socketClosed(): void {
    this.metrics.socketsConnected.inc(this.metrics.labels({ namespace: this.ns.replace('/', '') }), -1);
  }

  protected async replay(socket: Socket, tenantId: string, scopes: Array<{ kind: ScopeKind; id: string }>, cursor: string | null): Promise<{ snapshotCursor: string; snapshotRequired: boolean }> {
    return this.db.read(tenantId, async (tx) => {
      const maxRow = await tx.outboxEvent.findFirst({ where: { tenantId }, orderBy: { seq: 'desc' }, select: { seq: true } });
      const snapshotCursor = encodeEventCursor(maxRow?.seq ?? 0n);
      const since = decodeEventCursor(cursor);
      if (since === null) return { snapshotCursor, snapshotRequired: false };
      const minRow = await tx.outboxEvent.findFirst({ where: { tenantId }, orderBy: { seq: 'asc' }, select: { seq: true } });
      if (minRow && since < minRow.seq - 1n) return { snapshotCursor, snapshotRequired: true };
      const relevant = { tenantId, audience: this.audience, seq: { gt: since }, OR: scopes.map((s) => ({ scopeKind: s.kind, scopeId: s.id })) };
      // Replay covers 24 h; a cursor behind that with relevant events in the gap must resnapshot, never skip them.
      const windowStart = new Date(Date.now() - REPLAY_WINDOW_MS);
      const beyondWindow = await tx.outboxEvent.findFirst({ where: { ...relevant, occurredAt: { lte: windowStart } }, select: { seq: true } });
      if (beyondWindow) return { snapshotCursor, snapshotRequired: true };
      const rows = await tx.outboxEvent.findMany({
        where: { ...relevant, occurredAt: { gt: windowStart } },
        orderBy: { seq: 'asc' },
        take: REPLAY_LIMIT + 1,
      });
      if (rows.length > REPLAY_LIMIT) return { snapshotCursor, snapshotRequired: true };
      for (const r of rows) {
        const frame: DurableFrame = {
          v: 1,
          event_id: r.eventId,
          type: r.eventType,
          tenant_id: r.tenantId,
          scope: { kind: r.scopeKind, id: r.scopeId },
          cursor: encodeEventCursor(r.seq),
          occurred_at: r.occurredAt.toISOString(),
          aggregate_version: r.aggregateVersion,
          causation_id: r.causationId,
          payload: r.payload,
        };
        socket.emit('event', frame);
      }
      return { snapshotCursor, snapshotRequired: false };
    });
  }

  /**
   * command.ack result (ch. 47): {resource_id, seq?, version?}. The full resource stays alongside
   * so clients can reconcile without a refetch.
   */
  protected ackResult(result: unknown): Record<string, unknown> {
    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const resourceId = typeof r.id === 'string' ? r.id : typeof r.chatId === 'string' ? r.chatId : null;
    return toWire({
      ...r,
      resourceId,
      ...(typeof r.seq === 'number' ? { seq: r.seq } : {}),
      ...(typeof r.version === 'number' ? { version: r.version } : {}),
    }) as Record<string, unknown>;
  }

  /** `unsubscribe {scope_ids: ['kind:id']}` (ch. 77) or `{scopes: [{kind, id}]}`. */
  protected scopesToLeave(body: { scopeIds?: unknown; scopes?: Array<{ kind: ScopeKind; id: string }> } | undefined): Array<{ kind: ScopeKind; id: string }> {
    const out = Array.isArray(body?.scopes) ? body.scopes.filter((s) => typeof s?.kind === 'string' && typeof s?.id === 'string') : [];
    if (Array.isArray(body?.scopeIds)) {
      for (const v of body.scopeIds.slice(0, 200)) {
        if (typeof v !== 'string') continue;
        const i = v.indexOf(':');
        if (i > 0) out.push({ kind: v.slice(0, i) as ScopeKind, id: v.slice(i + 1) });
      }
    }
    return out;
  }

  protected parseCommand(raw: unknown): SocketCommand | null {
    // NUL cannot be stored in PostgreSQL text; treat it as a malformed command (VALIDATION_FAILED).
    if (containsNul(raw)) return null;
    const c = fromWire(raw) as Partial<SocketCommand> & { v?: number };
    if (!c || typeof c !== 'object' || typeof c.type !== 'string' || typeof c.commandId !== 'string' || c.commandId.length > 64) return null;
    return { commandId: c.commandId, type: c.type, scope: c.scope, expectedVersion: c.expectedVersion, payload: (c.payload as Record<string, unknown>) ?? {} };
  }

  protected ackError(commandId: string, err: unknown, commandType?: string) {
    const { status, body } = errorBody(err);
    const e = body.error as { code: string; message: string; retryable: boolean };
    if (commandType) this.metrics.command(commandType, this.metrics.outcomeFor(status, e.code));
    return { type: 'command.error', command_id: commandId, code: e.code, message: e.message, retryable: e.retryable };
  }
}

@WebSocketGateway({
  namespace: AGENT_NS,
  path: REALTIME_PATH,
  cors: { origin: (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => cb(null, !o || dashboardOrigins().includes(o)), credentials: true },
  pingInterval: HEARTBEAT_MS,
  pingTimeout: 30_000,
  maxHttpBufferSize: 64 * 1024,
})
export class AgentGateway extends BaseGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger('AgentGateway');
  protected readonly ns = AGENT_NS;
  protected readonly audience: Audience = 'staff';
  private namespace!: Namespace;
  private timer: NodeJS.Timeout | null = null;
  private overloadGuard: NodeJS.Timeout | null = null;

  constructor(
    db: TenantDb,
    rateLimit: RateLimitService,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly guard: AuthGuard,
    private readonly scopes: ScopeAuthorizer,
    private readonly commands: CommandRegistry,
    metrics: MetricsService,
  ) {
    super(db, rateLimit, metrics);
  }

  afterInit(ns: Namespace): void {
    this.namespace = ns;
    this.realtime.attach(ns);
    ns.use(async (socket, next) => {
      try {
        const origin = originOf(socket);
        if (origin && !dashboardOrigins().includes(origin)) return next(new Error('ORIGIN_NOT_ALLOWED'));
        if (!(await this.rateLimit.hit(`ws-agent-connect:${socketClientIp(socket.handshake)}`, 60, 60))) return next(new Error('RATE_LIMITED'));
        const claims = await this.tickets.consume((socket.handshake.auth as { ticket?: string })?.ticket);
        if (!claims || claims.kind !== 'agent') return next(new Error('AUTH_REQUIRED'));
        const session = await this.db.root.authSession.findUnique({ where: { id: claims.sessionId } });
        if (!session || session.revokedAt || session.expiresAt < new Date()) return next(new Error('AUTH_REQUIRED'));
        const m = await this.guard.membership(claims.tenantId, claims.userId);
        if (!m || !m.enabled || m.membershipId !== claims.membershipId) return next(new Error('PERMISSION_DENIED'));
        socket.data = { ...claims, connectionId: randomUUID(), subscriptions: new Set<string>(), capabilityExpiry: session.expiresAt.toISOString() } satisfies AgentData;
        next();
      } catch (err) {
        this.logger.error(`Agent socket auth failed: ${(err as Error).message}`);
        next(new Error('SERVICE_UNAVAILABLE'));
      }
    });
    this.timer = setInterval(() => {
      for (const s of this.namespace.sockets.values()) {
        const d = s.data as AgentData;
        if (d?.membershipId) void this.presence.agentHeartbeat(d.tenantId, d.membershipId, d.connectionId).catch(() => undefined);
      }
    }, HEARTBEAT_MS);
    this.overloadGuard = this.startBackpressureGuard(ns);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.overloadGuard) clearInterval(this.overloadGuard);
  }

  async authContext(d: AgentData): Promise<AuthContext> {
    const m = await this.guard.membership(d.tenantId, d.userId);
    if (!m || !m.enabled) throw Object.assign(new Error('Access revoked'), { code: 'PERMISSION_DENIED' });
    return {
      tenantId: d.tenantId,
      userId: d.userId,
      membershipId: m.membershipId,
      role: m.role,
      permissions: permissionsForRole(m.role),
      departmentScope: TENANT_WIDE_ROLES.has(m.role) ? 'all' : [...new Set([...m.servedDepartmentIds, ...m.monitoredDepartmentIds])],
      servedDepartmentIds: m.servedDepartmentIds,
      sessionId: d.sessionId,
      tokenId: null,
      actorName: m.displayName,
      requestId: `ws-${d.connectionId.slice(0, 8)}`,
      ipHash: null,
      userAgent: null,
    };
  }

  async handleConnection(socket: Socket): Promise<void> {
    const d = socket.data as AgentData;
    if (!d?.membershipId) return;
    this.socketOpened();
    await socket.join([controlRooms.session(d.sessionId), controlRooms.membership(d.tenantId, d.membershipId), controlRooms.tenant(d.tenantId)]);
    await socket.join(roomFor(d.tenantId, 'agent', d.membershipId, 'staff'));
    d.subscriptions.add(`agent:${d.membershipId}`);
    const first = await this.presence.agentConnected(d.tenantId, d.membershipId, d.connectionId);
    socket.emit('auth.ok', {
      connection_id: d.connectionId,
      heartbeat_interval_ms: HEARTBEAT_MS,
      capability_expiry: d.capabilityExpiry,
      resumable_scopes: ['chat', 'queue', 'agent', 'team', 'visitor', 'config'],
      membership_id: d.membershipId,
      server_time: new Date().toISOString(),
    });
    if (first) await this.presence.notifyAgentConnection(d.tenantId, d.membershipId, true);
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const d = socket.data as AgentData;
    if (!d?.membershipId) return;
    this.socketClosed();
    // Shutdown drain: the client reconnects to another replica; if it doesn't, the stale
    // connection entry ages out through the heartbeat sweeper (no offline/online churn).
    if (isDraining()) return;
    const last = await this.presence.agentDisconnected(d.tenantId, d.membershipId, d.connectionId);
    if (last) await this.presence.notifyAgentConnection(d.tenantId, d.membershipId, false);
  }

  @SubscribeMessage('heartbeat')
  async heartbeat(@ConnectedSocket() socket: Socket) {
    const d = socket.data as AgentData;
    await this.presence.agentHeartbeat(d.tenantId, d.membershipId, d.connectionId);
    await this.presence.recordAgentActivity(d.tenantId, d.membershipId);
    return { ok: true, server_time: new Date().toISOString() };
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as AgentData;
    const body = fromWire(raw) as { scopes?: Array<{ kind: ScopeKind; id: string }>; lastCursor?: string | null };
    const scopes = Array.isArray(body?.scopes) ? body.scopes.slice(0, 200) : [];
    try {
      const auth = await this.authContext(d);
      const denied: Array<{ kind: string; id: string }> = [];
      const granted: Array<{ kind: ScopeKind; id: string }> = [];
      for (const s of scopes) {
        if (await this.scopes.canAgentSubscribe(auth, s.kind, s.id)) granted.push(s);
        else denied.push(s);
      }
      await socket.join(granted.map((s) => roomFor(d.tenantId, s.kind, s.id, 'staff')));
      for (const s of granted) d.subscriptions.add(`${s.kind}:${s.id}`);
      const r = await this.replay(socket, d.tenantId, granted, body.lastCursor ?? null);
      if (r.snapshotRequired) return { type: 'snapshot.required', snapshot_cursor: r.snapshotCursor, denied };
      return { type: 'subscription.ok', snapshot_cursor: r.snapshotCursor, granted: granted.length, denied };
    } catch (err) {
      return this.ackError('subscribe', err);
    }
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as AgentData;
    const leave = this.scopesToLeave(fromWire(raw) as { scopeIds?: unknown; scopes?: Array<{ kind: ScopeKind; id: string }> });
    for (const s of leave) {
      // The agent's own offer stream is part of the connection, not a subscription.
      if (s.kind === 'agent' && s.id === d.membershipId) continue;
      await socket.leave(roomFor(d.tenantId, s.kind, s.id, 'staff'));
      d.subscriptions.delete(`${s.kind}:${s.id}`);
    }
    return { type: 'unsubscribe.ok', ok: true, scope_ids: leave.map((s) => `${s.kind}:${s.id}`) };
  }

  @SubscribeMessage('command')
  async command(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as AgentData;
    const cmd = this.parseCommand(raw);
    if (!cmd) return { type: 'command.error', command_id: null, code: 'VALIDATION_FAILED', message: 'Malformed command', retryable: false };
    const burst = await this.rateLimit.hit(`ws-cmd:${d.connectionId}:burst`, 20, 1);
    const sustained = await this.rateLimit.hit(`ws-cmd:${d.connectionId}`, 600, 60);
    if (!burst || !sustained) return { type: 'command.error', command_id: cmd.commandId, code: 'RATE_LIMITED', message: 'Slow down', retryable: true };
    const handler = this.commands.agentHandler(cmd.type);
    if (!handler) return { type: 'command.error', command_id: cmd.commandId, code: 'VALIDATION_FAILED', message: `Unknown command ${cmd.type}`, retryable: false };
    try {
      const auth = await this.authContext(d);
      const result = await handler({ auth, connectionId: d.connectionId }, cmd);
      this.metrics.command(cmd.type, 'ok');
      return { type: 'command.ack', command_id: cmd.commandId, result: this.ackResult(result), committed_at: new Date().toISOString() };
    } catch (err) {
      return this.ackError(cmd.commandId, err, cmd.type);
    }
  }
}

@WebSocketGateway({
  namespace: VISITOR_NS,
  path: REALTIME_PATH,
  cors: { origin: true, credentials: false },
  pingInterval: HEARTBEAT_MS,
  pingTimeout: 30_000,
  maxHttpBufferSize: 64 * 1024,
})
export class VisitorGateway extends BaseGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger('VisitorGateway');
  protected readonly ns = VISITOR_NS;
  protected readonly audience: Audience = 'public';
  private namespace!: Namespace;
  private timer: NodeJS.Timeout | null = null;
  private overloadGuard: NodeJS.Timeout | null = null;

  constructor(
    db: TenantDb,
    rateLimit: RateLimitService,
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly scopes: ScopeAuthorizer,
    private readonly commands: CommandRegistry,
    metrics: MetricsService,
  ) {
    super(db, rateLimit, metrics);
  }

  afterInit(ns: Namespace): void {
    this.namespace = ns;
    this.realtime.attach(ns);
    ns.use(async (socket, next) => {
      try {
        const origin = originOf(socket);
        // Visitor sockets come from the widget frame origin; the host page origin
        // was validated when the capability was issued (and enforced by frame-ancestors).
        if (origin && !widgetOrigins().includes(origin) && isProd()) return next(new Error('ORIGIN_NOT_ALLOWED'));
        if (!(await this.rateLimit.hit(`ws-visitor-connect:${socketClientIp(socket.handshake)}`, 120, 60))) return next(new Error('RATE_LIMITED'));
        const claims = await this.tickets.consume((socket.handshake.auth as { ticket?: string })?.ticket);
        if (!claims || claims.kind !== 'visitor') return next(new Error('AUTH_REQUIRED'));
        socket.data = { ...claims, connectionId: randomUUID(), subscriptions: new Set<string>() } satisfies VisitorData;
        next();
      } catch (err) {
        this.logger.error(`Visitor socket auth failed: ${(err as Error).message}`);
        next(new Error('SERVICE_UNAVAILABLE'));
      }
    });
    this.timer = setInterval(() => {
      for (const s of this.namespace.sockets.values()) {
        const d = s.data as VisitorData;
        if (d?.visitorId) void this.presence.visitorHeartbeat(d.tenantId, d.visitorId, d.sessionId, d.connectionId, false, d.siteId).catch(() => undefined);
      }
    }, HEARTBEAT_MS);
    this.overloadGuard = this.startBackpressureGuard(ns);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.overloadGuard) clearInterval(this.overloadGuard);
  }

  visitorContext(d: VisitorData, socket: Socket): VisitorContext {
    return {
      tenantId: d.tenantId,
      siteId: d.siteId,
      visitorId: d.visitorId,
      sessionId: d.sessionId,
      requestId: `ws-${d.connectionId.slice(0, 8)}`,
      ipHash: visitorIpHash(socketClientIp(socket.handshake)),
      origin: d.origin,
    };
  }

  async handleConnection(socket: Socket): Promise<void> {
    const d = socket.data as VisitorData;
    if (!d?.visitorId) return;
    this.socketOpened();
    await socket.join([
      controlRooms.visitor(d.tenantId, d.visitorId),
      controlRooms.site(d.tenantId, d.siteId),
      controlRooms.tenant(d.tenantId),
      roomFor(d.tenantId, 'visitor', d.sessionId, 'public'),
      roomFor(d.tenantId, 'config', d.siteId, 'public'),
    ]);
    d.subscriptions.add(`visitor:${d.sessionId}`);
    await this.presence.visitorConnected(d.tenantId, d.visitorId, d.sessionId, d.connectionId, d.siteId);
    socket.emit('auth.ok', {
      connection_id: d.connectionId,
      heartbeat_interval_ms: HEARTBEAT_MS,
      capability_expiry: d.capabilityExpiry ?? null,
      resumable_scopes: ['chat', 'visitor', 'config'],
      server_time: new Date().toISOString(),
    });
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const d = socket.data as VisitorData;
    if (!d?.visitorId) return;
    this.socketClosed();
    if (isDraining()) return; // see the agent gateway: reconnect elsewhere or age out via the sweeper
    await this.presence.visitorDisconnected(d.tenantId, d.visitorId, d.sessionId, d.connectionId).catch((err) => this.logger.warn(`visitor disconnect: ${(err as Error).message}`));
  }

  @SubscribeMessage('heartbeat')
  async heartbeat(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as VisitorData;
    const body = fromWire(raw) as { visible?: boolean; focused?: boolean } | undefined;
    await this.presence.visitorHeartbeat(d.tenantId, d.visitorId, d.sessionId, d.connectionId, body?.visible !== false && body?.focused !== false, d.siteId);
    return { ok: true, server_time: new Date().toISOString() };
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as VisitorData;
    const body = fromWire(raw) as { scopes?: Array<{ kind: ScopeKind; id: string }>; lastCursor?: string | null };
    const scopes = Array.isArray(body?.scopes) ? body.scopes.slice(0, 20) : [];
    try {
      const granted: Array<{ kind: ScopeKind; id: string }> = [];
      const denied: Array<{ kind: string; id: string }> = [];
      for (const s of scopes) {
        if (await this.scopes.canVisitorSubscribe(this.visitorContext(d, socket), s.kind, s.id)) granted.push(s);
        else denied.push(s);
      }
      await socket.join(granted.map((s) => roomFor(d.tenantId, s.kind, s.id, 'public')));
      for (const s of granted) d.subscriptions.add(`${s.kind}:${s.id}`);
      const r = await this.replay(socket, d.tenantId, [...granted, { kind: 'visitor', id: d.sessionId }], body.lastCursor ?? null);
      if (r.snapshotRequired) return { type: 'snapshot.required', snapshot_cursor: r.snapshotCursor, denied };
      return { type: 'subscription.ok', snapshot_cursor: r.snapshotCursor, granted: granted.length, denied };
    } catch (err) {
      return this.ackError('subscribe', err);
    }
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as VisitorData;
    const leave = this.scopesToLeave(fromWire(raw) as { scopeIds?: unknown; scopes?: Array<{ kind: ScopeKind; id: string }> });
    for (const s of leave) {
      // The session's own stream and its site config are part of the connection.
      if ((s.kind === 'visitor' && s.id === d.sessionId) || (s.kind === 'config' && s.id === d.siteId)) continue;
      await socket.leave(roomFor(d.tenantId, s.kind, s.id, 'public'));
      d.subscriptions.delete(`${s.kind}:${s.id}`);
    }
    return { type: 'unsubscribe.ok', ok: true, scope_ids: leave.map((s) => `${s.kind}:${s.id}`) };
  }

  @SubscribeMessage('command')
  async command(@ConnectedSocket() socket: Socket, @MessageBody() raw: unknown) {
    const d = socket.data as VisitorData;
    const cmd = this.parseCommand(raw);
    if (!cmd) return { type: 'command.error', command_id: null, code: 'VALIDATION_FAILED', message: 'Malformed command', retryable: false };
    const burst = await this.rateLimit.hit(`ws-vcmd:${d.connectionId}:burst`, 20, 1);
    const sustained = await this.rateLimit.hit(`ws-vcmd:${d.connectionId}`, 600, 60);
    if (!burst || !sustained) return { type: 'command.error', command_id: cmd.commandId, code: 'RATE_LIMITED', message: 'Slow down', retryable: true };
    const handler = this.commands.visitorHandler(cmd.type);
    if (!handler) return { type: 'command.error', command_id: cmd.commandId, code: 'VALIDATION_FAILED', message: `Unknown command ${cmd.type}`, retryable: false };
    try {
      const result = await handler({ visitor: this.visitorContext(d, socket), connectionId: d.connectionId }, cmd);
      this.metrics.command(cmd.type, 'ok');
      return { type: 'command.ack', command_id: cmd.commandId, result: this.ackResult(result), committed_at: new Date().toISOString() };
    } catch (err) {
      return this.ackError(cmd.commandId, err, cmd.type);
    }
  }
}
