'use client';
/**
 * Visitors (ch. 11): live, consent-limited visitor sessions grouped as Incoming,
 * Served, Browsing and Idle. Filters, sort, high-load mode and the selected
 * visitor live in the URL; the table is windowed so 10 000 rows stay usable;
 * realtime deltas are coalesced and applied without moving the reading position.
 */
import {
  Activity,
  ChevronsDownUp,
  ChevronsUpDown,
  RotateCw,
  Search,
  SlidersHorizontal,
  UsersRound,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PanelError,
  Select,
  Skeleton,
  SwitchField,
} from '@/components/ui';
import { useT } from '@/i18n';
import { useConnectionState } from '@/hooks/use-realtime';
import { cn } from '@/lib/cn';
import { countryName, flagEmoji, formatNumber } from '@/lib/format';
import { useDepartments, useSites, useTags } from '@/lib/queries';
import { useDock } from '@/stores/dock';
import { useSession } from '@/stores/session';
import { effectiveGroups, type LiveFilters, type LiveRow, type LiveSort } from './live-model';
import { urlLabel } from './display';
import { LiveTable, type TableGroup } from './live-table';
import {
  GROUP_HINT,
  GROUP_LABEL,
  HIGH_LOAD_GROUPS,
  LIVE_GROUPS,
  type LiveGroup,
  type LiveVisitor,
} from './types';
import { useLiveVisitors } from './use-live-visitors';
import { VisitorDrawer } from './visitor-drawer';

function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { params, set };
}

const IP_HINT_KEY = 'rd_visitors_ip_hint';

type GroupBy = 'activity' | 'country' | 'page';

