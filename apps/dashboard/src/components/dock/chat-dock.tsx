'use client';
/**
 * Chat dock: Zendesk-style chat windows along the bottom edge, on every page. Opening a visitor from the
 * Visitors list, accepting a chat request, or starting a chat with a browsing visitor puts a window here; it
 * keeps the transcript live and can be minimized, expanded into the Inbox, or closed (closing a window
 * never ends the chat). The chat currently open in the Inbox is not duplicated here.
 */
import { Maximize2, MessageSquarePlus, Minus, SendHorizontal, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar, Button, CountBadge } from '@/components/ui';
import { ComposerArea } from '@/components/inbox/conversation';
import { focusComposerWhenReady } from '@/components/inbox/composer';
import { Transcript } from '@/components/inbox/transcript';
import { useMediaQuery } from '@/hooks/use-media';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { countryName, flagEmoji } from '@/lib/format';
import type { Message, StaffChat } from '@/lib/types';
import { useDock, type DockVisitor, type DockWindow } from '@/stores/dock';
import { useInbox } from '@/stores/inbox';
import { useCan, useSession } from '@/stores/session';

const STATUS: Record<
  StaffChat['status'],
  { label: MessageKey; tone: 'warning' | 'info' | 'success' | 'neutral' }
> = {
  queued: { label: 'inbox.status.queued', tone: 'warning' },
  offered: { label: 'inbox.status.offered', tone: 'info' },
  active: { label: 'inbox.status.active', tone: 'success' },
  closed: { label: 'inbox.status.closed', tone: 'neutral' },
};

/** How many windows fit side by side (each ~360 px). Phones show one, full width. */
function useCapacity(): number {
  const xl = useMediaQuery('(min-width: 1600px)', true);
  const lg = useMediaQuery('(min-width: 1200px)', true);
  const md = useMediaQuery('(min-width: 900px)', true);
  return xl ? 4 : lg ? 3 : md ? 2 : 1;
}

export function ChatDock() {
  const t = useT();
  const windows = useDock((s) => s.windows);
  const pathname = usePathname();
  const signedIn = useSession((s) => !!s.agent);
  const capacity = useCapacity();
  const routeChat = pathname.startsWith('/inbox/') ? (pathname.split('/')[2] ?? null) : null;
  const shown = windows.filter((w) => !(w.kind === 'chat' && w.chatId === routeChat)).slice(-capacity);
  if (!signedIn || !shown.length) return null;
  return (
    <section
      aria-label={t('dock.region')}
      className="pointer-events-none fixed bottom-0 end-0 z-30 flex max-w-full items-end gap-3 sm:end-4"
    >
      {shown.map((w) =>
        w.kind === 'chat' ? (
          <ChatWindow key={w.key} w={w} chatId={w.chatId} />
        ) : (
          <VisitorWindow key={w.key} w={w} visitor={w.visitor} />
        ),
      )}
    </section>
  );
}

