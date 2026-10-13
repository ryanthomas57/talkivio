import { Injectable } from '@nestjs/common';
import type { Department, EmergencyClosure, Schedule, ScheduleException } from '@prisma/client';
import {
  isEffectiveScheduleOpen,
  localLabel,
  mergeOrgSettings,
  nextScheduleOpening,
  normalizeWeeklyIntervals,
  type EffectiveSchedule,
  type TimeRange,
} from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { PresenceService } from '../../core/presence.service';
import { ROLE_PERMISSIONS } from '../../common/permissions';

export type AvailabilityState = 'available' | 'busy' | 'offline';
export type AvailabilityReason = 'open' | 'closed_hours' | 'emergency_closure' | 'no_agents' | 'at_capacity' | 'queue_full' | 'disabled';

/** Which schedule governed a decision (snapshotted with admission decisions, ch. 22). */
export interface ScheduleSnapshot {
  id: string;
  version: number;
  timezone: string;
  /** department | site | tenant_default — where the schedule was inherited from. */
  source: 'department' | 'site' | 'tenant_default';
}

export interface ScopeAvailability {
  state: AvailabilityState;
  reason: AvailabilityReason;
  /** RFC3339 instant when the scope next opens (null when open, unknown or never). */
  nextOpenAt: Date | null;
  /** Human local representation of `nextOpenAt` in the governing timezone. */
  nextOpenLocal: string | null;
  timezone: string | null;
  acceptsQueue: boolean;
  eligibleAgentCount: number;
  queued: number;
  schedule: ScheduleSnapshot | null;
  emergencyClosureId: string | null;
  /** Queue overflow (ch. 23/31): seconds after which waiting visitors are offered the offline form (null = disabled). */
  maxWaitSeconds: number | null;
  longestWaitSeconds: number;
  waitExceeded: boolean;
  fallbackDepartmentId: string | null;
}

export interface DepartmentAvailability extends ScopeAvailability {
  id: string;
  label: string;
}

export interface SiteAvailability {
  siteId: string;
  state: AvailabilityState;
  reason: AvailabilityReason;
  nextOpenAt: Date | null;
  nextOpenLocal: string | null;
  acceptsQueue: boolean;
  eligibleAgentCount: number;
  /** True when the account (no-department) scope is closed and the site is reachable only through a department. */
  requiresDepartment: boolean;
  /** The no-department scope (site schedule, else tenant default). */
  account: ScopeAvailability;
  departments: DepartmentAvailability[];
  asOf: Date;
}

export function toEffectiveSchedule(s: Schedule & { exceptions?: ScheduleException[] }): EffectiveSchedule {
  return {
    timezone: s.timezone,
    days: normalizeWeeklyIntervals(s.weeklyIntervals),
    exceptions: (s.exceptions ?? []).map((e) => ({ date: e.localDate.toISOString().slice(0, 10), intervals: (e.intervals as unknown as TimeRange[]) ?? [] })),
  };
}

/** Exceptions older than this many days before `at` cannot affect the current state or next opening. */
const EXCEPTION_LOOKBACK_DAYS = 3;

const SERVING_ROLES = (Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>).filter((r) => ROLE_PERMISSIONS[r].has('chats.serve'));
const RANK: Record<AvailabilityState, number> = { offline: 0, busy: 1, available: 2 };

interface LoadedSchedule {
  id: string;
  version: number;
  timezone: string;
  eff: EffectiveSchedule;
}

/** Closure applicability: tenant-wide (no site, no department), one site, or one department. */
export function closureApplies(c: Pick<EmergencyClosure, 'siteId' | 'departmentId'>, siteId: string, departmentId: string | null): boolean {
  if (c.departmentId) return c.departmentId === departmentId;
  return c.siteId === null || c.siteId === siteId;
}

