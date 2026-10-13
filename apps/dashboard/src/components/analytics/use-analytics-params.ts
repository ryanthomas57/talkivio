'use client';
/**
 * Analytics filters live in the URL (ch. 06) so refresh, back/forward and shared
 * links restore the exact report. Unknown or invalid values fall back to defaults.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { useI18n } from '@/i18n';
import { useSession } from '@/stores/session';
import { defaultGroup, MAX_DAYS, resolveRange, type RangePreset, type ResolvedRange } from './range';
import type { GroupBy } from './types';

export type AnalyticsTab = 'chats' | 'agents' | 'invitations';

export interface AnalyticsParams {
  tab: AnalyticsTab;
  preset: RangePreset;
  customFrom: string | null;
  customTo: string | null;
  group: GroupBy;
  /** True when the grouping was chosen explicitly (not derived from the preset). */
  groupExplicit: boolean;
  timezone: string;
  workspaceTimezone: string;
  siteId: string | null;
  departmentId: string | null;
  currentDepartmentId: string | null;
  agentId: string | null;
  tagId: string | null;
  compare: boolean;
  view: 'chart' | 'table';
  reconcile: boolean;
  range: ResolvedRange;
}

const PRESET_VALUES: RangePreset[] = ['today', 'yesterday', '7d', '30d', 'custom'];
const TABS: AnalyticsTab[] = ['chats', 'agents', 'invitations'];
const GROUPS: GroupBy[] = ['hour', 'day', 'week'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null) => (v && UUID_RE.test(v) ? v : null);

function validTz(tz: string | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function useAnalyticsParams(): [AnalyticsParams, (patch: Record<string, string | null>) => void] {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const workspaceTimezone = useSession((s) => s.tenant?.timezone ?? 'UTC');
  // The range validation message is localized, so a language switch recomputes it.
  const { locale } = useI18n();

  const params = useMemo<AnalyticsParams>(() => {
    const tab = (TABS as string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as AnalyticsTab) : 'chats';
    const preset = (PRESET_VALUES as string[]).includes(sp.get('range') ?? '') ? (sp.get('range') as RangePreset) : 'today';
    const tz = validTz(sp.get('tz')) ? sp.get('tz')! : validTz(workspaceTimezone) ? workspaceTimezone : 'UTC';
    const customFrom = sp.get('from');
    const customTo = sp.get('to');
    const range = resolveRange(preset, tz, { from: customFrom, to: customTo });
    const explicit = sp.get('group');
    let group: GroupBy = (GROUPS as string[]).includes(explicit ?? '') ? (explicit as GroupBy) : defaultGroup(preset, range.days);
    if (range.days > MAX_DAYS[group]) group = range.days > MAX_DAYS.day ? 'week' : 'day';
    return {
      tab,
      preset,
      customFrom,
      customTo,
      group,
      groupExplicit: !!explicit && group === explicit,
      timezone: tz,
      workspaceTimezone,
      siteId: uuidOrNull(sp.get('site')),
      departmentId: uuidOrNull(sp.get('dept')),
      currentDepartmentId: uuidOrNull(sp.get('cdept')),
      agentId: uuidOrNull(sp.get('agent')),
      tagId: uuidOrNull(sp.get('tag')),
      compare: sp.get('compare') !== 'none',
      view: sp.get('view') === 'table' ? 'table' : 'chart',
      reconcile: sp.get('reconcile') === '1',
      range,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, workspaceTimezone, locale]);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const q = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') q.delete(k);
        else q.set(k, v);
      }
      const qs = q.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname],
  );

  return [params, update];
}

/** Query object for GET /analytics/chats (camelCase; converted to snake_case on the wire). */
export function chatsQuery(p: AnalyticsParams) {
  return {
    from: p.range.from,
    to: p.range.to,
    timezone: p.timezone,
    groupBy: p.group,
    siteId: p.siteId,
    departmentId: p.departmentId,
    currentDepartmentId: p.currentDepartmentId,
    agentId: p.agentId,
    tagId: p.tagId,
    compare: p.compare ? 'previous' : 'none',
    reconcile: p.reconcile ? '1' : null,
  };
}

/** GET /analytics/agents accepts only these filters (strict schema). */
export function agentsQuery(p: AnalyticsParams) {
  return { from: p.range.from, to: p.range.to, timezone: p.timezone, departmentId: p.departmentId ?? p.currentDepartmentId, agentId: p.agentId, siteId: p.siteId };
}

/** GET /analytics/invitations accepts only these filters (strict schema). */
export function invitationsQuery(p: AnalyticsParams) {
  return { from: p.range.from, to: p.range.to, timezone: p.timezone, siteId: p.siteId, departmentId: p.departmentId ?? p.currentDepartmentId };
}
