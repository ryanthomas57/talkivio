import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { env } from '../config/env';

export interface VisitorLiveState {
  tenantId: string;
  visitorId: string;
  siteId: string;
  sessionId: string;
  currentUrl: string;
  currentTitle: string;
  referrerOrigin: string | null;
  pageEnteredAt: number;
  sessionStartedAt: number;
  lastActivityAt: number;
  lastSeenAt: number;
  pageViews: number;
  connections: number;
  visible: boolean;
}

type AgentHook = (tenantId: string, membershipId: string, connected: boolean) => Promise<void> | void;
type VisitorHook = (
  tenantId: string,
  visitorId: string,
  sessionId: string,
  event: 'connected' | 'disconnected' | 'gone',
) => Promise<void> | void;

const k = {
  agentConn: (t: string) => `pa:conn:${t}`,
  agentTenants: 'pa:tenants',
  agentActivity: (t: string) => `pa:activity:${t}`,
  visitorZ: (t: string) => `pv:z:${t}`,
  visitorConn: (t: string, v: string) => `pv:conn:${t}:${v}`,
  visitorState: (t: string, v: string) => `pv:state:${t}:${v}`,
  visitorTenants: 'pv:tenants',
};

/**
 * How long a visitor whose last tab disconnected stays listed: a full-page navigation reconnects within it (measured
 * on a WordPress site: 3 s on a cached page, 8.4 s on a cold first load, so 15 s leaves room for slow phones), a
 * visitor who closed the site is gone after it.
 */
const RECONNECT_GRACE_MS = 15_000;

/** Claims a visitor whose presence score has expired (ZREM only if still stale), atomically against a reconnect. */
const CLAIM_STALE_VISITOR = `
local s = redis.call('ZSCORE', KEYS[1], ARGV[1])
if s and tonumber(s) <= tonumber(ARGV[2]) then return redis.call('ZREM', KEYS[1], ARGV[1]) end
return 0`;