function Frame({
  w,
  title,
  subtitle,
  avatar,
  badge,
  actions,
  children,
}: {
  w: DockWindow;
  title: string;
  subtitle: ReactNode;
  avatar: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const toggle = useDock((s) => s.toggle);
  const close = useDock((s) => s.close);
  const headingId = `dock-${w.key.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <section
      aria-labelledby={headingId}
      data-dock-window={w.key}
      className={cn(
        'pointer-events-auto flex w-screen flex-col overflow-hidden border border-b-0 border-line bg-surface shadow-[var(--shadow-float)] sm:w-[360px] sm:rounded-t-[var(--radius-card)]',
        w.minimized ? 'h-auto' : 'h-[min(560px,calc(100dvh-72px))]',
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-2 ps-3">
        <button
          type="button"
          onClick={() => toggle(w.key)}
          aria-expanded={!w.minimized}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-start"
        >
          {avatar}
          <span className="min-w-0 flex-1">
            <span id={headingId} className="block truncate text-sm font-semibold" dir="auto">
              {title}
            </span>
            <span className="block truncate text-xs text-fg-2">{subtitle}</span>
          </span>
          {badge}
        </button>
        {actions}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggle(w.key)}
          aria-label={w.minimized ? t('dock.expand') : t('dock.minimize')}
        >
          <Minus className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => close(w.key)} aria-label={t('dock.close')}>
          <X className="size-4" />
        </Button>
      </header>
      {!w.minimized && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
    </section>
  );
}

function ChatWindow({ w, chatId }: { w: DockWindow; chatId: string }) {
  const t = useT();
  const router = useRouter();
  const chat = useInbox((s) => s.chats[chatId]);
  const me = useSession((s) => s.agent?.agent.id ?? null);
  const lastSeq = useInbox((s) => s.transcripts[chatId]?.items.at(-1)?.seq ?? 0);
  const markRead = useInbox((s) => s.markRead);
  const closeChat = useDock((s) => s.closeChat);
  const initialUnread = useRef<number>(chat?.unreadCount ?? 0);

  useEffect(() => {
    let alive = true;
    const inbox = useInbox.getState();
    void inbox.loadChat(chatId).then((c) => {
      if (!alive || c || useInbox.getState().chats[chatId]) return;
      closeChat(chatId);
      toast.info(t('dock.chatUnavailable'));
    });
    void inbox.loadTranscript(chatId);
    return () => {
      alive = false;
    };
  }, [chatId, closeChat, t]);

  // An expanded window is on screen: messages that land while this tab has focus are read.
  useEffect(() => {
    if (w.minimized) return;
    const tryRead = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) markRead(chatId);
    };
    tryRead();
    window.addEventListener('focus', tryRead);
    document.addEventListener('visibilitychange', tryRead);
    return () => {
      window.removeEventListener('focus', tryRead);
      document.removeEventListener('visibilitychange', tryRead);
    };
  }, [chatId, lastSeq, w.minimized, markRead]);

  const name = chat?.visitor.displayName ?? t('common.visitor');
  const status = chat ? STATUS[chat.status] : null;
  const unread = chat?.unreadCount ?? 0;
  return (
    <Frame
      w={w}
      title={name}
      subtitle={chat ? `#${chat.number} · ${t(status!.label)}` : t('dock.loading')}
      avatar={<Avatar name={name} color={chat?.visitor.avatarColor} size="sm" />}
      badge={
        unread > 0 && (w.minimized || chat?.status !== 'active') ? (
          <CountBadge count={unread} label={t('dock.unread', { count: unread })} tone="danger" />
        ) : status ? (
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              status.tone === 'success'
                ? 'bg-success'
                : status.tone === 'warning'
                  ? 'bg-warning'
                  : status.tone === 'info'
                    ? 'bg-primary'
                    : 'bg-fg-3',
            )}
            aria-hidden
          />
        ) : null
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => router.push(`/inbox/${chatId}`)}
          aria-label={t('dock.openInInbox')}
        >
          <Maximize2 className="size-4" />
        </Button>
      }
    >
      {chat ? (
        <>
          <Transcript chat={chat} me={me} initialUnread={initialUnread.current} />
          <ComposerArea chat={chat} me={me} compact />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-fg-2" aria-busy="true">
          {t('dock.loading')}
        </div>
      )}
    </Frame>
  );
}

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function VisitorWindow({ w, visitor }: { w: DockWindow; visitor: DockVisitor }) {
  const t = useT();
  const canServe = useCan('chats.serve');
  const sendOnEnter = useSession((s) => s.agent?.preferences.sendOnEnter ?? true);
  const promote = useDock((s) => s.promote);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  const area = useRef<HTMLTextAreaElement>(null);
  const country = countryName(visitor.country);

  useEffect(() => {
    if (!w.minimized) area.current?.focus();
  }, [w.minimized]);

  const adopt = (chat: StaffChat, message?: Message) => {
    const inbox = useInbox.getState();
    inbox.upsertChat(chat);
    if (message) inbox.applyMessage(message);
    focusComposerWhenReady(chat.id);
    promote(w.key, chat.id);
  };

  const start = async () => {
    const body = text.trim();
    if (!body || busy || !canServe) return;
    setBusy(true);
    setError(null);
    // A visitor can be between pages for a moment: one quiet retry before reporting them gone.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await api.post<{ chat: StaffChat; message: Message }>(
          `/visitors/${visitor.visitorId}/chats`,
          {
            clientRequestId: requestId.current,
            message: body,
            ...(visitor.sessionId ? { sessionId: visitor.sessionId } : {}),
          },
        );
        adopt(r.chat, r.message);
        return;
      } catch (e) {
        if (isApiError(e, 'VISITOR_OFFLINE') && attempt === 0) {
          requestId.current = newRequestId();
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (isApiError(e, 'CHAT_EXISTS') && typeof e.details.chatId === 'string') {
          const existing = await useInbox.getState().loadChat(e.details.chatId);
          if (existing) {
            toast.info(t('dock.chatExists', { name: isolate(visitor.name) }));
            adopt(existing);
            return;
          }
        }
        setError(isApiError(e, 'VISITOR_OFFLINE') ? t('dock.visitorLeft') : errorMessage(e));
        break;
      }
    }
    setBusy(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const send = sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (send) {
      e.preventDefault();
      void start();
    }
  };

  const flag = flagEmoji(visitor.country);
  return (
    <Frame
      w={w}
      title={visitor.name}
      subtitle={t('dock.newChat')}
      avatar={
        <span
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary"
          aria-hidden
        >
          <MessageSquarePlus className="size-4" />
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 scroll-thin">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-fg-2">{t('visitors.page.country')}</dt>
          <dd className="truncate">
            {country ? `${flag ? `${flag} ` : ''}${country}` : t('common.unknown')}
          </dd>
          {visitor.page && (
            <>
              <dt className="text-fg-2">{t('visitors.live.col.viewing')}</dt>
              <dd className="truncate" dir="auto" title={visitor.page}>
                {visitor.page}
              </dd>
            </>
          )}
          {visitor.ipAddress && (
            <>
              <dt className="text-fg-2">{t('visitors.live.col.ip')}</dt>
              <dd className="truncate font-mono text-xs leading-5" dir="ltr">
                {visitor.ipAddress}
              </dd>
            </>
          )}
        </dl>
        <p className="text-sm text-fg-2">
          {canServe ? t('dock.startHint', { name: isolate(visitor.name) }) : t('dock.cannotStart')}
        </p>
      </div>
      <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2">
        <label htmlFor={`dock-start-${visitor.visitorId}`} className="sr-only">
          {t('dock.startLabel', { name: visitor.name })}
        </label>
        <textarea
          id={`dock-start-${visitor.visitorId}`}
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !canServe}
          rows={2}
          maxLength={8000}
          dir="auto"
          placeholder={t('dock.startPlaceholder')}
          className="block min-h-16 w-full resize-none rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2.5 text-sm leading-5 text-fg placeholder:text-fg-3 focus-visible:outline-2 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:bg-surface-3"
        />
        {error && (
          <p className="mt-2 text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            variant="primary"
            onClick={() => void start()}
            loading={busy}
            disabled={!text.trim() || !canServe}
          >
            <SendHorizontal className="size-4 rtl:-scale-x-100" aria-hidden />
            {t('dock.startChat')}
          </Button>
        </div>
      </div>
    </Frame>
  );
}
