import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { settle } from './routes';

/**
 * AUD-71-06 (loader is async, isolated, idempotent and removable) and AUD-71-08 (SDK methods return their
 * documented completion results; public events are safe), against docs/widget-sdk.md, on a host page served by the
 * widget demo storefront (an allowed site origin) that carries the documented snippet. Loader, frame and API are real.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';

type Site = { id: string; public_key: string; version: number; origins: Array<{ origin: string; pattern_type: string }> };
type Result = { ok: true; value: unknown } | { ok: false; code: string };

async function csrfOf(request: APIRequestContext) {
  return (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '';
}

async function demoSite(request: APIRequestContext): Promise<Site> {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Site[];
  const ready = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  if (ready) return ready;
  const site = sites[0]!;
  const origins = [...site.origins.map((o) => ({ origin: o.origin, pattern_type: o.pattern_type })), { origin: DEMO, pattern_type: 'exact' }];
  const r = await request.patch(`${API}/api/v1/sites/${site.id}`, { data: { origins, expected_version: site.version }, headers: { 'x-csrf-token': await csrfOf(request) } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).data as Site;
}

/** An online agent with a live dashboard connection, so the widget offers chat. */
async function onlineAgent(context: BrowserContext, request: APIRequestContext): Promise<Page> {
  const agent = await context.newPage();
  await agent.goto('/inbox');
  await settle(agent);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers: { 'x-csrf-token': await csrfOf(request) } });
  return agent;
}

/** The demo server's test host page (apps/widget/demo/sdk-host.html) with the real embed snippet. Served from the
 * demo origin itself: Chrome's local network access rules only let a page served from a local address load the
 * loader from the local API. */
async function openHost(page: Page, siteKey: string, opts: { css?: 'hostile'; pre?: 'open'; loaders?: number } = {}) {
  const q = new URLSearchParams({ key: siteKey, api: API, loaders: String(opts.loaders ?? 1), ...(opts.css ? { css: opts.css } : {}), ...(opts.pre ? { pre: opts.pre } : {}) });
  await page.goto(`${DEMO}/sdk-host.html?${q}`);
}

const call = (page: Page, command: string, ...args: unknown[]): Promise<Result> =>
  page.evaluate(
    async ([c, a]) => {
      try {
        return { ok: true as const, value: await (window as unknown as { Talkivio: (...x: unknown[]) => unknown }).Talkivio(c, ...(a as unknown[])) };
      } catch (e) {
        return { ok: false as const, code: String((e as { code?: string }).code) };
      }
    },
    [command, args] as const,
  );
const sync = <T>(page: Page, command: string) => page.evaluate((c) => (window as unknown as { Talkivio: (x: string) => T }).Talkivio(c), command);
const events = (page: Page) => page.evaluate(() => (window as unknown as { __events: Array<[string, Record<string, unknown>]> }).__events);
const isReady = (page: Page) => page.evaluate(() => (window as unknown as { __events: Array<[string]> }).__events.some(([n]) => n === 'ready'));

test.describe.configure({ mode: 'serial' });

