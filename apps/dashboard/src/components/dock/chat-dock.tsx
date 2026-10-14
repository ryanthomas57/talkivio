'use client';
/**
 * Chat dock: classic live chat windows along the bottom edge, on every page. Opening a visitor from the Visitors
 * list, accepting a chat request, or starting a chat with a browsing visitor opens a window here: a brand-coloured
 * header, the chat log with the reply box, and the visitor's details beside it. One window is open at a time;
 * the others wait as tabs. Windows keep the transcript live; closing one never ends the chat, and the chat that
 * is open in the Inbox is not duplicated here.
 */
import { ChevronUp, Info, Maximize2, MessageSquarePlus, Minus, SendHorizontal, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, CountBadge } from '@/components/ui';
import { EndChatDialog } from '@/components/inbox/chat-dialogs';
import { ComposerArea } from '@/components/inbox/conversation';
import { focusComposerWhenReady } from '@/components/inbox/composer';
import { Transcript } from '@/components/inbox/transcript';
import { useMediaQuery } from '@/hooks/use-media';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { flagEmoji } from '@/lib/format';
import type { Message, StaffChat } from '@/lib/types';
import { MAX_WINDOWS, useDock, type DockVisitor, type DockWindow } from '@/stores/dock';
import { useInbox } from '@/stores/inbox';
import { useCan, useSession } from '@/stores/session';
import { VisitorInfo } from './visitor-info';

const STATUS: Record<StaffChat['status'], { label: MessageKey; dot: string }> = {
  queued: { label: 'inbox.status.queued', dot: 'bg-warning' },
  offered: { label: 'inbox.status.offered', dot: 'bg-warning' },
  active: { label: 'inbox.status.active', dot: 'bg-success' },
  closed: { label: 'inbox.status.closed', dot: 'bg-fg-3' },
};

export function ChatDock() {
  const t = useT();
  const windows = useDock((s) => s.windows);
  const pathname = usePathname();
  const signedIn = useSession((s) => !!s.agent);
  const wide = useMediaQuery('(min-width: 1100px)', true);
  const phone = !useMediaQuery('(min-width: 640px)', true);
  const routeChat = pathname.startsWith('/inbox/') ? (pathname.split('/')[2] ?? null) : null;
  let shown = windows.filter((w) => !(w.kind === 'chat' && w.chatId === routeChat)).slice(-MAX_WINDOWS);
  // A phone has room for one window: the open one, else the newest tab.
  if (phone && shown.length) shown = [shown.find((w) => !w.minimized) ?? shown[shown.length - 1]!];
  if (!signedIn || !shown.length) return null;
  return (
    <section
      aria-label={t('dock.region')}
      className="pointer-events-none fixed bottom-0 end-0 z-30 flex max-w-full items-end gap-2 sm:end-4"
    >
      {shown.map((w) =>
        w.kind === 'chat' ? (
          <ChatWindow key={w.key} w={w} chatId={w.chatId} wide={wide} />
        ) : (
          <VisitorWindow key={w.key} w={w} visitor={w.visitor} wide={wide} />
        ),
      )}
    </section>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-primary-fg hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary-fg',
        pressed && 'bg-primary-hover',
      )}
    >
      {children}
    </button>
  );
}

