'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRealtimeEvent, useResync } from '@/hooks/use-realtime';
import { api } from '@/lib/api';
import type { InboxCounts } from '@/lib/types';
import { useCan } from '@/stores/session';

export const INBOX_COUNTS_KEY = ['inbox', 'counts'] as const;

/** Waiting + unread count for the Inbox navigation badge and document title. */
export function useInboxCounts() {
  const canServe = useCan('chats.serve');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: INBOX_COUNTS_KEY,
    queryFn: () => api.get<InboxCounts>('/chats/counts'),
    enabled: canServe,
    refetchInterval: 60_000,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: INBOX_COUNTS_KEY });
  useRealtimeEvent(
    [
      'chat.requested',
      'chat.updated',
      'assignment.accepted',
      'assignment.offered',
      'chat.closed',
      'chat.transferred',
      'message.created',
      'participant.joined',
      'participant.left',
    ],
    invalidate,
  );
  useResync(invalidate);
  return q.data ?? null;
}

export function useInboxBadge(): number {
  const counts = useInboxCounts();
  return counts ? counts.queue + counts.unreadMine + counts.pendingOffers : 0;
}

/**
 * "(3) Talkivio" — the title badge mirrors the waiting/unread count (ch. 14). Route
 * changes rewrite <title>, so the prefix is re-applied whenever the title changes.
 *
 * The observer must reach a fixed point after its own write. A client navigation briefly leaves the document with
 * no <title> (the old metadata is removed before the streamed one is inserted); writing "(1) " then would create a
 * stray <title> that reads back as "(1)" (document.title strips whitespace), never equal to what was written, so
 * every write re-triggered the observer in one endless microtask loop and froze the page. With no title there is
 * nothing to badge: the insertion of the new one triggers the observer again.
 */
export function useTitleBadge(count: number) {
  useEffect(() => {
    let obs: MutationObserver | null = null;
    const apply = () => {
      const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
      if (!base) return;
      const next = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
      if (document.title === next) return;
      document.title = next;
      // Our own write is not a title change to react to.
      obs?.takeRecords();
    };
    apply();
    const head = document.querySelector('head');
    if (!head) return;
    obs = new MutationObserver(apply);
    obs.observe(head, { subtree: true, childList: true, characterData: true });
    return () => obs?.disconnect();
  }, [count]);
}
