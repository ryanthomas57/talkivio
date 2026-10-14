'use client';
import { ArrowRightLeft, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Badge, Button } from '@/components/ui';
import { useNow } from '@/hooks/use-media';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { useDepartments, byId } from '@/lib/queries';
import { realtime } from '@/lib/realtime';
import type { PendingOffer, StaffChat } from '@/lib/types';
import { isolate, useT } from '@/i18n';
import { useDock } from '@/stores/dock';
import { useInbox } from '@/stores/inbox';
import { useCan, useSession } from '@/stores/session';
import { startAttention } from './attention';
import { focusComposerWhenReady } from './composer';

/** Keyboard path to offers (ch. 77 A11Y): offers never steal focus, so they are reached on demand. Key combo, never translated. */
export const OFFER_SHORTCUT = 'Alt+Shift+O';
const OFFERS_ID = 'chat-offers';

function useLiveOffers(): PendingOffer[] {
  const offers = useInbox((s) => s.offers);
  const now = useNow(1000);
  return offers.filter((o) => Date.parse(o.offer.expiresAt) > now - 1000);
}

/** Moves focus to the newest offer's Accept button; returns false when there is no offer. */
function focusOffers(): boolean {
  const target =
    document.querySelector<HTMLElement>(`#${OFFERS_ID} [data-offer-accept]:not(:disabled)`) ??
    document.getElementById(OFFERS_ID);
  target?.focus();
  return !!target;
}

/** "Skip to chat offers" — first in the tab order while offers are pending. */
export function OfferSkipLink() {
  const t = useT();
  const live = useLiveOffers();
  if (!live.length) return null;
  return (
    <a
      href={`#${OFFERS_ID}`}
      aria-keyshortcuts={OFFER_SHORTCUT}
      onClick={(e) => {
        e.preventDefault();
        focusOffers();
      }}
      className="sr-only-focusable fixed start-2 top-2 z-[100] rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-[var(--shadow-float)]"
    >
      {t('inbox.offers.skipLink', { count: live.length })}
    </a>
  );
}

/**
 * Offers addressed to this agent (assigned routing and direct transfers): a
 * floating stack with countdown, Accept and Decline (ch. 12/15/31). Arrival is
 * announced, never focused (focus must not jump on incoming chat); Alt+Shift+O
 * or the skip link moves focus to the newest offer.
 */
