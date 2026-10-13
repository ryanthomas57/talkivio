import { MetricsService } from '../../core/metrics.service';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TenantDb } from '../../db/tenant-db';
import { notFound, type AuthContext } from '../../common/http';
import { RedisService } from '../../common/redis.service';
import { ROLE_PERMISSIONS, TENANT_WIDE_ROLES } from '../../common/permissions';
import { PresenceService } from '../../core/presence.service';
import { EventConsumers } from '../../outbox/event-consumers';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService } from '../../realtime/realtime.service';
import { WorkerService } from '../../worker/worker.service';
import { assertDepartmentInScope, scopeKey, type MonitorQuery } from './schemas';
import { percent } from './stats';
import { isValidTimeZone, localDateKey, startOfLocalDay } from './time';

/** Events that can change a monitor counter; each marks the tenant dirty for a coalesced push. */
export const MONITOR_EVENTS = [
  'chat.requested',
  'chat.updated',
  'assignment.offered',
  'assignment.accepted',
  'assignment.withdrawn',
  'chat.transferred',
  'transfer.declined',
  'transfer.expired',
  'participant.joined',
  'participant.left',
  'message.created',
  'chat.closed',
  'rating.updated',
] as const;

export const MONITOR_THRESHOLDS = { queueWarningSeconds: 60, queueCriticalSeconds: 180, staleAfterMs: 15_000 };
const WATCH_TTL_MS = 5 * 60_000;
const PUSH_EVERY_MS = 5_000;
const LOOP_MS = 1_000;
const CACHE_MAX_AGE_MS = 2_000;
const LEASE_MS = 5_000;

const K = {
  watchers: (tenantId: string) => `rd:monitor:watchers:${tenantId}`,
  tenants: 'rd:monitor:tenants',
  dirty: 'rd:monitor:dirty',
  leader: 'rd:monitor:leader',
  snapshot: (tenantId: string, key: string) => `rd:monitor:snapshot:${tenantId}:${key}`,
};

export type WaitLevel = 'none' | 'ok' | 'warning' | 'critical';

export function waitLevel(seconds: number | null): WaitLevel {
  if (seconds === null) return 'none';
  if (seconds >= MONITOR_THRESHOLDS.queueCriticalSeconds) return 'critical';
  if (seconds >= MONITOR_THRESHOLDS.queueWarningSeconds) return 'warning';
  return 'ok';
}

export interface MonitorFilters {
  departmentId: string | null;
  siteId: string | null;
}

export interface DepartmentLoad {
  departmentId: string | null;
  name: string;
  queued: number;
  oldestWaitSeconds: number | null;
  oldestWaitLevel: WaitLevel;
  active: number;
  offeredReservations: number;
  responseBacklog: number;
  onlineAgents: number;
  availableAgents: number;
  busy: boolean;
}

export interface AgentGridRow {
  membershipId: string;
  displayName: string;
  role: string;
  effectiveStatus: 'online' | 'away' | 'invisible' | 'offline';
  desiredStatus: string;
  connected: boolean;
  capacity: number;
  activeChats: number;
  collaborations: number;
  reservedOffers: number;
  loadPct: number | null;
  atCapacity: boolean;
  available: boolean;
  responseBacklog: number;
  oldestUnansweredAt: Date | string | null;
  oldestUnansweredSeconds: number | null;
  departmentIds: string[];
}

export interface MonitorSnapshot {
  asOf: Date | string;
  sourceWatermark: Date | string | null;
  freshnessMs: number;
  stale: boolean;
  scope: { departmentIds: 'all' | string[]; departmentId: string | null; siteId: string | null };
  thresholds: typeof MONITOR_THRESHOLDS;
  counters: {
    queued: number;
    oldestWaitSeconds: number | null;
    oldestRequestedAt: Date | string | null;
    oldestWaitLevel: WaitLevel;
    oldestWaitWarning: boolean;
    oldestWaitCritical: boolean;
    active: number;
    availableAgents: number;
    onlineAgents: number;
    offeredReservations: number;
    responseBacklog: number;
    csat: { value: number | null; numerator: number; denominator: number; n: number; window: 'today'; windowStart: Date | string; timezone: string };
  };
  busyDepartments: DepartmentLoad[];
  departments: DepartmentLoad[];
  agents: AgentGridRow[];
}

