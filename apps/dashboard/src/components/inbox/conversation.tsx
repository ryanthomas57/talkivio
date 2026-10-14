'use client';
import {
  ArrowLeft,
  ArrowRightLeft,
  BellOff,
  BellRing,
  LogOut,
  MoreHorizontal,
  PanelRight,
  Star,
  UserPlus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DrawerContent,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PanelError,
  Skeleton,
} from '@/components/ui';
import { useMediaQuery } from '@/hooks/use-media';
import { intlLocale, isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { byId, useAgents } from '@/lib/queries';
import { realtime } from '@/lib/realtime';
import type { StaffChat } from '@/lib/types';
import { useInbox } from '@/stores/inbox';
import { useCan, useSession } from '@/stores/session';
import { chatMuted, setChatMuted } from './attention';
import { EndChatDialog, InviteDialog, TransferDialog } from './chat-dialogs';
import { Composer, focusComposerWhenReady } from './composer';
import { Transcript } from './transcript';
import { VisitorPanel } from './visitor-panel';

const STATUS_LABEL: Record<
  StaffChat['status'],
  { label: MessageKey; tone: 'warning' | 'info' | 'success' | 'neutral' }
> = {
  queued: { label: 'inbox.status.queued', tone: 'warning' },
  offered: { label: 'inbox.status.offered', tone: 'info' },
  active: { label: 'inbox.status.active', tone: 'success' },
  closed: { label: 'inbox.status.closed', tone: 'neutral' },
};

/** Conversation workspace: header, transcript, composer, visitor panel (ch. 12). */
export function Conversation({ chatId }: { chatId: string }) {
  const t = useT();
  const chat = useInbox((s) => s.chats[chatId]);
  const me = useSession((s) => s.agent?.agent.id ?? null);
  const loadChat = useInbox((s) => s.loadChat);
  const loadTranscript = useInbox((s) => s.loadTranscript);
  const setFocused = useInbox((s) => s.setFocused);
  const markRead = useInbox((s) => s.markRead);
  const lastSeq = useInbox((s) => s.transcripts[chatId]?.items.at(-1)?.seq ?? 0);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(chat ? 'ready' : 'loading');
  const initialUnread = useRef<number>(chat?.unreadCount ?? 0);
  const wide = useMediaQuery('(min-width: 1200px)', true);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    initialUnread.current = useInbox.getState().chats[chatId]?.unreadCount ?? 0;
    setFocused(chatId);
    let alive = true;
    void loadChat(chatId).then((c) => {
      if (!alive) return;
      setState(c ? 'ready' : useInbox.getState().chats[chatId] ? 'ready' : 'missing');
    });
    void loadTranscript(chatId);
    return () => {
      alive = false;
      setFocused(null);
    };
  }, [chatId, loadChat, loadTranscript, setFocused]);

  // Read receipts only when the conversation is visible and focused (ch. 13/14).
  useEffect(() => {
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
  }, [chatId, lastSeq, markRead]);

  if (!chat) {
    if (state === 'missing')
      return (
        <EmptyState
          title={t('inbox.conversation.missingTitle')}
          description={t('inbox.conversation.missingBody')}
          action={
            <Button asChild variant="secondary">
              <Link href="/inbox">{t('inbox.conversation.backToInbox')}</Link>
            </Button>
          }
        />
      );
    if (state === 'error')
      return <PanelError message={t('inbox.conversation.loadError')} onRetry={() => void loadChat(chatId)} />;
    return (
      <div className="flex flex-1 flex-col gap-4 p-5" aria-busy="true">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col min-[900px]:min-w-[400px]">
        <ChatHeader chat={chat} me={me} onTogglePanel={() => setPanelOpen(true)} showPanelToggle={!wide} />
        <Transcript chat={chat} me={me} initialUnread={initialUnread.current} />
        <ComposerArea chat={chat} me={me} />
      </div>
      {wide ? (
        <aside
          aria-label={t('inbox.conversation.visitorDetails')}
          className="w-80 shrink-0 overflow-y-auto border-s border-line bg-surface scroll-thin"
        >
          <VisitorPanel chat={chat} />
        </aside>
      ) : (
        <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
          <DrawerContent title={t('inbox.conversation.visitorDetails')} width={360}>
            <VisitorPanel chat={chat} />
          </DrawerContent>
        </Dialog>
      )}
    </div>
  );
}

