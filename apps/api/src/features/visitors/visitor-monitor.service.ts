import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { mergeOrgSettings, type OrgSettings } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { sha256, emailLookupHash } from '../../common/crypto';
import { badRequest, type AuthContext } from '../../common/http';
import { decodeCursor, encodeCursor } from '../../common/wire';
import { RedisService } from '../../common/redis.service';
import { env } from '../../config/env';
import { PresenceService } from '../../core/presence.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { encodeEventCursor, roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService } from '../../realtime/realtime.service';
import { WorkerService } from '../../worker/worker.service';
import { PresenceReader, type PresenceSnapshot } from './presence-reader';
import { displayNameOf, EMAIL_RE, likePattern, normalizeEmail, pageLimit } from './visitor-common';

/**
 * Live visitor monitoring (ch. 11/48): consent-limited, department-scoped live
 * snapshot for 10 000+ sessions (batched Redis + SQL, no per-visitor queries),
 * coalesced realtime deltas (≤ 1 per second per tenant), session lifecycle
 * (last_seen_at / ended_at on server time) and browsing-data lifecycle
 * (retention, consent-withdrawal purge).
 */
export type LiveGroup = 'incoming' | 'served' | 'browsing' | 'idle';
export const LIVE_GROUPS: LiveGroup[] = ['incoming', 'served', 'browsing', 'idle'];
const GROUP_RANK: Record<LiveGroup, number> = { incoming: 0, served: 1, browsing: 2, idle: 3 };

export const IDLE_AFTER_MS = 60_000;
/**
 * Continuation pages (cursor) of GET /visitors/live reuse the tenant's resolved live set for this long: paging
 * 10 000 sessions 100 at a time would otherwise re-read every presence entry for each page. First pages are always
 * resolved fresh; visibility and filters still apply per request, and clients apply live frames on top.
 */
const CONTINUATION_REUSE_MS = 3_000;
export const SESSION_INACTIVITY_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 1_000;
const TICK_MS = 250;
const RECONCILE_MS = 5_000;
const FLUSH_BATCH = 2_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sessions a present visitor is on: their open connections' sessions, or, while the last tab is disconnected but
 * presence still holds them (the reconnect grace, e.g. a full-page navigation), the session they were last on. They
 * leave the list when presence expires them ('gone'), not on every page change.
 */
function presentSessionIds(p: PresenceSnapshot): string[] {
  if (p.connections.length) return p.connections.map((c) => c.sessionId);
  return p.sessionId ? [p.sessionId] : [];
}

const K = {
  dirty: (t: string) => `vm:dirty:${t}`,
  dirtyTenants: 'vm:dirty:tenants',
  flushLock: (t: string) => `vm:flush:${t}`,
  reconLock: (t: string) => `vm:recon:${t}`,
  sig: (t: string) => `vm:sig:${t}`,
  sigTenants: 'vm:sig:tenants',
  /** `visitorId|sessionId` of disconnected sessions not yet announced (covers sessions shorter than one flush). */
  ended: (t: string) => `vm:ended:${t}`,
};
const ENDED_TTL_SECONDS = 600;

interface OpenChat {
  id: string;
  visitorId: string;
  siteId: string;
  departmentId: string | null;
  status: string;
  ownerMembershipId: string | null;
  requestedAt: Date;
}

interface SessionLite {
  id: string;
  visitorId: string;
  siteId: string;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
  analyticsConsent: string;
  country: string | null;
  ipAddress: string | null;
  network: string | null;
}

interface Core {
  visitorId: string;
  /** null → not visible in any live view (offline, or browsing without analytics consent). */
  group: LiveGroup | null;
  online: boolean;
  chat: OpenChat | null;
  presence: PresenceSnapshot | null;
  liveSessions: SessionLite[];
  consenting: boolean;
  siteId: string | null;
  arrivedAt: number | null;
  lastActivityAt: number | null;
  idle: boolean;
}

export interface LiveSessionItem {
  sessionId: string;
  siteId: string;
  connections: number;
  visible: boolean;
  mostRecent: boolean;
  browsingHidden: boolean;
  startedAt: Date | null;
  currentUrl: string | null;
  currentTitle: string | null;
  referrerOrigin: string | null;
  pageEnteredAt: Date | null;
  pageDwellMs: number | null;
}

export interface LiveVisitorItem {
  visitorId: string;
  group: LiveGroup;
  displayName: string;
  anonymousLabel: string;
  identity: { verified: boolean; identified: boolean };
  siteId: string | null;
  online: boolean;
  connections: number;
  browsingHidden: boolean;
  currentUrl: string | null;
  currentTitle: string | null;
  referrerOrigin: string | null;
  mostRecentSessionId: string | null;
  pageEnteredAt: Date | null;
  pageDwellMs: number | null;
  arrivedAt: Date | null;
  timeOnSiteMs: number | null;
  country: string | null;
  ipAddress: string | null;
  network: string | null;
  deviceCategory: string | null;
  browser: string | null;
  os: string | null;
  /** Pages viewed in the session shown (with analytics consent). */
  pageViews: number | null;
  sessionCount: number | null;
  lastActivityAt: Date | null;
  idle: boolean;
  tags: Array<{ id: string; slug: string; label: string }>;
  chat: {
    id: string;
    status: string;
    departmentId: string | null;
    departmentName: string | null;
    ownerMembershipId: string | null;
    requestedAt: Date;
    waitMs: number;
  } | null;
  sessions: LiveSessionItem[];
}

export interface LiveQuery {
  siteId?: string;
  departmentId?: string;
  status?: LiveGroup[];
  tag?: string;
  q?: string;
  country?: string;
  cursor?: string;
  limit?: number;
  mode?: 'normal' | 'high_load';
}

interface Signature {
  /** Live, existing sessions published in the last frame. */
  s: string[];
  /** All session ids seen on fresh connections (reconcile comparison). */
  a: string[];
  i: 0 | 1;
  d: string | null;
  c: 0 | 1;
  v: 0 | 1;
}