/**
 * Effective availability (ch. 22): emergency closure → schedule (department >
 * site > tenant default) → live eligible agents → capacity / queue admission.
 * Declared status alone never makes a site available; an agent must be online,
 * connected and have a free slot.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: TenantDb,
    private readonly presence: PresenceService,
  ) {}

  async forSite(tenantId: string, siteId: string, at = new Date()): Promise<SiteAvailability> {
    return this.db.read(tenantId, (tx) => this.compute(tx, tenantId, siteId, at));
  }

  async compute(tx: Tx, tenantId: string, siteId: string, at = new Date()): Promise<SiteAvailability> {
    const [site, tenant, departments, closures, members, connected] = await Promise.all([
      tx.site.findUniqueOrThrow({ where: { id: siteId } }),
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } }),
      tx.department.findMany({ where: { tenantId, enabled: true, archivedAt: null }, include: { members: true }, orderBy: { name: 'asc' } }),
      tx.emergencyClosure.findMany({
        where: { tenantId, revokedAt: null, startsAt: { lte: at }, OR: [{ endsAt: null }, { endsAt: { gt: at } }] },
      }),
      tx.membership.findMany({ where: { tenantId, enabled: true, archivedAt: null, desiredStatus: 'online', role: { in: SERVING_ROLES } } }),
      this.presence.connectedAgentIds(tenantId),
    ]);
    const settings = mergeOrgSettings(tenant.settings);
    const defaultScheduleId = settings.availability?.defaultScheduleId ?? null;
    const scheduleIds = [...new Set([site.scheduleId, defaultScheduleId, ...departments.map((d) => d.scheduleId)].filter((x): x is string => !!x))];
    const exceptionFrom = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - EXCEPTION_LOOKBACK_DAYS));
    const schedules = scheduleIds.length
      ? await tx.schedule.findMany({
          where: { tenantId, id: { in: scheduleIds }, archivedAt: null },
          include: { exceptions: { where: { localDate: { gte: exceptionFrom } } } },
        })
      : [];
    const scheduleById = new Map<string, LoadedSchedule>(schedules.map((s) => [s.id, { id: s.id, version: s.version, timezone: s.timezone, eff: toEffectiveSchedule(s) }]));

    // Eligible agents: online + connected + free capacity.
    const online = members.filter((m) => connected.has(m.id));
    const usage = new Map<string, number>();
    if (online.length) {
      const ids = online.map((m) => m.id);
      const [owned, collabs, reserved] = await Promise.all([
        tx.chat.groupBy({ by: ['ownerMembershipId'], where: { tenantId, status: 'active', ownerMembershipId: { in: ids } }, _count: { _all: true } }),
        tx.chatParticipant.groupBy({ by: ['membershipId'], where: { tenantId, role: 'collaborator', leftAt: null, membershipId: { in: ids }, chat: { status: { not: 'closed' } } }, _count: { _all: true } }),
        tx.assignmentOffer.groupBy({ by: ['membershipId'], where: { tenantId, status: 'pending', mode: { in: ['assigned', 'transfer'] }, expiresAt: { gt: at }, membershipId: { in: ids } }, _count: { _all: true } }),
      ]);
      for (const r of owned) usage.set(r.ownerMembershipId!, (usage.get(r.ownerMembershipId!) ?? 0) + r._count._all);
      for (const r of collabs) usage.set(r.membershipId!, (usage.get(r.membershipId!) ?? 0) + r._count._all);
      for (const r of reserved) usage.set(r.membershipId!, (usage.get(r.membershipId!) ?? 0) + r._count._all);
    }
    const hasFree = (m: (typeof online)[number]) => (usage.get(m.id) ?? 0) < m.capacity;
    const queuedRows = await tx.chat.groupBy({
      by: ['departmentId'],
      where: { tenantId, status: { in: ['queued', 'offered'] }, isPreview: false },
      _count: { _all: true },
      _min: { requestedAt: true },
    });
    const queued = new Map(queuedRows.map((q) => [q.departmentId ?? 'none', { count: q._count._all, oldest: q._min.requestedAt }]));

    const accountClosures = closures.filter((c) => !c.departmentId && closureApplies(c, siteId, null));
    const defaultSchedule = defaultScheduleId ? (scheduleById.get(defaultScheduleId) ?? null) : null;
    const siteSchedule: { s: LoadedSchedule; source: ScheduleSnapshot['source'] } | null = site.scheduleId && scheduleById.get(site.scheduleId)
      ? { s: scheduleById.get(site.scheduleId)!, source: 'site' }
      : defaultSchedule
        ? { s: defaultSchedule, source: 'tenant_default' }
        : null;
    const accountMaxWait = settings.chat.offerOfflineAfterSeconds > 0 ? settings.chat.offerOfflineAfterSeconds : null;

    const evalScope = (dept: (Department & { members: Array<{ membershipId: string; canServe: boolean }> }) | null): ScopeAvailability => {
      const governing = dept?.scheduleId && scheduleById.get(dept.scheduleId) ? { s: scheduleById.get(dept.scheduleId)!, source: 'department' as const } : siteSchedule;
      const schedule = governing ? { id: governing.s.id, version: governing.s.version, timezone: governing.s.timezone, source: governing.source } : null;
      const tz = governing?.s.timezone ?? null;
      const q = queued.get(dept?.id ?? 'none') ?? { count: 0, oldest: null };
      const longestWaitSeconds = q.oldest ? Math.max(0, Math.floor((at.getTime() - q.oldest.getTime()) / 1000)) : 0;
      const maxWaitSeconds = dept ? (dept.maxWaitSeconds > 0 ? dept.maxWaitSeconds : null) : accountMaxWait;
      const base = {
        timezone: tz,
        queued: q.count,
        schedule,
        maxWaitSeconds,
        longestWaitSeconds,
        waitExceeded: maxWaitSeconds !== null && q.count > 0 && longestWaitSeconds >= maxWaitSeconds,
        fallbackDepartmentId: dept?.fallbackDepartmentId ?? null,
      };
      const local = (d: Date | null) => (d && tz ? localLabel(d.getTime(), tz) : d ? d.toISOString() : null);
      const applicable = [...accountClosures, ...(dept ? closures.filter((c) => c.departmentId === dept.id) : [])];
      if (applicable.length) {
        // Reopens after the last applicable closure ends, then at the next scheduled opening.
        const ends = applicable.map((c) => c.endsAt);
        const until = ends.some((e) => e === null) ? null : new Date(Math.max(...ends.map((e) => e!.getTime())));
        const reopen = until && governing ? nextScheduleOpening(governing.s.eff, until) : until;
        return { ...base, state: 'offline', reason: 'emergency_closure', nextOpenAt: reopen, nextOpenLocal: local(reopen), acceptsQueue: false, eligibleAgentCount: 0, emergencyClosureId: applicable[0].id };
      }
      if (governing && !isEffectiveScheduleOpen(governing.s.eff, at)) {
        const next = nextScheduleOpening(governing.s.eff, at);
        return { ...base, state: 'offline', reason: 'closed_hours', nextOpenAt: next, nextOpenLocal: local(next), acceptsQueue: false, eligibleAgentCount: 0, emergencyClosureId: null };
      }
      const pool = dept ? online.filter((m) => dept.members.some((x) => x.membershipId === m.id && x.canServe)) : online;
      const free = pool.filter(hasFree);
      const limit = dept?.queueLimit ?? 1000;
      const common = { ...base, nextOpenAt: null, nextOpenLocal: null, emergencyClosureId: null };
      if (!pool.length) return { ...common, state: 'offline', reason: 'no_agents', acceptsQueue: false, eligibleAgentCount: 0 };
      if (!free.length) return { ...common, state: 'busy', reason: q.count >= limit ? 'queue_full' : 'at_capacity', acceptsQueue: q.count < limit, eligibleAgentCount: 0 };
      return { ...common, state: 'available', reason: 'open', acceptsQueue: q.count < limit, eligibleAgentCount: free.length };
    };

    const deptStates: DepartmentAvailability[] = departments.map((d) => ({ id: d.id, label: d.publicLabel || d.name, ...evalScope(d) }));
    const account = evalScope(null);
    // The site is as reachable as its best scope: a department schedule overrides the
    // site/tenant schedule, so an open department keeps the site reachable through it.
    const scopes: ScopeAvailability[] = [account, ...deptStates];
    const best = scopes.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a), account);
    const offlineNext = scopes
      .map((s) => s.nextOpenAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    // Offline everywhere: the site becomes reachable when the first scope reopens.
    const nextOpenAt = best.state === 'offline' ? offlineNext : null;
    const nextScope = nextOpenAt ? (scopes.find((s) => s.nextOpenAt?.getTime() === nextOpenAt.getTime()) ?? account) : null;
    return {
      siteId,
      state: best.state,
      reason: best.reason,
      nextOpenAt,
      nextOpenLocal: nextScope?.nextOpenLocal ?? null,
      acceptsQueue: scopes.some((s) => s.acceptsQueue),
      eligibleAgentCount: account.eligibleAgentCount,
      requiresDepartment: account.state === 'offline' && best.state !== 'offline',
      account,
      departments: deptStates,
      asOf: at,
    };
  }
}
