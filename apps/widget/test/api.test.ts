import { describe, expect, it } from 'vitest';
import { ApiError, camelize, snakeize, toAccount, toAttachment, toConversation, toMessage, type V2Chat, type V2Message } from '../src/frame/api';
import { handoffFromUrl, sortBySeq } from '../src/frame/controller';

const chat = (p: Partial<V2Chat> = {}): V2Chat => ({
  id: 'c1',
  status: 'queued',
  version: 3,
  lastSeq: 4,
  requestedAt: '2026-10-12T10:00:00Z',
  closedAt: null,
  closeReason: null,
  agents: [],
  rating: null,
  queue: { position: 3, approximate: true },
  ...p,
});

const msg = (p: Partial<V2Message> = {}): V2Message => ({
  id: 'm1',
  chatId: 'c1',
  seq: 2,
  clientMessageId: null,
  sender: { type: 'agent', id: 'a1', displayName: 'Alex' },
  automated: false,
  visibility: 'public',
  type: 'text',
  body: 'Hi',
  options: ['Yes', 'No'],
  systemEvent: null,
  attachments: [],
  sentAt: '2026-10-12T10:01:00Z',
  ...p,
});

describe('wire conversion', () => {
  it('camelizes snake_case payloads but leaves opaque maps untouched', () => {
    expect(camelize({ chat_id: 'c', last_seq: 2, details: { offline_form: true }, items: [{ sent_at: 'x' }] })).toEqual({ chatId: 'c', lastSeq: 2, details: { offline_form: true }, items: [{ sentAt: 'x' }] });
  });

  it('snakeizes request bodies and drops undefined values', () => {
    expect(snakeize({ siteKey: 'rds_1', hostOrigin: 'https://a.test', anonymousToken: undefined, page: { url: 'u' } })).toEqual({ site_key: 'rds_1', host_origin: 'https://a.test', page: { url: 'u' } });
  });

  it('round-trips a snake_case widget config into the WidgetConfig shape', () => {
    const cfg = camelize<{ appearance: { primaryColor: string; launcherIconUrl: null }; behavior: { prechatForm: { enabled: boolean } } }>({
      appearance: { primary_color: '#07778A', launcher_icon_url: null },
      behavior: { prechat_form: { enabled: true } },
    });
    expect(cfg.appearance.primaryColor).toBe('#07778A');
    expect(cfg.behavior.prechatForm.enabled).toBe(true);
  });
});

describe('v2 → UI adapters', () => {
  it('maps chat status, agents, rating and the approximate queue position', () => {
    expect(toConversation(chat()).status).toBe('WAITING');
    expect(toConversation(chat({ status: 'offered' })).status).toBe('WAITING');
    expect(toConversation(chat({ status: 'active' })).status).toBe('ACTIVE');
    const closed = toConversation(chat({ status: 'closed', rating: { rating: 'good', comment: 'Thanks' }, agents: [{ id: 'a1', displayName: 'Alex', avatarUrl: null, title: 'Support' }] }));
    expect(closed).toMatchObject({ status: 'RESOLVED', rating: 'GOOD', ratingComment: 'Thanks', agents: [{ id: 'a1', name: 'Alex' }] });
    expect(toConversation(chat()).queuePosition).toBe(3);
  });

  it('maps senders: agent, visitor, automated (trigger) and system events', () => {
    expect(toMessage(msg())).toMatchObject({ authorType: 'AGENT', type: 'TEXT', agentId: 'a1', options: ['Yes', 'No'], seq: 2 });
    expect(toMessage(msg({ sender: { type: 'visitor', id: 'v1', displayName: 'Visitor 1' }, clientMessageId: 'cm1' }))).toMatchObject({ authorType: 'VISITOR', clientId: 'cm1' });
    expect(toMessage(msg({ sender: { type: 'system', id: null, displayName: 'Concierge' }, automated: true }))).toMatchObject({ authorType: 'TRIGGER', type: 'TEXT', authorName: 'Concierge' });
    const ev = toMessage(msg({ type: 'system', sender: { type: 'system', id: null, displayName: 'System' }, systemEvent: { kind: 'chat.agent_joined' }, body: 'Alex joined' }));
    expect(ev).toMatchObject({ type: 'EVENT', authorType: 'SYSTEM', event: { kind: 'chat.agent_joined' } });
  });

  it('marks agent messages at or below the stored read cursor as read', () => {
    expect(toMessage(msg({ seq: 2 }), [], 2).readByVisitorAt).not.toBeNull();
    expect(toMessage(msg({ seq: 3 }), [], 2).readByVisitorAt).toBeNull();
  });

  it('treats busy-but-queueing sites as online and maps department states', () => {
    expect(toAccount({ state: 'busy', acceptsQueue: true, nextOpenAt: null, departments: [{ id: 'd1', label: 'Sales', state: 'offline', nextOpenAt: null }] })).toEqual({ online: true, departments: [{ id: 'd1', name: 'Sales', online: false }], nextOpenAt: null });
    expect(toAccount({ state: 'offline', acceptsQueue: false, nextOpenAt: null, departments: [] }).online).toBe(false);
  });

  it('orders by seq with unsent local messages last (public seq gaps are fine)', () => {
    const a = toMessage(msg({ id: 'a', seq: 5 }));
    const b = toMessage(msg({ id: 'b', seq: 2 }));
    const local = { ...toMessage(msg({ id: 'l' })), seq: undefined, local: 'pending' as const };
    expect(sortBySeq([local, a, b]).map((m) => m.id)).toEqual(['b', 'a', 'l']);
  });
});

describe('v2 integrations', () => {
  it('maps attachment refs with their scan state and no direct URL', () => {
    expect(toAttachment({ id: 'f1', name: 'a.png', sizeBytes: 10, mime: 'image/png', isImage: true, state: 'scanning' })).toEqual({ id: 'f1', name: 'a.png', size: 10, mimeType: 'image/png', url: '', isImage: true, state: 'scanning', errorCode: null });
    expect(toAttachment({ id: 'f2', name: 'x.exe', sizeBytes: 1, mime: 'application/octet-stream', isImage: false, state: 'rejected', errorCode: 'FILE_TYPE_BLOCKED' }).errorCode).toBe('FILE_TYPE_BLOCKED');
  });

  it('reads a one-time identity handoff code from the host page URL', () => {
    expect(handoffFromUrl('https://shop.test/account?rd_handoff=rdh_abc12345&x=1')).toBe('rdh_abc12345');
    expect(handoffFromUrl('https://shop.test/?rd_handoff=<script>')).toBeNull();
    expect(handoffFromUrl('not a url')).toBeNull();
  });

  it('keeps server field errors (wire names) on ApiError and leaves custom_fields keys untouched', () => {
    const e = new ApiError('VALIDATION_FAILED', 'Check the highlighted fields.', 422, false, null, { phone: ['Use digits'] });
    expect(e.fieldErrors?.phone).toEqual(['Use digits']);
    expect(snakeize({ customFields: { planTier: 'pro' } })).toEqual({ custom_fields: { planTier: 'pro' } });
  });
});
