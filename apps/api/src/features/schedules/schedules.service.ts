import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import type { EmergencyClosure, Prisma, Schedule, ScheduleException } from '@prisma/client';
import {
  canonicalTimezone,
  isEffectiveScheduleOpen,
  isLocalDate,
  localDateTimeOf,
  localLabel,
  mergeOrgSettings,
  nextScheduleBoundary,
  normalizeWeeklyIntervals,
  previewSchedule,
  validateDayIntervals,
  validateWeeklyIntervals,
  type EffectiveSchedule,
  type SchedulePreview,
  type TimeRange,
  type Weekday,
} from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { badRequest, conflict, notFound, type AuthContext } from '../../common/http';
import { decodeCursor, encodeCursor, page, type Page } from '../../common/wire';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import { AvailabilityBroadcaster } from '../availability/availability.broadcaster';
import { toEffectiveSchedule } from '../availability/availability.service';
import { ScheduleTimers } from './schedule-timers';

const TEAM_SCOPE: OutboxScope = { kind: 'team', id: 'all', audience: 'staff' };
const MAX_EXCEPTIONS_LISTED = 500;

export interface ScheduleState {
  open: boolean;
  nextBoundary: { kind: 'open' | 'close'; at: Date; local: string; localLabel: string } | null;
}

export interface ScheduleResource {
  id: string;
  name: string;
  timezone: string;
  weeklyIntervals: Record<Weekday, TimeRange[]>;
  exceptionCount: number;
  isTenantDefault: boolean;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  state: ScheduleState | null;
}

export interface ScheduleExceptionResource {
  date: string;
  intervals: TimeRange[];
  closed: boolean;
  reason: string | null;
  createdAt: Date;
}

export interface ScheduleUsage {
  departments: Array<{ id: string; name: string }>;
  sites: Array<{ id: string; name: string }>;
  tenantDefault: boolean;
}

export interface ScheduleImpact {
  inUse: boolean;
  openBefore: boolean;
  openAfter: boolean;
  /** The change closes service that is currently open (ch. 22 admin impact warning). */
  closesServiceNow: boolean;
}

export interface ClosureResource {
  id: string;
  scope: 'tenant' | 'site' | 'department';
  siteId: string | null;
  departmentId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
  createdBy: string;
  revokedAt: Date | null;
  createdAt: Date;
  state: 'active' | 'scheduled' | 'expired' | 'revoked';
}

type ScheduleWithEx = Schedule & { exceptions?: ScheduleException[] };

function scheduleState(eff: EffectiveSchedule, now: Date): ScheduleState {
  const b = nextScheduleBoundary(eff, now);
  return {
    open: isEffectiveScheduleOpen(eff, now),
    nextBoundary: b ? { kind: b.kind, at: new Date(b.at), local: localDateTimeOf(b.at, eff.timezone), localLabel: localLabel(b.at, eff.timezone) } : null,
  };
}

export function closureResource(c: EmergencyClosure, now = new Date()): ClosureResource {
  const state: ClosureResource['state'] = c.revokedAt ? 'revoked' : c.endsAt && c.endsAt <= now ? 'expired' : c.startsAt > now ? 'scheduled' : 'active';
  return {
    id: c.id,
    scope: c.departmentId ? 'department' : c.siteId ? 'site' : 'tenant',
    siteId: c.siteId,
    departmentId: c.departmentId,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    reason: c.reason,
    createdBy: c.createdBy,
    revokedAt: c.revokedAt,
    createdAt: c.createdAt,
    state,
  };
}

function exceptionResource(e: ScheduleException): ScheduleExceptionResource {
  const intervals = (e.intervals as unknown as TimeRange[]) ?? [];
  return { date: e.localDate.toISOString().slice(0, 10), intervals, closed: intervals.length === 0, reason: e.reason, createdAt: e.createdAt };
}

const dbDate = (local: string) => new Date(`${local}T00:00:00.000Z`);

function prefixErrors(prefix: string, errors: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [k === '_' ? prefix : `${prefix}.${k}`, v]));
}

