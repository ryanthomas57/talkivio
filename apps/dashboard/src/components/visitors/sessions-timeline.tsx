'use client';
/**
 * Session timeline (ch. 11/25/43): each browsing session with its sanitized page
 * trail and dwell times computed by the server from receipt times. Sessions
 * without analytics consent show only that they happened.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { EyeOff, Radio } from 'lucide-react';
import { Badge, Button, PanelError, Skeleton } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatTime } from '@/lib/format';
import { byId, useSites } from '@/lib/queries';
import { ApproxCountry, DeviceLabel, originLabel, safeHref, urlLabel } from './display';
import { visitorKeys, type VisitorSessionRecord } from './types';

export function SessionsTimeline({ visitorId, pageSize = 10, maxPagesShown }: { visitorId: string; pageSize?: number; maxPagesShown?: number }) {
  const t = useT();
  const sites = byId(useSites().data);
  const q = useInfiniteQuery({
    queryKey: [...visitorKeys.sessions(visitorId), pageSize],
    queryFn: ({ pageParam }) => api.page<VisitorSessionRecord>(`/visitors/${visitorId}/sessions`, { cursor: pageParam ?? undefined, limit: pageSize }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    staleTime: 15_000,
  });

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (q.isError) return <PanelError className="p-0" message={t('visitors.sessions.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />;
  const sessions = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (!sessions.length) return <p className="text-sm text-fg-2">{t('visitors.sessions.empty')}</p>;

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2" aria-label={t('visitors.sessions.listLabel')}>
        {sessions.map((s, i) => (
          <li key={s.id}>
            <details open={i === 0} className="group rounded-[var(--radius-control)] border border-line bg-surface">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
                <span className="font-medium text-fg">
                  <time dateTime={s.startedAt}>{formatDateTime(s.startedAt)}</time>
                </span>
                {s.live ? (
                  <Badge tone="success" icon={<Radio className="size-3" aria-hidden />}>
                    {t('visitors.sessions.liveNow')}
                  </Badge>
                ) : (
                  <span className="text-xs text-fg-2">{s.endedAt ? t('visitors.sessions.endedAt', { time: formatTime(s.endedAt) }) : t('visitors.sessions.lastSeenAt', { time: formatTime(s.lastSeenAt) })}</span>
                )}
                {s.isPreview && <Badge tone="info">{t('common.preview')}</Badge>}
                <span className="text-xs text-fg-2">
                  <span dir="auto">{sites.get(s.siteId)?.name ?? t('visitors.page.site')}</span> · <DeviceLabel category={s.device.category} className="text-xs" />
                  {s.device.browser ? (
                    <>
                      {' · '}
                      <span dir="auto">{s.device.browser}</span>
                    </>
                  ) : null}
                </span>
                <span className="ms-auto text-xs text-fg-2 group-open:hidden">{s.browsingHidden ? t('visitors.sessions.detailsHidden') : t('visitors.sessions.pageCount', { count: s.pageViewCount ?? s.pages.length })}</span>
              </summary>
              <div className="border-t border-line-subtle px-3 py-3">
                {s.browsingHidden ? (
                  <p className="flex items-start gap-2 text-sm text-fg-2">
                    <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t('visitors.sessions.hiddenBody')}
                  </p>
                ) : (
                  <>
                    <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-fg-2 sm:grid-cols-2">
                      <div className="flex gap-1.5">
                        <dt>{t('visitors.sessions.referrer')}</dt>
                        <dd className="min-w-0 truncate text-fg" dir="auto">
                          {s.referrerOrigin ? originLabel(s.referrerOrigin) : t('visitors.live.direct')}
                        </dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt>{t('visitors.sessions.location')}</dt>
                        <dd className="min-w-0 text-fg">
                          <ApproxCountry code={s.country} />
                        </dd>
                      </div>
                      {s.visibleMs !== null && (
                        <div className="flex gap-1.5">
                          <dt>{t('visitors.sessions.visibleTime')}</dt>
                          <dd className="tabular text-fg">{formatDuration(s.visibleMs)}</dd>
                        </div>
                      )}
                      {s.exclusiveVisibleMs !== null && s.exclusiveVisibleMs !== s.visibleMs && (
                        <div className="flex gap-1.5">
                          <dt>{t('visitors.sessions.excludingTabs')}</dt>
                          <dd className="tabular text-fg">{formatDuration(s.exclusiveVisibleMs)}</dd>
                        </div>
                      )}
                    </dl>
                    {s.pages.length ? (
                      <ol className="relative flex flex-col gap-0 border-s border-line ps-4" aria-label={t('visitors.sessions.pagesLabel')}>
                        {(maxPagesShown ? s.pages.slice(-maxPagesShown) : s.pages).map((p, j) => {
                          const href = safeHref(p.url);
                          return (
                            <li key={`${p.enteredAt}-${j}`} className="relative py-1.5">
                              <span className="absolute -start-[21px] top-3 size-2 rounded-full bg-primary" aria-hidden />
                              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <span className="min-w-0 flex-1">
                                  {p.title && (
                                    <span className="block truncate text-sm font-medium text-fg" dir="auto">
                                      {p.title}
                                    </span>
                                  )}
                                  {href ? (
                                    <a href={href} target="_blank" rel="noopener noreferrer nofollow" dir="auto" className="block break-all text-xs text-primary hover:underline">
                                      {urlLabel(p.url)}
                                    </a>
                                  ) : (
                                    <span className="block break-all text-xs text-fg-2" dir="auto">
                                      {urlLabel(p.url)}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-xs text-fg-2">
                                  <time dateTime={p.enteredAt} title={formatDateTime(p.enteredAt)}>
                                    {formatTime(p.enteredAt)}
                                  </time>
                                  {' · '}
                                  <span className="tabular font-medium text-fg">{formatDuration(p.dwellMs)}</span>
                                  {!p.leftAt && s.live ? ` ${t('visitors.sessions.onPage')}` : ''}
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <p className="text-sm text-fg-2">{t('visitors.sessions.noPages')}</p>
                    )}
                    {(s.pagesTruncated || (maxPagesShown && s.pages.length > maxPagesShown)) && <p className="mt-2 text-xs text-fg-2">{t('visitors.sessions.truncated')}</p>}
                  </>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <div>
          <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('visitors.sessions.loadOlder')}
          </Button>
        </div>
      )}
    </div>
  );
}
