'use client';
/**
 * Visitors (ch. 11): live, consent-limited visitor sessions grouped as Incoming,
 * Served, Browsing and Idle. Filters, sort, high-load mode and the selected
 * visitor live in the URL; the table is windowed so 10 000 rows stay usable;
 * realtime deltas are coalesced and applied without moving the reading position.
 */
import { Activity, RotateCw, Search, UsersRound, WifiOff } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Button, Card, EmptyState, Field, Input, PageHeader, PanelError, Select, Skeleton, SwitchField } from '@/components/ui';
import { useT } from '@/i18n';
import { useConnectionState } from '@/hooks/use-realtime';
import { cn } from '@/lib/cn';
import { countryName, formatNumber } from '@/lib/format';
import { useDepartments, useSites, useTags } from '@/lib/queries';
import { useSession } from '@/stores/session';
import { effectiveGroups, type LiveFilters, type LiveSort } from './live-model';
import { LiveTable } from './live-table';
import { GROUP_LABEL, HIGH_LOAD_GROUPS, LIVE_GROUPS, type LiveGroup } from './types';
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
    return [...set].map((c) => ({ code: c, name: countryName(c) ?? c })).sort((a, b) => a.name.localeCompare(b.name));
  }, [sorted, filters.country]);

  const activeFilters = !!(filters.siteId || filters.departmentId || filters.country || filters.tag || filters.q || filters.status.length);
  const total = groupsShown.reduce((n, g) => n + (state.counts[g] ?? 0), 0);
  const toggleStatus = (g: LiveGroup) => {
    const next = filters.status.includes(g) ? filters.status.filter((x) => x !== g) : [...filters.status, g];
    set({ status: next.length ? next.join(',') : null });
  };
  const clearFilters = () => {
    setSearch('');
    set({ site: null, dept: null, country: null, tag: null, q: null, status: null });
  };
  const onNearEnd = useCallback(() => void loadMore(), [loadMore]);
  const statusChoices = filters.highLoad ? HIGH_LOAD_GROUPS : LIVE_GROUPS;
  const canSites = perms.has('sites.view') && (sites.data?.length ?? 0) > 1;

  return (
    <div className="mx-auto flex h-full w-full max-w-[1280px] flex-col gap-4 p-4 lg:p-6">
      <PageHeader
        title={t('visitors.page.title')}
        description={t('visitors.page.description')}
        actions={
          <span className={cn('inline-flex items-center gap-1.5 text-sm', conn === 'live' ? 'text-success' : 'text-warning')} role="status">
            {conn === 'live' ? <Activity className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
            {conn === 'live' ? t('visitors.page.liveOn') : t('visitors.page.livePaused')}
          </span>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('visitors.page.search')} className="w-full sm:w-64">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
              <Input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} placeholder={t('visitors.page.searchPlaceholder')} className="ps-9" />
            </div>
          </Field>
          {canSites && (
            <Field label={t('visitors.page.site')} className="w-[calc(50%-6px)] sm:w-44">
              <Select value={filters.siteId} onChange={(e) => set({ site: e.target.value || null })}>
                <option value="">{t('visitors.page.allSites')}</option>
                {(sites.data ?? []).filter((s) => !s.archivedAt).map((s) => (
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
                {(departments.data ?? []).filter((d) => !d.archivedAt).map((d) => (
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
              {(tags.data ?? []).filter((tag) => !tag.archivedAt).map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('visitors.page.sort')} className="w-full sm:w-56">
            <Select value={filters.sort} onChange={(e) => set({ sort: e.target.value === 'arrival' ? 'arrival' : null })}>
              <option value="queue">{t('visitors.page.sortQueue')}</option>
              <option value="arrival">{t('visitors.page.sortArrival')}</option>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label={t('visitors.page.activity')} className="flex flex-wrap items-center gap-1.5">
            <span className="me-1 text-sm font-medium text-fg">{t('visitors.page.activity')}</span>
            {statusChoices.map((g) => {
              const on = filters.status.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleStatus(g)}
                  className={cn(
                    'inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors sm:h-9',
                    on ? 'border-primary bg-primary-tint text-primary-hover dark:text-primary' : 'border-line bg-surface text-fg-2 hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  {t(GROUP_LABEL[g])}
                  <span className="tabular text-xs">{state.status === 'ready' ? formatNumber(state.counts[g] ?? 0) : '…'}</span>
                </button>
              );
            })}
            {activeFilters && (
              <Button variant="link" size="sm" className="ms-1" onClick={clearFilters}>
                {t('visitors.page.clearFilters')}
              </Button>
            )}
          </div>
          <SwitchField
            className="min-h-9 py-0"
            label={t('visitors.page.highLoad')}
            description={t('visitors.page.highLoadHint')}
            checked={filters.highLoad}
            onCheckedChange={(c) => set({ mode: c ? 'high_load' : null, status: c ? filters.status.filter((g) => HIGH_LOAD_GROUPS.includes(g)).join(',') || null : statusParam || null })}
          />
        </div>
      </div>

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
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<UsersRound />}
            title={activeFilters ? t('visitors.page.emptyFilteredTitle') : filters.highLoad ? t('visitors.page.emptyHighLoadTitle') : t('visitors.page.emptyTitle')}
            description={activeFilters ? t('visitors.page.emptyFilteredBody') : filters.highLoad ? t('visitors.page.emptyHighLoadBody') : t('visitors.page.emptyBody')}
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
            rows={sorted}
            counts={state.counts}
            version={state.version}
            selectedId={selectedId}
            onSelect={(id) => set({ visitor: id })}
            onNearEnd={onNearEnd}
            showGroups={groupsShown}
            label={t('visitors.page.tableLabel', { count: sorted.length })}
          />
        )}
        {state.status === 'ready' && sorted.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle px-4 py-2 text-sm text-fg-2" aria-live="polite">
            <span>
              {total > sorted.length ? t('visitors.page.showingOf', { shown: sorted.length, total }) : t('visitors.page.showing', { count: sorted.length })}
              {filters.sort === 'arrival' && state.hasMore ? ` · ${t('visitors.page.sortedAmongLoaded')}` : ''}
            </span>
            <span className="flex items-center gap-2">
              {state.moreError && <span className="text-danger">{state.moreError}</span>}
              {state.hasMore && (
                <Button size="sm" variant="secondary" loading={state.loadingMore} onClick={() => void loadMore()}>
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
