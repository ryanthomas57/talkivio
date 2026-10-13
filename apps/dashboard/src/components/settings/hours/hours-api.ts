'use client';
/**
 * Schedules and emergency closures (ch. 22 / 42): resource shapes as returned by
 * `apps/api/src/features/schedules/schedules.service.ts` (camelCase after wire
 * conversion), query keys, and the team-scope realtime refresh.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SchedulePreview, TimeRange, Weekday } from '@talkivio/contracts';
import { useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { intlLocale, tStatic, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';

export type { TimeRange, Weekday };
export type WeeklyIntervals = Record<Weekday, TimeRange[]>;

export interface ScheduleState {
  open: boolean;
  nextBoundary: { kind: 'open' | 'close'; at: string; local: string; localLabel: string } | null;
}

export interface Schedule {
  id: string;
  name: string;
  timezone: string;
  weeklyIntervals: WeeklyIntervals;
  exceptionCount: number;
  isTenantDefault: boolean;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  state: ScheduleState | null;
}

export interface ScheduleException {
  date: string;
  intervals: TimeRange[];
  closed: boolean;
  reason: string | null;
  createdAt: string;
}

export interface ScheduleUsage {
  departments: Array<{ id: string; name: string }>;
  sites: Array<{ id: string; name: string }>;
  tenantDefault: boolean;
}

export interface ScheduleDetail extends Schedule {
  exceptions: ScheduleException[];
  usage: ScheduleUsage;
}

export interface ScheduleImpact {
  inUse: boolean;
  openBefore: boolean;
  openAfter: boolean;
  closesServiceNow: boolean;
}

export type PreviewResponse = SchedulePreview & { scheduleId: string; version: number; name: string };

export interface Closure {
  id: string;
  scope: 'tenant' | 'site' | 'department';
  siteId: string | null;
  departmentId: string | null;
  startsAt: string;
  endsAt: string | null;
  reason: string;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
  state: 'active' | 'scheduled' | 'expired' | 'revoked';
}

export const hk = {
  schedules: (includeArchived = false) => ['schedules', { includeArchived }] as const,
  schedulesRoot: ['schedules'] as const,
  schedule: (id: string) => ['schedule', id] as const,
  scheduleRoot: ['schedule'] as const,
  preview: (id: string, from: string) => ['schedule-preview', id, from] as const,
  previewRoot: ['schedule-preview'] as const,
  closures: ['emergency-closures'] as const,
};

/** Every page of a cursor list (schedules are few; bounded to 20 pages). */
async function allPages<T>(path: string, query: Record<string, string | number | boolean | undefined>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: { items: T[]; nextCursor: string | null; hasMore: boolean } = await api.page<T>(path, { ...query, cursor: cursor ?? undefined });
    out.push(...page.items);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export function useSchedules(includeArchived = false, enabled = true) {
  const can = useSession((s) => s.permissions.has('schedules.view'));
  return useQuery({
    queryKey: hk.schedules(includeArchived),
    queryFn: () => allPages<Schedule>('/schedules', { limit: 100, includeArchived: includeArchived ? 'true' : undefined }),
    enabled: enabled && can,
    staleTime: 30_000,
  });
}

export function useSchedule(id: string) {
  return useQuery({ queryKey: hk.schedule(id), queryFn: () => api.get<ScheduleDetail>(`/schedules/${id}`), staleTime: 10_000 });
}

export function useClosures(enabled = true) {
  const can = useSession((s) => s.permissions.has('schedules.view'));
  return useQuery({ queryKey: hk.closures, queryFn: () => allPages<Closure>('/emergency-closures', { state: 'active', limit: 100 }), enabled: enabled && can, staleTime: 30_000 });
}

/** Refresh schedule and closure views on team-scope events and after reconnects. */
export function useHoursRealtime() {
  const qc = useQueryClient();
  useScopes([{ kind: 'team', id: 'all' }]);
  useRealtimeEvent<{ scheduleId?: string }>('schedule.updated', (e) => {
    void qc.invalidateQueries({ queryKey: hk.schedulesRoot });
    if (e.payload.scheduleId) {
      void qc.invalidateQueries({ queryKey: hk.schedule(e.payload.scheduleId) });
      void qc.invalidateQueries({ queryKey: ['schedule-preview', e.payload.scheduleId] });
    }
  });
  useRealtimeEvent(['emergency_closure.created', 'emergency_closure.revoked'], () => {
    void qc.invalidateQueries({ queryKey: hk.closures });
  });
  useResync(() => {
    void qc.invalidateQueries({ queryKey: hk.schedulesRoot });
    void qc.invalidateQueries({ queryKey: hk.scheduleRoot });
    void qc.invalidateQueries({ queryKey: hk.previewRoot });
    void qc.invalidateQueries({ queryKey: hk.closures });
  });
}

/** Catalog keys for weekday names, translated at render time. */
export const WEEKDAY_LABEL: Record<Weekday, MessageKey> = { sun: 'settings.days.long.0', mon: 'settings.days.long.1', tue: 'settings.days.long.2', wed: 'settings.days.long.3', thu: 'settings.days.long.4', fri: 'settings.days.long.5', sat: 'settings.days.long.6' };
export const WEEKDAY_SHORT: Record<Weekday, MessageKey> = { sun: 'settings.days.short.0', mon: 'settings.days.short.1', tue: 'settings.days.short.2', wed: 'settings.days.short.3', thu: 'settings.days.short.4', fri: 'settings.days.short.5', sat: 'settings.days.short.6' };

export function orderedWeekdays(weekStartsOn: 0 | 1): Weekday[] {
  const all: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return weekStartsOn === 1 ? [...all.slice(1), all[0]] : all;
}

/** "Mon 09:00–17:00, …" one-line summary for lists (UI language). */
export function summarizeWeek(w: WeeklyIntervals, weekStartsOn: 0 | 1): string {
  const days = orderedWeekdays(weekStartsOn).filter((d) => w[d]?.length);
  if (!days.length) return tStatic('settings.hours.closedEveryDay');
  const list = new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' });
  return days.map((d) => tStatic('settings.hours.summaryDay', { day: tStatic(WEEKDAY_SHORT[d]), ranges: list.format(w[d].map((r) => `${r.start}–${r.end}`)) })).join(' · ');
}

/** Normalize loose entry ("9", "930", "9:5") to HH:MM; returns the input unchanged if it cannot. */
export function normalizeTime(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) return `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`;
  m = /^(\d{1,2})$/.exec(s);
  if (m) return `${m[1].padStart(2, '0')}:00`;
  m = /^(\d{1,2})(\d{2})$/.exec(s);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return s;
}