export function OfferCenter() {
  const t = useT();
  const live = useLiveOffers();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const requests = useQueueRequests(dismissed);
  const dismiss = (id: string) => setDismissed((d) => new Set(d).add(id));
  const now = useNow(1000);
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef(new Set<string>());
  useEffect(() => startAttention(), []);

  useEffect(() => {
    const fresh = live.filter((o) => !seen.current.has(o.offer.id));
    for (const o of live) seen.current.add(o.offer.id);
    if (!fresh.length) return;
    const o = fresh[fresh.length - 1]!;
    const vars = { name: o.chatPreview.visitor.displayName, shortcut: OFFER_SHORTCUT };
    setAnnouncement(
      o.offer.mode === 'transfer'
        ? t('inbox.offers.announceTransfer', vars)
        : t('inbox.offers.announceNew', vars),
    );
  }, [live, t]);

  const seenRequests = useRef(new Set<string>());
  useEffect(() => {
    const fresh = requests.filter((c) => !seenRequests.current.has(c.id));
    for (const c of requests) seenRequests.current.add(c.id);
    if (fresh.length)
      setAnnouncement(
        t('inbox.requests.announce', { name: fresh[0]!.visitor.displayName, shortcut: OFFER_SHORTCUT }),
      );
  }, [requests, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyO') return;
      e.preventDefault();
      if (!focusOffers()) toast.info(t('inbox.offers.none'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t]);

  return (
    <>
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement}
      </p>
      {(live.length > 0 || requests.length > 0) && (
        <section
          id={OFFERS_ID}
          tabIndex={-1}
          aria-labelledby={`${OFFERS_ID}-title`}
          className="pointer-events-none fixed inset-x-3 top-16 z-40 flex max-h-[calc(100dvh-5rem)] flex-col items-end gap-3 overflow-y-auto outline-none sm:inset-x-auto sm:end-4 sm:top-20 sm:w-[380px]"
        >
          <h2 id={`${OFFERS_ID}-title`} className="sr-only">
            {t('inbox.offers.regionTitle')}
          </h2>
          {live.map((o) => (
            <OfferCard key={o.offer.id} item={o} now={now} />
          ))}
          {requests.slice(0, MAX_REQUEST_CARDS).map((c) => (
            <RequestCard key={c.id} chat={c} now={now} onDismiss={() => dismiss(c.id)} />
          ))}
          {requests.length > MAX_REQUEST_CARDS && (
            <Link
              href="/inbox?view=queue"
              className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm font-medium text-primary shadow-[var(--shadow-float)] hover:underline"
            >
              {t('inbox.requests.more', { count: requests.length - MAX_REQUEST_CARDS })}
            </Link>
          )}
        </section>
      )}
    </>
  );
}

async function acceptChat(chatId: string, offerId: string | null): Promise<StaffChat> {
  if (realtime.connected) return realtime.command<StaffChat>('offer.accept', { chatId, offerId });
  return api.post<StaffChat>(`/chats/${chatId}/accept`, { offerId });
}

/** Where an accepted chat opens: the Inbox when the agent is working there, otherwise a docked chat window. */
function useShowAccepted(): (chatId: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  return (chatId) => {
    if (pathname.startsWith('/inbox')) router.push(`/inbox/${chatId}`);
    else useDock.getState().openChat(chatId);
  };
}

function OfferCard({ item, now }: { item: PendingOffer; now: number }) {
  const t = useT();
  const showAccepted = useShowAccepted();
  const removeOffer = useInbox((s) => s.removeOffer);
  const departments = byId(useDepartments().data);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { offer, chatPreview: chat } = item;
  const remaining = Math.max(0, Date.parse(offer.expiresAt) - now);
  const total = 30_000;
  const transfer = offer.mode === 'transfer';

  useEffect(() => {
    if (remaining > 0) return;
    const timer = setTimeout(() => removeOffer(offer.id), 1500);
    return () => clearTimeout(timer);
  }, [remaining, offer.id, removeOffer]);

  const accept = async () => {
    setBusy('accept');
    setError(null);
    try {
      const c = await acceptChat(chat.id, offer.id);
      focusComposerWhenReady(chat.id);
      useInbox.getState().upsertChat(c);
      removeOffer(offer.id);
      showAccepted(chat.id);
    } catch (e) {
      setError(
        isApiError(e, 'OFFER_EXPIRED') || isApiError(e, 'OFFER_WITHDRAWN')
          ? t('inbox.offers.unavailable')
          : errorMessage(e),
      );
      if (
        isApiError(e, 'OFFER_EXPIRED') ||
        isApiError(e, 'OFFER_WITHDRAWN') ||
        isApiError(e, 'CHAT_ALREADY_ASSIGNED')
      )
        setTimeout(() => removeOffer(offer.id), 2500);
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy('decline');
    setError(null);
    try {
      if (realtime.connected) await realtime.command('offer.decline', { offerId: offer.id });
      else await api.post(`/offers/${offer.id}/decline`, {});
      removeOffer(offer.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const dept = chat.departmentId ? departments.get(chat.departmentId)?.name : null;
  const secondsLeft = Math.ceil(remaining / 1000);
  return (
    <article
      role="group"
      aria-labelledby={`offer-${offer.id}-t`}
      aria-describedby={`offer-${offer.id}-d`}
      className="pointer-events-auto w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-float)] animate-slide-in-right rtl:animate-slide-in-left"
    >
      <div className="h-1 bg-surface-3" aria-hidden>
        <div
          className="h-full bg-primary transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.min(100, (remaining / total) * 100)}%` }}
        />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={`offer-${offer.id}-t`} className="truncate text-sm font-semibold">
                {transfer ? t('inbox.offers.transferTitle') : t('inbox.offers.newTitle')}
              </h3>
              <Badge
                tone={transfer ? 'info' : 'primary'}
                icon={transfer ? <ArrowRightLeft className="size-3" /> : <MessageCircle className="size-3" />}
              >
                {transfer ? t('inbox.offers.transferBadge') : t('inbox.offers.assignedBadge')}
              </Badge>
            </div>
            <p className="truncate text-sm text-fg">
              <bdi>{chat.visitor.displayName}</bdi>
              {dept && (
                <span className="text-fg-2">
                  {' · '}
                  <bdi>{dept}</bdi>
                </span>
              )}
            </p>
          </div>
          <span
            className="shrink-0 text-sm font-semibold tabular text-fg"
            aria-label={t('inbox.offers.secondsLeft', { count: secondsLeft })}
          >
            {formatDuration(secondsLeft * 1000)}
          </span>
        </div>
        <div id={`offer-${offer.id}-d`} className="flex flex-col gap-1.5">
          {chat.lastMessagePreview ? (
            <p
              className="line-clamp-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg break-anywhere"
              dir="auto"
            >
              {chat.lastMessagePreview}
            </p>
          ) : (
            <p className="line-clamp-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg break-anywhere">
              {t('inbox.offers.noMessage')}
            </p>
          )}
          <p className="text-xs text-fg-2">
            {t('inbox.offers.waiting', { duration: formatDuration(now - Date.parse(chat.requestedAt)) })}
          </p>
          {transfer && offer.note && (
            <p className="rounded-md bg-note px-3 py-2 text-sm text-note-fg">
              {t('inbox.offers.handoffNote', { note: isolate(offer.note) })}
            </p>
          )}
        </div>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={decline}
            loading={busy === 'decline'}
            disabled={!!busy || remaining <= 0}
          >
            {t('inbox.offers.decline')}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            data-offer-accept
            onClick={accept}
            loading={busy === 'accept'}
            disabled={!!busy || remaining <= 0}
            aria-label={t('inbox.accept.withName', { name: chat.visitor.displayName })}
          >
            {t('inbox.accept.button')}
          </Button>
        </div>
      </div>
    </article>
  );
}

const MAX_REQUEST_CARDS = 3;

/**
 * Chats waiting in a queue this agent serves, for departments that broadcast or leave chats for agents to pick
 * (assigned routing offers each chat to one agent, shown above as an offer). Only while the agent is online.
 */
function useQueueRequests(dismissed: Set<string>): StaffChat[] {
  const canServe = useCan('chats.serve');
  const online = useSession((s) => s.agent?.agent.desiredStatus === 'online');
  const queue = useInbox((s) => s.lists.queue);
  const chats = useInbox((s) => s.chats);
  const offers = useInbox((s) => s.offers);
  const departments = useDepartments(canServe);
  if (!canServe || !online) return [];
  const assigned = new Set(
    (departments.data ?? []).filter((d) => d.routingMode === 'assigned').map((d) => d.id),
  );
  const offered = new Set(offers.map((o) => o.chatPreview.id));
  return queue
    .map((id) => chats[id])
    .filter(
      (c): c is StaffChat =>
        !!c &&
        c.status === 'queued' &&
        !offered.has(c.id) &&
        !dismissed.has(c.id) &&
        !(c.departmentId && assigned.has(c.departmentId)),
    )
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
}

function RequestCard({ chat, now, onDismiss }: { chat: StaffChat; now: number; onDismiss: () => void }) {
  const t = useT();
  const showAccepted = useShowAccepted();
  const departments = byId(useDepartments().data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dept = chat.departmentId ? departments.get(chat.departmentId)?.name : null;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await acceptChat(chat.id, null);
      focusComposerWhenReady(chat.id);
      useInbox.getState().upsertChat(c);
      showAccepted(chat.id);
    } catch (e) {
      if (isApiError(e, 'CHAT_ALREADY_ASSIGNED')) {
        setError(t('inbox.accept.takenElsewhere'));
        setTimeout(onDismiss, 2500);
      } else setError(errorMessage(e));
      void useInbox.getState().loadChat(chat.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      role="group"
      aria-labelledby={`request-${chat.id}-t`}
      className="pointer-events-auto w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-float)] animate-slide-in-right rtl:animate-slide-in-left"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="md" />
          <div className="min-w-0 flex-1">
            <h3 id={`request-${chat.id}-t`} className="truncate text-sm font-semibold">
              {t('inbox.requests.title')}
            </h3>
            <p className="truncate text-sm text-fg">
              <bdi>{chat.visitor.displayName}</bdi>
              {dept && (
                <span className="text-fg-2">
                  {' · '}
                  <bdi>{dept}</bdi>
                </span>
              )}
            </p>
          </div>
          <span className="shrink-0 text-sm font-semibold tabular text-fg">
            {formatDuration(Math.max(0, now - Date.parse(chat.requestedAt)))}
          </span>
        </div>
        <p
          className="line-clamp-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg break-anywhere"
          dir="auto"
        >
          {chat.lastMessagePreview || t('inbox.offers.noMessage')}
        </p>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onDismiss} disabled={busy}>
            {t('inbox.requests.dismiss')}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            data-offer-accept
            onClick={accept}
            loading={busy}
            aria-label={t('inbox.accept.withName', { name: chat.visitor.displayName })}
          >
            {t('inbox.accept.button')}
          </Button>
        </div>
      </div>
    </article>
  );
}
