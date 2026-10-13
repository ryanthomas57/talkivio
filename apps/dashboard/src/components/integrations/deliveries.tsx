'use client';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History, RotateCw } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Banner, Button, Card, CardHeader, EmptyState, Field, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT, type Translate } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { CopyButton } from './secret-panel';
import { integrationKeys, type DeliveryStatus, type WebhookDelivery } from './types';
import { DELIVERY_FILTERS, DeliveryStatusBadge, eventLabel, IN_FLIGHT } from './webhook-shared';

/** HTTP status, else the server's error code (a code, shown humanized as-is). */
function responseSummary(t: Translate, d: WebhookDelivery): string {
  if (d.responseStatus !== null) return t('integrations.http', { status: String(d.responseStatus) });
  if (d.lastError) return d.lastError.split(':')[0]!.replace(/_/g, ' ');
  return '—';
}

export function DeliveriesCard({ endpointId, status, onStatus, enabled }: { endpointId: string; status: DeliveryStatus | null; onStatus: (s: DeliveryStatus | null) => void; enabled: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: integrationKeys.deliveries(endpointId, status),
    queryFn: ({ pageParam }) => api.page<WebhookDelivery>(`/webhooks/${endpointId}/deliveries`, { status: status ?? undefined, cursor: pageParam, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    // Keep in-flight deliveries current without a manual refresh.
    refetchInterval: (query) => (query.state.data?.pages[0]?.items.some((d) => IN_FLIGHT.has(d.status)) ? 4000 : false),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const retry = async (d: WebhookDelivery) => {
    setRetrying(d.id);
    setRetryError(null);
    try {
      await api.post(`/webhook-deliveries/${d.id}/retry`, {}, { idempotencyKey: uuid() });
      toast.success(t('integrations.deliveries.redeliveryQueued', { id: isolate(d.eventId.slice(0, 8)) }));
      await qc.invalidateQueries({ queryKey: integrationKeys.deliveriesFor(endpointId) });
      void qc.invalidateQueries({ queryKey: integrationKeys.webhooks, exact: true }); // list shows the latest delivery
    } catch (e) {
      setRetryError(t('integrations.deliveries.retryFailed', { event: eventLabel(t, d.eventType), error: errorMessage(e) }));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('integrations.deliveries.title')}
        description={t('integrations.deliveries.description')}
        action={
          <Field label={t('integrations.deliveries.filterLabel')} hideLabel className="w-44">
            <Select value={status ?? ''} onChange={(e) => onStatus((e.target.value || null) as DeliveryStatus | null)}>
              {DELIVERY_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {t(f.label)}
                </option>
              ))}
            </Select>
          </Field>
        }
      />
      {retryError && (
        <div className="px-4 pt-4 sm:px-6">
          <Banner
            tone="danger"
            action={
              <Button size="sm" variant="ghost" onClick={() => setRetryError(null)}>
                {t('common.dismiss')}
              </Button>
            }
          >
            {retryError}
          </Banner>
        </div>
      )}
      {!enabled && (
        <div className="px-4 pt-4 sm:px-6">
          <Banner tone="info">{t('integrations.deliveries.disabledNotice')}</Banner>
        </div>
      )}
      {q.isPending ? (
        <div className="flex flex-col gap-3 p-4 sm:p-6" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : q.error && !items.length ? (
        <PanelError message={t('integrations.deliveries.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={status ? t('integrations.deliveries.emptyStatusTitle', { status }) : t('integrations.deliveries.emptyTitle')}
          description={status ? t('integrations.deliveries.emptyStatusBody') : t('integrations.deliveries.emptyBody')}
          action={
            status ? (
              <Button variant="secondary" onClick={() => onStatus(null)}>
                {t('integrations.deliveries.showAll')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {q.error && (
            <div className="px-4 pt-4 sm:px-6">
              <Banner tone="danger">{t('integrations.deliveries.refreshFailed', { error: errorMessage(q.error) })}</Banner>
            </div>
          )}
          <TableScroll>
            <Table className="min-w-[860px]">
              <THead>
                <tr>
                  <TH className="w-10">
                    <span className="sr-only">{t('common.details')}</span>
                  </TH>
                  <TH>{t('integrations.deliveries.colEvent')}</TH>
                  <TH>{t('common.status')}</TH>
                  <TH className="text-end">{t('integrations.deliveries.colAttempts')}</TH>
                  <TH>{t('integrations.deliveries.colLastResponse')}</TH>
                  <TH>{t('integrations.deliveries.colNextRetry')}</TH>
                  <TH>{t('common.created')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </tr>
              </THead>
              <tbody>
                {items.map((d) => {
                  const expanded = open.has(d.id);
                  const canRetry = !IN_FLIGHT.has(d.status);
                  return (
                    <Fragment key={d.id}>
                      <TR className={expanded ? 'border-b-0' : undefined}>
                        <TD className="pe-0">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-expanded={expanded}
                            aria-controls={`delivery-${d.id}`}
                            aria-label={t(expanded ? 'integrations.deliveries.hideDetailsFor' : 'integrations.deliveries.showDetailsFor', { event: eventLabel(t, d.eventType) })}
                            onClick={() => toggle(d.id)}
                          >
                            {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />}
                          </Button>
                        </TD>
                        <TD>
                          <span className="block font-medium">{eventLabel(t, d.eventType)}</span>
                          <code className="font-mono text-xs text-fg-2" title={d.eventId} dir="ltr">
                            {d.eventId.slice(0, 8)}…
                          </code>
                        </TD>
                        <TD>
                          <DeliveryStatusBadge status={d.status} />
                        </TD>
                        <TD className="text-end tabular">{d.attempts}</TD>
                        <TD className="whitespace-nowrap" dir="auto">
                          {responseSummary(t, d)}
                        </TD>
                        <TD className="whitespace-nowrap">
                          {d.nextAttemptAt ? (
                            <time dateTime={d.nextAttemptAt} title={formatDateTime(d.nextAttemptAt)}>
                              {new Date(d.nextAttemptAt).getTime() <= Date.now() ? t('integrations.deliveries.dueNow') : formatRelative(d.nextAttemptAt)}
                            </time>
                          ) : (
                            <span className="text-fg-2">—</span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap">
                          <time dateTime={d.createdAt} title={formatDateTime(d.createdAt)}>
                            {formatRelative(d.createdAt)}
                          </time>
                        </TD>
                        <TD className="text-end">
                          {canRetry && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={retrying === d.id}
                              disabled={!enabled || (retrying !== null && retrying !== d.id)}
                              onClick={() => void retry(d)}
                              aria-label={t('integrations.deliveries.retryLabel', { event: eventLabel(t, d.eventType), id: isolate(d.eventId.slice(0, 8)) })}
                            >
                              <RotateCw className="size-4" aria-hidden />
                              {t('common.retry')}
                            </Button>
                          )}
                        </TD>
                      </TR>
                      {expanded && (
                        <tr id={`delivery-${d.id}`} className="border-b border-line-subtle bg-surface-2">
                          <td colSpan={8} className="px-4 py-4 sm:px-6">
                            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.eventId')}</dt>
                              <dd className="flex flex-wrap items-center gap-2">
                                <code className="break-all font-mono text-xs" dir="ltr">
                                  {d.eventId}
                                </code>
                                <CopyButton text={d.eventId} what={t('integrations.what.eventId')} />
                              </dd>
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.eventType')}</dt>
                              <dd>
                                <code className="font-mono text-xs" dir="ltr">
                                  {d.eventType}
                                </code>
                              </dd>
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.lastError')}</dt>
                              <dd className="break-words" dir={d.lastError ? 'auto' : undefined}>
                                {d.lastError ?? <span className="text-fg-2">{t('common.none')}</span>}
                              </dd>
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.duration')}</dt>
                              <dd>{d.durationMs !== null ? t('integrations.deliveries.durationMs', { ms: d.durationMs }) : <span className="text-fg-2">—</span>}</dd>
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.delivered')}</dt>
                              <dd>{d.deliveredAt ? formatDateTime(d.deliveredAt) : <span className="text-fg-2">{t('integrations.deliveries.notDelivered')}</span>}</dd>
                              <dt className="font-medium text-fg-2">{t('common.created')}</dt>
                              <dd>{formatDateTime(d.createdAt)}</dd>
                              <dt className="font-medium text-fg-2">{t('integrations.deliveries.responseExcerpt')}</dt>
                              <dd className="min-w-0">
                                {d.responseExcerpt ? (
                                  <pre dir="ltr" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] border border-line bg-surface p-3 font-mono text-xs scroll-thin">{d.responseExcerpt}</pre>
                                ) : (
                                  <span className="text-fg-2">{t('integrations.deliveries.noResponseBody')}</span>
                                )}
                                <p className="mt-1 text-xs text-fg-2">{t('integrations.deliveries.excerptNote', { count: 1000 })}</p>
                              </dd>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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
  );
}
