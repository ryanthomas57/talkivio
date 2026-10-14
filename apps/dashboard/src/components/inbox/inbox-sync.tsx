'use client';
/**
 * Keeps the inbox engine live for the whole session: loads Mine / Queue / offers,
 * subscribes to queue scopes for the agent's departments and to chat scopes for
 * every chat the agent participates in, and applies durable + ephemeral events.
 */
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useEphemeralEvent, useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { isolate, useT } from '@/i18n';
import { useDepartments } from '@/lib/queries';
import type { Scope } from '@/lib/realtime';
import type { Message, Offer, PendingOffer, StaffChat } from '@/lib/types';
import { dockChatIds, useDock } from '@/stores/dock';
import { acknowledgeDelivery, useInbox } from '@/stores/inbox';
import { useSession } from '@/stores/session';
import { notifyIncoming } from './attention';

export function InboxSync() {
  const t = useT();
  const membershipId = useSession((s) => s.agent?.agent.id ?? null);
  const canServe = useSession((s) => s.permissions.has('chats.serve'));
  const scope = useSession((s) => s.agent?.departmentScope);
  const departments = useDepartments(canServe && scope === 'all');
  const mine = useInbox((s) => s.lists.mine);
  const ended = useInbox((s) => s.endedOpen);
  const focused = useInbox((s) => s.focusedChatId);
  const docked = useDock((s) => s.windows);

  useEffect(() => {
    if (!membershipId || !canServe) return;
    const st = useInbox.getState();
    if (st.me !== membershipId) {
      st.reset();
      useInbox.getState().init(membershipId);
    }
    void useInbox.getState().loadList('mine');
    void useInbox.getState().loadList('queue');
    void useInbox.getState().loadOffers();
  }, [membershipId, canServe]);

  // Queue scopes: every department in scope plus chats without a department.
  const queueScopes = useMemo<Scope[] | null>(() => {
    if (!canServe || !scope) return null;
    const ids =
      scope === 'all' ? (departments.data ?? []).filter((d) => !d.archivedAt).map((d) => d.id) : scope;
    return [{ kind: 'queue', id: 'none' }, ...ids.map((id) => ({ kind: 'queue' as const, id }))];
  }, [canServe, scope, departments.data]);
  useScopes(queueScopes);

  // Chat scopes for my chats, the focused one (e.g. a supervisor viewing) and any chat window in the dock.
  const chatScopes = useMemo<Scope[] | null>(() => {
    const ids = new Set([...mine, ...ended, ...(focused ? [focused] : []), ...dockChatIds(docked)]);
    return ids.size ? [...ids].map((id) => ({ kind: 'chat' as const, id })) : null;
  }, [mine, ended, focused, docked]);
  useScopes(chatScopes);

  const inbox = useInbox;

  useRealtimeEvent<{ chat: StaffChat }>(['chat.requested', 'chat.updated'], (e) => {
    if (!e.payload.chat) return;
    const isNew = e.type === 'chat.requested' && !inbox.getState().chats[e.payload.chat.id];
    inbox.getState().upsertChat(e.payload.chat);
    if (isNew) notifyIncoming({ kind: 'queue', chat: e.payload.chat });
  });

  useRealtimeEvent<{ chatId: string; chat?: StaffChat }>(['chat.closed'], (e) => {
    if (e.payload.chat) inbox.getState().upsertChat(e.payload.chat);
    else void inbox.getState().loadChat(e.payload.chatId);
  });

  useRealtimeEvent<{ chatId: string }>(
    ['assignment.accepted', 'chat.transferred', 'participant.joined', 'participant.left'],
    (e) => {
      void inbox.getState().loadChat(e.payload.chatId);
    },
  );

  useRealtimeEvent<{ message: Message }>('message.created', (e) => {
    const m = e.payload.message;
    if (!m) return;
    inbox.getState().applyMessage(m);
    if (m.sender.type === 'visitor') {
      const chat = inbox.getState().chats[m.chatId];
      const participant =
        !!chat &&
        !!membershipId &&
        (chat.ownerMembershipId === membershipId || chat.collaboratorIds.includes(membershipId));
      if (participant) acknowledgeDelivery(m.chatId, m.seq);
      if (chat && chat.ownerMembershipId === membershipId)
        notifyIncoming({ kind: 'message', chat, message: m });
    }
  });

  useRealtimeEvent<{ chatId: string; messageId: string }>('message.redacted', (e) => {
    inbox.getState().redactMessage(e.payload.chatId, e.payload.messageId);
  });

  useRealtimeEvent<{ chatId: string; rating: 'good' | 'bad'; comment: string | null; submittedAt: string }>(
    'rating.updated',
    (e) => {
      const chat = inbox.getState().chats[e.payload.chatId];
      if (chat)
        inbox.getState().upsertChat({
          ...chat,
          rating: {
            rating: e.payload.rating,
            comment: e.payload.comment,
            submittedAt: e.payload.submittedAt,
          },
        });
    },
  );

  useRealtimeEvent<{ chatId: string; actorType: string; throughSeq: number }>('message.read', (e) => {
    if (e.payload.actorType === 'visitor')
      inbox.getState().setVisitorRead(e.payload.chatId, e.payload.throughSeq);
  });

  useRealtimeEvent<{ offer: Offer; chatPreview: StaffChat; from?: string }>('assignment.offered', (e) => {
    const o: PendingOffer = { offer: e.payload.offer, chatPreview: e.payload.chatPreview };
    inbox.getState().addOffer(o);
    notifyIncoming({ kind: 'offer', chat: e.payload.chatPreview, from: e.payload.from });
  });

  useRealtimeEvent<{ offerId: string; reason?: string }>(['assignment.withdrawn'], (e) =>
    inbox.getState().removeOffer(e.payload.offerId),
  );

  useRealtimeEvent<{ offerId: string; chatId: string; reason?: string }>(
    ['transfer.declined', 'transfer.expired'],
    (e) => {
      const chat = inbox.getState().chats[e.payload.chatId];
      const expired = e.type === 'transfer.expired';
      toast.warning(
        chat
          ? t(expired ? 'inbox.sync.transferExpired' : 'inbox.sync.transferDeclined', {
              name: isolate(chat.visitor.displayName),
              number: String(chat.number),
            })
          : t(expired ? 'inbox.sync.transferExpiredUnknown' : 'inbox.sync.transferDeclinedUnknown'),
      );
    },
  );

  useEphemeralEvent<{ chatId: string; actorType: 'agent' | 'visitor'; throughSeq: number }>(
    'message.delivered',
    (e) => {
      if (e.payload?.actorType === 'visitor')
        inbox.getState().setVisitorDelivered(e.payload.chatId, e.payload.throughSeq);
    },
  );

  useEphemeralEvent<{
    chatId: string;
    actor: { type: 'agent' | 'visitor'; id?: string; displayName?: string };
    isTyping: boolean;
    mode?: 'reply' | 'note';
  }>('typing.changed', (e) => {
    const p = e.payload;
    if (!p?.chatId) return;
    if (p.actor.type === 'agent' && p.actor.id === membershipId) return;
    const key = p.actor.type === 'visitor' ? 'visitor' : `agent:${p.actor.id ?? ''}`;
    inbox.getState().setTyping(
      p.chatId,
      key,
      p.isTyping
        ? {
            name: p.actor.displayName ?? t('common.visitor'),
            actorType: p.actor.type,
            mode: p.mode ?? 'reply',
            until: Date.now() + 5500,
          }
        : null,
    );
  });

  useResync(() => {
    const s = inbox.getState();
    void s.loadList('mine');
    void s.loadList('queue');
    if (s.listStatus.all === 'ready') void s.loadList('all');
    void s.loadOffers();
    for (const chatId of Object.keys(s.transcripts)) void s.catchUp(chatId);
  });

  // Expire stale typing indicators even if the stop frame was lost (ch. 14).
  useEffect(() => {
    const timer = setInterval(() => {
      const { typing, setTyping } = inbox.getState();
      const now = Date.now();
      for (const [chatId, actors] of Object.entries(typing))
        for (const [k, v] of Object.entries(actors)) if (v.until < now) setTyping(chatId, k, null);
    }, 1000);
    return () => clearInterval(timer);
  }, [inbox]);

  return null;
}
