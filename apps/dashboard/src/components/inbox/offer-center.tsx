'use client';
import { ArrowRightLeft, MessageCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { useInbox } from '@/stores/inbox';
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
  const target = document.querySelector<HTMLElement>(`#${OFFERS_ID} [data-offer-accept]:not(:disabled)`) ?? document.getElementById(OFFERS_ID);
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
    setAnnouncement(o.offer.mode === 'transfer' ? t('inbox.offers.announceTransfer', vars) : t('inbox.offers.announceNew', vars));
  }, [live, t]);

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
      {live.length > 0 && (
        <section
          id={OFFERS_ID}
          tabIndex={-1}
          aria-labelledby={`${OFFERS_ID}-title`}
          className="pointer-events-none fixed inset-x-3 bottom-3 z-40 flex flex-col items-end gap-3 outline-none sm:inset-x-auto sm:end-4 sm:w-[380px]"
        >
          <h2 id={`${OFFERS_ID}-title`} className="sr-only">
            {t('inbox.offers.regionTitle')}
          </h2>
          {live.map((o) => (
            <OfferCard key={o.offer.id} item={o} now={now} />
          ))}
        </section>
      )}
    </>
  );
}

async function acceptChat(chatId: string, offerId: string | null): Promise<StaffChat> {
  if (realtime.connected) return realtime.command<StaffChat>('offer.accept', { chatId, offerId });
  return api.post<StaffChat>(`/chats/${chatId}/accept`, { offerId });
}

function OfferCard({ item, now }: { item: PendingOffer; now: number }) {
  const t = useT();
  const router = useRouter();
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
      router.push(`/inbox/${chat.id}`);
    } catch (e) {
      setError(isApiError(e, 'OFFER_EXPIRED') || isApiError(e, 'OFFER_WITHDRAWN') ? t('inbox.offers.unavailable') : errorMessage(e));
      if (isApiError(e, 'OFFER_EXPIRED') || isApiError(e, 'OFFER_WITHDRAWN') || isApiError(e, 'CHAT_ALREADY_ASSIGNED')) setTimeout(() => removeOffer(offer.id), 2500);
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
        <div className="h-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(100, (remaining / total) * 100)}%` }} />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar name={chat.visitor.displayName} color={chat.visitor.avatarColor} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={`offer-${offer.id}-t`} className="truncate text-sm font-semibold">
                {transfer ? t('inbox.offers.transferTitle') : t('inbox.offers.newTitle')}
              </h3>
              <Badge tone={transfer ? 'info' : 'primary'} icon={transfer ? <ArrowRightLeft className="size-3" /> : <MessageCircle className="size-3" />}>
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
          <span className="shrink-0 text-sm font-semibold tabular text-fg" aria-label={t('inbox.offers.secondsLeft', { count: secondsLeft })}>
            {formatDuration(secondsLeft * 1000)}
          </span>
        </div>
        <div id={`offer-${offer.id}-d`} className="flex flex-col gap-1.5">
          {chat.lastMessagePreview ? (
            <p className="line-clamp-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg break-anywhere" dir="auto">
              {chat.lastMessagePreview}
            </p>
          ) : (
            <p className="line-clamp-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg break-anywhere">{t('inbox.offers.noMessage')}</p>
          )}
          <p className="text-xs text-fg-2">{t('inbox.offers.waiting', { duration: formatDuration(now - Date.parse(chat.requestedAt)) })}</p>
          {transfer && offer.note && <p className="rounded-md bg-note px-3 py-2 text-sm text-note-fg">{t('inbox.offers.handoffNote', { note: isolate(offer.note) })}</p>}
        </div>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={decline} loading={busy === 'decline'} disabled={!!busy || remaining <= 0}>
            {t('inbox.offers.decline')}
          </Button>
          <Button variant="primary" className="flex-1" data-offer-accept onClick={accept} loading={busy === 'accept'} disabled={!!busy || remaining <= 0} aria-label={t('inbox.accept.withName', { name: chat.visitor.displayName })}>
            {t('inbox.accept.button')}
          </Button>
        </div>
      </div>
    </article>
  );
}