test('AUD-71-06 loader: async with queued calls, isolated from host CSS and globals, idempotent, removable', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const site = await demoSite(request);
  const agent = await onlineAgent(context, request);
  try {
    // ── async: the loader is held for 2.5 s; the page parses and fires DOMContentLoaded without it, and the calls
    //    queued before it arrived run afterwards, in order.
    await page.route(`${API}/widget/loader.js*`, async (route) => {
      await new Promise((r) => setTimeout(r, 2_500));
      await route.continue();
    });
    await openHost(page, site.public_key, { css: 'hostile', pre: 'open' });
    const marks = await page.evaluate(() => (window as unknown as { __marks: { dcl: number; loaderRanAtDcl: boolean } }).__marks);
    expect(marks.loaderRanAtDcl, 'DOMContentLoaded fired before the (held) loader ran').toBe(false);
    expect(marks.dcl, 'parsing was not blocked by the loader').toBeLessThan(2_400);
    await expect.poll(() => isReady(page), { timeout: 30_000, message: 'ready after the delayed loader' }).toBe(true);
    await expect.poll(() => sync<boolean>(page, 'isOpen'), { message: 'the queued open() ran once the loader arrived' }).toBe(true);
    await page.unroute(`${API}/widget/loader.js*`);

    // ── isolated: hostile global CSS cannot hide, move or shrink the widget, nor reach inside the frame.
    const box = await page.locator('iframe[title="Chat"]').boundingBox();
    expect(box && box.width > 200 && box.height > 300, `widget frame keeps its size (${box?.width}×${box?.height})`).toBe(true);
    const host = await page.evaluate(() => {
      const c = document.querySelector('[data-talkivio]') as HTMLElement;
      const f = c.querySelector('iframe') as HTMLIFrameElement;
      const cs = getComputedStyle(c);
      const fs = getComputedStyle(f);
      return { position: cs.position, display: cs.display, frameDisplay: fs.display, frameVisibility: fs.visibility, frameBorder: fs.borderTopWidth };
    });
    expect(host).toEqual({ position: 'fixed', display: 'block', frameDisplay: 'block', frameVisibility: 'visible', frameBorder: '0px' });
    const inner = page.frameLocator('iframe[title="Chat"]');
    const innerColor = await inner.locator('body').evaluate((b) => getComputedStyle(b).color);
    expect(innerColor, "host colour rules don't reach the frame").not.toBe('rgb(255, 0, 0)');
    const globals = await page.evaluate(() => {
      const before = new Set((window as unknown as { __marks: { globalsAtDcl: string[] } }).__marks.globalsAtDcl);
      // Numeric keys are the window's child-frame indexes (window[0] is the widget iframe), not globals.
      return Object.keys(window).filter((k) => !before.has(k) && !/^\d+$/.test(k));
    });
    expect(globals.sort(), 'the only new global is the loader guard (window.Talkivio is the stub, replaced in place)').toEqual(['__talkivioLoaded']);
    const sheets = await page.evaluate(() => [document.styleSheets.length, (window as unknown as { __marks: { sheetsAtDcl: number } }).__marks.sheetsAtDcl]);
    expect(sheets[0], 'no stylesheet added to the host page').toBe(sheets[1]);

    // ── idempotent: two loader tags and a second init still give one widget.
    await openHost(page, site.public_key, { loaders: 2 });
    await expect.poll(() => isReady(page), { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(1_000);
    expect(await page.locator('[data-talkivio]').count(), 'one widget container').toBe(1);
    expect(await page.locator('iframe[title="Chat"]').count(), 'one widget frame').toBe(1);
    expect(await call(page, 'init', { siteKey: site.public_key }), 'a second init is refused').toEqual({ ok: false, code: 'ALREADY_INITIALIZED' });
    expect(await page.locator('[data-talkivio]').count()).toBe(1);

    // ── removable: destroy removes the DOM, restores history, stops traffic; init brings it back.
    const nativePush = await page.evaluate(() => history.pushState === History.prototype.pushState);
    expect(nativePush, 'the widget follows SPA navigation by wrapping history.pushState while mounted').toBe(false);
    expect(await call(page, 'destroy')).toEqual({ ok: true, value: undefined });
    expect(await page.locator('[data-talkivio]').count(), 'container and frame removed').toBe(0);
    expect(await page.evaluate(() => history.pushState === History.prototype.pushState && history.replaceState === History.prototype.replaceState), 'history methods restored').toBe(true);
    const after: string[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(API)) after.push(r.url());
    });
    await page.evaluate(() => history.pushState({}, '', '/sdk-host.html?moved'));
    await page.waitForTimeout(3_000);
    expect(after, 'no requests to the widget backend after destroy').toEqual([]);
    expect(await call(page, 'open'), 'commands after destroy reject').toEqual({ ok: false, code: 'DESTROYED' });
    expect(await call(page, 'init', { siteKey: site.public_key })).toEqual({ ok: true, value: undefined });
    await expect(page.locator('iframe[title="Chat"]')).toHaveCount(1);
  } finally {
    await agent.close();
  }
});

