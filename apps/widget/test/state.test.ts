import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_CONFIG, type MessageDTO, type WidgetConfig } from '@talkivio/contracts/protocol';
import { LAYOUT_PAD, type LayoutMessage } from '../src/common/protocol';
import { sanitizeSettingsPatch } from '../src/frame/controller';
import { computeInvitation, computeUnread, initialState, isHidden, panelView, type State, mergeIncoming, type UiMessage } from '../src/frame/state';
import { frameGeometry } from '../src/loader/mount';

const cfg = (patch: (c: WidgetConfig) => void = () => undefined): WidgetConfig => {
  const c: WidgetConfig = JSON.parse(JSON.stringify(DEFAULT_WIDGET_CONFIG));
  patch(c);
  return c;
};

const ready = (p: Partial<State> = {}): State =>
  initialState({ configLoaded: true, sessionReady: true, connection: 'connected', account: { online: true, departments: [] }, pageUrl: 'https://shop.test/', ...p });

const agentMsg = (id: string, read = false): MessageDTO => ({
  id,
  conversationId: 'c1',
  type: 'TEXT',
  authorType: 'AGENT',
  agentId: 'a1',
  authorName: 'Alex',
  authorAvatarUrl: null,
  body: 'Hello',
  attachments: [],
  event: null,
  options: [],
  clientId: null,
  createdAt: new Date().toISOString(),
  readByVisitorAt: read ? new Date().toISOString() : null,
});

describe('page visibility rules', () => {
  it('hides the widget on excluded URLs unless the panel is open', () => {
    const config = cfg((c) => (c.behavior.visibility = { mode: 'exclude', patterns: ['*/checkout*'] }));
    expect(isHidden(ready({ config, pageUrl: 'https://shop.test/checkout/pay' }))).toBe(true);
    expect(isHidden(ready({ config, pageUrl: 'https://shop.test/products' }))).toBe(false);
    expect(isHidden(ready({ config, pageUrl: 'https://shop.test/checkout/pay', open: true }))).toBe(false);
  });

  it('honours include-only rules, hideOnMobile and hideWhenOffline', () => {
    const include = cfg((c) => (c.behavior.visibility = { mode: 'include', patterns: ['/pricing'] }));
    expect(isHidden(ready({ config: include, pageUrl: 'https://shop.test/pricing' }))).toBe(false);
    expect(isHidden(ready({ config: include, pageUrl: 'https://shop.test/blog' }))).toBe(true);
    const mobile = cfg((c) => (c.behavior.hideOnMobile = true));
    expect(isHidden(ready({ config: mobile, viewport: { ...initialState().viewport, compact: true } }))).toBe(true);
    const offline = cfg((c) => (c.behavior.hideWhenOffline = true));
    expect(isHidden(ready({ config: offline, account: { online: false, departments: [] } }))).toBe(true);
    expect(
      isHidden(ready({ config: offline, account: { online: false, departments: [] }, conversation: { id: 'c1', status: 'ACTIVE', agents: [], rating: null, ratingComment: null, queuePosition: null } })),
    ).toBe(false);
  });
});

describe('panel state machine', () => {
  it('routes to prechat, offline, queued, rating and ended views', () => {
    const prechat = cfg((c) => (c.behavior.prechatForm.enabled = true));
    expect(panelView(ready({ config: prechat }))).toBe('prechat');
    // A proactive invitation skips the pre-chat form.
    expect(panelView(ready({ config: prechat, proactive: [agentMsg('proactive-v-0')] }))).toBe('welcome');
    expect(panelView(ready({ account: { online: false, departments: [] } }))).toBe('offline');
    expect(panelView(ready({ offlineSent: { reference: 'R-1' } }))).toBe('offline_success');
    const conv = { id: 'c1', status: 'WAITING' as const, agents: [], rating: null, ratingComment: null, queuePosition: 2 };
    expect(panelView(ready({ conversation: conv }))).toBe('queued');
    expect(panelView(ready({ conversation: { ...conv, status: 'RESOLVED' } }))).toBe('rating');
    expect(panelView(ready({ conversation: { ...conv, status: 'RESOLVED', rating: 'GOOD' } }))).toBe('ended');
    expect(panelView(initialState({ configLoaded: true }))).toBe('loading');
    expect(panelView(initialState({ configLoaded: true, fatal: 'ORIGIN_NOT_ALLOWED' }))).toBe('error');
  });

  it('counts unread agent messages only while closed or hidden', () => {
    const conv = { id: 'c1', status: 'ACTIVE' as const, agents: [], rating: null, ratingComment: null, queuePosition: null };
    const messages = [agentMsg('m1', true), agentMsg('m2'), agentMsg('m3')];
    expect(computeUnread(ready({ conversation: conv, messages }))).toBe(2);
    expect(computeUnread(ready({ conversation: conv, messages, open: true }))).toBe(0);
    expect(computeUnread(ready({ conversation: conv, messages, open: true, hostVisible: false }))).toBe(2);
  });

  it('shows an invitation card for proactive messages until seen', () => {
    const p = { ...agentMsg('proactive-v-0'), authorType: 'TRIGGER' as const, authorName: 'Concierge' };
    const s = ready({ proactive: [p] });
    const inv = computeInvitation(s);
    expect(inv?.kind).toBe('proactive');
    expect(computeInvitation({ ...s, seen: [inv!.id] })).toBeNull();
    expect(computeInvitation({ ...s, open: true })).toBeNull();
  });
});

