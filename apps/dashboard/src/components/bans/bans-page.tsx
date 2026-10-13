'use client';
/**
 * Settings → Bans (ch. 24): masked targets, scope, who created them, expiry and
 * reason; active / ended filter and search in the URL; audited unban with
 * confirmation; create ban dialog shared with the visitor profile.
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Search, ShieldBan, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Page, PageHeader, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { useAgents, useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { BanDialog } from './ban-dialog';
import { bansKey, type Ban } from './types';

type StatusFilter = 'active' | 'ended' | 'all';

export function BansPage() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canManage = useCan('bans.manage');
  const qc = useQueryClient();
  const sites = useSites();
  const agents = useAgents();
  const status = (['active', 'ended', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'active') as StatusFilter;
  const q = params.get('q') ?? '';

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
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => set({ q: search.trim() || null }), 300);
    return () => clearTimeout(timer);
  }, [search, q, set]);

  const list = useInfiniteQuery({
    queryKey: bansKey(status),
    queryFn: ({ pageParam }) => api.page<Ban>('/bans', { active: status === 'all' ? undefined : status === 'active' ? 'true' : 'false', cursor: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: canManage,
  });

  const siteName = useMemo(() => new Map((sites.data ?? []).map((s) => [s.id, s.name])), [sites.data]);
  const staffName = useMemo(() => new Map((agents.data ?? []).map((a) => [a.userId, a.displayName])), [agents.data]);
  const all = list.data?.pages.flatMap((p) => p.items) ?? [];
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? all.filter((b) =>
        [b.reason, b.target.kind === 'ip' ? b.target.masked : (b.target.displayName ?? ''), staffName.get(b.createdBy) ?? '', b.siteId ? (siteName.get(b.siteId) ?? '') : t('bans.scope.allSites')].some((s) => s.toLowerCase().includes(needle)),
      )
    : all;

  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Ban | null>(null);
  const targetLabel = (b: Ban) => (b.target.kind === 'ip' ? t('bans.target.ip', { ip: b.target.masked }) : (b.target.displayName ?? t('common.visitor')));

  if (!canManage)
    return (
      <Page>
        <EmptyState icon={<ShieldBan />} title={t('bans.page.noAccessTitle')} description={t('bans.page.noAccessBody')} />
      </Page>
    );

  return (
    <Page>
      <PageHeader
        title={t('bans.page.title')}
        description={t('bans.page.description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <ShieldBan className="size-4" aria-hidden /> {t('bans.page.create')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('bans.page.show')} className="w-full sm:w-48">
          <Select value={status} onChange={(e) => set({ status: e.target.value === 'active' ? null : e.target.value })}>
            <option value="active">{t('bans.page.filterActive')}</option>
            <option value="ended">{t('bans.page.filterEnded')}</option>
            <option value="all">{t('bans.page.filterAll')}</option>
          </Select>
        </Field>
        <Field label={t('common.search')} description={t('bans.page.searchHint')} className="w-full sm:w-80">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="ps-9" maxLength={100} />
          </div>
        </Field>
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : list.isError ? (
          <PanelError message={t('bans.page.loadFailed', { error: errorMessage(list.error) })} onRetry={() => void list.refetch()} />
        ) : !rows.length ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={needle ? t('bans.page.noMatch') : status === 'active' ? t('bans.page.emptyActive') : status === 'ended' ? t('bans.page.emptyEnded') : t('bans.page.emptyAll')}
            description={needle ? (list.hasNextPage ? t('bans.page.searchLoadedOnly') : t('bans.page.tryDifferent')) : t('bans.page.emptyBody')}
            action={
              needle ? (
                <Button variant="secondary" onClick={() => (setSearch(''), set({ q: null }))}>
                  {t('bans.page.clearSearch')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <TableScroll>
            <Table className="min-w-[980px]">
              <THead>
                <tr>
                  <TH>{t('bans.col.target')}</TH>
                  <TH>{t('bans.col.scope')}</TH>
                  <TH>{t('bans.col.createdBy')}</TH>
                  <TH>{t('bans.col.expires')}</TH>
                  <TH>{t('bans.col.reason')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      {b.target.kind === 'visitor' ? (
                        <span className="flex flex-col">
                          <Link href={`/visitors/${b.target.visitorId}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
                            <UserRound className="size-3.5" aria-hidden />
                            {b.target.displayName ? <bdi>{b.target.displayName}</bdi> : t('common.visitor')}
                          </Link>
                          <span className="text-xs text-fg-2">{t('bans.target.visitorIdentity')}</span>
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <span className="inline-flex items-center gap-1.5 font-mono text-sm">
                            <Globe className="size-3.5 text-fg-2" aria-hidden />
                            <bdi dir="ltr">{b.target.masked}</bdi>
                          </span>
                          <span className="text-xs text-fg-2">{t('bans.target.ipMasked')}</span>
                        </span>
                      )}
                    </TD>
                    <TD>{b.siteId ? siteName.get(b.siteId) ? <bdi>{siteName.get(b.siteId)}</bdi> : t('bans.scope.oneSite') : t('bans.scope.allSitesTitle')}</TD>
                    <TD>
                      <span className="flex flex-col">
                        <span>{staffName.get(b.createdBy) ? <bdi>{staffName.get(b.createdBy)}</bdi> : t('bans.page.formerStaff')}</span>
                        <time dateTime={b.createdAt} className="text-xs text-fg-2" title={formatDateTime(b.createdAt)}>
                          {formatRelative(b.createdAt)}
                        </time>
                      </span>
                    </TD>
                    <TD>{b.expiresAt ? <time dateTime={b.expiresAt} title={formatDateTime(b.expiresAt)}>{formatDateTime(b.expiresAt)}</time> : <span className="text-fg-2">{t('bans.page.never')}</span>}</TD>
                    <TD className="max-w-[260px]">
                      <span className="line-clamp-2 break-anywhere" title={b.reason} dir="auto">
                        {b.reason}
                      </span>
                    </TD>
                    <TD>
                      {b.active ? (
                        <Badge tone="danger" icon={<ShieldBan className="size-3.5" aria-hidden />}>
                          {t('bans.status.active')}
                        </Badge>
                      ) : b.revokedAt ? (
                        <Badge tone="neutral">{t('bans.status.unbanned', { date: formatDate(b.revokedAt) })}</Badge>
                      ) : (
                        <Badge tone="neutral">{t('bans.status.expired')}</Badge>
                      )}
                    </TD>
                    <TD className="text-end">
                      {b.active && (
                        <Button size="sm" variant="secondary" onClick={() => setRevoking(b)} aria-label={t('bans.unban.label', { target: targetLabel(b) })}>
                          {t('bans.unban.button')}
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center border-t border-line-subtle p-3">
            <Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('bans.page.loadMore')}
            </Button>
          </div>
        )}
      </Card>

      <BanDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('bans.unban.title', { target: isolate(revoking ? targetLabel(revoking) : '') })}
        description={
          revoking?.siteId
            ? t('bans.unban.bodySite', { target: isolate(targetLabel(revoking)), site: isolate(siteName.get(revoking.siteId)) || t('bans.unban.thatSite') })
            : revoking
              ? t('bans.unban.body', { target: isolate(targetLabel(revoking)) })
              : t('bans.unban.bodyGeneric')
        }
        confirmLabel={t('bans.unban.button')}
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/bans/${revoking.id}`);
          await qc.invalidateQueries({ queryKey: ['bans'] });
          toast.success(t('bans.unban.done', { target: isolate(targetLabel(revoking)) }));
        }}
      />
    </Page>
  );
}
