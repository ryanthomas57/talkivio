'use client';
/**
 * Offline messages left through the widget form or converted from a queue wait
 * (ch. 23). Department scoped; new submissions appear live from `offline.submitted`.
 * Contact details are only shown on the detail page.
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Link2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { Badge, Banner, Button, Card, EmptyState, Field, Page, PageHeader, PanelError, Select, Skeleton } from '@/components/ui';
import { useRealtimeEvent, useResync } from '@/hooks/use-realtime';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { byId, useDepartments, useSites } from '@/lib/queries';
import { useCan, useSession } from '@/stores/session';
import { OfflineStatusBadge, offlineKeys, useOfflineScopes } from './shared';
import type { OfflineEventPayload, OfflineSummary } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StatusFilter = 'received' | 'handled' | 'all';

export function OfflineList() {
  const t = useT();
  const canView = useCan('offline.view');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const status: StatusFilter = sp.get('status') === 'handled' ? 'handled' : sp.get('status') === 'all' ? 'all' : 'received';
  const deptParam = sp.get('department');
  const departmentId = deptParam && UUID_RE.test(deptParam) ? deptParam : null;
  const scope = useSession((s) => s.agent?.departmentScope ?? 'all');
  const departments = useDepartments(canView);
  const sites = useSites(canView);
  const deptById = byId(departments.data);
  const siteById = byId(sites.data);
  const deptOptions = useMemo(
    () => (departments.data ?? []).filter((d) => !d.archivedAt && (scope === 'all' || scope.includes(d.id))).sort((a, b) => a.name.localeCompare(b.name)),
    [departments.data, scope],
  );
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const known = useRef<Set<string>>(new Set());

  const setParam = (k: string, v: string | null) => {
    const q = new URLSearchParams(sp.toString());
    if (v) q.set(k, v);
    else q.delete(k);
    router.replace(q.toString() ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  useOfflineScopes();
  const key = offlineKeys.list(status, departmentId);
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.page<OfflineSummary>('/offline-submissions', { status: status === 'all' ? undefined : status, departmentId, cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: canView,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  for (const it of items) known.current.add(it.id);

  useRealtimeEvent<OfflineEventPayload>('offline.submitted', (e) => {
    const s = e.payload?.submission;
    if (!s) return;
    const matches = (status === 'all' || status === 'received') && (!departmentId || s.departmentId === departmentId);
    void qc.invalidateQueries({ queryKey: offlineKeys.listAll });
    if (matches && !known.current.has(s.id)) {
      setFresh((f) => new Set(f).add(s.id));
      setAnnounce(s.name ? t('offline.list.announceFrom', { reference: s.reference, name: s.name }) : t('offline.list.announce', { reference: s.reference }));
    }
  });
  useRealtimeEvent<OfflineEventPayload>('offline.updated', (e) => {
    const s = e.payload?.submission;
    if (!s) return;
    void qc.invalidateQueries({ queryKey: offlineKeys.listAll });
    void qc.invalidateQueries({ queryKey: offlineKeys.detail(s.id) });
  });
  useResync(() => void qc.invalidateQueries({ queryKey: offlineKeys.listAll }));

  if (!canView) {
    return (
      <Page>
        <EmptyState icon={<Inbox />} title={t('offline.noAccessTitle')} description={t('offline.list.noAccessBody')} />
      </Page>
    );
  }

  /** Variables shared by the list label and the empty-state sentence (status × department filter). */
  const filterVars = {
    status,
    dept: departmentId ? (deptById.get(departmentId) ? 'named' : 'this') : 'none',
    department: departmentId ? (deptById.get(departmentId)?.name ?? '') : '',
  };

  return (
    <Page>
      <PageHeader title={t('offline.list.title')} description={t('offline.list.description')} />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t('common.status')} className="w-full sm:w-56">
          <Select value={status} onChange={(e) => setParam('status', e.target.value === 'received' ? null : e.target.value)}>
            <option value="received">{t('offline.status.received')}</option>
            <option value="handled">{t('offline.status.handled')}</option>
            <option value="all">{t('offline.list.allStatuses')}</option>
          </Select>
        </Field>
        <Field label={t('common.department')} className="w-full sm:w-64">
          <Select value={departmentId ?? ''} onChange={(e) => setParam('department', e.target.value || null)}>
            <option value="">{scope === 'all' ? t('offline.list.allDepartments') : t('offline.list.allMyDepartments')}</option>
            {deptOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Card>
        {q.isPending ? (
          <ul aria-busy className="divide-y divide-line-subtle">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="flex flex-col gap-2 px-4 py-4 sm:px-6">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-full max-w-lg" />
              </li>
            ))}
          </ul>
        ) : q.error && !items.length ? (
          <PanelError message={t('offline.list.loadFailed', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={status === 'received' ? t('offline.list.emptyReceived') : t('offline.list.emptyMatch')}
            description={t('offline.list.emptyBody', { ...filterVars, hint: status !== 'all' ? 'status' : departmentId ? 'department' : 'none' })}
            action={
              status !== 'all' || departmentId ? (
                <Button variant="secondary" onClick={() => router.replace(`${pathname}?status=all`, { scroll: false })}>
                  {t('offline.list.showAll')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {q.error && (
              <div className="px-4 pt-4 sm:px-6">
                <Banner tone="danger">{t('offline.list.refreshFailed', { error: errorMessage(q.error) })}</Banner>
              </div>
            )}
            <ul className="divide-y divide-line-subtle" aria-label={t('offline.list.listLabel', filterVars)}>
              {items.map((m) => (
                <li key={m.id}>
                  <Link href={`/offline-messages/${m.id}`} className="flex flex-col gap-1.5 px-4 py-4 hover:bg-surface-2 sm:px-6">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-sm font-semibold text-fg" dir="ltr">
                        {m.reference}
                      </span>
                      <OfflineStatusBadge status={m.status} />
                      {fresh.has(m.id) && <Badge tone="info">{t('offline.list.new')}</Badge>}
                      {m.sourceChatId && (
                        <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                          <Link2 className="size-3.5" aria-hidden />
                          {t('offline.list.fromQueuedChat')}
                        </span>
                      )}
                      <time dateTime={m.createdAt} title={formatDateTime(m.createdAt)} className="ms-auto text-xs text-fg-2">
                        {formatRelative(m.createdAt)}
                      </time>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-sm">
                      {m.name ? (
                        <span className="font-medium text-fg" dir="auto">
                          {m.name}
                        </span>
                      ) : (
                        <span className="font-medium text-fg">{t('offline.list.nameNotGiven')}</span>
                      )}
                      <span className="text-fg-2">
                        · {m.departmentId ? (deptById.get(m.departmentId) ? <bdi>{deptById.get(m.departmentId)!.name}</bdi> : t('common.department')) : t('offline.noDepartment')}
                        {sites.data && sites.data.length > 1 && (
                          <>
                            {' · '}
                            {siteById.get(m.siteId) ? <bdi>{siteById.get(m.siteId)!.name}</bdi> : t('offline.list.site')}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="line-clamp-2 break-anywhere text-sm text-fg-2" dir="auto">
                      {m.messagePreview}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {q.hasNextPage && (
              <div className="border-t border-line-subtle p-3 text-center">
                <Button variant="secondary" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  {t('common.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}