test('AUD-71-08 SDK: every command returns its master-prompt signature result; events carry no content or personal data', async ({ page, context, request }) => {
  test.setTimeout(150_000);
  const site = await demoSite(request);
  const csrf = await csrfOf(request);
  const headers = { 'x-csrf-token': csrf };
  // Fixtures the SDK may reference: an existing tag and a public-writable custom field.
  await request.post(`${API}/api/v1/tags`, { data: { label: 'SDK VIP', slug: 'sdk-vip' }, headers });
  await request.post(`${API}/api/v1/custom-fields`, { data: { key: 'sdk_plan', label: 'SDK plan', dataType: 'string', publicWritable: true }, headers });
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{ id: string }>;
    for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  const agent = await onlineAgent(context, request);
  const stamp = Date.now();
  const canaries = { name: `SdkName${stamp}`, email: `sdk-visitor-${stamp}@example.com`, first: `SdkFirstMessage${stamp}`, second: `SdkSecondMessage${stamp}`, reply: `SdkAgentReply${stamp}` };
  let chatId = '';
  try {
    await openHost(page, site.public_key);
    await expect.poll(() => isReady(page), { timeout: 30_000 }).toBe(true);

    // open(): Promise<void>; close()/show()/hide(): void — their effect is observed through getState().
    expect(await call(page, 'open')).toEqual({ ok: true, value: undefined });
    expect(await sync<boolean>(page, 'isOpen')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => unknown }).Talkivio('close')), 'close() is void').toBeUndefined();
    await expect.poll(() => sync<boolean>(page, 'isOpen')).toBe(false);
    const toggled = await call(page, 'toggle');
    expect(toggled.ok && typeof toggled.value === 'boolean' && toggled.value === true, 'toggle resolves with the new open state').toBe(true);
    expect(await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => unknown }).Talkivio('hide')), 'hide() is void').toBeUndefined();
    await expect.poll(async () => (await sync<{ visible: boolean }>(page, 'getState')).visible).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => unknown }).Talkivio('show')), 'show() is void').toBeUndefined();
    await expect.poll(async () => (await sync<{ visible: boolean }>(page, 'getState')).visible).toBe(true);

    expect(await call(page, 'setLocale', 'ar')).toEqual({ ok: true, value: undefined });
    expect((await sync<{ locale: string }>(page, 'getState')).locale).toBe('ar');
    expect(await call(page, 'setLocale', null)).toEqual({ ok: true, value: undefined });
    expect(await call(page, 'setLocale', 42)).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    const cfg = await call(page, 'updateSettings', { content: { title: 'Help desk' }, bogus: true });
    expect(cfg.ok && typeof cfg.value === 'object' && cfg.value !== null && 'appearance' in cfg.value && 'behavior' in cfg.value && !('bogus' in cfg.value), 'updateSettings(): Promise<Config> — the effective configuration').toBe(true);
    expect(await call(page, 'trackPage', { url: `${DEMO}/pricing`, title: 'Pricing' })).toEqual({ ok: true, value: undefined });
    expect(await call(page, 'trackPage', { url: 'javascript:alert(1)' })).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await call(page, 'setConsent', { analytics: false, policyVersion: '2026-10' })).toEqual({ ok: true, value: undefined });
    expect(await call(page, 'setConsent', { analytics: 'yes' })).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await call(page, 'setDepartment', null)).toEqual({ ok: true, value: undefined });
    expect(await call(page, 'setDepartment', 7)).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });

    expect(await call(page, 'identify', { email: 'not an email' })).toEqual({ ok: false, code: 'INVALID_EMAIL' });
    const visitorId = (await sync<{ visitor: { id: string } | null }>(page, 'getState')).visitor!.id;
    expect(await call(page, 'identify', { name: canaries.name, email: canaries.email }), 'identify(): Promise<IdentityResult>').toEqual({ ok: true, value: { visitorId, verified: false } });
    expect(await call(page, 'setTags', ['sdk-vip'])).toEqual({ ok: true, value: undefined });
    expect(await call(page, 'addTags', ['no-such-tag-' + stamp])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await call(page, 'setCustomFields', { sdk_plan: 'pro' })).toEqual({ ok: true, value: undefined });
    const profile = (await (await request.get(`${API}/api/v1/visitors/${visitorId}`)).json()).data;
    expect(profile.tags.map((t: { slug: string; source: string }) => `${t.slug}:${t.source}`), 'the tag was stored as a client tag').toContain('sdk-vip:client');
    expect(profile.custom_fields.sdk_plan === 'pro' && profile.custom_field_sources.sdk_plan.source === 'visitor', 'the field was stored, attributed to the visitor').toBe(true);

    expect(await call(page, 'startChat', {}), 'no message: nothing created, no open chat').toEqual({ ok: true, value: null });
    const started = await call(page, 'startChat', { message: canaries.first });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const chat = (started as { value: { id: string; status: string } }).value;
    expect(Object.keys(chat).sort(), 'startChat(): Promise<Chat>').toEqual(['id', 'status']);
    chatId = chat.id;
    expect(chatId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await call(page, 'sendMessage', canaries.second)).toEqual({ ok: true, value: { chatId } });
    expect(await call(page, 'sendMessage', '   ')).toEqual({ ok: false, code: 'INVALID_ARGUMENT' });
    expect((await sync<{ chat: { id: string } | null }>(page, 'getState')).chat?.id).toBe(chatId);

    expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
    expect((await request.post(`${API}/api/v1/chats/${chatId}/messages`, { data: { client_message_id: crypto.randomUUID(), body: canaries.reply }, headers })).ok()).toBe(true);
    await expect.poll(async () => (await events(page)).some(([n, p]) => n === 'message.received' && p.chatId === chatId && p.type === 'agent'), { timeout: 15_000 }).toBe(true);

    expect(await call(page, 'endChat')).toEqual({ ok: true, value: undefined });
    await expect.poll(async () => (await events(page)).some(([n, p]) => n === 'chat.ended' && p.chatId === chatId), { timeout: 15_000 }).toBe(true);
    expect(await call(page, 'endChat'), 'nothing left to end: still resolves').toEqual({ ok: true, value: undefined });
    expect(await call(page, 'noSuchCommand')).toEqual({ ok: false, code: 'UNKNOWN_COMMAND' });
    expect(await page.evaluate(() => typeof (window as unknown as { Talkivio: (...a: unknown[]) => unknown }).Talkivio('on', 'ready', () => undefined))).toBe('function');

    const visitorBefore = (await sync<{ visitor: { id: string } | null }>(page, 'getState')).visitor?.id;
    expect(await call(page, 'resetIdentity')).toEqual({ ok: true, value: undefined });
    await expect.poll(async () => (await sync<{ visitor: { id: string } | null }>(page, 'getState')).visitor?.id, { message: 'a new anonymous visitor' }).not.toBe(visitorBefore);

    // Events: documented shapes, and nothing a host script could read that the visitor or agent wrote.
    const seen = await events(page);
    const byName = (n: string) => seen.filter(([x]) => x === n).map(([, p]) => p);
    expect(Object.keys(byName('ready')[0] ?? {}).sort()).toEqual(['configVersion', 'siteId']);
    expect(Object.keys(byName('availability.changed')[0] ?? {}).sort(), 'availability.changed → { state, departmentId, nextOpenAt }').toEqual(['departmentId', 'nextOpenAt', 'state']);
    expect(byName('opened').every((p) => Object.keys(p).join() === 'source'), 'opened → { source }').toBe(true);
    expect(byName('chat.requested').some((p) => p.chatId === chatId)).toBe(true);
    expect(Object.keys(byName('message.received').find((p) => p.chatId === chatId) ?? {}).sort()).toEqual(['chatId', 'messageId', 'type']);
    expect(Object.keys(byName('chat.ended').find((p) => p.chatId === chatId) ?? {}).sort()).toEqual(['chatId', 'reason']);
    expect(byName('identity.changed').every((p) => Object.keys(p).sort().join() === 'verified,visitorId')).toBe(true);
    const serialized = JSON.stringify(seen);
    const leaked = Object.entries(canaries).filter(([, v]) => serialized.includes(v)).map(([k]) => k);
    expect(leaked, `${seen.length} events, none carrying message text, the visitor's name or email`).toEqual([]);
  } finally {
    if (chatId) await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
    await agent.close();
  }
});