/** Reply/note composer, or an Accept bar while the chat waits for someone else to take it. Shared with the chat dock. */
export function ComposerArea({
  chat,
  me,
  compact = false,
}: {
  chat: StaffChat;
  me: string | null;
  compact?: boolean;
}) {
  const t = useT();
  const canServe = useCan('chats.serve');
  const canNotes = useCan('notes.view');
  const canMonitor = useCan('chats.monitor');
  const participant = !!me && (chat.ownerMembershipId === me || chat.collaboratorIds.includes(me));
  const waiting = chat.status === 'queued' || chat.status === 'offered';
  const canReply = canServe && participant && chat.status === 'active';
  const canNote = canNotes && (participant || canMonitor) && chat.status !== 'closed';
  let reason: MessageKey | null = null;
  if (waiting && !participant) reason = 'inbox.conversation.reasonAccept';
  else if (!participant && !canMonitor) reason = 'inbox.conversation.reasonParticipants';
  if (waiting && !participant)
    return (
      <div className={cn('shrink-0 border-t border-line bg-surface', compact ? 'px-3 py-3' : 'px-5 py-4')}>
        <AcceptBar chat={chat} />
      </div>
    );
  return (
    <Composer
      chat={chat}
      canReply={canReply}
      canNote={canNote}
      compact={compact}
      disabledReason={!canReply && !canNote ? t(reason ?? 'inbox.conversation.reasonCannotWrite') : null}
    />
  );
}

