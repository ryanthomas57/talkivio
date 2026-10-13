'use client';
/**
 * Inbox engine (ch. 12–15). Holds chats the agent can see, server-ordered
 * transcripts, pending sends and offers, and applies realtime events.
 *
 * Ordering rules (ch. 13): messages are keyed by id and rendered by `seq`; a gap
 * in seq triggers a REST catch-up (`after_seq`), never indefinite buffering.
 * Sends carry a client_message_id created before the first attempt; a retry reuses
 * it, so the server returns the same message instead of a duplicate.
 */
import { create } from 'zustand';
import { api, ApiError, errorMessage } from '@/lib/api';
import { uuid } from '@/lib/ids';
import { realtime } from '@/lib/realtime';
import type { Message, MessagePage, PendingOffer, StaffChat } from '@/lib/types';
import { tStatic } from '@/i18n';

export type InboxView = 'mine' | 'queue' | 'all';

export interface PendingSend {
  clientMessageId: string;
  chatId: string;
  body: string;
  visibility: 'public' | 'internal';
  attachmentIds: string[];
  replyId: string | null;
  options: string[];
  status: 'sending' | 'failed';
  error: string | null;
  errorCode: string | null;
  createdAt: number;
}

export interface Transcript {
  /** Ascending by seq, unique by id. */
  items: Message[];
  /** Highest seq the client has accounted for (visible or filtered). */
  throughSeq: number;
  hasMoreBefore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

export interface TypingState {
  name: string;
  actorType: 'agent' | 'visitor';
  mode: 'reply' | 'note';
  until: number;
}

interface InboxState {
  me: string | null;
  chats: Record<string, StaffChat>;
  lists: Record<InboxView, string[]>;
  listStatus: Record<InboxView, 'idle' | 'loading' | 'ready' | 'error'>;
  listError: Record<InboxView, string | null>;
  transcripts: Record<string, Transcript>;
  pending: Record<string, PendingSend[]>;
  typing: Record<string, Record<string, TypingState>>;
  offers: PendingOffer[];
  /** Chats closed while in the agent's workspace; kept visible until dismissed. */
  endedOpen: string[];
  focusedChatId: string | null;
  /** Highest seq the visitor has read (read receipts, when enabled). */
  visitorRead: Record<string, number>;
  /** Highest seq the visitor's transport acknowledged (delivered receipts). */
  visitorDelivered: Record<string, number>;