describe('settings patch sanitizer', () => {
  it('keeps only presentation keys with matching types', () => {
    const out = sanitizeSettingsPatch({ appearance: { title: 'Hi', width: 'wide', position: 'bottom-left' }, content: { welcomeMessage: 'Yo' }, behavior: { sound: false }, subtitle: 'Fast replies' });
    expect(out).toEqual({ appearance: { title: 'Hi', position: 'bottom-left', subtitle: 'Fast replies' }, content: { welcomeMessage: 'Yo' } });
  });
});

describe('loader frame geometry', () => {
  const base: LayoutMessage = { source: 'talkivio-frame', type: 'layout', mode: 'launcher', width: 56 + 2 * LAYOUT_PAD, height: 56 + 2 * LAYOUT_PAD, position: 'bottom-right', offsetX: 20 - LAYOUT_PAD, offsetY: 20 - LAYOUT_PAD, fullscreen: false };

  it('places the launcher in the configured corner', () => {
    const g = frameGeometry(base, 1280, 800);
    expect(g).toMatchObject({ right: '4px', bottom: '4px', left: 'auto', width: '88px', height: '88px', 'box-shadow': 'none' });
    expect(frameGeometry({ ...base, position: 'bottom-left' }, 1280, 800)).toMatchObject({ left: '4px', right: 'auto' });
  });

  it('clamps the open panel to min(640, viewport − 96) with the panel shadow', () => {
    const open = { ...base, mode: 'open' as const, width: 380, height: 640, offsetX: 20, offsetY: 20, radius: 16 };
    expect(frameGeometry(open, 1280, 900)).toMatchObject({ width: '380px', height: '640px', 'border-radius': '16px' });
    expect(frameGeometry(open, 1280, 700).height).toBe('604px');
    expect(frameGeometry(open, 1280, 700)['box-shadow']).toContain('48px');
  });

  it('covers the viewport when fullscreen and hides when hidden', () => {
    expect(frameGeometry({ ...base, mode: 'open', fullscreen: true }, 390, 700)).toMatchObject({ width: '100%', height: '700px', top: '0px', 'border-radius': '0px' });
    expect(frameGeometry({ ...base, mode: 'hidden' }, 390, 700)).toMatchObject({ width: '0px', visibility: 'hidden' });
  });
});

describe('incoming message copies (WS02)', () => {
  const base = { id: 'm1', conversationId: 'c1', type: 'TEXT', authorType: 'AGENT', authorName: 'Ada', body: 'Card ending 4242', attachments: [], createdAt: '2026-10-13T10:00:00.000Z', seq: 3 } as unknown as UiMessage;
  it('a newer copy replaces the shown message and keeps its read mark', () => {
    const shown = { ...base, readByVisitorAt: '2026-10-13T10:00:05.000Z' } as UiMessage;
    const merged = mergeIncoming(shown, { ...base, body: 'Card ending 4242 (edited)' } as UiMessage);
    expect(merged.body).toBe('Card ending 4242 (edited)');
    expect(merged.readByVisitorAt).toBe('2026-10-13T10:00:05.000Z');
  });
  it('a replayed or late original never brings redacted content back', () => {
    const redacted = { ...base, body: '', attachments: [], redacted: true } as UiMessage;
    expect(mergeIncoming(redacted, base)).toBe(redacted);
    expect(mergeIncoming(redacted, { ...base, body: '', redacted: true } as UiMessage).redacted).toBe(true);
  });
});
