'use client';
import { Inbox as InboxIcon, Mail, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Button, CountBadge, EmptyState, PanelError, Skeleton } from '@/components/ui';
import { useNow } from '@/hooks/use-media';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDuration, formatDurationLong, formatTime } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import { realtime } from '@/lib/realtime';
import type { StaffChat } from '@/lib/types';
import { focusComposerWhenReady } from './composer';
import { useInbox, type InboxView } from '@/stores/inbox';
import { useSession } from '@/stores/session';
import { useT, type MessageKey } from '@/i18n';

const ROUTE_REASON: Record<string, MessageKey> = {
  department_selected: 'inbox.routeReason.departmentSelected',
  trigger_override: 'inbox.routeReason.triggerOverride',
  default: 'inbox.routeReason.default',
  invitation_accepted: 'inbox.routeReason.invitationAccepted',
  fallback: 'inbox.routeReason.fallback',
};

/** Unassigned / Mine / All lists with live wait timers (ch. 12). */
export function ChatList({ activeId }: { activeId: string | null }) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const view = (params.get('view') as InboxView | null) ?? 'mine';
  const canAll = useSession((s) => s.agent?.departmentScope === 'all' || s.permissions.has('chats.monitor'));
  const canOffline = useSession((s) => s.permissions.has('offline.view'));
  const lists = useInbox((s) => s.lists);
  const status = useInbox((s) => s.listStatus);
  const errors = useInbox((s) => s.listError);
  const loadList = useInbox((s) => s.loadList);
  const chats = useInbox((s) => s.chats);
  const ended = useInbox((s) => s.endedOpen);

  useEffect(() => {
    if (view === 'all' && status.all === 'idle') void loadList('all');
  }, [view, status.all, loadList]);

  const tabs: Array<{ id: InboxView; label: string; count: number }> = [
    { id: 'mine', label: t('inbox.list.mine'), count: lists.mine.filter((id) => !ended.includes(id)).length },
    { id: 'queue', label: t('inbox.list.unassigned'), count: lists.queue.length },
    ...(canAll ? [{ id: 'all' as const, label: t('inbox.list.all'), count: lists.all.length }] : []),
  ];
  const setView = (v: InboxView) => {
    const q = new URLSearchParams(params.toString());
    q.set('view', v);
    router.replace(`${window.location.pathname}?${q.toString()}`, { scroll: false });
  };
  const ids = lists[view] ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* The list column is 280 px: tabs may shrink (a long label truncates, its count never clips). */}
      <div
        role="tablist"
        aria-label={t('inbox.list.tablistLabel')}
        className="flex h-14 shrink-0 items-end gap-0.5 border-b border-line px-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={view === tab.id}
            aria-controls="chat-list-panel"
            title={tab.label}
            onClick={() => setView(tab.id)}
            className={cn(
              '-mb-px inline-flex h-11 min-w-0 items-center gap-1.5 border-b-2 px-2 text-sm font-medium',
              view === tab.id ? 'border-primary text-fg' : 'border-transparent text-fg-2 hover:text-fg',
            )}
          >
            <span className="truncate">{tab.label}</span>
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 text-xs tabular',
                view === tab.id
                  ? 'bg-primary-tint text-primary-hover dark:text-primary'
                  : 'bg-surface-3 text-fg-2',
              )}
              aria-label={t('inbox.list.chatCount', { count: tab.count })}
            >
              {tab.count > 99 ? '99+' : tab.count}
            </span>
          </button>
        ))}
      </div>
      <div
        id="chat-list-panel"
        role="tabpanel"
        aria-labelledby={`tab-${view}`}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin"
      >
        {status[view] === 'loading' && !ids.length ? (
          <ListSkeleton />
        ) : status[view] === 'error' ? (
          <PanelError
            message={errors[view] ?? t('inbox.list.loadError')}
            onRetry={() => void loadList(view)}
          />
        ) : ids.length === 0 ? (
          <EmptyState
            icon={<InboxIcon />}
            title={t(
              view === 'queue'
                ? 'inbox.list.emptyQueueTitle'
                : view === 'mine'
                  ? 'inbox.list.emptyMineTitle'
                  : 'inbox.list.emptyAllTitle',
            )}
            description={t(
              view === 'queue'
                ? 'inbox.list.emptyQueueBody'
                : view === 'mine'
                  ? 'inbox.list.emptyMineBody'
                  : 'inbox.list.emptyAllBody',
            )}
          />
        ) : (
          <ul className="flex flex-col">
            {ids.map(
              (id) =>
                chats[id] && (
                  <ChatRow
                    key={id}
                    chat={chats[id]!}
                    view={view}
                    active={id === activeId}
                    ended={ended.includes(id)}
                  />
                ),
            )}
          </ul>
        )}
      </div>
      {canOffline && (
        <Link
          href="/offline-messages"
          className="flex min-h-11 shrink-0 items-center gap-2 border-t border-line px-4 text-sm font-medium text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          <Mail className="size-4" aria-hidden /> {t('inbox.list.offlineMessages')}
        </Link>
      )}
    </div>
  );
}

