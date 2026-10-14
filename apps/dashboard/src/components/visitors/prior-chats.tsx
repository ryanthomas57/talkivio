'use client';
/** Department-scoped chats of one visitor, newest first, linking to History (ch. 17/43). */
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { Button, PanelError, Skeleton } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import type { StaffChat } from '@/lib/types';
import { useCan } from '@/stores/session';
import { ChatStatusLabel } from './chat-status';
import { visitorKeys } from './types';

export function PriorChats({
  visitorId,
  pageSize = 10,
  excludeId,
}: {
  visitorId: string;
  pageSize?: number;
  excludeId?: string;
}) {
  const t = useT();
  const canHistory = useCan('history.view');
  const departments = byId(useDepartments().data);
  const q = useInfiniteQuery({
    queryKey: [...visitorKeys.chats(visitorId), pageSize],
    queryFn: ({ pageParam }) =>
      api.page<StaffChat>(`/visitors/${visitorId}/chats`, {
        cursor: pageParam ?? undefined,
        limit: pageSize,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: canHistory,
    staleTime: 15_000,
  });
  if (!canHistory) return <p className="text-sm text-fg-2">{t('visitors.chats.noAccess')}</p>;
  if (q.isLoading) return <Skeleton className="h-20 w-full" />;
  if (q.isError)
    return (
      <PanelError
        className="p-0"
        message={t('visitors.chats.loadError', { error: errorMessage(q.error) })}
        onRetry={() => void q.refetch()}
      />
    );
  const chats = (q.data?.pages.flatMap((p) => p.items) ?? []).filter((c) => c.id !== excludeId);
  if (!chats.length) return <p className="text-sm text-fg-2">{t('visitors.chats.empty')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line-subtle rounded-[var(--radius-control)] border border-line">
        {chats.map((c) => {
          const end = c.closedAt ? Date.parse(c.closedAt) : null;
          return (
            <li key={c.id}>
              <Link
                href={`/history/${c.id}`}
                className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-fg">
                      {t('visitors.chats.chatNumber', { number: String(c.number) })}
                    </span>
                    <ChatStatusLabel status={c.status} />
                    {c.rating && (
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${c.rating.rating === 'good' ? 'text-success' : 'text-danger'}`}
                      >
                        {c.rating.rating === 'good' ? (
                          <ThumbsUp className="size-3" aria-hidden />
                        ) : (
                          <ThumbsDown className="size-3" aria-hidden />
                        )}
                        {c.rating.rating === 'good'
                          ? t('visitors.chats.ratingGood')
                          : t('visitors.chats.ratingBad')}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-fg-2">
                    <time dateTime={c.requestedAt} title={formatDateTime(c.requestedAt)}>
                      {formatRelative(c.requestedAt)}
                    </time>
                    {' · '}
                    <bdi>
                      {c.departmentId
                        ? (departments.get(c.departmentId)?.name ?? t('common.department'))
                        : t('visitors.live.noDepartment')}
                    </bdi>
                    {end ? ` · ${formatDuration(end - Date.parse(c.requestedAt))}` : ''}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-fg-2 rtl:-scale-x-100" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      {q.hasNextPage && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {t('visitors.chats.loadOlder')}
          </Button>
        </div>
      )}
    </div>
  );
}
