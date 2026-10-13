import { Injectable } from '@nestjs/common';
import { mergeOrgSettings } from '@talkivio/contracts';
import { createHash } from 'node:crypto';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AppError, badRequest, denied } from '../../common/http';
import { RedisService } from '../../common/redis.service';
import { ROLE_PERMISSIONS } from '../../common/permissions';
import { FactLoader } from './fact-loader';
import { ownershipIntervals, overlapMs, responseTurns, type FactView, type HistorySource, type TurnMessage } from './facts';
import { aggregate, DEFINITIONS_VERSION, describe, MEASURE_KEYS, type MeasureSet, type ReportedMeasure } from './measures';
import { assertDepartmentInScope, scopeKey, visibleInScope, type AgentsQuery, type AnalyticsActor, type ChatsQuery, type InvitationsQuery } from './schemas';
import { distribution, percent, PERCENTILE_METHOD, type Distribution } from './stats';
import { bucketIndexer, buildBuckets, isValidTimeZone, parseBound, timezoneLabel, type Bucket, type GroupBy } from './time';

const DAY_MS = 86_400_000;
/** Synchronous range caps (ch. 51: cap synchronous ranges, queue large exports). */
export const SYNC_LIMITS = { hourDays: 31, dayDays: 400, weekDays: 731, rows: 200_000 };
export const EXPORT_LIMITS = { hourDays: 93, dayDays: 1100, weekDays: 1100, rows: 500_000 };
/** Chats open longer than this before the range start are only included while still open. */
const AGENT_LOOKBACK_MS = 7 * DAY_MS;
export const AGENT_SYNC_DAYS = 93;
export const AGENT_EXPORT_DAYS = 372;
const CACHE_TTL_S = 120;
const LAG_THRESHOLD_MS = 60_000;

export interface ReportLimits {
  hourDays: number;
  dayDays: number;
  weekDays: number;
  rows: number;
}

interface TenantContext {
  timezone: string;
  weekStartsOn: number;
  excludeQuickCancellations: boolean;
}

interface ResolvedRange {
  tz: string;
  from: number;
  to: number;
  groupBy: GroupBy;
  compare: { from: number; to: number } | null;
}

export interface Freshness {
  asOf: Date;
  updatedAt: Date | null;
  sourceWatermark: Date;
  lagMs: number;
  pendingFacts: number;
  status: 'fresh' | 'lagging';
  stale: boolean;
  source: 'facts' | 'raw';
  cached: boolean;
}

export interface SeriesPoint {
  key: string;
  start: Date;
  end: Date;
  unitHours: number;
  measures: MeasureSet;
}

export interface ChatsReport {
  report: 'chats';
  definitionsVersion: number;
  range: { from: Date; to: Date; timezone: string; timezoneLabel: string; utcOffsets: string[]; groupBy: GroupBy; halfOpen: true };
  comparisonRange: { from: Date; to: Date } | null;
  filters: Record<string, string | null>;
  scope: { departmentIds: 'all' | string[] };
  measureKeys: readonly string[];
  measures: Record<string, ReportedMeasure>;
  series: SeriesPoint[];
  freshness: Freshness;
}

interface WatermarkRow {
  pending: number;
  oldest_pending: Date | null;
  facts_updated_at: Date | null;
  facts_count: number;
  offline_count: number;
  offline_max: Date | null;
  invitations_count: number;
  invitations_max: Date | null;
}

const iso = (ms: number) => new Date(ms);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 40);

