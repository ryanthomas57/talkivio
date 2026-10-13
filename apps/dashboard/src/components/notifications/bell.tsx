'use client';
/**
 * Topbar notifications (ch. 14): unread badge (visually capped at 99+, full count
 * in the accessible name), newest-first list with "Load more", mark-read on open,
 * "Mark all as read", and live updates from `notification.created` /
 * `notification.read` frames on the member's own agent room. Text is generated
 * server-side (generic when the member uses privacy mode).
 */
import * as Popover from '@radix-ui/react-popover';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, Inbox, Mail, MessageSquare, Repeat } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, CountBadge, Spinner } from '@/components/ui';
import { useEphemeralEvent, useResync } from '@/hooks/use-realtime';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useCan, useSession } from '@/stores/session';
import { dashboardLink } from './links';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  items: AppNotification[];
  unreadCount: number;
  nextCursor: string | null;
  hasMore: boolean;
}

const PAGE = 20;
export const NOTIFICATIONS_KEY = ['notifications', 'list'] as const;

const ICONS: Record<string, typeof Bell> = {
  'chat.assigned': MessageSquare,
  'chat.transfer_offered': Repeat,
  'chat.transferred': Repeat,
  'chat.transferred_away': Repeat,
  'offline.submitted': Mail,
};

type Data = InfiniteData<NotificationPage, string | null>;

function patchItems(data: Data | undefined, fn: (n: AppNotification) => AppNotification, unreadCount?: number): Data | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((p, i) => ({ ...p, items: p.items.map(fn), unreadCount: i === 0 && unreadCount !== undefined ? unreadCount : p.unreadCount })),
  };
}