/**
 * Ephemeral presence in Redis (ch. 09/11). Desired agent status is durable in
 * PostgreSQL; connection liveness lives here with heartbeat expiry, so a crashed
 * node's connections age out. Losing Redis only causes temporary uncertainty.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('Presence');
  private readonly agentHooks: AgentHook[] = [];
  private readonly visitorHooks: VisitorHook[] = [];

  constructor(private readonly redis: RedisService) {}

  private get r() {
    return this.redis.client;
  }

  onAgentConnection(hook: AgentHook): void {
    this.agentHooks.push(hook);
  }

  onVisitorConnection(hook: VisitorHook): void {
    this.visitorHooks.push(hook);
  }

  private async runAgentHooks(t: string, m: string, connected: boolean) {
    for (const h of this.agentHooks) {
      try {
        await h(t, m, connected);
      } catch (err) {
        this.logger.warn(`agent presence hook failed: ${(err as Error).message}`);
      }
    }
  }

  private async runVisitorHooks(t: string, v: string, s: string, e: 'connected' | 'disconnected' | 'gone') {
    for (const h of this.visitorHooks) {
      try {
        await h(t, v, s, e);
      } catch (err) {
        this.logger.warn(`visitor presence hook failed: ${(err as Error).message}`);
      }
    }
  }

  // ───────── Agents ─────────

  async agentConnected(tenantId: string, membershipId: string, connectionId: string): Promise<boolean> {
    const before = await this.connectedAgentIds(tenantId);
    await this.r
      .multi()
      .zadd(k.agentConn(tenantId), Date.now(), `${membershipId}|${connectionId}`)
      .sadd(k.agentTenants, tenantId)
      .exec();
    await this.recordAgentActivity(tenantId, membershipId);
    return !before.has(membershipId);
  }

  /**
   * Refresh a live connection. If Redis lost the entry (restart without persistence, failover, or a
   * sweep during an event-loop stall) the still-open socket re-registers itself instead of looking
   * offline until the next reconnect.
   */
  async agentHeartbeat(tenantId: string, membershipId: string, connectionId: string): Promise<void> {
    const member = `${membershipId}|${connectionId}`;
    const changed = await this.r.zadd(k.agentConn(tenantId), 'XX', 'CH', Date.now(), member);
    if (Number(changed) > 0) return;
    const wasConnected = (await this.connectedAgentIds(tenantId)).has(membershipId);
    await this.r
      .multi()
      .zadd(k.agentConn(tenantId), Date.now(), member)
      .sadd(k.agentTenants, tenantId)
      .exec();
    if (!wasConnected) {
      this.logger.log(`Re-registered agent connection ${membershipId} (presence entry was missing)`);
      await this.runAgentHooks(tenantId, membershipId, true);
    }
  }

  /** Returns true when this was the agent's last live connection. */
  async agentDisconnected(tenantId: string, membershipId: string, connectionId: string): Promise<boolean> {
    await this.r.zrem(k.agentConn(tenantId), `${membershipId}|${connectionId}`);
    return !(await this.connectedAgentIds(tenantId)).has(membershipId);
  }

  async connectedAgentIds(tenantId: string): Promise<Set<string>> {
    const members = await this.r.zrangebyscore(
      k.agentConn(tenantId),
      Date.now() - env().AGENT_TIMEOUT_MS,
      '+inf',
    );
    return new Set(members.map((m) => m.split('|')[0]));
  }

  async agentConnectionCount(tenantId: string, membershipId: string): Promise<number> {
    const members = await this.r.zrangebyscore(
      k.agentConn(tenantId),
      Date.now() - env().AGENT_TIMEOUT_MS,
      '+inf',
    );
    return members.filter((m) => m.startsWith(`${membershipId}|`)).length;
  }

  async notifyAgentConnection(tenantId: string, membershipId: string, connected: boolean): Promise<void> {
    await this.runAgentHooks(tenantId, membershipId, connected);
  }

  async recordAgentActivity(tenantId: string, membershipId: string): Promise<void> {
    await this.r.hset(k.agentActivity(tenantId), membershipId, Date.now());
  }

  async agentActivity(tenantId: string): Promise<Record<string, number>> {
    const raw = await this.r.hgetall(k.agentActivity(tenantId));
    return Object.fromEntries(Object.entries(raw).map(([id, ts]) => [id, Number(ts)]));
  }

  async agentTenants(): Promise<string[]> {
    return this.r.smembers(k.agentTenants);
  }

  /** Expire agent connections whose heartbeats stopped (≤ 45 s). */
  async sweepAgents(): Promise<Array<{ tenantId: string; membershipId: string }>> {
    const lost: Array<{ tenantId: string; membershipId: string }> = [];
    const cutoff = Date.now() - env().AGENT_TIMEOUT_MS;
    for (const tenantId of await this.agentTenants()) {
      const stale = await this.r.zrangebyscore(k.agentConn(tenantId), '-inf', cutoff);
      if (!stale.length) continue;
      await this.r.zremrangebyscore(k.agentConn(tenantId), '-inf', cutoff);
      const still = await this.connectedAgentIds(tenantId);
      for (const id of new Set(stale.map((s) => s.split('|')[0]))) {
        if (!still.has(id)) {
          lost.push({ tenantId, membershipId: id });
          await this.runAgentHooks(tenantId, id, false);
        }
      }
    }
    return lost;
  }

  // ───────── Visitors ─────────

  async visitorConnected(
    tenantId: string,
    visitorId: string,
    sessionId: string,
    connectionId: string,
    siteId: string,
  ): Promise<void> {
    const ttl = Math.ceil((env().VISITOR_TIMEOUT_MS * 4) / 1000);
    const now = Date.now();
    const wasOnline = await this.isVisitorOnline(tenantId, visitorId);
    await this.r
      .multi()
      .hset(
        k.visitorConn(tenantId, visitorId),
        connectionId,
        JSON.stringify({ sessionId, siteId, ts: now, visible: true }),
      )
      .expire(k.visitorConn(tenantId, visitorId), ttl)
      .hsetnx(k.visitorState(tenantId, visitorId), 'sessionStartedAt', String(now))
      .hset(k.visitorState(tenantId, visitorId), {
        tenantId,
        visitorId,
        siteId,
        sessionId,
        lastSeenAt: now,
        lastActivityAt: now,
      })
      .expire(k.visitorState(tenantId, visitorId), ttl)
      .zadd(k.visitorZ(tenantId), now, visitorId)
      .sadd(k.visitorTenants, tenantId)
      .exec();
    await this.runVisitorHooks(tenantId, visitorId, sessionId, wasOnline ? 'connected' : 'connected');
  }

  async visitorHeartbeat(
    tenantId: string,
    visitorId: string,
    sessionId: string,
    connectionId: string,
    active = false,
    siteId?: string,
  ): Promise<void> {
    const now = Date.now();
    const raw = await this.r.hget(k.visitorConn(tenantId, visitorId), connectionId);
    if (!raw) {
      // Lost presence (Redis restart/failover) for a socket that is still open: register it again.
      if (siteId) await this.visitorConnected(tenantId, visitorId, sessionId, connectionId, siteId);
      return;
    }
    const c = JSON.parse(raw) as { sessionId: string; siteId: string; ts: number; visible: boolean };
    c.ts = now;
    c.visible = active || c.visible;
    const ttl = Math.ceil((env().VISITOR_TIMEOUT_MS * 4) / 1000);
    const m = this.r
      .multi()
      .hset(k.visitorConn(tenantId, visitorId), connectionId, JSON.stringify(c))
      .expire(k.visitorConn(tenantId, visitorId), ttl)
      .expire(k.visitorState(tenantId, visitorId), ttl)
      .zadd(k.visitorZ(tenantId), now, visitorId)
      .hset(k.visitorState(tenantId, visitorId), 'lastSeenAt', now);
    if (active) m.hset(k.visitorState(tenantId, visitorId), 'lastActivityAt', now);
    await m.exec();
  }

  async visitorDisconnected(
    tenantId: string,
    visitorId: string,
    sessionId: string,
    connectionId: string,
  ): Promise<void> {
    await this.r.hdel(k.visitorConn(tenantId, visitorId), connectionId);
    const remaining = await this.r.hlen(k.visitorConn(tenantId, visitorId));
    if (remaining === 0) {
      // Expire the visitor after a short grace (full-page navigations reconnect within it). The timer makes the
      // visitor leave on time; the sweeper (every 5 s) is the backstop if this process stops first.
      const score = Date.now() - env().VISITOR_TIMEOUT_MS + RECONNECT_GRACE_MS;
      await this.r.zadd(k.visitorZ(tenantId), 'XX', 'LT', score, visitorId);
      await this.runVisitorHooks(tenantId, visitorId, sessionId, 'disconnected');
      setTimeout(
        () =>
          void this.expireVisitor(tenantId, visitorId).catch((err) =>
            this.logger.warn(`visitor expiry failed: ${(err as Error).message}`),
          ),
        RECONNECT_GRACE_MS + 100,
      ).unref();
    }
  }

  /**
   * Ends a visitor's presence if it is still expired: claimed once across processes (a reconnect in between keeps it),
   * then its live state is dropped and the 'gone' hooks run. Returns the session it ended, or null if not claimed.
   */
  private async expireVisitor(
    tenantId: string,
    visitorId: string,
  ): Promise<{ sessionId: string | null } | null> {
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    if (!Number(await this.r.eval(CLAIM_STALE_VISITOR, 1, k.visitorZ(tenantId), visitorId, cutoff)))
      return null;
    const sessionId = (await this.r.hget(k.visitorState(tenantId, visitorId), 'sessionId')) || null;
    await this.r.del(k.visitorConn(tenantId, visitorId), k.visitorState(tenantId, visitorId));
    await this.runVisitorHooks(tenantId, visitorId, sessionId ?? '', 'gone');
    return { sessionId };
  }

  async patchVisitorState(
    tenantId: string,
    visitorId: string,
    patch: Partial<Record<keyof VisitorLiveState, string | number | null>>,
  ): Promise<void> {
    const entries = Object.entries(patch).map(([key, v]) => [
      key,
      v === null || v === undefined ? '' : String(v),
    ]);
    if (entries.length) await this.r.hset(k.visitorState(tenantId, visitorId), Object.fromEntries(entries));
  }

  async visitorState(tenantId: string, visitorId: string): Promise<VisitorLiveState | null> {
    const raw = await this.r.hgetall(k.visitorState(tenantId, visitorId));
    if (!raw?.visitorId) return null;
    const conns = await this.r.hvals(k.visitorConn(tenantId, visitorId));
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    const live = conns
      .map((c) => JSON.parse(c) as { ts: number; visible: boolean })
      .filter((c) => c.ts > cutoff);
    return {
      tenantId,
      visitorId,
      siteId: raw.siteId,
      sessionId: raw.sessionId,
      currentUrl: raw.currentUrl ?? '',
      currentTitle: raw.currentTitle ?? '',
      referrerOrigin: raw.referrerOrigin || null,
      pageEnteredAt: Number(raw.pageEnteredAt || raw.sessionStartedAt || Date.now()),
      sessionStartedAt: Number(raw.sessionStartedAt || Date.now()),
      lastActivityAt: Number(raw.lastActivityAt || 0),
      lastSeenAt: Number(raw.lastSeenAt || 0),
      pageViews: Number(raw.pageViews || 0),
      connections: live.length,
      visible: live.some((c) => c.visible),
    };
  }

  async isVisitorOnline(tenantId: string, visitorId: string): Promise<boolean> {
    const score = await this.r.zscore(k.visitorZ(tenantId), visitorId);
    return score !== null && Number(score) > Date.now() - env().VISITOR_TIMEOUT_MS;
  }

  async onlineVisitorIds(tenantId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const scores = await this.r.zmscore(k.visitorZ(tenantId), ...ids);
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    return new Set(ids.filter((_, i) => scores[i] !== null && Number(scores[i]) > cutoff));
  }

  async liveVisitorIds(tenantId: string, limit = 10_000): Promise<string[]> {
    return this.r.zrevrangebyscore(
      k.visitorZ(tenantId),
      '+inf',
      Date.now() - env().VISITOR_TIMEOUT_MS,
      'LIMIT',
      0,
      limit,
    );
  }

  async countOnline(tenantId: string): Promise<number> {
    return this.r.zcount(k.visitorZ(tenantId), Date.now() - env().VISITOR_TIMEOUT_MS, '+inf');
  }

  /** Expire visitors whose connections stopped; each is claimed once (ZREM) across sweepers. */
  async sweepVisitors(): Promise<Array<{ tenantId: string; visitorId: string; sessionId: string | null }>> {
    const gone: Array<{ tenantId: string; visitorId: string; sessionId: string | null }> = [];
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    for (const tenantId of await this.r.smembers(k.visitorTenants)) {
      const stale = await this.r.zrangebyscore(k.visitorZ(tenantId), '-inf', cutoff);
      for (const visitorId of stale) {
        const ended = await this.expireVisitor(tenantId, visitorId);
        if (ended) gone.push({ tenantId, visitorId, sessionId: ended.sessionId });
      }
      if ((await this.r.zcard(k.visitorZ(tenantId))) === 0) await this.r.srem(k.visitorTenants, tenantId);
    }
    return gone;
  }

  async forgetVisitor(tenantId: string, visitorId: string): Promise<void> {
    await this.r
      .multi()
      .zrem(k.visitorZ(tenantId), visitorId)
      .del(k.visitorConn(tenantId, visitorId), k.visitorState(tenantId, visitorId))
      .exec();
  }
}