/**
 * Report queries (ch. 50/51). Measures come from materialized facts by default,
 * or — with `reconcile` — are recomputed exactly from chats/messages/ratings so
 * tests and operators can reconcile the two paths.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly loader: FactLoader,
  ) {}

  // ───────── shared helpers ─────────

  async tenantContext(tenantId: string): Promise<TenantContext> {
    const t = await this.db.read(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, settings: true } }));
    const settings = mergeOrgSettings(t.settings);
    const raw = (t.settings ?? {}) as { analytics?: { excludeQuickCancellations?: unknown } };
    const tz = isValidTimeZone(t.timezone) ? t.timezone : isValidTimeZone(settings.locale.timezone) ? settings.locale.timezone : 'UTC';
    return { timezone: tz, weekStartsOn: settings.locale.weekStartsOn ?? 1, excludeQuickCancellations: raw.analytics?.excludeQuickCancellations === true };
  }

  resolveRange(
    q: { from: string; to: string; timezone?: string; groupBy?: GroupBy; compare?: 'previous' | 'none' | 'custom'; compareFrom?: string; compareTo?: string },
    ctx: TenantContext,
    limits: ReportLimits,
  ): ResolvedRange {
    const tz = q.timezone ?? ctx.timezone;
    if (!isValidTimeZone(tz)) throw badRequest('Unknown timezone', { timezone: ['Use an IANA timezone such as Europe/London'] });
    const from = parseBound(q.from, tz);
    const to = parseBound(q.to, tz);
    if (from === null) throw badRequest('Invalid start', { from: ['Use YYYY-MM-DD or an RFC 3339 timestamp with offset'] });
    if (to === null) throw badRequest('Invalid end', { to: ['Use YYYY-MM-DD or an RFC 3339 timestamp with offset'] });
    if (!(to > from)) throw badRequest('The range end must be after its start', { to: ['Must be after from (the range is half-open: [from, to))'] });
    const groupBy = q.groupBy ?? 'day';
    const maxDays = groupBy === 'hour' ? limits.hourDays : groupBy === 'week' ? limits.weekDays : limits.dayDays;
    if (to - from > maxDays * DAY_MS) throw badRequest(`Ranges grouped by ${groupBy} are limited to ${maxDays} days here; queue an export for longer ranges`, { to: [`Maximum ${maxDays} days`] });
    let compare: ResolvedRange['compare'] = null;
    if ((q.compare ?? 'previous') === 'previous') compare = { from: from - (to - from), to: from };
    else if (q.compare === 'custom') {
      const cf = q.compareFrom ? parseBound(q.compareFrom, tz) : null;
      const ct = q.compareTo ? parseBound(q.compareTo, tz) : null;
      if (cf === null || ct === null || !(ct > cf)) throw badRequest('Custom comparison needs compare_from < compare_to', { compare_from: ['Required for compare=custom'] });
      if (ct - cf > maxDays * DAY_MS) throw badRequest('Comparison range is too long', { compare_to: [`Maximum ${maxDays} days`] });
      compare = { from: cf, to: ct };
    }
    return { tz, from, to, groupBy, compare };
  }

  private tooMany(): AppError {
    return badRequest('This range contains too many chats for an interactive report. Narrow the filters or queue a CSV export.', { from: ['Range too large'] });
  }

  private async watermark(tx: Tx, tenantId: string, from: number, to: number): Promise<WatermarkRow> {
    const f = iso(from).toISOString();
    const t = iso(to).toISOString();
    const [row] = await tx.$queryRaw<WatermarkRow[]>`
      SELECT p.pending, p.oldest_pending, fx.facts_updated_at, fx.facts_count, o.offline_count, o.offline_max, i.invitations_count, i.invitations_max
        FROM (SELECT count(*)::int AS pending, min(c.updated_at) AS oldest_pending
                FROM chats c LEFT JOIN metric_chat_facts f ON f.tenant_id = c.tenant_id AND f.chat_id = c.id
               WHERE c.tenant_id = ${tenantId}::uuid AND c.is_preview = false
                 AND c.requested_at >= ${f}::timestamptz AND c.requested_at < ${t}::timestamptz
                 AND (f.chat_id IS NULL OR f.source_version < c.version + c.next_seq)) p,
             (SELECT max(updated_at) AS facts_updated_at, count(*)::int AS facts_count
                FROM metric_chat_facts WHERE tenant_id = ${tenantId}::uuid
                 AND requested_at >= ${f}::timestamptz AND requested_at < ${t}::timestamptz) fx,
             (SELECT count(*)::int AS offline_count, max(updated_at) AS offline_max
                FROM offline_submissions WHERE tenant_id = ${tenantId}::uuid
                 AND created_at >= ${f}::timestamptz AND created_at < ${t}::timestamptz) o,
             (SELECT count(*)::int AS invitations_count, max(displayed_at) AS invitations_max
                FROM invitations WHERE tenant_id = ${tenantId}::uuid
                 AND displayed_at >= ${f}::timestamptz AND displayed_at < ${t}::timestamptz) i`;
    return row;
  }

  private freshnessFrom(w: WatermarkRow, asOf: Date, source: 'facts' | 'raw', cached: boolean): Freshness {
    const pending = source === 'raw' ? 0 : w.pending;
    const watermark = pending > 0 && w.oldest_pending ? w.oldest_pending : asOf;
    const lagMs = Math.max(0, asOf.getTime() - watermark.getTime());
    return {
      asOf,
      updatedAt: w.facts_updated_at,
      sourceWatermark: watermark,
      lagMs,
      pendingFacts: pending,
      status: lagMs > LAG_THRESHOLD_MS ? 'lagging' : 'fresh',
      stale: lagMs > LAG_THRESHOLD_MS,
      source,
      cached,
    };
  }

  // ───────── GET /analytics/chats ─────────

  async chatsReport(actor: AnalyticsActor, q: Omit<ChatsQuery, 'reconcile'> & { reconcile?: boolean }, limits: ReportLimits = SYNC_LIMITS): Promise<ChatsReport> {
    assertDepartmentInScope(actor, q.departmentId);
    assertDepartmentInScope(actor, q.currentDepartmentId);
    const ctx = await this.tenantContext(actor.tenantId);
    const range = this.resolveRange(q, ctx, limits);
    const spanFrom = range.compare ? Math.min(range.compare.from, range.from) : range.from;
    const spanTo = range.compare ? Math.max(range.compare.to, range.to) : range.to;
    const source: 'facts' | 'raw' = q.reconcile ? 'raw' : 'facts';
    const w = await this.db.read(actor.tenantId, (tx) => this.watermark(tx, actor.tenantId, spanFrom, spanTo));
    const filters = {
      siteId: q.siteId ?? null,
      departmentId: q.departmentId ?? null,
      currentDepartmentId: q.currentDepartmentId ?? null,
      agentId: q.agentId ?? null,
      tagId: q.tagId ?? null,
    };
    const cacheKey =
      source === 'facts'
        ? `rd:analytics:report:${actor.tenantId}:${hash({ s: scopeKey(actor.departmentScope), f: filters, r: range, w, x: ctx.excludeQuickCancellations, v: DEFINITIONS_VERSION })}`
        : null;
    if (cacheKey) {
      const hit = await this.redis.client.get(cacheKey).catch(() => null);
      if (hit) {
        const cached = JSON.parse(hit) as ChatsReport;
        const asOf = new Date();
        return { ...cached, freshness: this.freshnessFrom(w, asOf, source, true) };
      }
    }

    const [main, previous] = await this.db.read(actor.tenantId, async (tx) => {
      const load = (from: number, to: number) =>
        (source === 'raw' ? this.loader.rawFacts(tx, actor.tenantId, iso(from), iso(to), limits.rows) : this.loader.storedFacts(tx, actor.tenantId, iso(from), iso(to), limits.rows)).catch((err) => {
          if (err instanceof RangeError) throw this.tooMany();
          throw err;
        });
      const visible = this.factFilter(actor, filters);
      const a = (await load(range.from, range.to)).filter(visible);
      const b = range.compare ? (await load(range.compare.from, range.compare.to)).filter(visible) : null;
      return [a, b] as const;
    });
    const sideApplicable = !filters.agentId && !filters.tagId;
    const offline = sideApplicable ? await this.offlineTimes(actor, spanFrom, spanTo, filters) : null;
    const displayed = sideApplicable ? await this.invitationDisplayTimes(actor, spanFrom, spanTo, filters) : null;
    const inRange = (xs: number[] | null, from: number, to: number) => (xs ? xs.filter((t) => t >= from && t < to) : null);

    const buckets = buildBuckets(range.from, range.to, range.tz, range.groupBy, ctx.weekStartsOn);
    const indexOf = bucketIndexer(buckets);
    const perBucket = buckets.map(() => ({ facts: [] as FactView[], offline: 0, displayed: 0 }));
    for (const f of main) {
      const i = indexOf(f.requestedAt);
      if (i >= 0) perBucket[i].facts.push(f);
    }
    for (const t of inRange(offline, range.from, range.to) ?? []) {
      const i = indexOf(t);
      if (i >= 0) perBucket[i].offline++;
    }
    for (const t of inRange(displayed, range.from, range.to) ?? []) {
      const i = indexOf(t);
      if (i >= 0) perBucket[i].displayed++;
    }
    const opts = { excludeQuickCancellations: ctx.excludeQuickCancellations };
    const totals = aggregate(main, inRange(offline, range.from, range.to)?.length ?? null, inRange(displayed, range.from, range.to)?.length ?? null, opts);
    const prevTotals =
      previous && range.compare
        ? aggregate(previous, inRange(offline, range.compare.from, range.compare.to)?.length ?? null, inRange(displayed, range.compare.from, range.compare.to)?.length ?? null, opts)
        : null;
    const tzl = timezoneLabel(range.tz, range.from, range.to);
    const report: ChatsReport = {
      report: 'chats',
      definitionsVersion: DEFINITIONS_VERSION,
      range: { from: iso(range.from), to: iso(range.to), timezone: range.tz, timezoneLabel: tzl.label, utcOffsets: tzl.offsets, groupBy: range.groupBy, halfOpen: true },
      comparisonRange: range.compare ? { from: iso(range.compare.from), to: iso(range.compare.to) } : null,
      filters,
      scope: { departmentIds: actor.departmentScope },
      measureKeys: MEASURE_KEYS,
      measures: describe(totals, prevTotals),
      series: buckets.map((b: Bucket, i) => ({
        key: b.key,
        start: iso(b.start),
        end: iso(b.end),
        unitHours: b.unitHours,
        measures: aggregate(perBucket[i].facts, offline ? perBucket[i].offline : null, displayed ? perBucket[i].displayed : null, opts),
      })),
      freshness: this.freshnessFrom(w, new Date(), source, false),
    };
    if (cacheKey) await this.redis.client.set(cacheKey, JSON.stringify(report), 'EX', CACHE_TTL_S).catch(() => undefined);
    return report;
  }

  private factFilter(actor: AnalyticsActor, f: { siteId: string | null; departmentId: string | null; currentDepartmentId: string | null; agentId: string | null; tagId: string | null }) {
    return (x: FactView) =>
      visibleInScope(actor.departmentScope, [x.acquisitionDepartmentId, x.departmentId]) &&
      (!f.siteId || x.siteId === f.siteId) &&
      (!f.departmentId || x.acquisitionDepartmentId === f.departmentId) &&
      (!f.currentDepartmentId || x.departmentId === f.currentDepartmentId) &&
      (!f.agentId || x.agentIds.includes(f.agentId)) &&
      (!f.tagId || x.tagIds.includes(f.tagId));
  }

  /** Offline submissions are a separate population (by created_at). */
  private async offlineTimes(actor: AnalyticsActor, from: number, to: number, f: { siteId: string | null; departmentId: string | null; currentDepartmentId: string | null }): Promise<number[]> {
    const dept = f.departmentId ?? f.currentDepartmentId;
    const rows = await this.db.read(actor.tenantId, (tx) =>
      tx.offlineSubmission.findMany({
        where: { tenantId: actor.tenantId, createdAt: { gte: iso(from), lt: iso(to) }, ...(f.siteId ? { siteId: f.siteId } : {}), ...(dept ? { departmentId: dept } : {}) },
        select: { createdAt: true, departmentId: true },
      }),
    );
    return rows.filter((r) => visibleInScope(actor.departmentScope, [r.departmentId])).map((r) => r.createdAt.getTime());
  }

  private async invitationDisplayTimes(actor: AnalyticsActor, from: number, to: number, f: { siteId: string | null; departmentId: string | null; currentDepartmentId: string | null }): Promise<number[]> {
    const dept = f.departmentId ?? f.currentDepartmentId;
    const rows = await this.db.read(actor.tenantId, (tx) =>
      tx.$queryRaw<Array<{ displayed_at: Date; department_id: string | null; site_id: string | null }>>`
        SELECT i.displayed_at, i.department_id, s.site_id
          FROM invitations i LEFT JOIN visitor_sessions s ON s.tenant_id = i.tenant_id AND s.id = i.session_id
         WHERE i.tenant_id = ${actor.tenantId}::uuid
           AND i.displayed_at >= ${iso(from).toISOString()}::timestamptz AND i.displayed_at < ${iso(to).toISOString()}::timestamptz`,
    );
    return rows
      .filter((r) => visibleInScope(actor.departmentScope, [r.department_id]) && (!f.siteId || r.site_id === f.siteId) && (!dept || r.department_id === dept))
      .map((r) => r.displayed_at.getTime());
  }

  // ───────── GET /analytics/agents ─────────

  async agentsReport(actor: AnalyticsActor, q: AgentsQuery, limits: ReportLimits = SYNC_LIMITS) {
    if (!actor.permissions.has('analytics.agents')) throw denied();
    assertDepartmentInScope(actor, q.departmentId);
    const ctx = await this.tenantContext(actor.tenantId);
    const range = this.resolveRange({ ...q, groupBy: 'day', compare: 'none' }, ctx, { ...limits, dayDays: limits.dayDays >= EXPORT_LIMITS.dayDays ? AGENT_EXPORT_DAYS : AGENT_SYNC_DAYS });
    const from = range.from;
    const to = range.to;
    const now = Date.now();
    const end = Math.min(to, now);
    const scope = actor.departmentScope;

    const data = await this.db.read(actor.tenantId, async (tx) => {
      const members = await tx.membership.findMany({
        where: { tenantId: actor.tenantId, archivedAt: null, ...(q.agentId ? { id: q.agentId } : {}) },
        include: { user: { select: { displayName: true } }, departments: { select: { departmentId: true, canServe: true, canMonitor: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const chats = await tx.chat.findMany({
        where: {
          tenantId: actor.tenantId,
          isPreview: false,
          requestedAt: { lt: iso(to) },
          AND: [{ OR: [{ requestedAt: { gte: iso(from - AGENT_LOOKBACK_MS) } }, { status: { not: 'closed' } }] }, { OR: [{ closedAt: null }, { closedAt: { gte: iso(from) } }] }],
          ...(q.siteId ? { siteId: q.siteId } : {}),
        },
        select: { id: true, departmentId: true, acquisitionDepartmentId: true, ownerMembershipId: true, requestedAt: true, closedAt: true, status: true },
        take: limits.rows + 1,
      });
      if (chats.length > limits.rows) throw this.tooMany();
      const visible = chats.filter(
        (c) =>
          visibleInScope(scope, [c.acquisitionDepartmentId, c.departmentId]) && (!q.departmentId || c.departmentId === q.departmentId || c.acquisitionDepartmentId === q.departmentId),
      );
      const ids = visible.map((c) => c.id);
      const history: Array<HistorySource & { chatId: string }> = [];
      const collabs: Array<{ chatId: string; membershipId: string | null; joinedAt: Date; leftAt: Date | null }> = [];
      const messages: Array<{ chat_id: string; sent_at: Date; sender_type: string; sender_membership_id: string | null }> = [];
      const ratings: Array<{ chatId: string; rating: 'good' | 'bad' }> = [];
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        history.push(
          ...(await tx.assignmentHistory.findMany({
            where: { tenantId: actor.tenantId, chatId: { in: part } },
            select: { chatId: true, reason: true, previousOwnerId: true, nextOwnerId: true, occurredAt: true },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          })),
        );
        collabs.push(
          ...(await tx.chatParticipant.findMany({
            where: { tenantId: actor.tenantId, chatId: { in: part }, role: 'collaborator', actorType: 'agent' },
            select: { chatId: true, membershipId: true, joinedAt: true, leftAt: true },
          })),
        );
        messages.push(
          ...(await tx.$queryRaw<typeof messages>`
            SELECT chat_id, sent_at, sender_type::text AS sender_type, sender_membership_id
              FROM messages
             WHERE tenant_id = ${actor.tenantId}::uuid AND chat_id = ANY(${part}::uuid[])
               AND visibility = 'public' AND sent_at < ${iso(to).toISOString()}::timestamptz
               AND (sender_type = 'visitor' OR (sender_type = 'agent' AND automated = false))
             ORDER BY chat_id, seq`),
        );
        ratings.push(...(await tx.chatRating.findMany({ where: { tenantId: actor.tenantId, chatId: { in: part } }, select: { chatId: true, rating: true } })));
      }
      const intervals = await tx.availabilityInterval.findMany({
        where: { tenantId: actor.tenantId, status: 'online', startedAt: { lt: iso(to) }, OR: [{ endedAt: null }, { endedAt: { gt: iso(from) } }] },
        select: { membershipId: true, startedAt: true, endedAt: true },
      });
      return { members, visible, history, collabs, messages, ratings, intervals };
    });

    const inScopeMember = (m: (typeof data.members)[number]) => {
      const serves = ROLE_PERMISSIONS[m.role].has('chats.serve');
      if (q.departmentId) return m.departments.some((d) => d.departmentId === q.departmentId && d.canServe);
      if (scope === 'all') return serves;
      return m.departments.some((d) => d.canServe && scope.includes(d.departmentId));
    };
    const members = data.members.filter(inScopeMember);
    const memberIds = new Set(members.map((m) => m.id));
    const chatById = new Map(data.visible.map((c) => [c.id, c]));
    const historyBy = new Map<string, HistorySource[]>();
    for (const h of data.history) historyBy.set(h.chatId, [...(historyBy.get(h.chatId) ?? []), h]);
    const ratingBy = new Map(data.ratings.map((r) => [r.chatId, r.rating]));

    interface Acc {
      handled: Set<string>;
      ownedMs: number;
      occupancy: Array<{ from: number; to: number }>;
      replies: number;
      replied: Set<string>;
      firstResponses: number[];
      turns: number[];
      good: number;
      bad: number;
      transfersIn: number;
      transfersOut: number;
    }
    const acc = new Map<string, Acc>();
    const get = (id: string): Acc => {
      let a = acc.get(id);
      if (!a) {
        a = { handled: new Set(), ownedMs: 0, occupancy: [], replies: 0, replied: new Set(), firstResponses: [], turns: [], good: 0, bad: 0, transfersIn: 0, transfersOut: 0 };
        acc.set(id, a);
      }
      return a;
    };
    const window = [{ from, to: end }];
    const distinctHandled = new Set<string>();

    for (const c of data.visible) {
      const hist = historyBy.get(c.id) ?? [];
      for (const o of ownershipIntervals(hist, c.closedAt)) {
        if (!memberIds.has(o.membershipId)) continue;
        const span = { from: o.from, to: o.to ?? now };
        const ms = overlapMs(span, window);
        const a = get(o.membershipId);
        if (span.to > from && span.from < to) {
          a.handled.add(c.id);
          distinctHandled.add(c.id);
        }
        a.ownedMs += ms;
        a.occupancy.push(span);
      }
      for (const h of hist) {
        const at = h.occurredAt.getTime();
        if (at < from || at >= to || !(h.reason === 'transfer_accepted' || h.reason === 'forced_transfer')) continue;
        if (h.nextOwnerId && memberIds.has(h.nextOwnerId)) get(h.nextOwnerId).transfersIn++;
        if (h.previousOwnerId && memberIds.has(h.previousOwnerId)) get(h.previousOwnerId).transfersOut++;
      }
      const rating = ratingBy.get(c.id);
      const requested = c.requestedAt.getTime();
      if (rating && c.ownerMembershipId && memberIds.has(c.ownerMembershipId) && requested >= from && requested < to) {
        if (rating === 'good') get(c.ownerMembershipId).good++;
        else get(c.ownerMembershipId).bad++;
      }
    }
    for (const p of data.collabs) {
      if (!p.membershipId || !memberIds.has(p.membershipId)) continue;
      const c = chatById.get(p.chatId);
      const endAt = p.leftAt?.getTime() ?? c?.closedAt?.getTime() ?? now;
      get(p.membershipId).occupancy.push({ from: p.joinedAt.getTime(), to: endAt });
    }
    const byChat = new Map<string, TurnMessage[]>();
    for (const m of data.messages) {
      const kind = m.sender_type === 'visitor' ? 'visitor' : 'human';
      const at = m.sent_at.getTime();
      byChat.set(m.chat_id, [...(byChat.get(m.chat_id) ?? []), { at, kind, authorId: m.sender_membership_id }]);
      if (kind === 'human' && m.sender_membership_id && memberIds.has(m.sender_membership_id) && at >= from && at < to) {
        const a = get(m.sender_membership_id);
        a.replies++;
        a.replied.add(m.chat_id);
      }
    }
    for (const [chatId, msgs] of byChat) {
      const c = chatById.get(chatId);
      const firstHuman = msgs.find((m) => m.kind === 'human');
      if (c && firstHuman?.authorId && memberIds.has(firstHuman.authorId)) {
        const requested = c.requestedAt.getTime();
        if (requested >= from && requested < to) get(firstHuman.authorId).firstResponses.push((firstHuman.at - requested) / 1000);
      }
      for (const t of responseTurns(msgs)) {
        if (t.end < from || t.end >= to || !t.authorId || !memberIds.has(t.authorId)) continue;
        get(t.authorId).turns.push((t.end - t.start) / 1000);
      }
    }
    const onlineBy = new Map<string, Array<{ from: number; to: number }>>();
    for (const iv of data.intervals) {
      if (!memberIds.has(iv.membershipId)) continue;
      const s = Math.max(iv.startedAt.getTime(), from);
      const e = Math.min(iv.endedAt?.getTime() ?? now, end);
      if (e > s) onlineBy.set(iv.membershipId, [...(onlineBy.get(iv.membershipId) ?? []), { from: s, to: e }]);
    }

    const rows = members.map((m) => {
      const a = get(m.id);
      const online = onlineBy.get(m.id) ?? [];
      const onlineMs = online.reduce((s, w) => s + (w.to - w.from), 0);
      const availableSlotSeconds = Math.round((m.capacity * onlineMs) / 1000);
      const occupiedSlotSeconds = Math.round(a.occupancy.reduce((s, o) => s + overlapMs(o, online), 0) / 1000);
      const raw = availableSlotSeconds > 0 ? occupiedSlotSeconds / availableSlotSeconds : null;
      const violation = raw !== null && raw > 1;
      return {
        membershipId: m.id,
        displayName: m.displayName || m.user.displayName,
        role: m.role,
        enabled: m.enabled,
        capacity: m.capacity,
        departmentIds: m.departments.filter((d) => d.canServe && (scope === 'all' || scope.includes(d.departmentId))).map((d) => d.departmentId),
        handledChats: a.handled.size,
        ownedSeconds: Math.round(a.ownedMs / 1000),
        replies: a.replies,
        repliedChats: a.replied.size,
        transfersIn: a.transfersIn,
        transfersOut: a.transfersOut,
        firstResponses: a.firstResponses.length,
        firstResponseTime: this.dist(a.firstResponses),
        responseTime: this.dist(a.turns),
        onlineSeconds: Math.round(onlineMs / 1000),
        availableSlotSeconds,
        occupiedSlotSeconds,
        utilization: {
          value: raw === null ? null : Math.round(Math.min(raw, 1) * 10000) / 100,
          raw: raw === null ? null : Math.round(raw * 10000) / 100,
          numerator: occupiedSlotSeconds,
          denominator: availableSlotSeconds,
          unit: 'percent',
          cappedForReporting: violation,
          invariantViolation: violation,
        },
        ratings: { good: a.good, bad: a.bad, csat: { value: percent(a.good, a.good + a.bad), numerator: a.good, denominator: a.good + a.bad, n: a.good + a.bad } },
      };
    });
    const sum = (k: 'handledChats' | 'replies' | 'firstResponses' | 'onlineSeconds' | 'availableSlotSeconds' | 'occupiedSlotSeconds' | 'ownedSeconds') => rows.reduce((s, r) => s + r[k], 0);
    const totalsAvail = sum('availableSlotSeconds');
    const tzl = timezoneLabel(range.tz, from, to);
    return {
      report: 'agents' as const,
      definitionsVersion: DEFINITIONS_VERSION,
      range: { from: iso(from), to: iso(to), timezone: range.tz, timezoneLabel: tzl.label, halfOpen: true },
      filters: { departmentId: q.departmentId ?? null, agentId: q.agentId ?? null, siteId: q.siteId ?? null },
      scope: { departmentIds: scope },
      definitions: {
        handledChats: 'Distinct chats with an ownership interval (from assignment history) overlapping the range. Sums across agents can exceed distinct tenant chats.',
        ownedSeconds: 'Wall-clock seconds of ownership intervals inside the range, attributed to the interval owner (queue time excluded).',
        replies: 'Human public messages authored by the agent in the range (attributed to the actual author, also after transfers).',
        firstResponseTime: 'For chats requested in the range: first human public reply − requested_at, attributed to the reply author.',
        responseTime: 'Between turns: first visitor message of a burst → next human public reply (author), replies in range.',
        utilization: 'Occupied capacity slot-seconds (owned + collaborating chats, during online intervals) ÷ capacity × online seconds. Capped at 100 % for reporting; invariant_violation flags raw values above 100 %.',
        percentileMethod: PERCENTILE_METHOD,
        capacity: 'Current configured capacity (capacity history is not recorded).',
      },
      agents: rows,
      totals: {
        agents: rows.length,
        distinctChatsHandled: distinctHandled.size,
        handledChatsSum: sum('handledChats'),
        replies: sum('replies'),
        firstResponses: sum('firstResponses'),
        ownedSeconds: sum('ownedSeconds'),
        onlineSeconds: sum('onlineSeconds'),
        availableSlotSeconds: totalsAvail,
        occupiedSlotSeconds: sum('occupiedSlotSeconds'),
        utilization: percent(Math.min(sum('occupiedSlotSeconds'), totalsAvail), totalsAvail),
      },
      freshness: { asOf: new Date(), source: 'raw' as const, sourceWatermark: new Date(), lagMs: 0, stale: false },
    };
  }

  private dist(values: number[]): Distribution & { unit: 'seconds'; nullPolicy: string } {
    return { ...distribution(values), unit: 'seconds', nullPolicy: 'null_when_no_samples' };
  }

  // ───────── GET /analytics/invitations ─────────

  async invitationsReport(actor: AnalyticsActor, q: InvitationsQuery, limits: ReportLimits = SYNC_LIMITS) {
    assertDepartmentInScope(actor, q.departmentId);
    const ctx = await this.tenantContext(actor.tenantId);
    const range = this.resolveRange({ ...q, groupBy: 'day', compare: 'none' }, ctx, limits);
    const rows = await this.db.read(actor.tenantId, async (tx) => {
      const list = await tx.$queryRaw<
        Array<{ id: string; campaign_id: string; state: string; displayed_at: Date | null; accepted_chat_id: string | null; department_id: string | null; site_id: string | null; served: boolean }>
      >`
        SELECT i.id, i.campaign_id, i.state::text AS state, i.displayed_at, i.accepted_chat_id, i.department_id, s.site_id,
               (i.accepted_chat_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM messages m
                   WHERE m.tenant_id = i.tenant_id AND m.chat_id = i.accepted_chat_id
                     AND m.sender_type = 'agent' AND m.visibility = 'public' AND m.automated = false)) AS served
          FROM invitations i LEFT JOIN visitor_sessions s ON s.tenant_id = i.tenant_id AND s.id = i.session_id
         WHERE i.tenant_id = ${actor.tenantId}::uuid
           AND i.created_at >= ${iso(range.from).toISOString()}::timestamptz AND i.created_at < ${iso(range.to).toISOString()}::timestamptz
         LIMIT ${limits.rows + 1}`;
      if (list.length > limits.rows) throw this.tooMany();
      const campaignIds = [...new Set(list.map((r) => r.campaign_id))];
      const names = campaignIds.length ? await tx.trigger.findMany({ where: { tenantId: actor.tenantId, id: { in: campaignIds } }, select: { id: true, name: true } }) : [];
      return { list, names: new Map(names.map((n) => [n.id, n.name])) };
    });
    const visible = rows.list.filter(
      (r) =>
        visibleInScope(actor.departmentScope, [r.department_id]) &&
        (!q.siteId || r.site_id === q.siteId) &&
        (!q.campaignId || r.campaign_id === q.campaignId) &&
        (!q.departmentId || r.department_id === q.departmentId),
    );
    const funnel = (xs: typeof visible) => {
      const eligible = new Set(xs.map((x) => x.id));
      const displayed = new Set(xs.filter((x) => x.displayed_at || x.state === 'displayed' || x.state === 'accepted').map((x) => x.id));
      const accepted = new Set(xs.filter((x) => x.accepted_chat_id || x.state === 'accepted').map((x) => x.id));
      const served = new Set(xs.filter((x) => x.served).map((x) => x.id));
      return {
        eligible: eligible.size,
        displayed: displayed.size,
        accepted: accepted.size,
        served: served.size,
        displayRate: percent(displayed.size, eligible.size),
        acceptanceRate: percent(accepted.size, displayed.size),
        serveRate: percent(served.size, accepted.size),
      };
    };
    const byCampaign = new Map<string, typeof visible>();
    for (const r of visible) byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r]);
    const tzl = timezoneLabel(range.tz, range.from, range.to);
    return {
      report: 'invitations' as const,
      definitionsVersion: DEFINITIONS_VERSION,
      range: { from: iso(range.from), to: iso(range.to), timezone: range.tz, timezoneLabel: tzl.label, halfOpen: true },
      filters: { siteId: q.siteId ?? null, campaignId: q.campaignId ?? null, departmentId: q.departmentId ?? null },
      scope: { departmentIds: actor.departmentScope },
      definitions: {
        population: 'Distinct invitation ids created (eligible) in [from, to).',
        displayed: 'Eligible invitations shown to the visitor (displayed_at set).',
        accepted: 'Displayed invitations the visitor accepted into a chat.',
        served: 'Accepted invitations whose chat has at least one human agent public message.',
        rates: 'display_rate = displayed ÷ eligible; acceptance_rate = accepted ÷ displayed; serve_rate = served ÷ accepted (null when the denominator is zero).',
      },
      totals: funnel(visible),
      campaigns: [...byCampaign.entries()].map(([campaignId, xs]) => ({ campaignId, name: rows.names.get(campaignId) ?? null, ...funnel(xs) })).sort((a, b) => b.eligible - a.eligible),
      freshness: { asOf: new Date(), source: 'raw' as const, sourceWatermark: new Date(), lagMs: 0, stale: false },
    };
  }
}

export type AgentsReport = Awaited<ReturnType<AnalyticsService['agentsReport']>>;
export type InvitationsReport = Awaited<ReturnType<AnalyticsService['invitationsReport']>>;
