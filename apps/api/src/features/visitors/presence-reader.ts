import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis.service';
import { env } from '../../config/env';

/**
 * Batched, read-only view over the visitor presence keys written by
 * core/presence.service.ts (`pv:z:{t}`, `pv:conn:{t}:{v}`, `pv:state:{t}:{v}`,
 * `pv:tenants`). PresenceService only exposes per-visitor reads; live
 * monitoring of 10 000 sessions needs one pipelined round trip instead of
 * N+1 calls. Keep the key layout in sync with PresenceService.
 */
export interface PresenceConnection {
  connectionId: string;
  sessionId: string;
  siteId: string;
  ts: number;
  visible: boolean;
}

export interface PresenceSnapshot {
  visitorId: string;
  /** Last heartbeat score in the live sorted set (ms). */
  score: number;
  siteId: string | null;
  /** Session of the most recently connected transport. */
  sessionId: string | null;
  lastActivityAt: number | null;
  sessionStartedAt: number | null;
  pageEnteredAt: number | null;
  /** Fresh connections only (heartbeat within the visitor timeout). */
  connections: PresenceConnection[];
}

const STATE_FIELDS = ['siteId', 'sessionId', 'lastActivityAt', 'sessionStartedAt', 'pageEnteredAt'] as const;

@Injectable()
export class PresenceReader {
  constructor(private readonly redis: RedisService) {}

  private num(v: string | null | undefined): number | null {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Live visitor ids with their last heartbeat score, most recent first. */
  async liveVisitors(tenantId: string, limit = 10_000): Promise<Array<{ visitorId: string; score: number }>> {
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    const raw = await this.redis.client.zrevrangebyscore(`pv:z:${tenantId}`, '+inf', cutoff, 'WITHSCORES', 'LIMIT', 0, limit);
    const out: Array<{ visitorId: string; score: number }> = [];
    for (let i = 0; i < raw.length; i += 2) out.push({ visitorId: raw[i], score: Number(raw[i + 1]) });
    return out;
  }

  /** Tenants that currently have (or recently had) live visitors. */
  async tenants(): Promise<string[]> {
    return this.redis.client.smembers('pv:tenants');
  }

  /** One pipelined read of state + connections for many visitors. Missing visitors are omitted. */
  async read(tenantId: string, visitorIds: string[], scores?: Map<string, number>): Promise<Map<string, PresenceSnapshot>> {
    const out = new Map<string, PresenceSnapshot>();
    if (!visitorIds.length) return out;
    const cutoff = Date.now() - env().VISITOR_TIMEOUT_MS;
    const CHUNK = 2_000;
    for (let start = 0; start < visitorIds.length; start += CHUNK) {
      const ids = visitorIds.slice(start, start + CHUNK);
      const p = this.redis.client.pipeline();
      for (const v of ids) {
        p.hmget(`pv:state:${tenantId}:${v}`, ...STATE_FIELDS);
        p.hgetall(`pv:conn:${tenantId}:${v}`);
        if (!scores) p.zscore(`pv:z:${tenantId}`, v);
      }
      const res = (await p.exec()) ?? [];
      const step = scores ? 2 : 3;
      ids.forEach((visitorId, i) => {
        const state = (res[i * step]?.[1] as Array<string | null>) ?? [];
        const conns = (res[i * step + 1]?.[1] as Record<string, string>) ?? {};
        const score = scores ? (scores.get(visitorId) ?? null) : this.num(res[i * step + 2]?.[1] as string | null);
        const connections: PresenceConnection[] = [];
        for (const [connectionId, json] of Object.entries(conns)) {
          try {
            const c = JSON.parse(json) as { sessionId?: string; siteId?: string; ts?: number; visible?: boolean };
            if (c.sessionId && typeof c.ts === 'number' && c.ts > cutoff) {
              connections.push({ connectionId, sessionId: c.sessionId, siteId: c.siteId ?? '', ts: c.ts, visible: c.visible !== false });
            }
          } catch {
            /* ignore malformed entries */
          }
        }
        if (score === null && !connections.length && !state[0]) return;
        out.set(visitorId, {
          visitorId,
          score: score ?? 0,
          siteId: state[0] || null,
          sessionId: state[1] || null,
          lastActivityAt: this.num(state[2]),
          sessionStartedAt: this.num(state[3]),
          pageEnteredAt: this.num(state[4]),
          connections,
        });
      });
    }
    return out;
  }

  /** Is the visitor inside the live window (heartbeat newer than the timeout)? */
  isOnline(p: PresenceSnapshot | null | undefined): boolean {
    return !!p && p.score > Date.now() - env().VISITOR_TIMEOUT_MS;
  }
}