@Injectable()
export class VisitorMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('VisitorMonitor');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastReconcile = 0;
  private readonly recentCores = new Map<string, { at: number; cores: Promise<Map<string, Core>> }>();

  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly presence: PresenceService,
    private readonly reader: PresenceReader,
    private readonly realtime: RealtimeService,
    private readonly consumers: EventConsumers,
    private readonly worker: WorkerService,
    private readonly queues: QueueService,
  ) {}

  // ════════════════════════ Wiring ════════════════════════

  onModuleInit(): void {
    this.presence.onVisitorConnection((tenantId, visitorId, sessionId, event) =>
      this.onPresence(tenantId, visitorId, sessionId, event),
    );
    this.consumers.on('visitor.page.changed', 'visitors.monitor.page', (e) => this.onPageChanged(e));
    for (const type of [
      'chat.requested',
      'chat.updated',
      'chat.closed',
      'chat.transferred',
      'assignment.accepted',
      'participant.joined',
      'participant.left',
    ]) {
      this.consumers.on(type, `visitors.monitor.${type}`, (e) => this.onChatEvent(e));
    }
    this.worker.onMaintenance('visitors-maintenance', () => this.maintenance());
    this.worker.onTimer(async (name, data) => {
      if (name !== 'visitors.consent-purge') return false;
      await this.runConsentPurge(String(data.tenantId), String(data.jobId));
      return true;
    });
    // Delta flusher/reconciler runs in every long-lived process; Redis locks keep it ≤ 1/s per tenant.
    if (process.env.TALKIVIO_PROCESS) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ════════════════════════ Snapshot (GET /visitors/live) ════════════════════════

  async snapshot(auth: AuthContext, q: LiveQuery) {
    const tenantId = auth.tenantId;
    const now = Date.now();
    const highLoad = q.mode === 'high_load';
    const limit = pageLimit(q.limit);
    const filterHash = sha256(
      JSON.stringify({
        s: q.siteId,
        d: q.departmentId,
        st: q.status,
        t: q.tag,
        q: q.q,
        c: q.country,
        m: q.mode ?? 'normal',
      }),
    ).slice(0, 16);
    const cur = decodeCursor<{ r: number; k: number; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });

    const settings = await this.settings(tenantId);
    const cores = await this.liveCores(tenantId, !highLoad, !!cur);
    let list = [...cores.values()].filter((c) => this.visibleTo(c, auth));
    if (highLoad) list = list.filter((c) => c.group === 'incoming' || c.group === 'served');
    if (q.siteId) list = list.filter((c) => c.siteId === q.siteId);
    if (q.departmentId) list = list.filter((c) => c.chat?.departmentId === q.departmentId);
    if (q.country) {
      const cc = q.country.toUpperCase();
      list = settings.tracking.locationEnabled
        ? list.filter((c) => c.consenting && c.liveSessions.some((s) => s.country === cc))
        : [];
    }
    if (q.tag || q.q) list = await this.filterByRecord(tenantId, list, q.tag, q.q);

    const counts: Record<LiveGroup, number> = { incoming: 0, served: 0, browsing: 0, idle: 0 };
    for (const c of list) counts[c.group!]++;
    if (q.status?.length) list = list.filter((c) => q.status!.includes(c.group!));

    const keyed = list.map((c) => ({ c, key: this.sortKey(c) })).sort((a, b) => this.cmp(a.key, b.key));
    const after = cur ? keyed.filter((x) => this.cmp(x.key, [cur.r, cur.k, cur.id]) > 0) : keyed;
    const slice = after.slice(0, limit);
    const items = await this.hydrate(
      tenantId,
      slice.map((x) => x.c),
      settings,
      now,
    );
    const last = slice[slice.length - 1];
    const nextCursor =
      after.length > limit && last
        ? encodeCursor({ r: last.key[0], k: last.key[1], id: last.key[2] }, filterHash)
        : null;
    const maxSeq = await this.db.read(tenantId, (tx) =>
      tx.outboxEvent.findFirst({ where: { tenantId }, orderBy: { seq: 'desc' }, select: { seq: true } }),
    );
    return {
      items,
      asOf: new Date(now),
      snapshotCursor: encodeEventCursor(maxSeq?.seq ?? 0n),
      nextCursor,
      hasMore: !!nextCursor,
      mode: highLoad ? 'high_load' : 'normal',
      omittedBrowsing: highLoad,
      counts: highLoad ? { incoming: counts.incoming, served: counts.served } : counts,
      idleAfterMs: IDLE_AFTER_MS,
      realtime: {
        unscopedRoom: { kind: 'visitor', id: 'all' },
        departmentRooms:
          'Visitors whose open chat belongs to a department are published only to that department queue scope.',
      },
    };
  }

  private sortKey(c: Core): [number, number, string] {
    const rank = GROUP_RANK[c.group!];
    if (c.group === 'incoming' || c.group === 'served')
      return [rank, c.chat!.requestedAt.getTime(), c.visitorId];
    return [rank, -(c.arrivedAt ?? 0), c.visitorId];
  }

  private cmp(a: [number, number, string], b: [number, number, string]): number {
    return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  }

  /** Department scope: chats in departments outside the agent's scope hide the visitor entirely. */
  private visibleTo(c: Core, auth: AuthContext): boolean {
    if (!c.group) return false;
    if (!c.chat?.departmentId || auth.departmentScope === 'all') return true;
    return (
      auth.departmentScope.includes(c.chat.departmentId) ||
      (!!auth.membershipId && c.chat.ownerMembershipId === auth.membershipId)
    );
  }

  private async filterByRecord(
    tenantId: string,
    list: Core[],
    tag: string | undefined,
    q: string | undefined,
  ): Promise<Core[]> {
    if (!list.length) return list;
    const ids = list.map((c) => c.visitorId);
    const keep = await this.db.read(tenantId, async (tx) => {
      let set: Set<string> | null = null;
      if (tag) {
        const t = await tx.tag.findFirst({
          where: { tenantId, ...(UUID_RE.test(tag) ? { id: tag } : { slug: tag.toLowerCase() }) },
          select: { id: true },
        });
        if (!t) return new Set<string>();
        const rows = await tx.$queryRaw<Array<{ visitor_id: string }>>`
          SELECT visitor_id FROM visitor_tags WHERE tenant_id = ${tenantId}::uuid AND tag_id = ${t.id}::uuid AND visitor_id = ANY(${ids}::uuid[])`;
        set = new Set(rows.map((r) => r.visitor_id));
      }
      if (q) {
        const term = q.trim().slice(0, 100);
        const email = normalizeEmail(term);
        const hash = email && EMAIL_RE.test(email) ? emailLookupHash(email) : '__none__';
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM visitors
          WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[]) AND erased_at IS NULL
            AND (name ILIKE ${likePattern(term)} ESCAPE '\\' OR anonymous_label ILIKE ${likePattern(term)} ESCAPE '\\' OR email_lookup_hash = ${hash})`;
        const qs = new Set(rows.map((r) => r.id));
        set = set ? new Set([...set].filter((id) => qs.has(id))) : qs;
      }
      return set ?? new Set(ids);
    });
    return list.filter((c) => keep.has(c.visitorId));
  }

  private liveCores(
    tenantId: string,
    includeBrowsing: boolean,
    continuation: boolean,
  ): Promise<Map<string, Core>> {
    const key = `${tenantId}:${includeBrowsing ? 1 : 0}`;
    const now = Date.now();
    const hit = this.recentCores.get(key);
    if (continuation && hit && now - hit.at < CONTINUATION_REUSE_MS) return hit.cores;
    for (const [k, v] of this.recentCores)
      if (now - v.at >= CONTINUATION_REUSE_MS) this.recentCores.delete(k);
    const cores = this.resolveCores(tenantId, { includeBrowsing });
    this.recentCores.set(key, { at: now, cores });
    cores.catch(() => this.recentCores.delete(key));
    return cores;
  }

  // ════════════════════════ Core resolution (batched) ════════════════════════

  private async resolveCores(
    tenantId: string,
    opts: { visitorIds?: string[]; includeBrowsing: boolean },
  ): Promise<Map<string, Core>> {
    const now = Date.now();
    let presence: Map<string, PresenceSnapshot>;
    let chats: OpenChat[];
    const chatSelect = {
      id: true,
      visitorId: true,
      siteId: true,
      departmentId: true,
      status: true,
      ownerMembershipId: true,
      requestedAt: true,
    } satisfies Prisma.ChatSelect;
    if (opts.visitorIds) {
      const ids = opts.visitorIds.filter((id) => UUID_RE.test(id));
      [presence, chats] = await Promise.all([
        this.reader.read(tenantId, ids),
        ids.length
          ? this.db.read(tenantId, (tx) =>
              tx.chat.findMany({
                where: { tenantId, visitorId: { in: ids }, status: { not: 'closed' }, isPreview: false },
                select: chatSelect,
                orderBy: { requestedAt: 'desc' },
              }),
            )
          : Promise.resolve([] as OpenChat[]),
      ]);
    } else {
      const [live, open] = await Promise.all([
        opts.includeBrowsing
          ? this.reader.liveVisitors(tenantId)
          : Promise.resolve([] as Array<{ visitorId: string; score: number }>),
        this.db.read(tenantId, (tx) =>
          tx.chat.findMany({
            where: { tenantId, status: { not: 'closed' }, isPreview: false },
            select: chatSelect,
            orderBy: { requestedAt: 'desc' },
            take: 20_000,
          }),
        ),
      ]);
      chats = open;
      const scores = new Map(live.map((l) => [l.visitorId, l.score]));
      const ids = [...new Set([...live.map((l) => l.visitorId), ...open.map((c) => c.visitorId)])];
      presence = opts.includeBrowsing
        ? await this.reader.read(tenantId, ids, scores)
        : await this.reader.read(tenantId, ids);
      if (opts.includeBrowsing) for (const id of ids) if (!scores.has(id)) presence.delete(id);
    }

    const chatByVisitor = new Map<string, OpenChat>();
    for (const c of chats) if (!chatByVisitor.has(c.visitorId)) chatByVisitor.set(c.visitorId, c);

    const sessionIds = new Set<string>();
    for (const p of presence.values())
      if (this.reader.isOnline(p))
        for (const id of presentSessionIds(p)) if (UUID_RE.test(id)) sessionIds.add(id);
    const sessions = sessionIds.size
      ? await this.db.read(
          tenantId,
          (tx) =>
            tx.$queryRaw<
              Array<{
                id: string;
                visitor_id: string;
                site_id: string;
                started_at: Date;
                last_seen_at: Date;
                ended_at: Date | null;
                analytics_consent: string;
                country: string | null;
                ip_address: string | null;
                network: string | null;
              }>
            >`
            SELECT id, visitor_id, site_id, started_at, last_seen_at, ended_at, analytics_consent, country, ip_address, network
            FROM visitor_sessions WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${[...sessionIds]}::uuid[])`,
        )
      : [];
    const sessionById = new Map<string, SessionLite>(
      sessions.map((s) => [
        s.id,
        {
          id: s.id,
          visitorId: s.visitor_id,
          siteId: s.site_id,
          startedAt: s.started_at,
          lastSeenAt: s.last_seen_at,
          endedAt: s.ended_at,
          analyticsConsent: s.analytics_consent,
          country: s.country,
          ipAddress: s.ip_address,
          network: s.network,
        },
      ]),
    );

    const candidates = opts.visitorIds ?? [...new Set([...presence.keys(), ...chatByVisitor.keys()])];
    const out = new Map<string, Core>();
    for (const visitorId of candidates) {
      const p = presence.get(visitorId) ?? null;
      const online = this.reader.isOnline(p);
      const chat = chatByVisitor.get(visitorId) ?? null;
      const liveSessions: SessionLite[] = [];
      if (online && p) {
        const seen = new Set<string>();
        for (const id of presentSessionIds(p)) {
          const s = sessionById.get(id);
          if (!s || seen.has(s.id) || s.visitorId !== visitorId || s.endedAt) continue;
          seen.add(s.id);
          liveSessions.push(s);
        }
      }
      const consenting = liveSessions.some((s) => s.analyticsConsent === 'granted');
      const lastActivityAt = p?.lastActivityAt ?? null;
      const idle = online && (lastActivityAt === null || now - lastActivityAt > IDLE_AFTER_MS);
      let group: LiveGroup | null = null;
      // A visitor who left the website leaves the list with their presence (their open chat stays in the inbox).
      if (chat && online) group = chat.status === 'active' ? 'served' : 'incoming';
      else if (online && liveSessions.length && consenting) group = idle ? 'idle' : 'browsing';
      const arrived = liveSessions.length
        ? Math.min(...liveSessions.map((s) => s.startedAt.getTime()))
        : null;
      out.set(visitorId, {
        visitorId,
        group,
        online,
        chat,
        presence: p,
        liveSessions,
        consenting,
        siteId: chat?.siteId ?? liveSessions[0]?.siteId ?? p?.siteId ?? null,
        arrivedAt: arrived,
        lastActivityAt,
        idle,
      });
    }
    return out;
  }

  private async settings(tenantId: string): Promise<OrgSettings> {
    return this.db.read(tenantId, async (tx) =>
      mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings,
      ),
    );
  }

  /** Full, consent-limited projections for a bounded set of visitors (one query per relation). */
  private async hydrate(
    tenantId: string,
    cores: Core[],
    settings: OrgSettings,
    now: number,
  ): Promise<LiveVisitorItem[]> {
    if (!cores.length) return [];
    const ids = cores.map((c) => c.visitorId);
    const sessionIds = cores.flatMap((c) => c.liveSessions.map((s) => s.id));
    const deptIds = [...new Set(cores.map((c) => c.chat?.departmentId).filter((d): d is string => !!d))];
    const data = await this.db.read(tenantId, async (tx) => {
      const [visitors, sessions, entered, tagRows, depts, identities] = await Promise.all([
        tx.visitor.findMany({
          where: { tenantId, id: { in: ids } },
          select: {
            id: true,
            anonymousLabel: true,
            name: true,
            verified: true,
            visitCount: true,
            deviceCategory: true,
            emailCiphertext: true,
          },
        }),
        sessionIds.length
          ? tx.visitorSession.findMany({
              where: { tenantId, id: { in: sessionIds } },
              select: {
                id: true,
                siteId: true,
                startedAt: true,
                currentUrl: true,
                currentTitle: true,
                referrerOrigin: true,
                deviceCategory: true,
                browser: true,
                os: true,
                pageViewCount: true,
                country: true,
                analyticsConsent: true,
              },
            })
          : Promise.resolve([]),
        sessionIds.length
          ? tx.$queryRaw<Array<{ session_id: string; received_at: Date }>>`
              SELECT DISTINCT ON (session_id) session_id, received_at FROM page_events
              WHERE tenant_id = ${tenantId}::uuid AND session_id = ANY(${sessionIds}::uuid[]) AND kind = 'entered'
              ORDER BY session_id, received_at DESC, id DESC`
          : Promise.resolve([] as Array<{ session_id: string; received_at: Date }>),
        tx.visitorTag.findMany({
          where: { tenantId, visitorId: { in: ids } },
          select: { visitorId: true, tagId: true },
        }),
        deptIds.length
          ? tx.department.findMany({
              where: { tenantId, id: { in: deptIds } },
              select: { id: true, name: true },
            })
          : Promise.resolve([]),
        tx.visitorIdentity.findMany({
          where: { tenantId, visitorId: { in: ids } },
          select: { visitorId: true },
          distinct: ['visitorId'],
        }),
      ]);
      const tagIds = [...new Set(tagRows.map((t) => t.tagId))];
      const tags = tagIds.length
        ? await tx.tag.findMany({
            where: { tenantId, id: { in: tagIds }, archivedAt: null },
            select: { id: true, slug: true, label: true },
          })
        : [];
      return { visitors, sessions, entered, tagRows, tags, depts, identities };
    });
    const visitorById = new Map(data.visitors.map((v) => [v.id, v]));
    const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
    const enteredBySession = new Map(data.entered.map((e) => [e.session_id, e.received_at.getTime()]));
    const tagById = new Map(data.tags.map((t) => [t.id, t]));
    const tagsByVisitor = new Map<string, Array<{ id: string; slug: string; label: string }>>();
    for (const r of data.tagRows) {
      const t = tagById.get(r.tagId);
      if (t) tagsByVisitor.set(r.visitorId, [...(tagsByVisitor.get(r.visitorId) ?? []), t]);
    }
    const deptName = new Map(data.depts.map((d) => [d.id, d.name]));
    const identified = new Set(data.identities.map((i) => i.visitorId));

    const items: LiveVisitorItem[] = [];
    for (const c of cores) {
      const v = visitorById.get(c.visitorId);
      if (!v || !c.group) continue;
      const conns = c.online && c.presence ? c.presence.connections : [];
      const sessionItems: LiveSessionItem[] = c.liveSessions.map((s) => {
        const full = sessionById.get(s.id);
        const granted = full?.analyticsConsent === 'granted';
        const sconns = conns.filter((x) => x.sessionId === s.id);
        const enteredAt = enteredBySession.get(s.id) ?? s.startedAt.getTime();
        return {
          sessionId: s.id,
          siteId: s.siteId,
          connections: sconns.length,
          visible: sconns.some((x) => x.visible),
          mostRecent: false,
          browsingHidden: !granted,
          startedAt: granted ? s.startedAt : null,
          currentUrl: granted ? (full?.currentUrl ?? null) : null,
          currentTitle: granted ? (full?.currentTitle ?? null) : null,
          referrerOrigin: granted ? (full?.referrerOrigin ?? null) : null,
          pageEnteredAt: granted ? new Date(enteredAt) : null,
          pageDwellMs: granted ? Math.max(0, now - enteredAt) : null,
        };
      });
      // Most recently active page across tabs: latest page entry (server receipt), then latest connection.
      let recent: LiveSessionItem | null = null;
      let recentAt = -1;
      for (const s of sessionItems) {
        const at =
          enteredBySession.get(s.sessionId) ??
          c.liveSessions.find((x) => x.id === s.sessionId)?.startedAt.getTime() ??
          0;
        const tieBreak = c.presence?.sessionId === s.sessionId ? 0.5 : 0;
        if (at + tieBreak > recentAt) {
          recentAt = at + tieBreak;
          recent = s;
        }
      }
      if (recent) recent.mostRecent = true;
      const shown =
        recent && !recent.browsingHidden ? recent : (sessionItems.find((s) => !s.browsingHidden) ?? null);
      const consenting = c.consenting;
      const country =
        consenting && settings.tracking.locationEnabled
          ? (c.liveSessions.find((s) => s.country)?.country ?? null)
          : null;
      // IP address and network of the most recent visit (stored only while the workspace keeps them).
      const addressed = consenting
        ? ([c.liveSessions.find((s) => s.id === recent?.sessionId), ...c.liveSessions].find(
            (s) => s?.ipAddress,
          ) ?? null)
        : null;
      items.push({
        visitorId: c.visitorId,
        group: c.group,
        displayName: displayNameOf(v),
        anonymousLabel: v.anonymousLabel,
        identity: { verified: identified.has(c.visitorId), identified: !!v.name || !!v.emailCiphertext },
        siteId: c.siteId,
        online: c.online,
        connections: conns.length,
        browsingHidden: !consenting,
        currentUrl: shown?.currentUrl ?? null,
        currentTitle: shown?.currentTitle ?? null,
        referrerOrigin: shown?.referrerOrigin ?? null,
        mostRecentSessionId: recent?.sessionId ?? null,
        pageEnteredAt: shown?.pageEnteredAt ?? null,
        pageDwellMs: shown?.pageDwellMs ?? null,
        arrivedAt: consenting && c.arrivedAt ? new Date(c.arrivedAt) : null,
        timeOnSiteMs: consenting && c.arrivedAt ? Math.max(0, now - c.arrivedAt) : null,
        country,
        ipAddress: addressed?.ipAddress ?? null,
        network: addressed?.network ?? null,
        deviceCategory:
          sessionById.get(c.liveSessions[0]?.id ?? '')?.deviceCategory ?? v.deviceCategory ?? null,
        browser: sessionById.get(recent?.sessionId ?? c.liveSessions[0]?.id ?? '')?.browser ?? null,
        os: sessionById.get(recent?.sessionId ?? c.liveSessions[0]?.id ?? '')?.os ?? null,
        pageViews: shown ? (sessionById.get(shown.sessionId)?.pageViewCount ?? null) : null,
        sessionCount: consenting ? v.visitCount : null,
        lastActivityAt: c.lastActivityAt ? new Date(c.lastActivityAt) : null,
        idle: c.idle,
        tags: tagsByVisitor.get(c.visitorId) ?? [],
        chat: c.chat
          ? {
              id: c.chat.id,
              status: c.chat.status,
              departmentId: c.chat.departmentId,
              departmentName: c.chat.departmentId ? (deptName.get(c.chat.departmentId) ?? null) : null,
              ownerMembershipId: c.chat.ownerMembershipId,
              requestedAt: c.chat.requestedAt,
              waitMs: Math.max(0, now - c.chat.requestedAt.getTime()),
            }
          : null,
        sessions: sessionItems,
      });
    }
    return items;
  }

  // ════════════════════════ Deltas ════════════════════════

  /** Mark visitors whose live projection may have changed; flushed ≤ 1/s per tenant. */
  async markDirty(tenantId: string, visitorIds: string[]): Promise<void> {
    const ids = [...new Set(visitorIds.filter((v) => UUID_RE.test(v)))];
    if (!ids.length) return;
    try {
      await this.redis.client
        .multi()
        .sadd(K.dirty(tenantId), ...ids)
        .sadd(K.dirtyTenants, tenantId)
        .exec();
    } catch (err) {
      this.logger.warn(`markDirty failed: ${(err as Error).message}`);
    }
  }

  /**
   * A workspace that no longer exists (a hook raced its deletion and re-registered it, or Redis outlived the
   * database) fails every flush: drop its monitor state once instead of retrying it every tick forever.
   * Row-level security lets a tenant read its own row, so "not found in its own context" means it is gone.
   */
  private async flushFailed(tenantId: string, err: unknown): Promise<void> {
    const gone =
      (err as { code?: string }).code === 'P2025' &&
      !(await this.db
        .read(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))
        .catch(() => true));
    if (!gone) {
      this.logger.warn(`flush ${tenantId}: ${(err as Error).message}`);
      return;
    }
    const r = this.redis.client;
    await r
      .multi()
      .srem(K.dirtyTenants, tenantId)
      .srem(K.sigTenants, tenantId)
      .srem('pv:tenants', tenantId)
      .del(K.dirty(tenantId), K.sig(tenantId), K.ended(tenantId))
      .exec();
    this.logger.log(`Dropped live-monitor state of workspace ${tenantId}: it no longer exists`);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const r = this.redis.client;
      for (const tenantId of await r.smembers(K.dirtyTenants)) {
        if ((await r.set(K.flushLock(tenantId), '1', 'PX', FLUSH_INTERVAL_MS, 'NX')) !== 'OK') continue;
        await r.srem(K.dirtyTenants, tenantId);
        const ids = (await r.spop(K.dirty(tenantId), FLUSH_BATCH)) as unknown as string[];
        if ((await r.scard(K.dirty(tenantId))) > 0) await r.sadd(K.dirtyTenants, tenantId);
        if (ids?.length) await this.flush(tenantId, ids).catch((err) => this.flushFailed(tenantId, err));
      }
      if (Date.now() - this.lastReconcile >= RECONCILE_MS) {
        this.lastReconcile = Date.now();
        await this.reconcile().catch((err) => this.logger.warn(`reconcile: ${(err as Error).message}`));
      }
    } catch (err) {
      this.logger.warn(`monitor tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private signature(c: Core | undefined, item: LiveVisitorItem | null): Signature {
    return {
      s: (c?.liveSessions.map((s) => s.id) ?? []).sort(),
      a: c?.online && c.presence ? [...new Set(c.presence.connections.map((x) => x.sessionId))].sort() : [],
      i: c?.idle ? 1 : 0,
      d: item?.chat?.departmentId ?? null,
      c: c?.chat ? 1 : 0,
      v: item ? 1 : 0,
    };
  }

  /** Build and publish coalesced `visitor.updated` / `visitor.session.left` frames for dirty visitors. */
  async flush(tenantId: string, visitorIds: string[]): Promise<void> {
    const now = Date.now();
    const asOf = new Date(now);
    const settings = await this.settings(tenantId);
    const cores = await this.resolveCores(tenantId, { visitorIds, includeBrowsing: true });
    const items = new Map(
      (
        await this.hydrate(
          tenantId,
          [...cores.values()].filter((c) => c.group),
          settings,
          now,
        )
      ).map((i) => [i.visitorId, i]),
    );
    const r = this.redis.client;
    const prevRaw = await r.hmget(K.sig(tenantId), ...visitorIds);
    const prev = new Map<string, Signature | null>(
      visitorIds.map((id, i) => [id, this.parseSig(prevRaw[i])]),
    );

    // Disconnected sessions recorded by onPresence, per visitor (in addition to the previous signature).
    const wanted = new Set(visitorIds);
    const endedByVisitor = new Map<string, string[]>();
    for (const m of await r.smembers(K.ended(tenantId))) {
      const [vid, sid] = m.split('|');
      if (wanted.has(vid) && sid) endedByVisitor.set(vid, [...(endedByVisitor.get(vid) ?? []), sid]);
    }
    const leftByVisitor = new Map<string, string[]>();
    const announced: string[] = [];
    // last_seen_at for sessions that left (server time from PostgreSQL).
    const leftIds = new Set<string>();
    for (const id of visitorIds) {
      const p = prev.get(id);
      const nowSessions = new Set(cores.get(id)?.liveSessions.map((s) => s.id) ?? []);
      const left = [...new Set([...(p?.s ?? []), ...(endedByVisitor.get(id) ?? [])])].filter(
        (s) => !nowSessions.has(s),
      );
      leftByVisitor.set(id, left);
      for (const s of left) leftIds.add(s);
      // A recorded disconnect is settled once the session is no longer live (left) or live again.
      for (const s of endedByVisitor.get(id) ?? [])
        if (left.includes(s) || nowSessions.has(s)) announced.push(`${id}|${s}`);
    }
    const lastSeen = leftIds.size
      ? new Map(
          (
            await this.db.read(
              tenantId,
              (tx) =>
                tx.$queryRaw<
                  Array<{ id: string; last_seen_at: Date }>
                >`SELECT id, last_seen_at FROM visitor_sessions WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${[...leftIds]}::uuid[])`,
            )
          ).map((s) => [s.id, s.last_seen_at]),
        )
      : new Map<string, Date>();

    const allRoom = roomFor(tenantId, 'visitor', 'all', 'staff');
    const deptRoom = (d: string) => roomFor(tenantId, 'queue', d, 'staff');
    const sigWrites: Record<string, string> = {};
    const sigDeletes: string[] = [];
    for (const visitorId of visitorIds) {
      const c = cores.get(visitorId);
      const item = items.get(visitorId) ?? null;
      const p = prev.get(visitorId) ?? null;
      const sig = this.signature(c, item);
      for (const sessionId of leftByVisitor.get(visitorId) ?? []) {
        const payload = { visitorId, sessionId, lastSeenAt: lastSeen.get(sessionId) ?? asOf };
        this.realtime.ephemeral(
          AGENT_NS,
          allRoom,
          'visitor.session.left',
          { kind: 'visitor', id: 'all' },
          payload,
          10_000,
        );
        if (p?.d)
          this.realtime.ephemeral(
            AGENT_NS,
            deptRoom(p.d),
            'visitor.session.left',
            { kind: 'queue', id: p.d },
            payload,
            10_000,
          );
      }
      const dept = item?.chat?.departmentId ?? null;
      // Unscoped room: full projection, or null (hidden / department-restricted / gone).
      this.realtime.ephemeral(
        AGENT_NS,
        allRoom,
        'visitor.updated',
        { kind: 'visitor', id: 'all' },
        { visitorId, allowedPatch: dept ? null : item, asOf },
        10_000,
      );
      if (dept)
        this.realtime.ephemeral(
          AGENT_NS,
          deptRoom(dept),
          'visitor.updated',
          { kind: 'queue', id: dept },
          { visitorId, allowedPatch: item, asOf },
          10_000,
        );
      if (p?.d && p.d !== dept)
        this.realtime.ephemeral(
          AGENT_NS,
          deptRoom(p.d),
          'visitor.updated',
          { kind: 'queue', id: p.d },
          { visitorId, allowedPatch: null, asOf },
          10_000,
        );
      // A visitor who was not listed now is, browsing: they arrived on the website (page changes keep them listed
      // through the reconnect grace, so this is once per visit). Dashboards chime and show a desktop notification; the
      // same room already receives the full item, so the summary exposes nothing new.
      if (item && !p?.v && (item.group === 'browsing' || item.group === 'idle'))
        this.realtime.ephemeral(
          AGENT_NS,
          allRoom,
          'visitor.arrived',
          { kind: 'visitor', id: 'all' },
          {
            visitorId,
            displayName: item.displayName,
            country: item.country,
            page: item.currentTitle || item.currentUrl,
            asOf,
          },
          10_000,
        );
      if (c && (c.online || c.chat)) sigWrites[visitorId] = JSON.stringify(sig);
      else sigDeletes.push(visitorId);
    }
    const m = r.multi();
    if (announced.length) m.srem(K.ended(tenantId), ...announced);
    if (Object.keys(sigWrites).length) m.hset(K.sig(tenantId), sigWrites).sadd(K.sigTenants, tenantId);
    if (sigDeletes.length) m.hdel(K.sig(tenantId), ...sigDeletes);
    await m.exec();
  }

  private parseSig(raw: string | null | undefined): Signature | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Signature;
    } catch {
      return null;
    }
  }

  /**
   * Catch changes that have no hook (idle transitions, a second tab closing,
   * lost hooks after a crash) by comparing Redis presence with the last
   * published signature. Runs every 5 s per tenant under a Redis lock.
   */
  private async reconcile(): Promise<void> {
    const r = this.redis.client;
    const tenants = new Set([...(await this.reader.tenants()), ...(await r.smembers(K.sigTenants))]);
    for (const tenantId of tenants) {
      if ((await r.set(K.reconLock(tenantId), '1', 'PX', RECONCILE_MS - 500, 'NX')) !== 'OK') continue;
      const live = await this.reader.liveVisitors(tenantId);
      const scores = new Map(live.map((l) => [l.visitorId, l.score]));
      const presence = await this.reader.read(
        tenantId,
        live.map((l) => l.visitorId),
        scores,
      );
      const sigs = await r.hgetall(K.sig(tenantId));
      const now = Date.now();
      const dirty: string[] = [];
      for (const [visitorId, p] of presence) {
        const sig = this.parseSig(sigs[visitorId]);
        if (!sig) {
          dirty.push(visitorId);
          continue;
        }
        const idle = p.lastActivityAt === null || now - p.lastActivityAt > IDLE_AFTER_MS ? 1 : 0;
        const sessions = [...new Set(p.connections.map((c) => c.sessionId))].sort();
        const known = sig.a ?? [];
        if (idle !== sig.i || sessions.length !== known.length || sessions.some((s, i) => s !== known[i]))
          dirty.push(visitorId);
      }
      for (const [visitorId, raw] of Object.entries(sigs)) {
        if (presence.has(visitorId)) continue;
        const sig = this.parseSig(raw);
        if (!sig || !sig.c || sig.s.length) dirty.push(visitorId);
      }
      if (!Object.keys(sigs).length) await r.srem(K.sigTenants, tenantId);
      await this.markDirty(tenantId, dirty);
    }
  }

  // ════════════════════════ Hooks & consumers ════════════════════════

  private async onPresence(
    tenantId: string,
    visitorId: string,
    sessionId: string,
    event: 'connected' | 'disconnected' | 'gone',
  ): Promise<void> {
    const sessions = new Set<string>(UUID_RE.test(sessionId) ? [sessionId] : []);
    if (event === 'gone') {
      const sig = this.parseSig(await this.redis.client.hget(K.sig(tenantId), visitorId));
      for (const s of sig?.s ?? []) sessions.add(s);
    }
    if (sessions.size && event !== 'connected') {
      // Remember the session so its visitor.session.left is emitted even when it connected and
      // left within one flush window (no signature recorded it yet).
      await this.redis.client
        .multi()
        .sadd(K.ended(tenantId), ...[...sessions].map((sid) => `${visitorId}|${sid}`))
        .expire(K.ended(tenantId), ENDED_TTL_SECONDS)
        .exec();
    }
    if (sessions.size) {
      const ids = [...sessions];
      const seenAt = event === 'gone' ? new Date(Date.now() - env().VISITOR_TIMEOUT_MS) : new Date();
      await this.db.tx(tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE visitor_sessions SET last_seen_at = GREATEST(last_seen_at, ${seenAt})
          WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[]) AND ended_at IS NULL`;
        await tx.$executeRaw`
          UPDATE visitors SET last_seen_at = GREATEST(last_seen_at, ${seenAt})
          WHERE tenant_id = ${tenantId}::uuid AND id = ${visitorId}::uuid`;
      });
    }
    await this.markDirty(tenantId, [visitorId]);
  }

  private async onPageChanged(e: InternalEvent): Promise<void> {
    // Session last_seen_at is written by the ingest transaction; visitors.last_seen_at by the
    // minute-level maintenance touch (avoids hot-row contention with chat admission).
    const visitorId = String(e.payload.visitor_id ?? '');
    if (!UUID_RE.test(visitorId)) return;
    await this.markDirty(e.tenantId, [visitorId]);
  }

  private async onChatEvent(e: InternalEvent): Promise<void> {
    if (e.aggregateType !== 'chat') return;
    const chat = e.payload.chat as { visitor_id?: string } | undefined;
    let visitorId = chat?.visitor_id ?? null;
    if (!visitorId) {
      const row = await this.db.read(e.tenantId, (tx) =>
        tx.chat.findFirst({
          where: { tenantId: e.tenantId, id: e.aggregateId },
          select: { visitorId: true },
        }),
      );
      visitorId = row?.visitorId ?? null;
    }
    if (visitorId) await this.markDirty(e.tenantId, [visitorId]);
  }

  // ════════════════════════ Maintenance (worker, every 60 s) ════════════════════════

  async maintenance(): Promise<void> {
    const liveByTenant = new Map<string, string[]>();
    for (const tenantId of await this.reader.tenants()) {
      try {
        const live = await this.reader.liveVisitors(tenantId);
        const presence = await this.reader.read(
          tenantId,
          live.map((l) => l.visitorId),
          new Map(live.map((l) => [l.visitorId, l.score])),
        );
        const sessionIds = [
          ...new Set(
            [...presence.values()]
              .flatMap((p) => p.connections.map((c) => c.sessionId))
              .filter((s) => UUID_RE.test(s)),
          ),
        ];
        const visitorIds = [...presence.keys()];
        liveByTenant.set(tenantId, sessionIds);
        if (!sessionIds.length) continue;
        // Keep server-time last_seen_at fresh for long-lived connections (heartbeats are Redis-only).
        await this.db.tx(tenantId, async (tx) => {
          await tx.$executeRaw`UPDATE visitor_sessions SET last_seen_at = now() WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${sessionIds}::uuid[]) AND ended_at IS NULL`;
          await tx.$executeRaw`UPDATE visitors SET last_seen_at = now() WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${visitorIds}::uuid[])`;
        });
      } catch (err) {
        this.logger.warn(`touch live sessions ${tenantId}: ${(err as Error).message}`);
      }
    }
    for (const tenantId of await this.db.activeTenantIds()) {
      try {
        const live = liveByTenant.get(tenantId) ?? [];
        const settings = await this.settings(tenantId);
        const retentionDays = Math.max(1, Math.min(3650, settings.tracking.pageEventRetentionDays || 30));
        await this.db.tx(tenantId, async (tx) => {
          // Sessions end after 30 minutes without activity (ch. 25), on server time.
          await tx.$executeRaw`
            UPDATE visitor_sessions SET ended_at = GREATEST(last_seen_at, started_at)
            WHERE id IN (
              SELECT id FROM visitor_sessions
              WHERE tenant_id = ${tenantId}::uuid AND ended_at IS NULL
                AND last_seen_at < now() - make_interval(secs => ${SESSION_INACTIVITY_MS / 1000}::double precision)
                AND NOT (id = ANY(${live}::uuid[]))
              LIMIT 5000)`;
          // Persist only needed browsing history.
          await tx.$executeRaw`
            DELETE FROM page_events WHERE id IN (
              SELECT id FROM page_events WHERE tenant_id = ${tenantId}::uuid
                AND received_at < now() - make_interval(days => ${retentionDays}::int) LIMIT 5000)`;
          await tx.$executeRaw`
            DELETE FROM identity_handoffs WHERE tenant_id = ${tenantId}::uuid AND expires_at < now() - interval '1 day'`;
        });
        const pending = await this.db.read(tenantId, (tx) =>
          tx.job.findMany({
            where: {
              tenantId,
              kind: 'consent_purge',
              state: { in: ['queued', 'running'] },
              runAfter: { lt: new Date(Date.now() - 120_000) },
            },
            select: { id: true },
            take: 50,
          }),
        );
        for (const j of pending) await this.runConsentPurge(tenantId, j.id);
      } catch (err) {
        this.logger.warn(`visitor maintenance ${tenantId}: ${(err as Error).message}`);
      }
    }
  }

  // ════════════════════════ Consent withdrawal purge ════════════════════════

  /** Record a durable purge job inside the consent transaction; enqueue it after commit. */
  async createConsentPurgeJob(
    tx: Tx,
    tenantId: string,
    visitorId: string,
    recordId: string,
    before: Date,
  ): Promise<string> {
    const job = await tx.job.create({
      data: {
        tenantId,
        kind: 'consent_purge',
        dedupeKey: `${visitorId}:${recordId}`,
        state: 'queued',
        payload: { visitorId, before: before.toISOString() },
      },
    });
    return job.id;
  }

  async enqueueConsentPurge(tenantId: string, jobId: string): Promise<void> {
    await this.queues
      .add(
        QUEUES.timers,
        'visitors.consent-purge',
        { tenantId, jobId },
        { jobId: `consent-purge-${jobId}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
      )
      .catch((err) =>
        this.logger.warn(`enqueue consent purge failed (maintenance will retry): ${(err as Error).message}`),
      );
  }

  async runConsentPurge(tenantId: string, jobId: string): Promise<void> {
    await this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; state: string; payload: { visitorId?: string; before?: string } }>
      >`
        SELECT id, state, payload FROM jobs WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid AND kind = 'consent_purge' FOR UPDATE SKIP LOCKED`;
      const job = rows[0];
      if (!job || job.state === 'succeeded' || job.state === 'cancelled') return;
      const visitorId = job.payload?.visitorId;
      const before = job.payload?.before ? new Date(job.payload.before) : new Date();
      if (!visitorId || !UUID_RE.test(visitorId)) {
        await tx.job.update({
          where: { id: jobId },
          data: { state: 'failed', lastErrorCode: 'INVALID_PAYLOAD', attempts: { increment: 1 } },
        });
        return;
      }
      const deleted = await tx.$executeRaw`
        DELETE FROM page_events WHERE tenant_id = ${tenantId}::uuid AND received_at <= ${before}
          AND session_id IN (SELECT id FROM visitor_sessions WHERE tenant_id = ${tenantId}::uuid AND visitor_id = ${visitorId}::uuid)`;
      const cleared = await tx.$executeRaw`
        UPDATE visitor_sessions SET current_url = NULL, current_title = NULL, landing_url = NULL, referrer_origin = NULL, utm = NULL, country = NULL, city = NULL, ip_address = NULL, network = NULL
        WHERE tenant_id = ${tenantId}::uuid AND visitor_id = ${visitorId}::uuid AND analytics_consent <> 'granted'`;
      await tx.job.update({
        where: { id: jobId },
        data: {
          state: 'succeeded',
          attempts: { increment: 1 },
          completedAt: new Date(),
          progress: 100,
          result: { pageEventsDeleted: Number(deleted), sessionsCleared: Number(cleared) },
        },
      });
    });
  }
}
