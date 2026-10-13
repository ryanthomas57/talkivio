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
  const q = useQuery({ queryKey: INBOX_COUNTS_KEY, queryFn: () => api.get<InboxCounts>('/chats/counts'), enabled: canServe, refetchInterval: 60_000 });
  const invalidate = () => void qc.invalidateQueries({ queryKey: INBOX_COUNTS_KEY });
  useRealtimeEvent(['chat.requested', 'chat.updated', 'assignment.accepted', 'assignment.offered', 'chat.closed', 'chat.transferred', 'message.created', 'participant.joined', 'participant.left'], invalidate);
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
 */
export function useTitleBadge(count: number) {
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
      const next = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const head = document.querySelector('head');
    if (!head) return;
    const obs = new MutationObserver(apply);
    obs.observe(head, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [count]);
}
