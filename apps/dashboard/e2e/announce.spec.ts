import { expect, test, type APIRequestContext } from '@playwright/test';
import { settle, startVisitorChat } from './routes';

/**
 * A11Y02 (ch. 59/77): screen-reader behaviour of both transcripts, asserted on their ARIA live regions in Chromium.
 * Loading a conversation (its history) is silent: the transcript log is not a live region and the polite announcer
 * stays empty. A message that arrives from someone else while the conversation is open is announced once, as one
 * short sentence ("New message from Ana: …", long text shortened); the reader's own messages are not announced.
 * Agent side: the dashboard inbox. Visitor side: the widget on the demo storefront, including a page reload that
 * restores the history. This automates the live-region contract; it is not a session with a screen reader.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
type Site = { id: string; public_key: string; origins: Array<{ origin: string }> };
/** What a screen reader voices: bidi isolation marks (U+2068/U+2069) and the repeat-toggle no-break space are silent. */
const spoken = (text: string | null) => (text ?? '').replace(/[\u2068\u2069\u00a0]/g, '').trim();

async function setup(request: APIRequestContext) {
  const csrf = (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Site[];
  const site = sites.find((s) => s.origins?.some((o) => o.origin === DEMO)) ?? sites.find((s) => s.origins?.length) ?? sites[0];
  test.skip(!site, 'no site for the UI test owner');
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{ id: string }>;
    for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  return { site: site!, headers };
}

test('A11Y02 agent: opening a conversation is silent; new visitor messages are announced once, briefly', async ({ page, request }) => {
  const { site, headers } = await setup(request);
  await page.goto('/inbox');
  await settle(page);
  const sess = (await (await request.post(`${API}/widget/v1/sessions`, { data: { site_key: site.public_key, host_origin: site.origins?.[0]?.origin ?? DEMO, consent: { analytics: false, policy_version: '2026-10' } } })).json()).data;
  const visitor = { authorization: `Bearer ${sess.capability}` };
  const chatId = await startVisitorChat(request, API, visitor, 'History one: my parcel is late');
  try {
    expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
    const say = async (body: string) => expect((await request.post(`${API}/widget/v1/chats/${chatId}/messages`, { headers: visitor, data: { client_message_id: crypto.randomUUID(), body } })).ok()).toBe(true);
    for (const body of ['History two: order 1234', 'History three: it was due Monday']) await say(body);

    await page.goto(`/inbox/${chatId}`);
    await settle(page);
    const log = page.getByRole('log', { name: /^Conversation with/ });
    await expect(log.getByText('History three: it was due Monday')).toBeVisible();
    const announcer = page.locator('[data-announcer]');
    expect(await log.getAttribute('aria-live'), 'the transcript log itself is not a live region').toBe('off');
    expect(await announcer.getAttribute('aria-live')).toBe('polite');
    await page.waitForTimeout(1_500);
    await expect(announcer, 'history is not announced').toHaveText('');

    await say('Where is my order now?');
    await expect.poll(async () => spoken(await announcer.textContent())).toMatch(/^New message from Visitor \d+: Where is my order now\?$/);
    const composer = page.locator(`#composer-${chatId}`);
    await composer.fill('Let me check that for you.');
    await composer.press('Enter');
    await expect(log.getByText('Let me check that for you.')).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(spoken(await announcer.textContent()), "the agent's own message is not announced").toMatch(/Where is my order now\?$/);

    const long = `Long message ${'with many words '.repeat(20)}end`;
    await say(long);
    await expect.poll(async () => spoken(await announcer.textContent())).toMatch(/^New message from Visitor \d+: Long message with many words .*…$/);
    expect(spoken(await announcer.textContent()).length, 'long text is shortened').toBeLessThan(200);
  } finally {
    await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
  }
});

test('A11Y02 visitor: agent replies are announced once, briefly; restored history and own messages are silent', async ({ page, context, request }) => {
  const { site, headers } = await setup(request);
  test.skip(!site.origins.some((o) => o.origin === DEMO), 'the site has no demo storefront origin (widget-sdk.spec adds it)');
  const agent = await context.newPage();
  await agent.goto('/inbox');
  await settle(agent);
  let chatId = '';
  try {
    const host = `${DEMO}/sdk-host.html?${new URLSearchParams({ key: site.public_key, api: API })}`;
    await page.goto(host);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __events: Array<[string]> }).__events.some(([n]) => n === 'ready')), { timeout: 30_000 }).toBe(true);
    const started = await page.evaluate(() => (window as unknown as { Talkivio: (c: string, a: unknown) => Promise<{ id: string }> }).Talkivio('startChat', { message: 'Hello, I need help' }));
    chatId = started.id;
    const frame = page.frameLocator('iframe[title="Chat"]');
    const announcer = frame.locator('[data-announcer]');
    expect(await frame.getByRole('log').getAttribute('aria-live'), 'the widget transcript log is not a live region').toBe('off');
    await expect(announcer, "the visitor's own message is not announced").toHaveText('');

    expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
    expect((await request.post(`${API}/api/v1/chats/${chatId}/messages`, { data: { client_message_id: crypto.randomUUID(), body: 'Agent says hello' }, headers })).ok()).toBe(true);
    await expect(announcer).toHaveText(/^New message from .+: Agent says hello\s?$/);
    await page.evaluate(() => (window as unknown as { Talkivio: (c: string, a: unknown) => Promise<unknown> }).Talkivio('sendMessage', 'Thanks!'));
    await page.waitForTimeout(1_500);
    await expect(announcer, 'unchanged by the visitor sending').toHaveText(/Agent says hello\s?$/);

    // Reload: the conversation and its history are restored silently.
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __events: Array<[string]> }).__events.some(([n]) => n === 'ready')), { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => Promise<unknown> }).Talkivio('open'));
    await expect(frame.getByRole('log').getByText('Agent says hello')).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(frame.locator('[data-announcer]'), 'restored history is not announced').toHaveText('');
  } finally {
    if (chatId) await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
    await agent.close();
  }
});