  init: (membershipId: string) => void;
  reset: () => void;
  loadList: (view: InboxView) => Promise<void>;
  loadOffers: () => Promise<void>;
  loadChat: (chatId: string) => Promise<StaffChat | null>;
  loadTranscript: (chatId: string) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  catchUp: (chatId: string) => Promise<void>;
  upsertChat: (chat: StaffChat) => void;
  applyMessage: (m: Message) => void;
  /** `message.redacted`: drop the cached body and attachments, keep a tombstone in place. */
  redactMessage: (chatId: string, messageId: string) => void;
  send: (chatId: string, input: { body: string; visibility: 'public' | 'internal'; attachmentIds?: string[]; replyId?: string | null; options?: string[] }) => Promise<void>;
  retry: (chatId: string, clientMessageId: string) => Promise<void>;
  discardPending: (chatId: string, clientMessageId: string) => void;
  markRead: (chatId: string) => void;
  setTyping: (chatId: string, actorKey: string, t: TypingState | null) => void;
  setFocused: (chatId: string | null) => void;
  dismissEnded: (chatId: string) => void;
  removeOffer: (offerId: string) => void;
  addOffer: (o: PendingOffer) => void;
  setVisitorRead: (chatId: string, seq: number) => void;
  setVisitorDelivered: (chatId: string, seq: number) => void;
}

const emptyTranscript = (): Transcript => ({ items: [], throughSeq: 0, hasMoreBefore: false, loading: false, loadingOlder: false, error: null });

/** Upsert by id and order by seq. Redaction is permanent: a replayed frame or a REST page fetched before the
 * `message.redacted` event (and applied after it) must not bring the removed content back. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev?.redacted && !m.redacted ? prev : m);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const readSent = new Map<string, number>();
const catchingUp = new Set<string>();

export const useInbox = create<InboxState>((set, get) => ({
  me: null,
  chats: {},
  lists: { mine: [], queue: [], all: [] },
  listStatus: { mine: 'idle', queue: 'idle', all: 'idle' },
  listError: { mine: null, queue: null, all: null },
  transcripts: {},
  pending: {},
  typing: {},
  offers: [],
  endedOpen: [],
  focusedChatId: null,
  visitorRead: {},
  visitorDelivered: {},

  init: (membershipId) => set({ me: membershipId }),

  reset: () => {
    readSent.clear();
    catchingUp.clear();
    set({
      me: null,
      chats: {},
      lists: { mine: [], queue: [], all: [] },
      listStatus: { mine: 'idle', queue: 'idle', all: 'idle' },
      listError: { mine: null, queue: null, all: null },
      transcripts: {},
      pending: {},
      typing: {},
      offers: [],
      endedOpen: [],
      focusedChatId: null,
      visitorRead: {},
      visitorDelivered: {},
    });
  },

  async loadList(view) {
    set((s) => ({ listStatus: { ...s.listStatus, [view]: s.listStatus[view] === 'ready' ? 'ready' : 'loading' }, listError: { ...s.listError, [view]: null } }));
    try {
      const page = await api.page<StaffChat>('/chats', { view });
      set((s) => {
        const chats = { ...s.chats };
        for (const c of page.items) chats[c.id] = { ...chats[c.id], ...c };
        return { chats, lists: { ...s.lists, [view]: page.items.map((c) => c.id) }, listStatus: { ...s.listStatus, [view]: 'ready' } };
      });
    } catch (e) {
      set((s) => ({ listStatus: { ...s.listStatus, [view]: 'error' }, listError: { ...s.listError, [view]: errorMessage(e) } }));
    }
  },

  async loadOffers() {
    try {
      const offers = await api.get<PendingOffer[]>('/chats/offers');
      set({ offers });
    } catch {
      /* the offer center shows nothing new; the next event or resync retries */
    }
  },

  async loadChat(chatId) {
    try {
      const chat = await api.get<StaffChat>(`/chats/${chatId}`);
      get().upsertChat(chat);
      return chat;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        set((s) => {
          const lists = { mine: s.lists.mine.filter((x) => x !== chatId), queue: s.lists.queue.filter((x) => x !== chatId), all: s.lists.all.filter((x) => x !== chatId) };
          return { lists };
        });
      }
      return null;
    }
  },

  async loadTranscript(chatId) {
    const cur = get().transcripts[chatId];
    if (cur?.loading) return;
    set((s) => ({ transcripts: { ...s.transcripts, [chatId]: { ...(cur ?? emptyTranscript()), loading: true, error: null } } }));
    try {
      const page = await api.get<MessagePage>(`/chats/${chatId}/messages`, { limit: 50 });
      set((s) => {
        const prev = s.transcripts[chatId] ?? emptyTranscript();
        const items = mergeMessages(prev.items, page.items);
        const first = page.items[0]?.seq ?? 1;
        return {
          transcripts: {
            ...s.transcripts,
            [chatId]: { ...prev, items, throughSeq: Math.max(prev.throughSeq, page.throughSeq), hasMoreBefore: prev.items.length ? prev.hasMoreBefore : page.hasMore || first > 1 && page.hasMore, loading: false, error: null },
          },
        };
      });
      // Messages may have been committed between the snapshot and the subscription.
      await get().catchUp(chatId);
    } catch (e) {
      set((s) => ({ transcripts: { ...s.transcripts, [chatId]: { ...(s.transcripts[chatId] ?? emptyTranscript()), loading: false, error: errorMessage(e) } } }));
    }
  },

  async loadOlder(chatId) {
    const t = get().transcripts[chatId];
    if (!t || t.loadingOlder || !t.hasMoreBefore || !t.items.length) return;
    set((s) => ({ transcripts: { ...s.transcripts, [chatId]: { ...t, loadingOlder: true } } }));
    try {
      const page = await api.get<MessagePage>(`/chats/${chatId}/messages`, { beforeSeq: t.items[0]!.seq, limit: 50 });
      set((s) => {
        const prev = s.transcripts[chatId] ?? emptyTranscript();
        return { transcripts: { ...s.transcripts, [chatId]: { ...prev, items: mergeMessages(prev.items, page.items), hasMoreBefore: page.hasMore, loadingOlder: false } } };
      });
    } catch (e) {
      set((s) => ({ transcripts: { ...s.transcripts, [chatId]: { ...(s.transcripts[chatId] ?? emptyTranscript()), loadingOlder: false, error: errorMessage(e) } } }));
    }
  },

  /** REST gap recovery: fetch everything after the highest accounted-for seq. */
  async catchUp(chatId) {
    if (catchingUp.has(chatId)) return;
    catchingUp.add(chatId);
    try {
      for (let i = 0; i < 20; i++) {
        const t = get().transcripts[chatId];
        if (!t) return;
        const page = await api.get<MessagePage>(`/chats/${chatId}/messages`, { afterSeq: t.throughSeq, limit: 100 });
        set((s) => {
          const prev = s.transcripts[chatId] ?? emptyTranscript();
          return { transcripts: { ...s.transcripts, [chatId]: { ...prev, items: mergeMessages(prev.items, page.items), throughSeq: Math.max(prev.throughSeq, page.throughSeq) } } };
        });
        for (const m of page.items) settlePending(m);
        if (!page.hasMore) break;
      }
    } catch {
      /* the next event or resync retries */
    } finally {
      catchingUp.delete(chatId);
    }
  },

  upsertChat(chat) {
    set((s) => {
      const prev = s.chats[chat.id];
      if (prev && prev.version > chat.version) return {};
      // Event projections omit live presence; keep the last known value until a snapshot says otherwise.
      const visitor = { ...chat.visitor, online: chat.visitor.online ?? prev?.visitor.online };
      const merged: StaffChat = { ...prev, ...chat, visitor, unreadCount: chat.unreadCount ?? prev?.unreadCount ?? 0 };
      const chats = { ...s.chats, [chat.id]: merged };
      const me = s.me;
      const participant = !!me && (merged.ownerMembershipId === me || merged.collaboratorIds.includes(me));
      const queued = merged.status === 'queued' || merged.status === 'offered';
      const without = (l: string[]) => l.filter((x) => x !== chat.id);
      let mine = s.lists.mine;
      let queue = s.lists.queue;
      let all = s.lists.all;
      let endedOpen = s.endedOpen;
      if (participant && merged.status !== 'closed') mine = mine.includes(chat.id) ? mine : [chat.id, ...mine];
      else if (merged.status === 'closed' && mine.includes(chat.id)) {
        endedOpen = endedOpen.includes(chat.id) ? endedOpen : [...endedOpen, chat.id];
      } else if (!participant) mine = without(mine);
      queue = queued ? (queue.includes(chat.id) ? queue : [...queue, chat.id]) : without(queue);
      if (merged.status === 'closed') all = without(all);
      else if (s.listStatus.all === 'ready' && !all.includes(chat.id)) all = [chat.id, ...all];
      queue = sortQueue(queue, chats);
      mine = [...mine].sort((a, b) => Date.parse(chats[b]?.lastMessageAt ?? '0') - Date.parse(chats[a]?.lastMessageAt ?? '0'));
      return { chats, lists: { mine, queue, all }, endedOpen };
    });
  },

  redactMessage(chatId, messageId) {
    set((st) => {
      const prev = st.transcripts[chatId];
      if (!prev || !prev.items.some((x) => x.id === messageId)) return {};
      const items = prev.items.map((x) => (x.id === messageId ? { ...x, body: null, options: [], attachments: [], redacted: true } : x));
      return { transcripts: { ...st.transcripts, [chatId]: { ...prev, items } } };
    });
  },

  applyMessage(m) {
    const s = get();
    const t = s.transcripts[m.chatId];
    const chat = s.chats[m.chatId];
    if (t) {
      const gap = m.seq > t.throughSeq + 1;
      set((st) => {
        const prev = st.transcripts[m.chatId] ?? emptyTranscript();
        return { transcripts: { ...st.transcripts, [m.chatId]: { ...prev, items: mergeMessages(prev.items, [m]), throughSeq: gap ? prev.throughSeq : Math.max(prev.throughSeq, m.seq) } } };
      });
      if (gap) void get().catchUp(m.chatId);
    }
    settlePending(m);
    if (chat) {
      const fromVisitor = m.sender.type === 'visitor';
      const focused = s.focusedChatId === m.chatId && typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
      const preview = m.visibility === 'public' ? (m.body ?? (m.attachments.length ? `📎 ${m.attachments[0]!.name}` : chat.lastMessagePreview)) : chat.lastMessagePreview;
      get().upsertChat({
        ...chat,
        lastMessageAt: m.sentAt,
        lastMessagePreview: preview.slice(0, 140),
        lastSeq: Math.max(chat.lastSeq, m.seq),
        lastPublicSenderType: m.visibility === 'public' ? m.sender.type : chat.lastPublicSenderType,
        awaitingReply: m.visibility === 'public' ? fromVisitor : chat.awaitingReply,
        unreadCount: fromVisitor && !focused ? (chat.unreadCount ?? 0) + 1 : chat.unreadCount ?? 0,
      });
      // Typing stops when a message from that actor lands.
      if (fromVisitor) get().setTyping(m.chatId, 'visitor', null);
    }
  },

  async send(chatId, input) {
    const p: PendingSend = {
      clientMessageId: uuid(),
      chatId,
      body: input.body,
      visibility: input.visibility,
      attachmentIds: input.attachmentIds ?? [],
      replyId: input.replyId ?? null,
      options: input.visibility === 'public' ? (input.options ?? []) : [],
      status: 'sending',
      error: null,
      errorCode: null,
      createdAt: Date.now(),
    };
    set((s) => ({ pending: { ...s.pending, [chatId]: [...(s.pending[chatId] ?? []), p] } }));
    await deliver(p);
  },

  async retry(chatId, clientMessageId) {
    const p = get().pending[chatId]?.find((x) => x.clientMessageId === clientMessageId);
    if (!p || p.status === 'sending') return;
    updatePending(chatId, clientMessageId, { status: 'sending', error: null, errorCode: null });
    await deliver({ ...p, status: 'sending' });
  },

  discardPending(chatId, clientMessageId) {
    set((s) => ({ pending: { ...s.pending, [chatId]: (s.pending[chatId] ?? []).filter((x) => x.clientMessageId !== clientMessageId) } }));
  },

  /** Advance the read cursor monotonically once the chat is visible and focused (ch. 13/14). */
  markRead(chatId) {
    const s = get();
    const t = s.transcripts[chatId];
    const chat = s.chats[chatId];
    if (!t || !chat || !s.me) return;
    const participant = chat.ownerMembershipId === s.me || chat.collaboratorIds.includes(s.me);
    if (!participant) return;
    const last = t.items.length ? t.items[t.items.length - 1]!.seq : 0;
    const through = Math.min(Math.max(last, t.throughSeq), chat.lastSeq || last);
    if (through <= (readSent.get(chatId) ?? 0)) return;
    readSent.set(chatId, through);
    if ((chat.unreadCount ?? 0) > 0) set((st) => ({ chats: { ...st.chats, [chatId]: { ...st.chats[chatId]!, unreadCount: 0 } } }));
    const req = realtime.connected ? realtime.command('message.read', { chatId, lastReadSeq: through }) : api.put(`/chats/${chatId}/read-cursor`, { lastReadSeq: through });
    req.catch(() => readSent.delete(chatId));
  },

  setTyping(chatId, actorKey, t) {
    set((s) => {
      const cur = { ...(s.typing[chatId] ?? {}) };
      if (t) cur[actorKey] = t;
      else delete cur[actorKey];
      return { typing: { ...s.typing, [chatId]: cur } };
    });
  },

  setFocused: (chatId) => set({ focusedChatId: chatId }),

  dismissEnded(chatId) {
    set((s) => ({ endedOpen: s.endedOpen.filter((x) => x !== chatId), lists: { ...s.lists, mine: s.lists.mine.filter((x) => x !== chatId) } }));
  },

  removeOffer: (offerId) => set((s) => ({ offers: s.offers.filter((o) => o.offer.id !== offerId) })),
  addOffer: (o) => set((s) => ({ offers: [...s.offers.filter((x) => x.offer.id !== o.offer.id), o] })),
  setVisitorRead: (chatId, seq) => set((s) => ({ visitorRead: { ...s.visitorRead, [chatId]: Math.max(s.visitorRead[chatId] ?? 0, seq) } })),
  setVisitorDelivered: (chatId, seq) => set((s) => ({ visitorDelivered: { ...s.visitorDelivered, [chatId]: Math.max(s.visitorDelivered[chatId] ?? 0, seq) } })),
}));