test('SITE01 install: the same snippet on an origin the site does not list cannot frame the widget or open a session', async ({ page, request }) => {
  const site = await demoSite(request);
  const unapproved = DEMO.replace('localhost', '[::1]');
  expect(site.origins.some((o) => o.origin === unapproved), `${unapproved} is not an approved origin`).toBe(false);
  const sessions: number[] = [];
  const frames: Array<{ status: number; csp: string }> = [];
  const blocked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/widget/v1/sessions')) sessions.push(1);
  });
  page.on('response', (r) => {
    if (r.url().includes('/widget/frame/')) frames.push({ status: r.status(), csp: r.headers()['content-security-policy'] ?? '' });
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes('/widget/frame/')) blocked.push(r.failure()?.errorText ?? '');
  });
  await page.goto(`${unapproved}/sdk-host.html?${new URLSearchParams({ key: site.public_key, api: API })}`);
  await expect.poll(() => blocked.length, { timeout: 20_000, message: 'the browser refuses to frame the widget' }).toBeGreaterThan(0);
  expect(frames[0]?.csp, 'the frame is only embeddable by the approved origins').toMatch(/frame-ancestors [^;]*http:\/\/localhost:5173/);
  expect(frames[0]?.csp).not.toContain('[::1]');
  expect(blocked[0]).toContain('ERR_BLOCKED_BY_RESPONSE');
  await page.waitForTimeout(2_000);
  expect(sessions, 'no visitor session (and so no capability) is ever requested').toEqual([]);
  const st = await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => { visible: boolean; ready: boolean } }).Talkivio('getState'));
  expect(st, 'nothing is shown on the unapproved site').toMatchObject({ visible: false, ready: false });
  expect(await page.locator('[data-talkivio]').evaluate((c) => getComputedStyle(c).visibility)).toBe('hidden');
  // Failed init is reported, and commands reject with a typed error instead of hanging.
  await expect.poll(async () => (await events(page)).find(([n]) => n === 'error')?.[1]?.code, { timeout: 15_000, message: 'the page is told the widget is unavailable' }).toBe('WIDGET_UNAVAILABLE');
  expect(await call(page, 'open')).toEqual({ ok: false, code: 'WIDGET_UNAVAILABLE' });
  expect(await call(page, 'setTags', ['x'])).toEqual({ ok: false, code: 'WIDGET_UNAVAILABLE' });
});