function ListSkeleton() {
  const t = useT();
  return (
    <div className="flex flex-col" aria-busy="true" aria-label={t('inbox.list.loading')}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex h-[76px] items-center gap-3 border-b border-line-subtle px-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatRow({
  chat,
  view,
  active,
  ended,
}: {
  chat: StaffChat;
  view: InboxView;
  active: boolean;
  ended: boolean;
}) {
  const t = useT();
  const now = useNow(1000);
  const router = useRouter();
  const me = useSession((s) => s.agent?.agent.id);
  const departments = byId(useDepartments().data);
  const [busy, setBusy] = useState(false);
  const waiting = chat.status === 'queued' || chat.status === 'offered';
  const wait = now - Date.parse(chat.requestedAt);
  const dept = chat.departmentId ? departments.get(chat.departmentId)?.name : null;
  const unread = chat.unreadCount ?? 0;
  const reasonKey = chat.routeReason ? ROUTE_REASON[chat.routeReason] : undefined;
  const reason = chat.routeReason ? (reasonKey ? t(reasonKey) : chat.routeReason.replace(/_/g, ' ')) : null;
  const severity = waiting
    ? wait >= 180_000
      ? 'text-danger'
      : wait >= 60_000
        ? 'text-warning'
        : 'text-fg-2'
    : 'text-fg-2';
  const participant = !!me && (chat.ownerMembershipId === me || chat.collaboratorIds.includes(me));

  const accept = async () => {
    setBusy(true);
    try {
      const c = realtime.connected
        ? await realtime.command<StaffChat>('offer.accept', { chatId: chat.id, offerId: null })
        : await api.post<StaffChat>(`/chats/${chat.id}/accept`, {});
      focusComposerWhenReady(chat.id);
      useInbox.getState().upsertChat(c);
      router.push(`/inbox/${chat.id}`);
    } catch (e) {
      if (isApiError(e, 'CHAT_ALREADY_ASSIGNED')) toast.info(t('inbox.accept.takenElsewhere'));
      else if (isApiError(e, 'CAPACITY_EXCEEDED')) toast.error(t('inbox.accept.atCapacity'));
      else toast.error(t('inbox.accept.failed', { error: errorMessage(e) }));
      void useInbox.getState().loadChat(chat.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={cn(
        'relative flex min-h-[76px] gap-3 border-b border-line-subtle px-4 py-3',
        active ? 'bg-primary-tint/70' : 'hover:bg-surface-2',
      )}
    >
      <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="md" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Link
            href={`/inbox/${chat.id}?view=${view}`}
            aria-current={active ? 'page' : undefined}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-fg after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-primary"
          >
            <bdi>{chat.visitor.displayName}</bdi>
            <span className="sr-only">
              {waiting
                ? t('inbox.row.srWaiting', { duration: formatDurationLong(wait) })
                : ended
                  ? t('inbox.row.srEnded')
                  : ''}
              {unread ? t('inbox.row.srUnread', { count: unread }) : ''}
            </span>
          </Link>
          {waiting ? (
            <span className={cn('shrink-0 text-xs font-medium tabular', severity)} aria-hidden>
              {formatDuration(wait)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-fg-2" aria-hidden>
              {formatTime(chat.lastMessageAt)}
            </span>
          )}
        </div>
        <p
          className={cn(
            'flex items-center gap-1 truncate text-sm',
            unread ? 'font-medium text-fg' : 'text-fg-2',
          )}
        >
          {chat.lastMessagePreview.startsWith('📎') && (
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate" dir="auto">
            {chat.lastMessagePreview.replace(/^📎\s*/, '') || t('inbox.row.noMessages')}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-xs text-fg-2">
            {dept && <span className="truncate">{dept}</span>}
            {waiting && reason && <span className="truncate">· {reason}</span>}
            {ended && <span className="font-medium">· {t('inbox.row.ended')}</span>}
            {!waiting && !ended && chat.awaitingReply && participant && (
              <span className="font-medium text-warning">· {t('inbox.row.awaitingReply')}</span>
            )}
            {chat.status === 'offered' && (
              <span className="font-medium text-info">· {t('inbox.row.offered')}</span>
            )}
          </p>
          <CountBadge count={unread} label={t('inbox.row.unreadMessages')} className="relative z-[1]" />
          {waiting && !participant && (
            <Button
              size="sm"
              variant="primary"
              onClick={accept}
              loading={busy}
              aria-label={t('inbox.accept.withName', { name: chat.visitor.displayName })}
              className="relative z-[1] h-7 px-2.5"
            >
              {t('inbox.accept.button')}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