function Frame({
  w,
  wide,
  title,
  flag,
  subtitle,
  dot,
  badge,
  actions,
  info,
  children,
}: {
  w: DockWindow;
  wide: boolean;
  title: string;
  flag: string | null;
  subtitle: string;
  dot: string;
  badge?: ReactNode;
  actions?: ReactNode;
  info: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const toggle = useDock((s) => s.toggle);
  const close = useDock((s) => s.close);
  const [showInfo, setShowInfo] = useState(false);
  const headingId = `dock-${w.key.replace(/[^a-z0-9-]/gi, '-')}`;

  if (w.minimized)
    return (
      <section
        aria-labelledby={headingId}
        data-dock-window={w.key}
        className="pointer-events-auto w-60 overflow-hidden rounded-t-[var(--radius-card)] shadow-[var(--shadow-float)]"
      >
        <header className="flex h-11 items-center gap-1 bg-primary ps-3 pe-1 text-primary-fg">
          <button
            type="button"
            onClick={() => toggle(w.key)}
            aria-expanded={false}
            className="flex min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-2 focus-visible:outline-primary-fg"
          >
            <span className={cn('size-2 shrink-0 rounded-full ring-2 ring-primary-fg/60', dot)} aria-hidden />
            <span id={headingId} className="truncate text-sm font-semibold" dir="auto">
              {title}
            </span>
            {badge}
          </button>
          <HeaderButton label={t('dock.expand')} onClick={() => toggle(w.key)}>
            <ChevronUp className="size-4" />
          </HeaderButton>
          <HeaderButton label={t('dock.close')} onClick={() => close(w.key)}>
            <X className="size-4" />
          </HeaderButton>
        </header>
      </section>
    );

  return (
    <section
      aria-labelledby={headingId}
      data-dock-window={w.key}
      className={cn(
        'pointer-events-auto relative flex h-[min(600px,calc(100dvh-72px))] w-screen flex-col overflow-hidden border border-b-0 border-line bg-surface shadow-[var(--shadow-float)] sm:rounded-t-[var(--radius-card)]',
        wide ? 'sm:w-[720px]' : 'sm:w-[400px]',
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 bg-primary ps-3 pe-1.5 text-primary-fg">
        <button
          type="button"
          onClick={() => toggle(w.key)}
          aria-expanded
          className="flex min-w-0 flex-1 items-center gap-2 text-start focus-visible:outline-2 focus-visible:outline-primary-fg"
        >
          <span className={cn('size-2.5 shrink-0 rounded-full ring-2 ring-primary-fg/60', dot)} aria-hidden />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span id={headingId} className="truncate text-sm font-semibold" dir="auto">
                {title}
              </span>
              {flag && (
                <span className="text-base leading-none" aria-hidden>
                  {flag}
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-primary-fg">{subtitle}</span>
          </span>
        </button>
        {actions}
        {!wide && (
          <HeaderButton
            label={t('dock.info.title')}
            onClick={() => setShowInfo((v) => !v)}
            pressed={showInfo}
          >
            <Info className="size-4" />
          </HeaderButton>
        )}
        <HeaderButton label={t('dock.minimize')} onClick={() => toggle(w.key)}>
          <Minus className="size-4" />
        </HeaderButton>
        <HeaderButton label={t('dock.close')} onClick={() => close(w.key)}>
          <X className="size-4" />
        </HeaderButton>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        {(wide || showInfo) && (
          <aside
            aria-label={t('dock.info.title')}
            className={cn(
              'w-[280px] shrink-0 overflow-y-auto border-s border-line bg-surface-2 scroll-thin',
              !wide && 'absolute inset-y-12 end-0 bottom-0 z-[1] shadow-[var(--shadow-float)]',
            )}
          >
            {info}
          </aside>
        )}
      </div>
    </section>
  );
}

function ChatWindow({ w, chatId, wide }: { w: DockWindow; chatId: string; wide: boolean }) {
  const t = useT();
  const router = useRouter();
  const chat = useInbox((s) => s.chats[chatId]);
  const me = useSession((s) => s.agent?.agent.id ?? null);
  const lastSeq = useInbox((s) => s.transcripts[chatId]?.items.at(-1)?.seq ?? 0);
  const markRead = useInbox((s) => s.markRead);
  const closeChat = useDock((s) => s.closeChat);
  const initialUnread = useRef<number>(chat?.unreadCount ?? 0);
  const [ending, setEnding] = useState(false);

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

  // An open window is on screen: messages that land while this tab has focus are read.
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
  const participant = !!chat && !!me && (chat.ownerMembershipId === me || chat.collaboratorIds.includes(me));
  return (
    <Frame
      w={w}
      wide={wide}
      title={name}
      flag={flagEmoji(chat?.visitor.countryCode)}
      subtitle={chat ? `#${chat.number} · ${t(status!.label)}` : t('dock.loading')}
      dot={status?.dot ?? 'bg-fg-3'}
      badge={
        unread > 0 ? (
          <CountBadge count={unread} label={t('dock.unread', { count: unread })} tone="danger" />
        ) : null
      }
      actions={
        <>
          {chat?.status === 'active' && participant && (
            <button
              type="button"
              onClick={() => setEnding(true)}
              className="me-1 inline-flex h-8 shrink-0 items-center rounded-md border border-primary-fg/50 px-2.5 text-xs font-semibold text-primary-fg hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-primary-fg"
            >
              {t('inbox.header.endChat')}
            </button>
          )}
          <HeaderButton label={t('dock.openInInbox')} onClick={() => router.push(`/inbox/${chatId}`)}>
            <Maximize2 className="size-4" />
          </HeaderButton>
        </>
      }
      info={chat ? <VisitorInfo visitorId={chat.visitorId} chat={chat} /> : null}
    >
      {chat ? (
        <>
          <Transcript chat={chat} me={me} initialUnread={initialUnread.current} variant="log" />
          <ComposerArea chat={chat} me={me} compact />
          <EndChatDialog chat={chat} open={ending} onOpenChange={setEnding} />
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

function VisitorWindow({ w, visitor, wide }: { w: DockWindow; visitor: DockVisitor; wide: boolean }) {
  const t = useT();
  const canServe = useCan('chats.serve');
  const sendOnEnter = useSession((s) => s.agent?.preferences.sendOnEnter ?? true);
  const promote = useDock((s) => s.promote);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  const area = useRef<HTMLTextAreaElement>(null);

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

  return (
    <Frame
      w={w}
      wide={wide}
      title={visitor.name}
      flag={flagEmoji(visitor.country)}
      subtitle={visitor.page ? t('dock.viewing', { page: visitor.page }) : t('dock.newChat')}
      dot="bg-primary-tint"
      info={<VisitorInfo visitorId={visitor.visitorId} fallback={visitor} />}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <span
          className="inline-flex size-10 items-center justify-center rounded-full bg-primary-tint text-primary"
          aria-hidden
        >
          <MessageSquarePlus className="size-5" />
        </span>
        <p className="max-w-[280px] text-sm text-fg-2">
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
          placeholder={t('dock.typeHere')}
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
            size="sm"
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