export function VisitorsPage() {
  const t = useT();
  const { params, set } = useUrlState();
  const perms = useSession((s) => s.permissions);
  const sites = useSites();
  const departments = useDepartments();
  const tags = useTags();
  const conn = useConnectionState();

  const statusParam = params.get('status') ?? '';
  const filters: LiveFilters = useMemo(
    () => ({
      siteId: params.get('site') ?? '',
      departmentId: params.get('dept') ?? '',
      country: (params.get('country') ?? '').toUpperCase().slice(0, 2),
      tag: params.get('tag') ?? '',
      q: params.get('q') ?? '',
      status: statusParam.split(',').filter((s): s is LiveGroup => (LIVE_GROUPS as string[]).includes(s)),
      highLoad: params.get('mode') === 'high_load',
      sort: (params.get('sort') === 'arrival' ? 'arrival' : 'queue') as LiveSort,
    }),
    [params, statusParam],
  );
  const selectedId = params.get('visitor');

  // Debounced search box (300 ms) → URL.
  const [search, setSearch] = useState(filters.q);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => {
    if (search === filters.q) return;
    const timer = setTimeout(() => set({ q: search.trim() ? search.slice(0, 100) : null }), 300);
    return () => clearTimeout(timer);
  }, [search, filters.q, set]);

  const { state, sorted, reload, loadMore } = useLiveVisitors(filters);
  const groupsShown = effectiveGroups(filters);
  const rowsById = useMemo(() => new Map(sorted.map((r) => [r.v.visitorId, r])), [sorted]);
  const selectedRow = selectedId ? (rowsById.get(selectedId) ?? null) : null;

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of sorted) if (r.v.country) set.add(r.v.country.toUpperCase());
    if (filters.country) set.add(filters.country);
    return [...set]
      .map((c) => ({ code: c, name: countryName(c) ?? c }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sorted, filters.country]);

  const activeFilters = !!(
    filters.siteId ||
    filters.departmentId ||
    filters.country ||
    filters.tag ||
    filters.q ||
    filters.status.length
  );
  const total = groupsShown.reduce((n, g) => n + (state.counts[g] ?? 0), 0);
  const clearFilters = () => {
    setSearch('');
    set({ site: null, dept: null, country: null, tag: null, q: null, status: null });
  };
  const onNearEnd = useCallback(() => void loadMore(), [loadMore]);

  // Sections of the table: by activity (server counts), or by country / page among the loaded visitors.
  const groupBy: GroupBy =
    params.get('group') === 'country' ? 'country' : params.get('group') === 'page' ? 'page' : 'activity';
  const groups = useMemo<TableGroup[]>(() => {
    if (groupBy === 'activity')
      return groupsShown
        .map((g) => ({
          key: g,
          label: t(GROUP_LABEL[g]),
          hint: t(GROUP_HINT[g]),
          rows: sorted.filter((r) => r.v.group === g),
          total: state.counts[g] ?? 0,
        }))
        .map((g) => ({ ...g, total: Math.max(g.total, g.rows.length) }))
        .filter((g) => g.rows.length > 0 || g.total > 0);
    const byKey = new Map<string, LiveRow[]>();
    for (const r of sorted) {
      const k =
        groupBy === 'country'
          ? (r.v.country?.toUpperCase() ?? '')
          : r.v.browsingHidden
            ? ''
            : r.v.currentTitle || (r.v.currentUrl ? urlLabel(r.v.currentUrl) : '');
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    return [...byKey.entries()]
      .sort(([a, ra], [b, rb]) =>
        a === '' ? 1 : b === '' ? -1 : rb.length - ra.length || a.localeCompare(b),
      )
      .map(([k, rows]) => ({
        key: k || '-',
        label: k
          ? groupBy === 'country'
            ? `${flagEmoji(k) ?? ''} ${countryName(k) ?? k}`.trim()
            : k
          : t(groupBy === 'country' ? 'visitors.group.unknownCountry' : 'visitors.group.unknownPage'),
        rows,
        total: rows.length,
      }));
  }, [groupBy, groupsShown, sorted, state.counts, t]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => setCollapsed(new Set()), [groupBy]);
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)));
  const canSites = perms.has('sites.view') && (sites.data?.length ?? 0) > 1;
  const canServe = perms.has('chats.serve');
  // Owners and admins (who can see websites) are pointed at installing the widget when there is none yet.
  const noSite = perms.has('sites.view') && sites.isSuccess && !(sites.data ?? []).some((x) => !x.archivedAt);
  const advancedCount =
    [filters.siteId, filters.departmentId, filters.country, filters.tag].filter(Boolean).length +
    (filters.sort === 'arrival' ? 1 : 0) +
    (filters.highLoad ? 1 : 0);
  const [showFilters, setShowFilters] = useState(() => advancedCount > 0);

  // Owners and admins are told once where visitor IPs are switched on (they are off by default).
  const [ipHintDismissed, setIpHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(IP_HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dismissIpHint = () => {
    setIpHintDismissed(true);
    try {
      localStorage.setItem(IP_HINT_KEY, '1');
    } catch {
      /* not persisted */
    }
  };
  const ipHint =
    !ipHintDismissed &&
    perms.has('tenant.manage') &&
    state.status === 'ready' &&
    sorted.length > 0 &&
    !sorted.some((r) => r.v.ipAddress);

  // A click on a visitor opens their chat in a docked window; a browsing visitor gets a new-chat window.
  const openChat = useCallback(
    (v: LiveVisitor) => {
      if (v.chat) {
        useDock.getState().openChat(v.chat.id);
        return;
      }
      if (!canServe) {
        set({ visitor: v.visitorId });
        return;
      }
      useDock.getState().openVisitor({
        visitorId: v.visitorId,
        sessionId: v.mostRecentSessionId,
        name: v.displayName,
        country: v.country,
        ipAddress: v.ipAddress,
        page: v.browsingHidden ? null : v.currentTitle || (v.currentUrl ? urlLabel(v.currentUrl) : null),
      });
    },
    [canServe, set],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-[1280px] flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold leading-8">{t('visitors.page.title')}</h1>
        <div className="flex items-center gap-4 text-sm">
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              conn === 'live' ? 'text-success' : 'text-warning',
            )}
            role="status"
          >
            {conn === 'live' ? (
              <Activity className="size-4" aria-hidden />
            ) : (
              <WifiOff className="size-4" aria-hidden />
            )}
            {conn === 'live' ? t('visitors.page.liveOn') : t('visitors.page.livePaused')}
          </span>
          <span className="text-fg-2">
            {t('visitors.page.total', { count: state.status === 'ready' ? formatNumber(total) : '…' })}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-y border-line-subtle py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleAll}
            disabled={!groups.length}
            aria-label={allCollapsed ? t('visitors.page.expandAll') : t('visitors.page.collapseAll')}
            title={allCollapsed ? t('visitors.page.expandAll') : t('visitors.page.collapseAll')}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-fg-2 hover:bg-surface-3 hover:text-fg disabled:opacity-50"
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-4" aria-hidden />
            ) : (
              <ChevronsDownUp className="size-4" aria-hidden />
            )}
          </button>
          <Select
            value={groupBy}
            onChange={(e) => set({ group: e.target.value === 'activity' ? null : e.target.value })}
            aria-label={t('visitors.page.groupBy')}
            className="w-56"
          >
            <option value="activity">{t('visitors.page.groupByActivity')}</option>
            <option value="country">{t('visitors.page.groupByCountry')}</option>
            <option value="page">{t('visitors.page.groupByPage')}</option>
          </Select>
          <Button
            variant="secondary"
            aria-expanded={showFilters}
            aria-controls="visitor-filters"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            {advancedCount
              ? t('visitors.page.filtersCount', { count: advancedCount })
              : t('visitors.page.filters')}
          </Button>
          {activeFilters && (
            <Button variant="link" size="sm" onClick={clearFilters}>
              {t('visitors.page.clearFilters')}
            </Button>
          )}
          <div className="relative ms-auto w-full sm:w-64">
            <Search
              className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-2"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('visitors.page.searchPlaceholder')}
              aria-label={t('visitors.page.search')}
              className="rounded-full ps-10"
            />
          </div>
        </div>

        {showFilters && (
          <div
            id="visitor-filters"
            className="flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line-subtle bg-surface-2 p-3"
          >
            {canSites && (
              <Field label={t('visitors.page.site')} className="w-[calc(50%-6px)] sm:w-44">
                <Select value={filters.siteId} onChange={(e) => set({ site: e.target.value || null })}>
                  <option value="">{t('visitors.page.allSites')}</option>
                  {(sites.data ?? [])
                    .filter((s) => !s.archivedAt)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {(departments.data?.length ?? 0) > 0 && (
              <Field label={t('common.department')} className="w-[calc(50%-6px)] sm:w-44">
                <Select value={filters.departmentId} onChange={(e) => set({ dept: e.target.value || null })}>
                  <option value="">{t('visitors.page.anyDepartment')}</option>
                  {(departments.data ?? [])
                    .filter((d) => !d.archivedAt)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            <Field label={t('visitors.page.country')} className="w-[calc(50%-6px)] sm:w-44">
              <Select value={filters.country} onChange={(e) => set({ country: e.target.value || null })}>
                <option value="">{t('visitors.page.anyCountry')}</option>
                {countryOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('visitors.page.tag')} className="w-[calc(50%-6px)] sm:w-44">
              <Select value={filters.tag} onChange={(e) => set({ tag: e.target.value || null })}>
                <option value="">{t('visitors.page.anyTag')}</option>
                {(tags.data ?? [])
                  .filter((tag) => !tag.archivedAt)
                  .map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('visitors.page.sort')} className="w-full sm:w-56">
              <Select
                value={filters.sort}
                onChange={(e) => set({ sort: e.target.value === 'arrival' ? 'arrival' : null })}
              >
                <option value="queue">{t('visitors.page.sortQueue')}</option>
                <option value="arrival">{t('visitors.page.sortArrival')}</option>
              </Select>
            </Field>
            <SwitchField
              className="min-h-9 py-0"
              label={t('visitors.page.highLoad')}
              description={t('visitors.page.highLoadHint')}
              checked={filters.highLoad}
              onCheckedChange={(c) =>
                set({
                  mode: c ? 'high_load' : null,
                  status: c
                    ? filters.status.filter((g) => HIGH_LOAD_GROUPS.includes(g)).join(',') || null
                    : statusParam || null,
                })
              }
            />
          </div>
        )}
      </div>

      {ipHint && (
        <Banner
          tone="info"
          title={t('visitors.page.ipOffTitle')}
          action={
            <span className="flex items-center gap-1">
              <Button asChild variant="secondary" size="sm">
                <Link href="/settings/general">{t('visitors.page.ipOffAction')}</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={dismissIpHint}>
                {t('visitors.page.ipOffDismiss')}
              </Button>
            </span>
          }
        >
          {t('visitors.page.ipOffBody')}
        </Banner>
      )}

      {filters.highLoad && (
        <Banner tone="warning" title={t('visitors.page.highLoadBannerTitle')}>
          {t('visitors.page.highLoadBannerBody')}
        </Banner>
      )}

      <Card className="flex min-h-[460px] flex-1 flex-col overflow-hidden">
        {state.status === 'loading' ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label={t('visitors.page.loading')}>
            <Skeleton className="h-9 w-full" />
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : state.status === 'error' ? (
          <PanelError message={state.error ?? t('visitors.live.loadError')} onRetry={reload} />
        ) : sorted.length === 0 && noSite ? (
          <EmptyState
            icon={<UsersRound />}
            title={t('visitors.page.noSiteTitle')}
            description={t('visitors.page.noSiteBody')}
            action={
              <Button asChild variant="primary">
                <Link href="/settings/sites">{t('visitors.page.noSiteAction')}</Link>
              </Button>
            }
          />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<UsersRound />}
            title={
              activeFilters
                ? t('visitors.page.emptyFilteredTitle')
                : filters.highLoad
                  ? t('visitors.page.emptyHighLoadTitle')
                  : t('visitors.page.emptyTitle')
            }
            description={
              activeFilters
                ? t('visitors.page.emptyFilteredBody')
                : filters.highLoad
                  ? t('visitors.page.emptyHighLoadBody')
                  : t('visitors.page.emptyBody')
            }
            action={
              activeFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  {t('visitors.page.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <LiveTable
            groups={groups}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            version={state.version}
            selectedId={selectedId}
            onOpen={openChat}
            onDetails={(id) => set({ visitor: id })}
            onNearEnd={onNearEnd}
            label={t('visitors.page.tableLabel', { count: sorted.length })}
          />
        )}
        {state.status === 'ready' && sorted.length > 0 && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle px-4 py-2 text-sm text-fg-2"
            aria-live="polite"
          >
            <span>
              {total > sorted.length
                ? t('visitors.page.showingOf', { shown: sorted.length, total })
                : t('visitors.page.showing', { count: sorted.length })}
              {filters.sort === 'arrival' && state.hasMore
                ? ` · ${t('visitors.page.sortedAmongLoaded')}`
                : ''}
            </span>
            <span className="flex items-center gap-3">
              {/* DB-IP City Lite (CC BY 4.0) supplies locations in the bundled deployment; the licence requires this credit. */}
              <a
                href="https://db-ip.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline underline-offset-2 hover:text-fg"
              >
                {t('visitors.page.geoCredit')}
              </a>
              {state.moreError && <span className="text-danger">{state.moreError}</span>}
              {state.hasMore && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={state.loadingMore}
                  onClick={() => void loadMore()}
                >
                  {state.moreError ? <RotateCw className="size-3.5" aria-hidden /> : null}
                  {t('common.loadMore')}
                </Button>
              )}
            </span>
          </div>
        )}
      </Card>

      <VisitorDrawer visitorId={selectedId} live={selectedRow} onClose={() => set({ visitor: null })} />
    </div>
  );
}