interface BacklogRow {
  chat_id: string;
  last_visitor_at: Date | null;
  last_human_at: Date | null;
  oldest_unanswered_at: Date | null;
}

interface WatcherEntry {
  exp: number;
  departmentId: string | null;
  siteId: string | null;
}

/**
 * Supervisor monitoring (ch. 49). Counters derive from durable chat/offer state
 * in PostgreSQL; the latest snapshot per scope is cached briefly in Redis. A
 * leader-elected loop in the worker pushes coalesced `monitor.updated` frames
 * (≤ 1 s after a relevant event, and at least every 5 s) to each watching
 * supervisor's own agent room, computed with that supervisor's department scope
 * so hidden departments never leak into aggregate counts.
 */
@Injectable()
export class MonitorService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Monitor');
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly lastPush = new Map<string, number>();

  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    private readonly consumers: EventConsumers,
    private readonly worker: WorkerService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    for (const type of MONITOR_EVENTS) this.consumers.on(type, `analytics.monitor:${type}`, (e) => this.markDirty(e.tenantId));
    this.presence.onAgentConnection(async (tenantId) => this.markDirty(tenantId));
    // Backstop reconciliation: every watched tenant is recomputed from PostgreSQL.
    this.worker.onMaintenance('monitor-reconcile', async () => {
      const tenants = await this.redis.client.smembers(K.tenants);
      if (tenants.length) await this.redis.client.sadd(K.dirty, ...tenants);
    });
  }

  onApplicationBootstrap(): void {
    if (process.env.TALKIVIO_PROCESS === 'worker') {
      this.timer = setInterval(() => void this.tick(), LOOP_MS);
      this.timer.unref?.();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const r = this.redis.client;
    if ((await r.get(K.leader).catch(() => null)) === this.instanceId) await r.del(K.leader).catch(() => undefined);
  }

  async markDirty(tenantId: string): Promise<void> {
    const r = this.redis.client;
    if (await r.sismember(K.tenants, tenantId)) await r.sadd(K.dirty, tenantId);
  }

  // ───────── REST ─────────

  async get(auth: AuthContext, q: MonitorQuery): Promise<MonitorSnapshot> {
    assertDepartmentInScope(auth, q.departmentId);
    const filters: MonitorFilters = { departmentId: q.departmentId ?? null, siteId: q.siteId ?? null };
    if (filters.siteId) {
      const site = await this.db.read(auth.tenantId, (tx) => tx.site.findFirst({ where: { tenantId: auth.tenantId, id: filters.siteId! }, select: { id: true } }));
      if (!site) throw notFound('Site');
    }
    if (filters.departmentId) {
      const dept = await this.db.read(auth.tenantId, (tx) => tx.department.findFirst({ where: { tenantId: auth.tenantId, id: filters.departmentId! }, select: { id: true } }));
      if (!dept) throw notFound('Department');
    }
    const snap = await this.cachedOrCompute(auth.tenantId, auth.departmentScope, filters);
    if (auth.membershipId) await this.watch(auth.tenantId, auth.membershipId, filters);
    return snap;
  }

  /** Register (or refresh) a push session for this supervisor; frames go to their own agent room. */
  async watch(tenantId: string, membershipId: string, filters: MonitorFilters): Promise<void> {
    const entry: WatcherEntry = { exp: Date.now() + WATCH_TTL_MS, departmentId: filters.departmentId, siteId: filters.siteId };
    await this.redis.client
      .multi()
      // One registration per member *and* filter, so two tabs with different filters both stay fresh.
      .hset(K.watchers(tenantId), `${membershipId}|${filters.departmentId ?? ''}|${filters.siteId ?? ''}`, JSON.stringify(entry))
      .pexpire(K.watchers(tenantId), WATCH_TTL_MS + 60_000)
      .sadd(K.tenants, tenantId)
      .exec();
  }

  private withFreshness(s: MonitorSnapshot): MonitorSnapshot {
    const freshnessMs = Math.max(0, Date.now() - new Date(s.asOf).getTime());
    return { ...s, freshnessMs, stale: freshnessMs > MONITOR_THRESHOLDS.staleAfterMs };
  }

  private cacheKey(tenantId: string, scope: 'all' | string[], f: MonitorFilters): string {
    return K.snapshot(tenantId, `${scopeKey(scope)}|${f.departmentId ?? ''}|${f.siteId ?? ''}`);
  }

  async cachedOrCompute(tenantId: string, scope: 'all' | string[], filters: MonitorFilters): Promise<MonitorSnapshot> {
    const key = this.cacheKey(tenantId, scope, filters);
    const hit = await this.redis.client.get(key).catch(() => null);
    if (hit) {
      const s = JSON.parse(hit) as MonitorSnapshot;
      if (Date.now() - new Date(s.asOf).getTime() <= CACHE_MAX_AGE_MS) return this.withFreshness(s);
    }
    const fresh = await this.compute(tenantId, scope, filters);
    await this.redis.client.set(key, JSON.stringify(fresh), 'PX', MONITOR_THRESHOLDS.staleAfterMs).catch(() => undefined);
    return this.withFreshness(fresh);
  }

  // ───────── Snapshot ─────────

  async compute(tenantId: string, scope: 'all' | string[], filters: MonitorFilters): Promise<MonitorSnapshot> {
    const connected = await this.presence.connectedAgentIds(tenantId);
    return this.db.read(tenantId, async (tx) => {
      const now = new Date();
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const tz = isValidTimeZone(tenant.timezone) ? tenant.timezone : 'UTC';
      const dayStart = new Date(startOfLocalDay(localDateKey(now.getTime(), tz), tz));

      const deptWhere: Prisma.DepartmentWhereInput = filters.departmentId ? { id: filters.departmentId } : scope === 'all' ? {} : { id: { in: scope } };
      const departments = await tx.department.findMany({
        where: { tenantId, archivedAt: null, ...deptWhere },
        select: { id: true, name: true, members: { select: { membershipId: true, canServe: true } } },
        orderBy: { name: 'asc' },
      });
      const chatScope: Prisma.ChatWhereInput = filters.departmentId
        ? { departmentId: filters.departmentId }
        : scope === 'all'
          ? {}
          : { OR: [{ departmentId: { in: scope } }, { departmentId: null }] };
      const siteWhere: Prisma.ChatWhereInput = filters.siteId ? { siteId: filters.siteId } : {};
      const open = await tx.chat.findMany({
        where: { tenantId, isPreview: false, status: { in: ['queued', 'offered', 'active'] }, ...siteWhere, ...chatScope },
        select: { id: true, status: true, departmentId: true, ownerMembershipId: true, requestedAt: true, updatedAt: true },
      });
      const openIds = open.map((c) => c.id);
      const activeIds = open.filter((c) => c.status === 'active').map((c) => c.id);
      const [offers, collabs, backlogRows, lastClosed] = await Promise.all([
        openIds.length
          ? tx.assignmentOffer.findMany({ where: { tenantId, chatId: { in: openIds }, status: 'pending', mode: { in: ['assigned', 'transfer'] }, expiresAt: { gt: now } }, select: { chatId: true, membershipId: true } })
          : Promise.resolve([]),
        activeIds.length
          ? tx.chatParticipant.findMany({ where: { tenantId, chatId: { in: activeIds }, role: 'collaborator', leftAt: null }, select: { chatId: true, membershipId: true } })
          : Promise.resolve([]),
        activeIds.length
          ? tx.$queryRaw<BacklogRow[]>`
              SELECT c.id AS chat_id, lv.last_visitor_at, hr.last_human_at,
                     (SELECT min(m.sent_at) FROM messages m
                       WHERE m.tenant_id = c.tenant_id AND m.chat_id = c.id AND m.sender_type = 'visitor' AND m.visibility = 'public'
                         AND m.sent_at > COALESCE(hr.last_human_at, '-infinity'::timestamptz)) AS oldest_unanswered_at
                FROM chats c
                LEFT JOIN LATERAL (SELECT max(sent_at) AS last_visitor_at FROM messages
                                    WHERE tenant_id = c.tenant_id AND chat_id = c.id AND sender_type = 'visitor' AND visibility = 'public') lv ON true
                LEFT JOIN LATERAL (SELECT max(sent_at) AS last_human_at FROM messages
                                    WHERE tenant_id = c.tenant_id AND chat_id = c.id AND sender_type = 'agent' AND visibility = 'public' AND automated = false) hr ON true
               WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ANY(${activeIds}::uuid[])`
          : Promise.resolve([] as BacklogRow[]),
        tx.chat.aggregate({ _max: { closedAt: true }, where: { tenantId, isPreview: false, status: 'closed', requestedAt: { gt: new Date(now.getTime() - 86_400_000) }, ...siteWhere, ...chatScope } }),
      ]);
      // Response backlog: latest public visitor message has no later human public reply.
      const backlog = new Map<string, Date>();
      for (const b of backlogRows) {
        if (b.last_visitor_at && (!b.last_human_at || b.last_human_at < b.last_visitor_at) && b.oldest_unanswered_at) backlog.set(b.chat_id, b.oldest_unanswered_at);
      }

      const memberWhere: Prisma.MembershipWhereInput = filters.departmentId
        ? { departments: { some: { departmentId: filters.departmentId, canServe: true } } }
        : scope === 'all'
          ? {}
          : { departments: { some: { departmentId: { in: scope }, canServe: true } } };
      const members = (
        await tx.membership.findMany({
          where: { tenantId, archivedAt: null, enabled: true, ...memberWhere },
          include: { user: { select: { displayName: true } }, departments: { select: { departmentId: true, canServe: true } } },
          orderBy: { createdAt: 'asc' },
        })
      ).filter((m) => ROLE_PERMISSIONS[m.role].has('chats.serve'));
      const memberIds = members.map((m) => m.id);
      // Total capacity usage (all departments) decides availability, exactly like routing.
      const [ownedAll, collabAll, reservedAll] = await Promise.all([
        tx.chat.groupBy({ by: ['ownerMembershipId'], where: { tenantId, status: 'active', ownerMembershipId: { in: memberIds } }, _count: { _all: true } }),
        tx.chatParticipant.groupBy({ by: ['membershipId'], where: { tenantId, role: 'collaborator', leftAt: null, membershipId: { in: memberIds }, chat: { status: { not: 'closed' } } }, _count: { _all: true } }),
        tx.assignmentOffer.groupBy({ by: ['membershipId'], where: { tenantId, status: 'pending', mode: { in: ['assigned', 'transfer'] }, expiresAt: { gt: now }, membershipId: { in: memberIds } }, _count: { _all: true } }),
      ]);
      const usage = new Map<string, number>();
      for (const r of ownedAll) if (r.ownerMembershipId) usage.set(r.ownerMembershipId, (usage.get(r.ownerMembershipId) ?? 0) + r._count._all);
      for (const r of collabAll) if (r.membershipId) usage.set(r.membershipId, (usage.get(r.membershipId) ?? 0) + r._count._all);
      for (const r of reservedAll) if (r.membershipId) usage.set(r.membershipId, (usage.get(r.membershipId) ?? 0) + r._count._all);

      const ratingScope =
        filters.departmentId
          ? Prisma.sql`AND c.department_id = ${filters.departmentId}::uuid`
          : scope === 'all'
            ? Prisma.empty
            : Prisma.sql`AND (c.department_id = ANY(${scope}::uuid[]) OR c.department_id IS NULL)`;
      const ratingSite = filters.siteId ? Prisma.sql`AND c.site_id = ${filters.siteId}::uuid` : Prisma.empty;
      const ratingRows = await tx.$queryRaw<Array<{ rating: string; n: number }>>`
        SELECT r.rating::text AS rating, count(*)::int AS n
          FROM chat_ratings r JOIN chats c ON c.tenant_id = r.tenant_id AND c.id = r.chat_id
         WHERE r.tenant_id = ${tenantId}::uuid AND c.is_preview = false AND c.requested_at >= ${dayStart.toISOString()}::timestamptz
           ${ratingScope} ${ratingSite}
         GROUP BY r.rating`;
      const good = ratingRows.find((r) => r.rating === 'good')?.n ?? 0;
      const bad = ratingRows.find((r) => r.rating === 'bad')?.n ?? 0;

      const secondsSince = (d: Date | null) => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 100) / 10) : null);
      const isOnline = (m: (typeof members)[number]) => connected.has(m.id) && m.desiredStatus === 'online';
      const isAvailable = (m: (typeof members)[number]) => isOnline(m) && (usage.get(m.id) ?? 0) < m.capacity;
      const queuedChats = open.filter((c) => c.status === 'queued' || c.status === 'offered');
      const oldest = queuedChats.reduce<Date | null>((min, c) => (!min || c.requestedAt < min ? c.requestedAt : min), null);
      const oldestSeconds = secondsSince(oldest);

      const loadFor = (deptId: string | null, name: string, servers: typeof members): DepartmentLoad => {
        const inDept = open.filter((c) => c.departmentId === deptId);
        const q = inDept.filter((c) => c.status === 'queued' || c.status === 'offered');
        const o = q.reduce<Date | null>((min, c) => (!min || c.requestedAt < min ? c.requestedAt : min), null);
        const ids = new Set(inDept.map((c) => c.id));
        const level = waitLevel(secondsSince(o));
        const available = servers.filter(isAvailable).length;
        return {
          departmentId: deptId,
          name,
          queued: q.length,
          oldestWaitSeconds: secondsSince(o),
          oldestWaitLevel: level,
          active: inDept.filter((c) => c.status === 'active').length,
          offeredReservations: offers.filter((x) => ids.has(x.chatId)).length,
          responseBacklog: [...backlog.keys()].filter((id) => ids.has(id)).length,
          onlineAgents: servers.filter(isOnline).length,
          availableAgents: available,
          busy: q.length > 0 && (available === 0 || level === 'warning' || level === 'critical'),
        };
      };
      const deptLoads = departments.map((d) => {
        const servers = members.filter((m) => d.members.some((x) => x.membershipId === m.id && x.canServe));
        return loadFor(d.id, d.name, servers);
      });
      if (!filters.departmentId && open.some((c) => c.departmentId === null)) deptLoads.push(loadFor(null, 'No department', members));

      const agents: AgentGridRow[] = members.map((m) => {
        const owned = open.filter((c) => c.status === 'active' && c.ownerMembershipId === m.id);
        const unanswered = owned.map((c) => backlog.get(c.id)).filter((d): d is Date => !!d);
        const oldestUnanswered = unanswered.reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);
        const total = usage.get(m.id) ?? 0;
        const isConnected = connected.has(m.id);
        return {
          membershipId: m.id,
          displayName: m.displayName || m.user.displayName,
          role: m.role,
          effectiveStatus: isConnected ? m.desiredStatus : 'offline',
          desiredStatus: m.desiredStatus,
          connected: isConnected,
          capacity: m.capacity,
          activeChats: owned.length,
          collaborations: collabs.filter((c) => c.membershipId === m.id).length,
          reservedOffers: offers.filter((o) => o.membershipId === m.id).length,
          loadPct: percent(owned.length, m.capacity),
          atCapacity: total >= m.capacity,
          available: isAvailable(m),
          responseBacklog: unanswered.length,
          oldestUnansweredAt: oldestUnanswered,
          oldestUnansweredSeconds: secondsSince(oldestUnanswered),
          departmentIds: m.departments.filter((d) => d.canServe && (scope === 'all' || scope.includes(d.departmentId))).map((d) => d.departmentId),
        };
      });
      agents.sort((a, b) => (b.loadPct ?? 0) - (a.loadPct ?? 0) || b.responseBacklog - a.responseBacklog || a.displayName.localeCompare(b.displayName));

      const watermarkMs = Math.max(0, ...open.map((c) => c.updatedAt.getTime()), lastClosed._max.closedAt?.getTime() ?? 0);
      const level = waitLevel(oldestSeconds);
      return {
        asOf: now,
        sourceWatermark: watermarkMs ? new Date(watermarkMs) : null,
        freshnessMs: 0,
        stale: false,
        scope: { departmentIds: scope, departmentId: filters.departmentId, siteId: filters.siteId },
        thresholds: MONITOR_THRESHOLDS,
        counters: {
          queued: queuedChats.length,
          oldestWaitSeconds: oldestSeconds,
          oldestRequestedAt: oldest,
          oldestWaitLevel: level,
          oldestWaitWarning: level === 'warning' || level === 'critical',
          oldestWaitCritical: level === 'critical',
          active: activeIds.length,
          availableAgents: members.filter(isAvailable).length,
          onlineAgents: members.filter(isOnline).length,
          offeredReservations: offers.length,
          responseBacklog: backlog.size,
          csat: { value: percent(good, good + bad), numerator: good, denominator: good + bad, n: good + bad, window: 'today', windowStart: dayStart, timezone: tz },
        },
        busyDepartments: deptLoads.filter((d) => d.busy).sort((a, b) => b.queued - a.queued || (b.oldestWaitSeconds ?? 0) - (a.oldestWaitSeconds ?? 0)),
        departments: deptLoads,
        agents,
      };
    });
  }

  // ───────── Push loop (worker, single leader) ─────────

  private async lease(): Promise<boolean> {
    const r = this.redis.client;
    const current = await r.get(K.leader);
    if (current === this.instanceId) {
      await r.pexpire(K.leader, LEASE_MS);
      return true;
    }
    return (await r.set(K.leader, this.instanceId, 'PX', LEASE_MS, 'NX')) === 'OK';
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.lease())) return;
      const r = this.redis.client;
      const dirty = ((await r.spop(K.dirty, 500)) as unknown as string[] | null) ?? [];
      const watched = await r.smembers(K.tenants);
      const now = Date.now();
      const due = new Set(dirty.filter((t) => watched.includes(t)));
      for (const t of watched) if (now - (this.lastPush.get(t) ?? 0) >= PUSH_EVERY_MS) due.add(t);
      for (const t of due) {
        try {
          await this.pushTenant(t);
        } catch (err) {
          this.logger.warn(`monitor push failed for ${t}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`monitor tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  async pushTenant(tenantId: string): Promise<number> {
    const r = this.redis.client;
    this.lastPush.set(tenantId, Date.now());
    const raw = await r.hgetall(K.watchers(tenantId));
    const now = Date.now();
    const live = new Map<string, WatcherEntry>();
    const drop: string[] = [];
    for (const [field, json] of Object.entries(raw)) {
      try {
        const w = JSON.parse(json) as WatcherEntry;
        if (w.exp > now) live.set(field, w);
        else drop.push(field);
      } catch {
        drop.push(field);
      }
    }
    if (!live.size) {
      if (drop.length) await r.hdel(K.watchers(tenantId), ...drop);
      await r.srem(K.tenants, tenantId);
      return 0;
    }
    // Re-derive each watcher's permission and department scope from PostgreSQL (revocation-safe).
    const members = await this.db.read(tenantId, (tx) =>
      tx.membership.findMany({ where: { tenantId, id: { in: [...new Set([...live.keys()].map((k) => k.split('|')[0]!))] } }, include: { departments: { select: { departmentId: true, canServe: true, canMonitor: true } } } }),
    );
    const groups = new Map<string, { scope: 'all' | string[]; filters: MonitorFilters; recipients: string[] }>();
    for (const [field, w] of live) {
      const membershipId = field.split('|')[0]!;
      const m = members.find((x) => x.id === membershipId);
      if (!m || !m.enabled || m.archivedAt || !ROLE_PERMISSIONS[m.role].has('monitor.view')) {
        drop.push(field);
        continue;
      }
      const scope: 'all' | string[] = TENANT_WIDE_ROLES.has(m.role) ? 'all' : [...new Set(m.departments.filter((d) => d.canServe || d.canMonitor).map((d) => d.departmentId))];
      const departmentId = w.departmentId && (scope === 'all' || scope.includes(w.departmentId)) ? w.departmentId : null;
      const filters: MonitorFilters = { departmentId, siteId: w.siteId };
      const key = `${scopeKey(scope)}|${departmentId ?? ''}|${w.siteId ?? ''}`;
      const g = groups.get(key) ?? { scope, filters, recipients: [] };
      g.recipients.push(membershipId);
      groups.set(key, g);
    }
    if (drop.length) await r.hdel(K.watchers(tenantId), ...drop);
    let sent = 0;
    for (const g of groups.values()) {
      const snap = await this.compute(tenantId, g.scope, g.filters);
      this.metrics.monitorFreshness.set(this.metrics.labels(), Math.max(0, (Date.now() - Date.parse(String(snap.asOf))) / 1000));
      await r.set(this.cacheKey(tenantId, g.scope, g.filters), JSON.stringify(snap), 'PX', MONITOR_THRESHOLDS.staleAfterMs).catch(() => undefined);
      for (const membershipId of g.recipients) {
        this.realtime.ephemeral(
          AGENT_NS,
          roomFor(tenantId, 'agent', membershipId, 'staff'),
          'monitor.updated',
          { kind: 'agent', id: membershipId },
          { snapshot: snap, asOf: snap.asOf, stale: false },
          MONITOR_THRESHOLDS.staleAfterMs,
        );
        sent++;
      }
    }
    return sent;
  }
}