/** Coalesced delivery acknowledgements for visitor messages this agent received (ch. 13). */
const pendingAcks = new Map<string, number>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;
export function acknowledgeDelivery(chatId: string, seq: number): void {
  pendingAcks.set(chatId, Math.max(pendingAcks.get(chatId) ?? 0, seq));
  if (ackTimer) return;
  ackTimer = setTimeout(() => {
    ackTimer = null;
    const batch = [...pendingAcks.entries()];
    pendingAcks.clear();
    if (!realtime.connected) return;
    for (const [id, through] of batch) void realtime.command('message.delivered', { chatId: id, lastDeliveredSeq: through }).catch(() => undefined);
  }, 400);
}

function sortQueue(ids: string[], chats: Record<string, StaffChat>): string[] {
  return [...ids].sort((a, b) => {
    const x = chats[a];
    const y = chats[b];
    if (!x || !y) return 0;
    if (x.priority !== y.priority) return y.priority - x.priority;
    const t = Date.parse(x.requestedAt) - Date.parse(y.requestedAt);
    return t !== 0 ? t : a.localeCompare(b);
  });
}

function updatePending(chatId: string, clientMessageId: string, patch: Partial<PendingSend>): void {
  useInbox.setState((s) => ({ pending: { ...s.pending, [chatId]: (s.pending[chatId] ?? []).map((x) => (x.clientMessageId === clientMessageId ? { ...x, ...patch } : x)) } }));
}