export function NotificationsBell() {
  const t = useT();
  const ready = useSession((s) => s.status === 'ready' && !!s.agent);
  const canOffline = useCan('offline.view');
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const q = useInfiniteQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: ({ pageParam }) => api.get<NotificationPage>('/notifications', { cursor: pageParam, limit: PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: ready,
    staleTime: 60_000,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = q.data?.pages[0]?.unreadCount ?? 0;

  useEphemeralEvent<{ notification: AppNotification; unreadCount: number }>('notification.created', (e) => {
    const n = e.payload?.notification;
    if (!n) return;
    qc.setQueryData<Data>(NOTIFICATIONS_KEY, (data) => {
      if (!data || !data.pages.length) return data;
      const exists = data.pages.some((p) => p.items.some((x) => x.id === n.id));
      const [first, ...rest] = data.pages;
      return { ...data, pages: [{ ...first!, items: exists ? first!.items : [n, ...first!.items], unreadCount: e.payload.unreadCount }, ...rest] };
    });
    if (!q.data) void q.refetch();
    setAnnounce(t('notifications.announceNew', { title: n.title }));
  });

  useEphemeralEvent<{ ids: string[] | null; all: boolean; unreadCount: number }>('notification.read', (e) => {
    const ids = new Set(e.payload?.ids ?? []);
    const at = new Date().toISOString();
    qc.setQueryData<Data>(NOTIFICATIONS_KEY, (data) => patchItems(data, (n) => (e.payload.all || ids.has(n.id) ? { ...n, read: true, readAt: n.readAt ?? at } : n), e.payload.unreadCount));
  });

  useResync(() => void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }));

  const markRead = async (n: AppNotification) => {
    if (n.read) return;
    const at = new Date().toISOString();
    qc.setQueryData<Data>(NOTIFICATIONS_KEY, (data) => patchItems(data, (x) => (x.id === n.id ? { ...x, read: true, readAt: at } : x), Math.max(0, unread - 1)));
    try {
      const r = await api.post<{ id: string; readAt: string; unreadCount: number }>(`/notifications/${n.id}/read`);
      qc.setQueryData<Data>(NOTIFICATIONS_KEY, (data) => patchItems(data, (x) => x, r.unreadCount));
    } catch (e) {
      setError(t('notifications.markReadFailed', { error: errorMessage(e) }));
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    }
  };

  const [markingAll, setMarkingAll] = useState(false);
  const markAll = async () => {
    setMarkingAll(true);
    setError(null);
    try {
      await api.post('/notifications/read-all');
      const at = new Date().toISOString();
      qc.setQueryData<Data>(NOTIFICATIONS_KEY, (data) => patchItems(data, (n) => ({ ...n, read: true, readAt: n.readAt ?? at }), 0));
      setAnnounce(t('notifications.allMarkedRead'));
    } catch (e) {
      setError(t('notifications.markAllFailed', { error: errorMessage(e) }));
    } finally {
      setMarkingAll(false);
    }
  };

  const openItem = (n: AppNotification) => {
    void markRead(n);
    const href = dashboardLink(n.link);
    setOpen(false);
    if (href) router.push(href);
  };

  if (!ready) return null;
  const label = unread > 0 ? t('notifications.bellUnread', { count: unread }) : t('notifications.title');

  return (
    <div className="flex justify-end">
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) {
            setError(null);
            void q.refetch();
          }
        }}
      >
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} className="relative">
            <Bell className="size-5" aria-hidden />
            {unread > 0 && (
              <span className="pointer-events-none absolute -end-0.5 -top-0.5" aria-hidden>
                <CountBadge count={unread} label={t('notifications.unreadBadge')} tone="danger" className="h-[18px] min-w-[18px] px-1 text-[11px]" />
              </span>
            )}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            collisionPadding={8}
            aria-label={t('notifications.title')}
            className="z-50 flex max-h-[min(560px,calc(100dvh-80px))] w-[min(400px,calc(100vw-16px))] flex-col rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-float)] data-[state=open]:animate-fade-in"
          >
            <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-4 py-3">
              <div className="flex flex-col">
                <h2 className="text-base font-semibold">{t('notifications.title')}</h2>
                <p className="text-xs text-fg-2">{unread > 0 ? t('notifications.unreadCount', { count: unread }) : t('notifications.allCaughtUp')}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void markAll()} loading={markingAll} disabled={unread === 0}>
                <CheckCheck className="size-4" aria-hidden />
                {t('notifications.markAll')}
              </Button>
            </div>
            {error && (
              <div className="px-3 pt-3">
                <Banner tone="danger">{error}</Banner>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
              {q.isPending ? (
                <div className="flex justify-center py-10">
                  <Spinner label={t('notifications.loading')} />
                </div>
              ) : q.error && !items.length ? (
                <div className="p-3">
                  <Banner
                    tone="danger"
                    action={
                      <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
                        {t('common.retry')}
                      </Button>
                    }
                  >
                    {t('notifications.loadFailed', { error: errorMessage(q.error) })}
                  </Banner>
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                  <BellOff className="size-6 text-fg-2" aria-hidden />
                  <p className="font-medium">{t('notifications.emptyTitle')}</p>
                  <p className="text-sm text-fg-2">{t('notifications.emptyBody')}</p>
                </div>
              ) : (
                <ul className="flex flex-col py-1">
                  {items.map((n) => (
                    <NotificationItem key={n.id} n={n} onOpen={() => openItem(n)} />
                  ))}
                </ul>
              )}
              {q.hasNextPage && (
                <div className="border-t border-line-subtle p-2">
                  <Button variant="ghost" className="w-full" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                    {t('common.loadMore')}
                  </Button>
                </div>
              )}
            </div>
            {canOffline && (
            <div className="border-t border-line-subtle px-4 py-2 text-xs text-fg-2">
              <Link href="/offline-messages" className="inline-flex min-h-8 items-center gap-1 font-medium text-primary hover:underline" onClick={() => setOpen(false)}>
                <Inbox className="size-3.5" aria-hidden />
                {t('notifications.offlineMessages')}
              </Link>
            </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function NotificationItem({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const t = useT();
  const Icon = ICONS[n.type] ?? Bell;
  const href = dashboardLink(n.link);
  const content = (
    <>
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', n.read ? 'bg-surface-3 text-fg-2' : 'bg-primary-tint text-primary-hover dark:text-primary')}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('break-anywhere text-sm', n.read ? 'text-fg' : 'font-semibold text-fg')} dir="auto">
          {n.title}
        </span>
        {n.body && (
          <span className="line-clamp-2 break-anywhere text-sm text-fg-2" dir="auto">
            {n.body}
          </span>
        )}
        <span className="text-xs text-fg-2">
          <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
            {formatRelative(n.createdAt)}
          </time>
          {!n.read && <span className="sr-only">{t('notifications.srUnread')}</span>}
        </span>
      </span>
      {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
    </>
  );
  const cls = 'flex w-full items-start gap-3 px-4 py-3 text-start hover:bg-surface-2 focus-visible:bg-surface-2';
  return (
    <li className="border-b border-line-subtle last:border-b-0">
      {href ? (
        <a
          href={href}
          className={cls}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onOpen();
          }}
        >
          {content}
        </a>
      ) : (
        <button type="button" className={cls} onClick={onOpen} aria-label={n.read ? undefined : t('notifications.markAsReadLabel', { title: n.title })}>
          {content}
        </button>
      )}
    </li>
  );
}
