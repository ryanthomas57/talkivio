'use client';
/**
 * History (ch. 17): closed and active chats, 48 px rows, 50 per page with cursor
 * pagination. Search is debounced 300 ms (≤ 256 chars) and returns safe
 * highlighted snippets; filters are removable chips; dates are inclusive in the
 * workspace time zone and sent as half-open UTC instants. Selected chats can be
 * exported with a count preview and job progress.
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileStack, History as HistoryIcon, Search, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, Card, Checkbox, EmptyState, Field, Input, Page, PageHeader, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDuration, formatDurationLong } from '@/lib/format';
import { byId, useAgents, useDepartments, useSites, useTags } from '@/lib/queries';
import { useSession } from '@/stores/session';
import { ChatStatusLabel } from '../visitors/chat-status';
import { ExportDialog, type ExportSource } from './export-dialog';
import { ExportsDrawer, useExportEvents } from './export-jobs';
import { Snippet } from './snippet';
import { historyKeys, type ExportFilters, type HistoryChat } from './types';
import { addDays, formatInZone, isIsoDate, todayIn, validTimeZone, zonedRange } from './tz';

const PAGE = 50;
const MAX_Q = 256;
const MAX_RANGE_DAYS = 365;

type FilterKey = 'site' | 'agent' | 'dept' | 'rating' | 'tag' | 'status' | 'from' | 'to';
const FILTER_KEYS: FilterKey[] = ['site', 'agent', 'dept', 'rating', 'tag', 'status', 'from', 'to'];
const RATING_LABEL: Record<string, MessageKey> = { good: 'history.rating.good', bad: 'history.rating.bad', none: 'history.rating.none' };
const STATUS_LABEL: Record<string, MessageKey> = { closed: 'history.status.closed', active: 'history.status.active', queued: 'history.status.queued' };

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function HistoryPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tz = useSession((s) => validTimeZone(s.tenant?.timezone));
  const perms = useSession((s) => s.permissions);
  const canExport = perms.has('exports.create');
  const sites = useSites();
  const agents = useAgents();
  const departments = useDepartments();
  const tags = useTags();
  const agentMap = byId(agents.data);
  const deptMap = byId(departments.data);
  const siteMap = byId(sites.data);
  const tagMap = byId(tags.data);
  useExportEvents();

  const set = useCallback(
    (patch: Record<string, string | null>, keepCursor = false) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      if (!keepCursor) next.delete('cursor');
      const s = next.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>;
  const q = (params.get('q') ?? '').slice(0, MAX_Q);
  const cursor = params.get('cursor');

  // Search box → URL after 300 ms.
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => set({ q: search.trim() ? search.slice(0, MAX_Q) : null }), 300);
    return () => clearTimeout(timer);
  }, [search, q, set]);

  // Inclusive workspace-zone dates → half-open UTC.
  const fromDate = isIsoDate(f.from) ? f.from : '';
  const toDate = isIsoDate(f.to) ? f.to : '';
  const dateError = fromDate && toDate && fromDate > toDate ? t('history.page.errOrder') : fromDate && toDate && daysBetween(fromDate, toDate) + 1 > MAX_RANGE_DAYS ? t('history.page.errTooLong', { days: MAX_RANGE_DAYS }) : null;
  const range = useMemo(() => {
    if (dateError || (!fromDate && !toDate)) return null;
    const end = toDate || todayIn(tz);
    const start = fromDate || addDays(end, -29);
    return { ...zonedRange(start, end, tz), start, end };
  }, [fromDate, toDate, tz, dateError]);

  const query = {
    q: q.trim() || undefined,
    from: range?.from,
    to: range?.to,
    siteId: f.site || undefined,
    agentId: f.agent || undefined,
    departmentId: f.dept || undefined,
    rating: f.rating || undefined,
    tagId: f.tag || undefined,
    status: f.status || undefined,
    limit: PAGE,
  };
  const listKey = JSON.stringify(query);
  const list = useQuery({
    queryKey: historyKeys.list(`${listKey}|${cursor ?? ''}`),
    queryFn: () => api.page<HistoryChat>('/chats/history', { ...query, cursor: cursor ?? undefined }),
    enabled: !dateError,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  // Cursor history for "Previous" (the API paginates forward only).
  const [stack, setStack] = useState<string[]>([]);
  const [lastKey, setLastKey] = useState(listKey);
  if (lastKey !== listKey) {
    setLastKey(listKey);
    setStack([]);
  }
  const pageNo = stack.length + 1;
  const goNext = () => {
    if (!list.data?.nextCursor) return;
    setStack((s) => [...s, cursor ?? '']);
    set({ cursor: list.data.nextCursor }, true);
  };
  const goPrev = () => {
    const prev = stack[stack.length - 1];
    setStack((s) => s.slice(0, -1));
    set({ cursor: prev || null }, true);
  };

  // Selection survives paging (ids → summary for the dialog label).
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const items = list.data?.items ?? [];
  const pageIds = items.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));
  const toggle = (c: HistoryChat) =>
    setSelected((m) => {
      const n = new Map(m);
      if (n.has(c.id)) n.delete(c.id);
      else n.set(c.id, c.number);
      return n;
    });
  const togglePage = () =>
    setSelected((m) => {
      const n = new Map(m);
      if (allOnPage) pageIds.forEach((id) => n.delete(id));
      else items.forEach((c) => n.set(c.id, c.number));
      return n;
    });

  const [exportSource, setExportSource] = useState<ExportSource | null>(null);
  const [exportsOpen, setExportsOpen] = useState(false);
  const filtersActive = FILTER_KEYS.some((k) => !!f[k]) || !!q;
  const clearAll = () => {
    setSearch('');
    set(Object.fromEntries([...FILTER_KEYS, 'q'].map((k) => [k, null])));
  };

  const exportFilters: ExportFilters = useMemo(() => {
    const end = toDate || todayIn(tz);
    const start = fromDate || addDays(end, -29);
    const r = zonedRange(start, end, tz);
    return {
      from: r.from,
      to: r.to,
      ...(f.site ? { siteId: f.site } : {}),
      ...(f.dept ? { departmentId: f.dept } : {}),
      ...(f.agent ? { agentId: f.agent } : {}),
      ...(f.status ? { status: f.status as ExportFilters['status'] } : {}),
      ...(f.rating ? { rating: f.rating as ExportFilters['rating'] } : {}),
      ...(f.tag ? { tagId: f.tag } : {}),
    };
  }, [fromDate, toDate, tz, f.site, f.dept, f.agent, f.status, f.rating, f.tag]);

  const chips: Array<{ key: FilterKey | 'q' | 'dates'; label: string; clear: Record<string, null> }> = [];
  const named = (v: string | undefined) => (v ? isolate(v) : t('common.unknown'));
  if (q) chips.push({ key: 'q', label: t('history.page.chipSearch', { q: isolate(q.length > 40 ? `${q.slice(0, 40)}…` : q) }), clear: { q: null } });
  if (fromDate || toDate) chips.push({ key: 'dates', label: fromDate && toDate ? t('history.page.chipRange', { from: fromDate, to: toDate }) : fromDate ? t('history.page.chipFrom', { date: fromDate }) : t('history.page.chipUntil', { date: toDate }), clear: { from: null, to: null } });
  if (f.site) chips.push({ key: 'site', label: t('history.page.chipSite', { name: named(siteMap.get(f.site)?.name) }), clear: { site: null } });
  if (f.agent) chips.push({ key: 'agent', label: t('history.page.chipAgent', { name: named(agentMap.get(f.agent)?.displayName) }), clear: { agent: null } });
  if (f.dept) chips.push({ key: 'dept', label: t('history.page.chipDept', { name: named(deptMap.get(f.dept)?.name) }), clear: { dept: null } });
  if (f.rating) chips.push({ key: 'rating', label: RATING_LABEL[f.rating] ? t(RATING_LABEL[f.rating]!) : f.rating, clear: { rating: null } });
  if (f.tag) chips.push({ key: 'tag', label: t('history.page.chipTag', { name: named(tagMap.get(f.tag)?.label) }), clear: { tag: null } });
  if (f.status) chips.push({ key: 'status', label: STATUS_LABEL[f.status] ? t(STATUS_LABEL[f.status]!) : f.status, clear: { status: null } });

  return (
    <Page>
      <PageHeader
        title={t('history.page.title')}
        description={t('history.page.description', { timezone: tz })}
        actions={
          canExport && (
            <>
              <Button variant="secondary" onClick={() => setExportsOpen(true)}>
                <FileStack className="size-4" aria-hidden /> {t('history.page.yourExports')}
              </Button>
              <Button
                variant="secondary"
                disabled={!!q || !!dateError}
                title={q ? t('history.page.exportAllHint') : undefined}
                onClick={() =>
                  setExportSource({
                    kind: 'filters',
                    filters: exportFilters,
                    label: t('history.page.exportAllLabel', {
                      from: formatInZone(exportFilters.from, tz, { hour: undefined, minute: undefined }),
                      to: formatInZone(new Date(Date.parse(exportFilters.to) - 1).toISOString(), tz, { hour: undefined, minute: undefined }),
                    }),
                  })
                }
              >
                <Download className="size-4" aria-hidden /> {t('history.page.exportAll')}
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col gap-3">
        <Field label={t('history.page.searchLabel')} description={t('history.page.searchHint')}>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
            <Input type="search" value={search} maxLength={MAX_Q} onChange={(e) => setSearch(e.target.value)} placeholder={t('history.page.searchPlaceholder')} className="ps-9" />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
          <Field label={t('common.from')} error={dateError ?? undefined}>
            <Input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => set({ from: e.target.value || null })} />
          </Field>
          <Field label={t('history.page.toInclusive')}>
            <Input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => set({ to: e.target.value || null })} />
          </Field>
          {perms.has('sites.view') && (sites.data?.length ?? 0) > 1 && (
            <Field label={t('history.page.site')}>
              <Select value={f.site} onChange={(e) => set({ site: e.target.value || null })}>
                <option value="">{t('history.page.allSites')}</option>
                {(sites.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {(agents.data?.length ?? 0) > 0 && (
            <Field label={t('common.agent')}>
              <Select value={f.agent} onChange={(e) => set({ agent: e.target.value || null })}>
                <option value="">{t('history.page.anyAgent')}</option>
                {[...(agents.data ?? [])]
                  .sort((a, b) => a.displayName.localeCompare(b.displayName))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {(departments.data?.length ?? 0) > 0 && (
            <Field label={t('common.department')}>
              <Select value={f.dept} onChange={(e) => set({ dept: e.target.value || null })}>
                <option value="">{t('history.page.anyDepartment')}</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.archivedAt ? t('history.page.archivedOption', { name: isolate(d.name) }) : d.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('history.page.rating')}>
            <Select value={f.rating} onChange={(e) => set({ rating: e.target.value || null })}>
              <option value="">{t('history.page.anyRating')}</option>
              <option value="good">{t('history.page.good')}</option>
              <option value="bad">{t('history.page.bad')}</option>
              <option value="none">{t('history.rating.none')}</option>
            </Select>
          </Field>
          <Field label={t('history.page.tag')}>
            <Select value={f.tag} onChange={(e) => set({ tag: e.target.value || null })}>
              <option value="">{t('history.page.anyTag')}</option>
              {(tags.data ?? []).map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.status')}>
            <Select value={f.status} onChange={(e) => set({ status: e.target.value || null })}>
              <option value="">{t('history.page.anyStatus')}</option>
              <option value="closed">{t('history.status.closed')}</option>
              <option value="active">{t('history.status.active')}</option>
              <option value="queued">{t('history.page.waiting')}</option>
            </Select>
          </Field>
        </div>
        <div className="flex min-h-8 flex-wrap items-center gap-2" aria-label={t('history.page.activeFilters')}>
          {chips.length ? (
            <>
              <ul className="flex flex-wrap gap-2">
                {chips.map((c) => (
                  <li key={c.key}>
                    <span className="inline-flex h-11 items-center gap-1 rounded-full border border-line bg-surface ps-3 pe-1 text-sm sm:h-8">
                      <span className="max-w-[260px] truncate">{c.label}</span>
                      <button type="button" onClick={() => (c.key === 'q' ? (setSearch(''), set(c.clear)) : set(c.clear))} className="inline-flex size-10 items-center justify-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg sm:size-7" aria-label={t('history.page.removeFilter', { label: isolate(c.label) })}>
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <Button variant="link" size="sm" onClick={clearAll}>
                {t('history.page.clearFilters')}
              </Button>
            </>
          ) : (
            <p className="text-sm text-fg-2">{t('history.page.defaultRange', { days: MAX_RANGE_DAYS })}</p>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-[5] flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-primary/40 bg-primary-tint px-4 py-2" role="region" aria-label={t('history.page.selection')}>
          <span className="text-sm font-medium" aria-live="polite">
            {t('history.page.selectedCount', { count: selected.size })}
          </span>
          <span className="flex flex-wrap gap-2">
            {canExport && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setExportSource({ kind: 'chats', chatIds: [...selected.keys()], label: t('history.page.selectedLabel', { count: selected.size }) })}
              >
                <Download className="size-3.5" aria-hidden /> {t('history.page.exportSelected')}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Map())}>
              {t('history.page.clearSelection')}
            </Button>
          </span>
        </div>
      )}

      <Card className="overflow-hidden">
        {dateError ? (
          <div className="p-4">
            <Banner tone="warning">{dateError}</Banner>
          </div>
        ) : list.isLoading ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label={t('history.page.loading')}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <PanelError message={t('history.page.loadError', { error: errorMessage(list.error) })} onRetry={() => void list.refetch()} />
        ) : !items.length ? (
          <EmptyState
            icon={<HistoryIcon />}
            title={filtersActive ? t('history.page.emptyFilteredTitle') : t('history.page.emptyTitle')}
            description={filtersActive ? (q ? t('history.page.emptySearchBody') : t('history.page.emptyFilteredBody')) : t('history.page.emptyBody')}
            action={
              filtersActive ? (
                <Button variant="secondary" onClick={clearAll}>
                  {t('history.page.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableScroll>
              <Table className="min-w-[1040px] table-fixed" aria-busy={list.isFetching || undefined}>
                <colgroup>
                  <col style={{ width: 44 }} />
                  <col style={{ width: 168 }} />
                  <col />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 96 }} />
                </colgroup>
                <THead>
                  <tr>
                    <TH className="px-3">
                      <Checkbox checked={allOnPage ? true : someOnPage ? 'indeterminate' : false} onCheckedChange={togglePage} aria-label={allOnPage ? t('history.page.deselectPage') : t('history.page.selectPage')} />
                    </TH>
                    <TH className="px-3">{t('common.date')}</TH>
                    <TH className="px-3">{t('common.visitor')}</TH>
                    <TH className="px-3">{t('history.page.agents')}</TH>
                    <TH className="px-3">{t('common.department')}</TH>
                    <TH className="px-3">{t('history.page.duration')}</TH>
                    <TH className="px-3">{t('history.page.tags')}</TH>
                    <TH className="px-3">{t('history.page.rating')}</TH>
                    <TH className="px-3">{t('common.status')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {items.map((c) => {
                    const agentIds = [c.ownerMembershipId, ...c.collaboratorIds].filter((x): x is string => !!x);
                    const agentNames = agentIds.map((id) => agentMap.get(id)?.displayName ?? t('history.page.formerAgent'));
                    const end = c.closedAt ? Date.parse(c.closedAt) : null;
                    const dur = end ? end - Date.parse(c.requestedAt) : null;
                    const isSel = selected.has(c.id);
                    return (
                      <TR key={c.id} selected={isSel} className="h-12 hover:bg-surface-2">
                        <TD className="h-12 px-3">
                          <Checkbox checked={isSel} onCheckedChange={() => toggle(c)} aria-label={t('history.page.selectChat', { number: String(c.number), name: isolate(c.visitor.displayName) })} />
                        </TD>
                        <TD className="h-12 truncate px-3 text-fg-2">
                          <time dateTime={c.requestedAt}>{formatInZone(c.requestedAt, tz)}</time>
                        </TD>
                        <TD className="h-12 px-3">
                          <Link href={`/history/${c.id}`} className="flex min-w-0 flex-col rounded-sm hover:underline">
                            <span className="truncate font-medium text-fg">
                              <bdi>{c.visitor.displayName}</bdi> <span className="font-normal text-fg-2">· #{c.number}</span>
                            </span>
                            {c.snippet ? (
                              <Snippet text={c.snippet} highlights={c.snippetHighlights} className="truncate text-xs text-fg-2" />
                            ) : c.lastMessagePreview ? (
                              <span className="truncate text-xs text-fg-2" dir="auto">
                                {c.lastMessagePreview}
                              </span>
                            ) : null}
                          </Link>
                        </TD>
                        <TD className="h-12 truncate px-3" title={agentNames.join(', ')} dir={agentNames.length ? 'auto' : undefined}>
                          {agentNames.length ? agentNames.join(', ') : <span className="text-fg-3">{t('history.page.unassigned')}</span>}
                        </TD>
                        <TD className="h-12 truncate px-3">{c.departmentId ? <bdi>{deptMap.get(c.departmentId)?.name ?? t('common.department')}</bdi> : <span className="text-fg-3">{t('common.none')}</span>}</TD>
                        <TD className="h-12 px-3 tabular">{dur !== null ? <span aria-label={formatDurationLong(dur)}>{formatDuration(dur)}</span> : <span className="text-fg-2">{t('history.page.ongoing')}</span>}</TD>
                        <TD className="h-12 px-3">
                          {c.tags.length ? (
                            <span className="flex min-w-0 items-center gap-1 overflow-hidden" dir="auto" title={c.tags.map((tag) => tag.label).join(', ')}>
                              {c.tags.slice(0, 2).map((tag) => (
                                <Badge key={tag.id} tone="primary" className="max-w-[90px] shrink" dir="auto">
                                  {tag.label}
                                </Badge>
                              ))}
                              {c.tags.length > 2 && <span className="shrink-0 text-xs text-fg-2">+{c.tags.length - 2}</span>}
                            </span>
                          ) : (
                            <span className="text-fg-3">—</span>
                          )}
                        </TD>
                        <TD className="h-12 px-3">
                          {c.rating ? (
                            <span className={`inline-flex items-center gap-1 text-sm font-medium ${c.rating.rating === 'good' ? 'text-success' : 'text-danger'}`}>
                              {c.rating.rating === 'good' ? <ThumbsUp className="size-3.5" aria-hidden /> : <ThumbsDown className="size-3.5" aria-hidden />}
                              {c.rating.rating === 'good' ? t('history.page.good') : t('history.page.bad')}
                            </span>
                          ) : (
                            <span className="text-fg-3">—</span>
                          )}
                        </TD>
                        <TD className="h-12 px-3">
                          <ChatStatusLabel status={c.status} />
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </TableScroll>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle px-4 py-2 text-sm text-fg-2">
              <span aria-live="polite">
                {t('history.page.footer', { page: pageNo, count: items.length })}
                {list.isFetching ? ` · ${t('history.page.updating')}` : ''}
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={goPrev} disabled={pageNo === 1 && !cursor}>
                  <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden /> {pageNo === 1 && cursor ? t('history.page.firstPage') : t('common.previous')}
                </Button>
                <Button size="sm" variant="secondary" onClick={goNext} disabled={!list.data?.hasMore}>
                  {t('common.next')} <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>

      <ExportDialog open={!!exportSource} onOpenChange={(o) => !o && setExportSource(null)} source={exportSource} />
      <ExportsDrawer open={exportsOpen} onOpenChange={setExportsOpen} />
    </Page>
  );
}