/** Remove a pending bubble once the durable message (same client id) is known. */
function settlePending(m: Message): void {
  if (!m.clientMessageId) return;
  const list = useInbox.getState().pending[m.chatId];
  if (!list?.some((x) => x.clientMessageId === m.clientMessageId)) return;
  useInbox.setState((s) => ({ pending: { ...s.pending, [m.chatId]: (s.pending[m.chatId] ?? []).filter((x) => x.clientMessageId !== m.clientMessageId) } }));
}

async function deliver(p: PendingSend): Promise<void> {
  const payload = { chatId: p.chatId, clientMessageId: p.clientMessageId, body: p.body || null, visibility: p.visibility, attachmentIds: p.attachmentIds, replyId: p.replyId, options: p.options, type: p.attachmentIds.length && !p.body ? 'attachment' : 'text' };
  try {
    let message: Message;
    if (realtime.connected) {
      const { type: _type, ...cmd } = payload;
      message = await realtime.command<Message>('message.send', cmd);
    } else {
      const { chatId: _c, ...body } = payload;
      message = await api.post<Message>(`/chats/${p.chatId}/messages`, body);
    }
    useInbox.getState().applyMessage(message);
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'NETWORK';
    updatePending(p.chatId, p.clientMessageId, { status: 'failed', error: errorMessage(e, tStatic('common.notSent')), errorCode: code });
  }
}