const HM = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
export const minutesOf = (hm: string): number | null => {
  if (!HM.test(hm)) return null;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

/** True when the range runs past midnight into the next local day (end earlier than start). */
export function isOvernight(r: TimeRange): boolean {
  const s = minutesOf(r.start);
  const e = minutesOf(r.end);
  return s !== null && e !== null && e < s;
}

/**
 * The shared hours validators (packages/contracts/src/logic/hours.ts) and the API return these English
 * messages; known ones are shown in the UI language, anything else passes through unchanged.
 */
const HOURS_MESSAGES: Record<string, MessageKey> = {
  'Expected {start, end}': 'settings.hours.validation.shape',
  'Use HH:MM between 00:00 and 23:59': 'settings.hours.validation.startFormat',
  'Use HH:MM between 00:00 and 24:00': 'settings.hours.validation.endFormat',
  'Start and end must differ': 'settings.hours.validation.sameStartEnd',
  'Intervals overlap': 'settings.hours.validation.overlap',
  'Expected a list of intervals': 'settings.hours.validation.list',
  'Expected an object keyed by weekday (sun…sat)': 'settings.hours.validation.weekObject',
  'Unknown weekday; use sun, mon, tue, wed, thu, fri, sat': 'settings.hours.validation.weekday',
};

export function localizeHoursMessage(msg: string): string {
  const key = HOURS_MESSAGES[msg];
  if (key) return tStatic(key);
  const max = /^At most (\d+) intervals per day$/.exec(msg);
  return max ? tStatic('settings.hours.validation.maxIntervals', { count: Number(max[1]) }) : msg;
}

export function localizeHoursErrors(errors: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(errors).map(([k, list]) => [k, list.map(localizeHoursMessage)]));
}

/** Field-error key → message, with a prefix (e.g. `weekly_intervals.`) stripped. */
export function stripErrors(errors: Record<string, string[]>, prefix: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Format an instant in a timezone: "Sun 8 Mar, 03:00 EDT". */
export function formatIn(iso: string, timeZone: string, opts: { date?: boolean } = { date: true }): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(), {
      timeZone,
      ...(opts.date ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "Monday 9 March 2026" for a local YYYY-MM-DD date (no timezone shift). */
export function formatLocalDate(date: string, style: 'long' | 'short' = 'long'): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat(intlLocale(), style === 'long' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(dt);
}

/** Today's local date (YYYY-MM-DD) in a timezone. */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
