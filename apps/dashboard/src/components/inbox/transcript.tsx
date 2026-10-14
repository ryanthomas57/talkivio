'use client';
import { ArrowDown } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, PanelError, Skeleton, Spinner } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { dayLabel, sameDay } from '@/lib/format';
import type { Message, StaffChat } from '@/lib/types';
import { useInbox } from '@/stores/inbox';
import { cn } from '@/lib/cn';
import { LogMessage, MessageBubble, PendingBubble } from './message-bubble';

const NEAR_BOTTOM_PX = 120;

/**
 * Server-ordered transcript (ch. 12/13): date separators in the viewer's timezone,
 * an unread separator at the first unread message when the chat was opened, a
 * reserved typing row, and scroll anchoring that never jumps while reading history.
 *
 * Screen readers (A11Y02): the log itself is not a live region — loading the transcript, earlier pages or a
 * catch-up batch is silent. A separate polite region announces each message that arrives from someone else
 * while the chat is open, in one short sentence ("New message from Ana: …"), or a count for a burst.
 */
const ANNOUNCE_CHARS = 140;
/** `log` renders the classic live chat log (name, time, text) used by docked chat windows; `bubbles` is the Inbox. */
export function Transcript({
  chat,
  me,
  initialUnread,
  variant = 'bubbles',
}: {
  chat: StaffChat;
  me: string | null;
  initialUnread: number;
  variant?: 'bubbles' | 'log';
}) {
  const t = useT();
  const tr = useInbox((s) => s.transcripts[chat.id]);
  const pending = useInbox((s) => s.pending[chat.id]);
  const typing = useInbox((s) => s.typing[chat.id]);
  const visitorRead = useInbox((s) => s.visitorRead[chat.id] ?? 0);
  const visitorDelivered = useInbox((s) => s.visitorDelivered[chat.id] ?? 0);
  const loadOlder = useInbox((s) => s.loadOlder);
  const loadTranscript = useInbox((s) => s.loadTranscript);
  const retry = useInbox((s) => s.retry);
  const discard = useInbox((s) => s.discardPending);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const firstUnreadSeq = useRef<number | null>(null);
  const prevCount = useRef(0);
  const prevFirstSeq = useRef<number | null>(null);
  /** Distance from the bottom captured before an older page loads. */
  const olderAnchor = useRef<number | null>(null);
  /** Highest seq already accounted for by the screen-reader announcer, for the chat in `announcedChat`. */
  const announcedThrough = useRef<number | null>(null);
  const announcedChat = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const items = tr?.items ?? [];
  // Compute the unread marker once per open, from the unread count at that moment.
  if (firstUnreadSeq.current === null && items.length && initialUnread > 0) {
    const visitorMsgs = items.filter((m) => m.sender.type === 'visitor');
    firstUnreadSeq.current = visitorMsgs[Math.max(0, visitorMsgs.length - initialUnread)]?.seq ?? null;
  }

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewBelow(0);
  }, []);

  // Keep position stable when older pages prepend; follow new messages only when near the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const count = items.length + (pending?.length ?? 0);
    const firstSeq = items[0]?.seq ?? null;
    const prepended = prevFirstSeq.current !== null && firstSeq !== null && firstSeq < prevFirstSeq.current;
    if (prepended && olderAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - olderAnchor.current;
      olderAnchor.current = null;
    } else if (count > prevCount.current) {
      if (atBottom || prevCount.current === 0) el.scrollTop = el.scrollHeight;
      else setNewBelow((n) => n + (count - prevCount.current));
    }
    prevCount.current = count;
    prevFirstSeq.current = firstSeq;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, items[0]?.seq, pending?.length]);

  const requestOlder = () => {
    const el = scroller.current;
    if (!el || !tr?.hasMoreBefore || tr.loadingOlder) return;
    olderAnchor.current = el.scrollHeight - el.scrollTop;
    void loadOlder(chat.id);
  };

  // Announce messages appended after the transcript was loaded; history (first load, earlier pages) stays silent.
  const lastSeq = items.length ? items[items.length - 1]!.seq : 0;
  useEffect(() => {
    if (!tr || tr.loading || !items.length) return;
    // First loaded render for this chat (cached or fetched): everything present is history.
    if (announcedChat.current !== chat.id || announcedThrough.current === null) {
      announcedChat.current = chat.id;
      announcedThrough.current = lastSeq;
      return;
    }
    const fresh = items.filter(
      (m) =>
        m.seq > announcedThrough.current! &&
        m.type !== 'system' &&
        !(m.sender.type === 'agent' && m.sender.id === me),
    );
    announcedThrough.current = Math.max(announcedThrough.current, lastSeq);
    if (!fresh.length) return;
    let text: string;
    if (fresh.length === 1) {
      const m = fresh[0]!;
      const body = m.body ?? (m.attachments.length ? t('inbox.message.attachmentOnly') : '');
      const short = body.length > ANNOUNCE_CHARS ? `${body.slice(0, ANNOUNCE_CHARS - 1)}…` : body;
      text = t('inbox.transcript.announceMessage', {
        name: isolate(m.sender.type === 'visitor' ? chat.visitor.displayName : m.sender.displayName),
        text: isolate(short),
      });
    } else text = t('inbox.transcript.newBelow', { count: fresh.length });
    // A trailing no-break space toggles so two identical messages are both announced.
    setAnnouncement((prevText) => (prevText === text ? `${text}\u00a0` : text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq, tr?.loading, chat.id]);

  useEffect(() => {
    setAnnouncement('');
    firstUnreadSeq.current = null;
    prevCount.current = 0;
    prevFirstSeq.current = null;
    olderAnchor.current = null;
    setNewBelow(0);
    setAtBottom(true);
  }, [chat.id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAtBottom(bottom);
    if (bottom) setNewBelow(0);
    if (el.scrollTop < 80) requestOlder();
  };

  const typers = Object.values(typing ?? {}).filter((x) => x.until > Date.now());
  const typingText = typers.length
    ? typers
        .map((x) =>
          x.actorType === 'visitor'
            ? t('inbox.transcript.typing', { name: isolate(chat.visitor.displayName) })
            : x.mode === 'note'
              ? t('inbox.transcript.writingNote', { name: isolate(x.name) })
              : t('inbox.transcript.typing', { name: isolate(x.name) }),
        )
        .join(' · ')
    : '';

  if (!tr || (tr.loading && !items.length))
    return (
      <div
        className="flex flex-1 flex-col gap-4 p-5"
        aria-busy="true"
        aria-label={t('inbox.transcript.loading')}
      >
        {[60, 40, 70, 30].map((w, i) => (
          <Skeleton key={i} className={`h-10 ${i % 2 ? 'self-end' : ''}`} />
        ))}
      </div>
    );
  if (tr.error && !items.length)
    return <PanelError message={tr.error} onRetry={() => void loadTranscript(chat.id)} />;

  let prev: Message | null = null;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto scroll-thin',
          variant === 'log' ? 'px-2 py-3' : 'px-4 py-5 sm:px-5',
        )}
        role="log"
        aria-live="off"
        aria-label={t('inbox.transcript.label', { name: chat.visitor.displayName })}
      >
        {tr.hasMoreBefore && (
          <div className="flex justify-center pb-3">
            {tr.loadingOlder ? (
              <Spinner label={t('inbox.transcript.loadingEarlier')} />
            ) : (
              <Button size="sm" variant="ghost" onClick={requestOlder}>
                {t('inbox.transcript.loadEarlier')}
              </Button>
            )}
          </div>
        )}
        {items.map((m) => {
          const newDay = !prev || !sameDay(prev.sentAt, m.sentAt);
          const grouped =
            !!prev &&
            !newDay &&
            prev.sender.type === m.sender.type &&
            prev.sender.id === m.sender.id &&
            prev.visibility === m.visibility &&
            prev.type !== 'system' &&
            Date.parse(m.sentAt) - Date.parse(prev.sentAt) < 120_000;
          prev = m;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div
                  className="my-4 flex items-center gap-3"
                  role="separator"
                  aria-label={dayLabel(m.sentAt)}
                >
                  <span className="h-px flex-1 bg-line-subtle" />
                  <span className="text-xs font-medium text-fg-2">{dayLabel(m.sentAt)}</span>
                  <span className="h-px flex-1 bg-line-subtle" />
                </div>
              )}
              {firstUnreadSeq.current === m.seq && (
                <div
                  className="my-3 flex items-center gap-3"
                  role="separator"
                  aria-label={t('inbox.transcript.newMessages')}
                >
                  <span className="h-px flex-1 bg-danger/40" />
                  <span className="text-xs font-semibold text-danger">{t('inbox.transcript.newMarker')}</span>
                  <span className="h-px flex-1 bg-danger/40" />
                </div>
              )}
              {variant === 'log' ? (
                <LogMessage
                  m={m}
                  own={!!me && m.sender.type === 'agent' && m.sender.id === me}
                  grouped={grouped}
                  readByVisitor={visitorRead >= m.seq}
                  deliveredToVisitor={visitorDelivered >= m.seq}
                />
              ) : (
                <MessageBubble
                  m={m}
                  own={!!me && m.sender.type === 'agent' && m.sender.id === me}
                  grouped={grouped}
                  readByVisitor={visitorRead >= m.seq}
                  deliveredToVisitor={visitorDelivered >= m.seq}
                />
              )}
            </Fragment>
          );
        })}
        {pending?.map((p) => (
          <PendingBubble
            key={p.clientMessageId}
            p={p}
            onRetry={() => void retry(chat.id, p.clientMessageId)}
            onDiscard={() => discard(chat.id, p.clientMessageId)}
          />
        ))}
        {chat.status === 'closed' && (
          <div
            className="my-5 flex items-center gap-3"
            role="separator"
            aria-label={t('inbox.transcript.ended')}
          >
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs font-semibold text-fg-2">{t('inbox.transcript.ended')}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}
      </div>
      <div className="h-5 shrink-0 px-5 text-xs italic text-fg-2" aria-live="polite">
        {typingText}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-announcer="">
        {announcement}
      </p>
      {newBelow > 0 && !atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center">
          <Button
            size="sm"
            variant="primary"
            className="pointer-events-auto shadow-[var(--shadow-float)]"
            onClick={() => scrollToBottom(true)}
          >
            <ArrowDown className="size-4" aria-hidden /> {t('inbox.transcript.newBelow', { count: newBelow })}
          </Button>
        </div>
      )}
    </div>
  );
}
