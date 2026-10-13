import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessagePage } from '@/lib/types';

/**
 * WS02 (ch. 13): the inbox reducer tolerates duplicate and reordered frames and recovers gaps over REST.
 * `api.get` answers from an in-memory transcript (the server's view); the realtime client is not involved.
 */
const server: Message[] = [];
const get = vi.fn(async (path: string, query: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): Promise<MessagePage> => {
  const after = query.afterSeq ?? 0;
  const items = server.filter((m) => path.endsWith(`/chats/${m.chatId}/messages`) && m.seq > after).slice(0, query.limit ?? 50);
  const lastSeq = server.reduce((n, m) => Math.max(n, m.seq), 0);
  return { items, throughSeq: items.length ? items[items.length - 1]!.seq : after, lastSeq, hasMore: false };
});
vi.mock('@/lib/api', () => ({ api: { get: (...a: Parameters<typeof get>) => get(...a), post: vi.fn(), put: vi.fn() }, ApiError: class extends Error {}, errorMessage: (_e: unknown, fallback: string) => fallback }));
vi.mock('@/lib/realtime', () => ({ realtime: { connected: false, command: vi.fn() } }));
vi.mock('@/i18n', () => ({ tStatic: (key: string) => key }));

const { useInbox, mergeMessages } = await import('./inbox');

const CHAT = 'c0000000-0000-4000-8000-000000000001';
const msg = (seq: number, patch: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  chatId: CHAT,
  seq,
  clientMessageId: null,
  sender: { type: 'visitor', id: 'v1', displayName: 'Visitor' },
  automated: false,
  visibility: 'public',
  type: 'text',
  body: `message ${seq}`,
  options: [],
  systemEvent: null,
  attachments: [],
  sentAt: new Date(Date.UTC(2026, 9, 13, 10, 0, seq)).toISOString(),
  redacted: false,
  ...patch,
});
const transcript = () => useInbox.getState().transcripts[CHAT]!;
const seqs = () => transcript().items.map((m) => m.seq);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  useInbox.getState().reset();
  server.length = 0;
  get.mockClear();
  server.push(msg(1), msg(2));
  await useInbox.getState().loadTranscript(CHAT);
  get.mockClear();
});

describe('inbox reducer (WS02)', () => {
  it('ignores duplicate frames: one entry per message id', () => {
    server.push(msg(3));
    for (let i = 0; i < 3; i++) useInbox.getState().applyMessage(msg(3));
    expect(seqs()).toEqual([1, 2, 3]);
    expect(transcript().throughSeq).toBe(3);
    expect(get).not.toHaveBeenCalled();
  });

  it('reversed frames end in seq order, and the gap they open is filled over REST', async () => {
    server.push(msg(3), msg(4), msg(5));
    const { applyMessage } = useInbox.getState();
    applyMessage(msg(5));
    applyMessage(msg(4));
    applyMessage(msg(3));
    await settle();
    expect(get).toHaveBeenCalledWith(`/chats/${CHAT}/messages`, { afterSeq: 2, limit: 100 });
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(transcript().throughSeq).toBe(5);
  });

  it('a dropped frame is recovered from the next one that reveals the gap', async () => {
    server.push(msg(3), msg(4));
    useInbox.getState().applyMessage(msg(4)); // seq 3 never arrives as a frame
    await settle();
    expect(seqs()).toEqual([1, 2, 3, 4]);
    expect(transcript().items.find((m) => m.seq === 3)?.body).toBe('message 3');
  });

  it('redaction is permanent: a replayed frame or a stale REST page cannot bring the content back', async () => {
    useInbox.getState().redactMessage(CHAT, 'm2');
    useInbox.getState().applyMessage(msg(2)); // replayed original
    expect(transcript().items.find((m) => m.id === 'm2')).toMatchObject({ redacted: true, body: null });
    // A transcript reload whose response was produced before the redaction (the server copy here is the original).
    await useInbox.getState().loadTranscript(CHAT);
    expect(get).toHaveBeenCalled();
    expect(transcript().items.find((m) => m.id === 'm2')).toMatchObject({ redacted: true, body: null });
    expect(mergeMessages([msg(2, { redacted: true, body: null })], [msg(2)])[0]!.body).toBeNull();
  });
});