/** Schedules, dated exceptions and emergency closures (ch. 22 / 42). */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly broadcaster: AvailabilityBroadcaster,
    private readonly timers: ScheduleTimers,
  ) {}

  // ═════════════════════════════ Schedules ═════════════════════════════

  private async defaultScheduleId(tx: Tx, tenantId: string): Promise<string | null> {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    return mergeOrgSettings(t.settings).availability?.defaultScheduleId ?? null;
  }

  private resource(s: ScheduleWithEx, exceptionCount: number, defaultId: string | null, now = new Date()): ScheduleResource {
    const eff = toEffectiveSchedule(s);
    return {
      id: s.id,
      name: s.name,
      timezone: s.timezone,
      weeklyIntervals: normalizeWeeklyIntervals(s.weeklyIntervals),
      exceptionCount,
      isTenantDefault: defaultId === s.id,
      archivedAt: s.archivedAt,
      version: s.version,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      state: s.archivedAt ? null : scheduleState(eff, now),
    };
  }

  private async load(tx: Tx, tenantId: string, id: string, exceptionsFrom?: Date): Promise<ScheduleWithEx> {
    const s = await tx.schedule.findFirst({
      where: { tenantId, id },
      include: { exceptions: { where: { localDate: { gte: exceptionsFrom ?? new Date(Date.now() - 3 * 86_400_000) } }, orderBy: { localDate: 'asc' } } },
    });
    if (!s) throw notFound('Schedule');
    return s;
  }

  async usage(tx: Tx, tenantId: string, id: string): Promise<ScheduleUsage> {
    const [departments, sites, def] = await Promise.all([
      tx.department.findMany({ where: { tenantId, scheduleId: id, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      tx.site.findMany({ where: { tenantId, scheduleId: id, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.defaultScheduleId(tx, tenantId),
    ]);
    return { departments, sites, tenantDefault: def === id };
  }

  async list(auth: AuthContext, q: { cursor?: string; limit: number; includeArchived?: boolean }): Promise<Page<ScheduleResource>> {
    const filterHash = sha256(JSON.stringify({ a: !!q.includeArchived })).slice(0, 16);
    const cur = decodeCursor<{ n: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const where: Prisma.ScheduleWhereInput = {
        tenantId: auth.tenantId,
        ...(q.includeArchived ? {} : { archivedAt: null }),
        ...(cur ? { OR: [{ name: { gt: cur.n } }, { name: cur.n, id: { gt: cur.id } }] } : {}),
      };
      const rows = await tx.schedule.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: q.limit + 1, include: { exceptions: { where: { localDate: { gte: new Date(Date.now() - 3 * 86_400_000) } } } } });
      const slice = rows.slice(0, q.limit);
      const counts = slice.length
        ? await tx.scheduleException.groupBy({ by: ['scheduleId'], where: { tenantId: auth.tenantId, scheduleId: { in: slice.map((s) => s.id) } }, _count: { _all: true } })
        : [];
      const countBy = new Map(counts.map((c) => [c.scheduleId, c._count._all]));
      const def = await this.defaultScheduleId(tx, auth.tenantId);
      const now = new Date();
      const items = slice.map((s) => this.resource(s, countBy.get(s.id) ?? 0, def, now));
      const last = slice[slice.length - 1];
      return page(items, rows.length > q.limit && last ? encodeCursor({ n: last.name, id: last.id }, filterHash) : null);
    });
  }

  async get(auth: AuthContext, id: string): Promise<ScheduleResource & { exceptions: ScheduleExceptionResource[]; usage: ScheduleUsage }> {
    return this.db.read(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth.tenantId, id);
      const all = await tx.scheduleException.findMany({
        where: { tenantId: auth.tenantId, scheduleId: id, localDate: { gte: new Date(Date.now() - 31 * 86_400_000) } },
        orderBy: { localDate: 'asc' },
        take: MAX_EXCEPTIONS_LISTED,
      });
      const count = await tx.scheduleException.count({ where: { tenantId: auth.tenantId, scheduleId: id } });
      const usage = await this.usage(tx, auth.tenantId, id);
      return { ...this.resource(s, count, usage.tenantDefault ? id : null), exceptions: all.map(exceptionResource), usage };
    });
  }

  private validateWeekly(weekly: Record<string, TimeRange[]>): Record<Weekday, TimeRange[]> {
    const errors = validateWeeklyIntervals(weekly);
    if (Object.keys(errors).length) throw badRequest('Check the opening hours', prefixErrors('weekly_intervals', errors));
    return normalizeWeeklyIntervals(weekly);
  }

  private async emit(tx: Tx, tenantId: string, s: Schedule, change: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.outbox.append(tx, tenantId, {
      aggregateType: 'schedule',
      aggregateId: s.id,
      aggregateVersion: s.version,
      eventType: 'schedule.updated',
      payload: { scheduleId: s.id, version: s.version, change, ...extra },
      scopes: [TEAM_SCOPE],
    });
  }

  private afterChange(tenantId: string): void {
    this.broadcaster.schedule(tenantId);
    this.timers.rearm(tenantId);
  }

  async create(auth: AuthContext, input: { name: string; timezone: string; weeklyIntervals: Record<string, TimeRange[]> }): Promise<ScheduleResource> {
    const weekly = this.validateWeekly(input.weeklyIntervals);
    const timezone = canonicalTimezone(input.timezone);
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      const s = await tx.schedule.create({ data: { tenantId: auth.tenantId, name: input.name, timezone, weeklyIntervals: weekly as unknown as Prisma.InputJsonValue } });
      await this.audit.inTx(tx, auth, { action: 'schedule.created', objectType: 'schedule', objectId: s.id, safeDiff: { name: s.name, timezone, weekly_intervals: weekly } });
      await this.emit(tx, auth.tenantId, s, 'created');
      return this.resource({ ...s, exceptions: [] }, 0, await this.defaultScheduleId(tx, auth.tenantId));
    });
    this.afterChange(auth.tenantId);
    return out;
  }

  private impact(before: EffectiveSchedule | null, after: EffectiveSchedule, usage: ScheduleUsage, now = new Date()): ScheduleImpact {
    const inUse = usage.tenantDefault || usage.departments.length > 0 || usage.sites.length > 0;
    const openBefore = before ? isEffectiveScheduleOpen(before, now) : false;
    const openAfter = isEffectiveScheduleOpen(after, now);
    return { inUse, openBefore, openAfter, closesServiceNow: inUse && openBefore && !openAfter };
  }

  async update(
    auth: AuthContext,
    id: string,
    input: { name?: string; timezone?: string; weeklyIntervals?: Record<string, TimeRange[]>; dryRun?: boolean },
    expectedVersion: number | null,
  ): Promise<{ schedule: ScheduleResource; impact: ScheduleImpact; applied: boolean }> {
    const weekly = input.weeklyIntervals ? this.validateWeekly(input.weeklyIntervals) : undefined;
    const timezone = input.timezone ? canonicalTimezone(input.timezone) : undefined;
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'schedules', auth.tenantId, id);
      const s = await this.load(tx, auth.tenantId, id);
      if (s.archivedAt) throw conflict('CONFLICT', 'This schedule is archived');
      if (expectedVersion !== null && expectedVersion !== s.version) throw conflict('VERSION_CONFLICT', 'This schedule was changed by someone else. Reload to continue.', false, { current_version: s.version });
      const next: ScheduleWithEx = { ...s, name: input.name ?? s.name, timezone: timezone ?? s.timezone, weeklyIntervals: (weekly ?? s.weeklyIntervals) as Prisma.JsonValue };
      const usage = await this.usage(tx, auth.tenantId, id);
      const impact = this.impact(toEffectiveSchedule(s), toEffectiveSchedule(next), usage);
      const count = await tx.scheduleException.count({ where: { tenantId: auth.tenantId, scheduleId: id } });
      if (input.dryRun) return { schedule: this.resource(s, count, usage.tenantDefault ? id : null), impact, applied: false };
      const r = await tx.schedule.updateMany({
        where: { tenantId: auth.tenantId, id, version: s.version },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
          ...(weekly !== undefined ? { weeklyIntervals: weekly as unknown as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw conflict('VERSION_CONFLICT', 'This schedule was changed by someone else. Reload to continue.', true);
      const saved = await this.load(tx, auth.tenantId, id);
      await this.audit.inTx(tx, auth, {
        action: 'schedule.updated',
        objectType: 'schedule',
        objectId: id,
        safeDiff: {
          version: saved.version,
          ...(input.name !== undefined ? { name: { from: s.name, to: saved.name } } : {}),
          ...(timezone !== undefined ? { timezone: { from: s.timezone, to: saved.timezone } } : {}),
          ...(weekly !== undefined ? { weekly_intervals: { from: normalizeWeeklyIntervals(s.weeklyIntervals), to: weekly } } : {}),
          closes_service_now: impact.closesServiceNow,
        },
      });
      await this.emit(tx, auth.tenantId, saved, 'updated');
      return { schedule: this.resource(saved, count, usage.tenantDefault ? id : null), impact, applied: true };
    });
    if (out.applied) this.afterChange(auth.tenantId);
    return out;
  }

  async archive(auth: AuthContext, id: string, expectedVersion: number | null): Promise<ScheduleResource> {
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'schedules', auth.tenantId, id);
      const s = await this.load(tx, auth.tenantId, id);
      const count = await tx.scheduleException.count({ where: { tenantId: auth.tenantId, scheduleId: id } });
      if (s.archivedAt) return { resource: this.resource(s, count, null), changed: false };
      if (expectedVersion !== null && expectedVersion !== s.version) throw conflict('VERSION_CONFLICT', 'This schedule was changed by someone else. Reload to continue.', false, { current_version: s.version });
      const usage = await this.usage(tx, auth.tenantId, id);
      if (usage.tenantDefault || usage.departments.length || usage.sites.length) {
        throw conflict('CONFLICT', 'This schedule is still in use. Assign another schedule first.', false, usage);
      }
      const saved = await tx.schedule.update({ where: { id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, { action: 'schedule.archived', objectType: 'schedule', objectId: id, safeDiff: { version: saved.version } });
      await this.emit(tx, auth.tenantId, saved, 'archived');
      return { resource: this.resource({ ...saved, exceptions: [] }, count, null), changed: true };
    });
    if (out.changed) this.afterChange(auth.tenantId);
    return out.resource;
  }

  private checkDate(date: string): void {
    if (!isLocalDate(date) || date < '2000-01-01' || date > '2100-12-31') throw badRequest('Use a calendar date like 2026-12-25', { date: ['Invalid local date'] });
  }

  async setException(
    auth: AuthContext,
    id: string,
    date: string,
    input: { intervals: TimeRange[]; reason?: string | null; dryRun?: boolean },
    expectedVersion: number | null,
  ): Promise<{ exception: ScheduleExceptionResource; scheduleVersion: number; impact: ScheduleImpact; applied: boolean }> {
    this.checkDate(date);
    const errors = validateDayIntervals(input.intervals, 'intervals');
    if (Object.keys(errors).length) throw badRequest('Check the special hours', errors);
    const intervals = [...input.intervals].map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start.localeCompare(b.start));
    const reason = input.reason?.trim() || null;
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'schedules', auth.tenantId, id);
      const s = await this.load(tx, auth.tenantId, id);
      if (s.archivedAt) throw conflict('CONFLICT', 'This schedule is archived');
      if (expectedVersion !== null && expectedVersion !== s.version) throw conflict('VERSION_CONFLICT', 'This schedule was changed by someone else. Reload to continue.', false, { current_version: s.version });
      const before = toEffectiveSchedule(s);
      const after: EffectiveSchedule = { ...before, exceptions: [...before.exceptions.filter((e) => e.date !== date), { date, intervals }] };
      const impact = this.impact(before, after, await this.usage(tx, auth.tenantId, id));
      if (input.dryRun) {
        return { exception: { date, intervals, closed: intervals.length === 0, reason, createdAt: new Date() }, scheduleVersion: s.version, impact, applied: false };
      }
      const existing = await tx.scheduleException.findUnique({ where: { tenantId_scheduleId_localDate: { tenantId: auth.tenantId, scheduleId: id, localDate: dbDate(date) } } });
      const row = await tx.scheduleException.upsert({
        where: { tenantId_scheduleId_localDate: { tenantId: auth.tenantId, scheduleId: id, localDate: dbDate(date) } },
        create: { tenantId: auth.tenantId, scheduleId: id, localDate: dbDate(date), intervals: intervals as unknown as Prisma.InputJsonValue, reason },
        update: { intervals: intervals as unknown as Prisma.InputJsonValue, reason },
      });
      const saved = await tx.schedule.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, {
        action: existing ? 'schedule.exception_updated' : 'schedule.exception_created',
        objectType: 'schedule',
        objectId: id,
        safeDiff: { date, intervals, closed: intervals.length === 0, version: saved.version, closes_service_now: impact.closesServiceNow },
      });
      await this.emit(tx, auth.tenantId, saved, 'exception_set', { date });
      return { exception: exceptionResource(row), scheduleVersion: saved.version, impact, applied: true };
    });
    if (out.applied) this.afterChange(auth.tenantId);
    return out;
  }

  async removeException(auth: AuthContext, id: string, date: string, expectedVersion: number | null): Promise<void> {
    this.checkDate(date);
    const changed = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'schedules', auth.tenantId, id);
      const s = await this.load(tx, auth.tenantId, id);
      if (expectedVersion !== null && expectedVersion !== s.version) throw conflict('VERSION_CONFLICT', 'This schedule was changed by someone else. Reload to continue.', false, { current_version: s.version });
      const r = await tx.scheduleException.deleteMany({ where: { tenantId: auth.tenantId, scheduleId: id, localDate: dbDate(date) } });
      if (!r.count) return false;
      const saved = await tx.schedule.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, { action: 'schedule.exception_deleted', objectType: 'schedule', objectId: id, safeDiff: { date, version: saved.version } });
      await this.emit(tx, auth.tenantId, saved, 'exception_removed', { date });
      return true;
    });
    if (changed) this.afterChange(auth.tenantId);
  }

  async preview(auth: AuthContext, id: string, q: { from?: string; days: number }): Promise<SchedulePreview & { scheduleId: string; version: number; name: string }> {
    const from = q.from ? new Date(q.from) : new Date();
    if (Number.isNaN(from.getTime())) throw badRequest('Use an RFC3339 instant', { from: ['Invalid instant'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const s = await this.load(tx, auth.tenantId, id, new Date(from.getTime() - 3 * 86_400_000));
      return { scheduleId: s.id, version: s.version, name: s.name, ...previewSchedule(toEffectiveSchedule(s), from, q.days) };
    });
  }

  // ═════════════════════════════ Emergency closures ═════════════════════════════

  async listClosures(auth: AuthContext, q: { state: 'active' | 'all'; cursor?: string; limit: number }): Promise<Page<ClosureResource>> {
    const filterHash = sha256(JSON.stringify({ s: q.state })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    const now = new Date();
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.EmergencyClosureWhereInput[] = [{ tenantId: auth.tenantId }];
      if (q.state === 'active') and.push({ revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] });
      if (cur) and.push({ OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] });
      const rows = await tx.emergencyClosure.findMany({ where: { AND: and }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 });
      const slice = rows.slice(0, q.limit);
      const last = slice[slice.length - 1];
      return page(
        slice.map((c) => closureResource(c, now)),
        rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  async createClosure(auth: AuthContext, input: { siteId?: string | null; departmentId?: string | null; endsAt?: string | null; reason: string }): Promise<ClosureResource> {
    if (input.siteId && input.departmentId) throw badRequest('Choose a site or a department, not both', { department_id: ['Only one scope is allowed'] });
    const now = new Date();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt.getTime() <= now.getTime() + 1000) throw badRequest('The closure must end in the future', { ends_at: ['Must be in the future'] });
    if (endsAt && endsAt.getTime() > now.getTime() + 366 * 86_400_000) throw badRequest('Closures can be scheduled at most one year ahead', { ends_at: ['At most one year ahead'] });
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      if (input.siteId && !(await tx.site.findFirst({ where: { tenantId: auth.tenantId, id: input.siteId, archivedAt: null } }))) throw notFound('Site');
      if (input.departmentId && !(await tx.department.findFirst({ where: { tenantId: auth.tenantId, id: input.departmentId, archivedAt: null } }))) throw notFound('Department');
      const c = await tx.emergencyClosure.create({
        data: {
          tenantId: auth.tenantId,
          siteId: input.siteId ?? null,
          departmentId: input.departmentId ?? null,
          startsAt: now,
          endsAt,
          reason: input.reason,
          createdBy: auth.membershipId ?? auth.userId ?? auth.tokenId ?? auth.tenantId,
        },
      });
      const res = closureResource(c, now);
      await this.audit.inTx(tx, auth, { action: 'emergency_closure.created', objectType: 'emergency_closure', objectId: c.id, safeDiff: { scope: res.scope, site_id: c.siteId, department_id: c.departmentId, ends_at: c.endsAt } });
      await this.outbox.append(tx, auth.tenantId, { aggregateType: 'emergency_closure', aggregateId: c.id, aggregateVersion: 1, eventType: 'emergency_closure.created', payload: { closure: res }, scopes: [TEAM_SCOPE] });
      return res;
    });
    this.afterChange(auth.tenantId);
    return out;
  }

  async revokeClosure(auth: AuthContext, id: string): Promise<void> {
    const changed = await this.db.tx(auth.tenantId, async (tx) => {
      const c = await tx.emergencyClosure.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!c) throw notFound('Emergency closure');
      if (c.revokedAt) return false;
      const r = await tx.emergencyClosure.updateMany({ where: { tenantId: auth.tenantId, id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (!r.count) return false;
      const saved = await tx.emergencyClosure.findUniqueOrThrow({ where: { id } });
      await this.audit.inTx(tx, auth, { action: 'emergency_closure.revoked', objectType: 'emergency_closure', objectId: id, safeDiff: { scope: closureResource(saved).scope, was_expired: !!(c.endsAt && c.endsAt <= new Date()) } });
      await this.outbox.append(tx, auth.tenantId, { aggregateType: 'emergency_closure', aggregateId: id, aggregateVersion: 2, eventType: 'emergency_closure.revoked', payload: { closure: closureResource(saved) }, scopes: [TEAM_SCOPE] });
      return true;
    });
    if (changed) this.afterChange(auth.tenantId);
  }
}