function AcceptBar({ chat }: { chat: StaffChat }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const canServe = useCan('chats.serve');
  const accept = async () => {
    setBusy(true);
    try {
      const c = realtime.connected
        ? await realtime.command<StaffChat>('offer.accept', { chatId: chat.id, offerId: null })
        : await api.post<StaffChat>(`/chats/${chat.id}/accept`, {});
      focusComposerWhenReady(chat.id);
      useInbox.getState().upsertChat(c);
    } catch (e) {
      if (isApiError(e, 'CHAT_ALREADY_ASSIGNED')) toast.info(t('inbox.accept.takenElsewhere'));
      else toast.error(t('inbox.accept.failed', { error: errorMessage(e) }));
      void useInbox.getState().loadChat(chat.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-fg-2">
        {t('inbox.conversation.acceptPrompt', { name: isolate(chat.visitor.displayName) })}
      </p>
      {canServe && (
        <Button variant="primary" onClick={accept} loading={busy}>
          {t('inbox.conversation.acceptChat')}
        </Button>
      )}
    </div>
  );
}

function ChatHeader({
  chat,
  me,
  onTogglePanel,
  showPanelToggle,
}: {
  chat: StaffChat;
  me: string | null;
  onTogglePanel: () => void;
  showPanelToggle: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const agents = byId(useAgents().data);
  const canForce = useCan('chats.force_transfer');
  const dismissEnded = useInbox((s) => s.dismissEnded);
  const [dialog, setDialog] = useState<'transfer' | 'invite' | 'end' | null>(null);
  const [muted, setMuted] = useState(() => chatMuted(chat.id));
  const owner = chat.ownerMembershipId ? agents.get(chat.ownerMembershipId) : null;
  const collaborators = chat.collaboratorIds.map((id) => agents.get(id)?.displayName ?? t('common.agent'));
  const isOwner = chat.ownerMembershipId === me;
  const isCollaborator = !!me && chat.collaboratorIds.includes(me);
  const active = chat.status === 'active';
  const status = STATUS_LABEL[chat.status];
  const back = `/inbox${params.get('view') ? `?view=${params.get('view')}` : ''}`;
  // Independent facts separated by a middle dot; each one is a whole translated phrase.
  const ownerText = owner
    ? owner.id === me
      ? t('inbox.header.ownerYou')
      : t('inbox.header.owner', { name: isolate(owner.displayName) })
    : chat.status === 'closed'
      ? null
      : t('inbox.list.unassigned');
  const withText =
    collaborators.length > 0
      ? t('inbox.header.with', {
          names: new Intl.ListFormat(intlLocale(), { style: 'short', type: 'unit' }).format(
            collaborators.map(isolate),
          ),
        })
      : null;
  const subtitle = [`#${chat.number}`, ownerText, withText].filter(Boolean).join(' · ');

  const leave = async () => {
    try {
      await api.delete(`/chats/${chat.id}/collaborators/${me}`);
      router.push(back);
    } catch (e) {
      toast.error(t('inbox.header.leaveFailed', { error: errorMessage(e) }));
    }
  };
  const requestRating = async () => {
    try {
      await api.post(`/chats/${chat.id}/request-rating`, {});
      toast.success(t('inbox.header.ratingRequested'));
    } catch (e) {
      toast.error(t('inbox.header.ratingFailed', { error: errorMessage(e) }));
    }
  };

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="min-[900px]:hidden"
        aria-label={t('inbox.header.back')}
      >
        <Link href={back}>
          <ArrowLeft className="size-5 rtl:-scale-x-100" />
        </Link>
      </Button>
      <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold leading-6" dir="auto">
            {chat.visitor.displayName}
          </h1>
          <Badge tone={status.tone}>{t(status.label)}</Badge>
        </div>
        <p className="truncate text-xs text-fg-2">{subtitle}</p>
      </div>
      <div className="flex items-center gap-1">
        {active && (isOwner || canForce) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialog('transfer')}
            className="hidden sm:inline-flex"
          >
            <ArrowRightLeft className="size-4" aria-hidden /> {t('inbox.header.transfer')}
          </Button>
        )}
        {active && (isOwner || isCollaborator) && (
          <Button variant="secondary" size="sm" onClick={() => setDialog('end')}>
            {t('inbox.header.endChat')}
          </Button>
        )}
        {chat.status === 'closed' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              dismissEnded(chat.id);
              router.push(back);
            }}
          >
            <X className="size-4" aria-hidden /> {t('inbox.header.closeTab')}
          </Button>
        )}
        {showPanelToggle && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onTogglePanel}
            aria-label={t('inbox.conversation.visitorDetails')}
          >
            <PanelRight className="size-5 rtl:-scale-x-100" />
          </Button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('inbox.header.moreActions')}>
              <MoreHorizontal className="size-5" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            {active && (isOwner || canForce) && (
              <MenuItem
                icon={<ArrowRightLeft />}
                onSelect={() => setDialog('transfer')}
                className="sm:hidden"
              >
                {t('inbox.header.transfer')}
              </MenuItem>
            )}
            {active && isOwner && (
              <MenuItem icon={<UserPlus />} onSelect={() => setDialog('invite')}>
                {t('inbox.header.invite')}
              </MenuItem>
            )}
            {active && (isOwner || isCollaborator) && (
              <MenuItem icon={<Star />} onSelect={() => void requestRating()}>
                {t('inbox.header.requestRating')}
              </MenuItem>
            )}
            <MenuItem
              icon={muted ? <BellRing /> : <BellOff />}
              onSelect={() => {
                setChatMuted(chat.id, !muted);
                setMuted(!muted);
              }}
            >
              {muted ? t('inbox.header.unmute') : t('inbox.header.mute')}
            </MenuItem>
            {isCollaborator && active && (
              <>
                <MenuSeparator />
                <MenuItem icon={<LogOut className="rtl:-scale-x-100" />} danger onSelect={() => void leave()}>
                  {t('inbox.header.leave')}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>
      <TransferDialog
        chat={chat}
        open={dialog === 'transfer'}
        onOpenChange={(o) => setDialog(o ? 'transfer' : null)}
      />
      <InviteDialog
        chat={chat}
        open={dialog === 'invite'}
        onOpenChange={(o) => setDialog(o ? 'invite' : null)}
      />
      <EndChatDialog chat={chat} open={dialog === 'end'} onOpenChange={(o) => setDialog(o ? 'end' : null)} />
    </header>
  );
}
