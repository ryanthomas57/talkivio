'use client';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { FileLock2, Plus, ShieldOff } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, Card, CardHeader, EmptyState, Field, Page, PageHeader, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useCan } from '@/stores/session';
import { NewRequestDialog } from './new-request-dialog';
import { humanize, KindBadge, PrivacyStateBadge, ProgressBar, stateLabel, SubjectName, useFallbackPoll, usePrivacyLive } from './privacy-shared';
import { RequestDrawer } from './request-drawer';
import { RetentionCard } from './retention-card';
import { ACTIVE_STATES, privacyKeys, type PrivacyKind, type PrivacyListItem, type PrivacyState } from './types';

const STATES: PrivacyState[] = ['pending_verification', 'queued', 'running', 'completed', 'failed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Settings → Privacy (ch. 53): subject access/erasure requests and retention. */
export function PrivacyView() {
  const t = useT();
  const canManage = useCan('privacy.manage');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const stateParam = sp.get('state');
  const state = STATES.includes(stateParam as PrivacyState) ? (stateParam as PrivacyState) : null;
  const kindParam = sp.get('kind');
  const kind: PrivacyKind | null = kindParam === 'access' || kindParam === 'erase' ? kindParam : null;
  const reqParam = sp.get('request');
  const selected = reqParam && UUID_RE.test(reqParam) ? reqParam : null;
  const [creating, setCreating] = useState(false);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };

  // privacy.updated reaches every privacy admin with live progress; polling is a slow fallback.
  usePrivacyLive();
  const fallbackPollMs = useFallbackPoll();

  const q = useInfiniteQuery({
    queryKey: privacyKeys.list(state, kind),
    queryFn: ({ pageParam }) => api.page<PrivacyListItem>('/privacy/requests', { state: state ?? undefined, kind: kind ?? undefined, cursor: pageParam, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: canManage,
    refetchInterval: (query) => fallbackPollMs(!!query.state.data?.pages.some((p) => p.items.some((r) => ACTIVE_STATES.has(r.state))), 30_000),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  if (!canManage) {
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('privacy.view.noAccessTitle')} description={t('privacy.view.noAccessBody')} />
      </Page>
    );
  }

  const filtered = !!state || !!kind;

  return (
    <Page>
      <PageHeader
        title={t('privacy.view.title')}
        description={t('privacy.view.description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            {t('privacy.view.newRequest')}
          </Button>
        }
      />

      <Banner tone="info" title={t('privacy.view.legalHoldTitle')}>
        {t('privacy.view.legalHoldBody')}
      </Banner>

      <Card>
        <CardHeader title={t('privacy.list.title')} description={t('privacy.list.description')} />
        <div className="flex flex-wrap items-end gap-4 border-b border-line-subtle px-4 py-3 sm:px-6">
          <Field label={t('privacy.list.state')} className="w-full sm:w-56">
            <Select value={state ?? ''} onChange={(e) => setParams({ state: e.target.value || null })}>
              <option value="">{t('privacy.list.allStates')}</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {stateLabel(t, s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('privacy.list.type')} className="w-full sm:w-48">
            <Select value={kind ?? ''} onChange={(e) => setParams({ kind: e.target.value || null })}>
              <option value="">{t('privacy.list.allTypes')}</option>
              <option value="access">{t('privacy.list.typeAccess')}</option>
              <option value="erase">{t('privacy.list.typeErase')}</option>
            </Select>
          </Field>
        </div>
        {q.isPending ? (
          <div className="flex flex-col gap-3 p-4 sm:p-6" aria-busy>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : q.error && !items.length ? (
          <PanelError message={t('privacy.list.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<FileLock2 />}
            title={filtered ? t('privacy.list.emptyFilteredTitle') : t('privacy.list.emptyTitle')}
            description={filtered ? t('privacy.list.emptyFilteredBody') : t('privacy.list.emptyBody')}
            action={
              filtered ? (
                <Button variant="secondary" onClick={() => setParams({ state: null, kind: null })}>
                  {t('privacy.list.clearFilters')}
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setCreating(true)}>
                  {t('privacy.view.newRequest')}
                </Button>
              )
            }
          />
        ) : (
          <>
            {q.error && (
              <div className="px-4 pt-4 sm:px-6">
                <Banner tone="danger">{t('privacy.list.refreshFailed', { error: errorMessage(q.error) })}</Banner>
              </div>
            )}
            <TableScroll>
              <Table className="min-w-[760px]">
                <THead>
                  <tr>
                    <TH>{t('privacy.list.type')}</TH>
                    <TH>{t('privacy.list.colSubject')}</TH>
                    <TH>{t('privacy.list.state')}</TH>
                    <TH>{t('common.created')}</TH>
                    <TH className="w-56">{t('privacy.list.colProgress')}</TH>
                    <TH>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TH>
                  </tr>
                </THead>
                <tbody>
                  {items.map((r) => (
                    <TR key={r.id} selected={selected === r.id}>
                      <TD>
                        <KindBadge kind={r.kind} />
                      </TD>
                      <TD className="max-w-[220px] truncate font-medium">
                        <SubjectName r={r} />
                      </TD>
                      <TD>
                        <PrivacyStateBadge state={r.state} />
                      </TD>
                      <TD className="whitespace-nowrap">
                        <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>
                          {formatRelative(r.createdAt)}
                        </time>
                      </TD>
                      <TD>
                        <RowProgress r={r} />
                      </TD>
                      <TD className="text-end">
                        <Button size="sm" variant={r.state === 'pending_verification' || r.state === 'failed' ? 'primary' : 'secondary'} onClick={() => setParams({ request: r.id })}>
                          {r.state === 'pending_verification' ? t('privacy.list.verify') : r.state === 'failed' ? t('privacy.list.review') : t('common.view')}
                          <span className="sr-only">{t('privacy.list.rowSr', { kind: r.kind })}</span>
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
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

      <RetentionCard />

      <NewRequestDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(r) => {
          qc.setQueryData(privacyKeys.detail(r.id), r);
          void qc.invalidateQueries({ queryKey: privacyKeys.all });
          setParams({ request: r.id });
        }}
        onOpenExisting={(id) => setParams({ request: id })}
      />
      <RequestDrawer id={selected} onClose={() => setParams({ request: null })} />
    </Page>
  );
}

function RowProgress({ r }: { r: PrivacyListItem }) {
  const t = useT();
  if (r.state === 'pending_verification') return <span className="text-sm text-fg-2">{t('privacy.list.needsVerification')}</span>;
  if (r.state === 'completed') return <span className="text-sm text-fg-2">{r.completedAt ? t('privacy.list.doneAt', { relative: formatRelative(r.completedAt) }) : t('common.done')}</span>;
  if (r.state === 'failed') return <span className="text-sm text-danger">{t('privacy.list.failedResume', { reason: r.report?.errorCode ? humanize(t, r.report.errorCode) : t('privacy.list.stopped') })}</span>;
  return <ProgressBar value={r.job?.progress ?? null} label={t('privacy.list.progressLabel', { kind: r.kind })} />;
}
