import { expect, test, type APIRequestContext, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { settle } from './routes';
import { AUTH_FILE } from './paths';

/**
 * AUD-71-07: one visitor walks through every widget state on the demo storefront (real loader, frame, API and
 * dashboard agent): prechat form → queued → active (agent reply) → reconnect (the visitor's socket is cut and
 * reconnection held back while the agent writes; the message arrives once after recovery) → closed by the agent →
 * rating → offline (no agent available) → offline form submitted with a reference. Each step is checked twice:
 * the SDK's `getState().view` and what the visitor actually sees in the frame.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';

type Site = { id: string; public_key: string; version: number; origins: Array<{ origin: string; pattern_type: string }> };
type WidgetConfigDoc = { published: { config: Record<string, any>; revision: number } | null; draft: { config: Record<string, any>; revision: number } | null; etag?: string };

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

/** Saves and publishes a widget configuration; returns the configuration that was live before. */
async function publishConfig(request: APIRequestContext, siteId: string, change: (config: Record<string, any>) => void): Promise<Record<string, any>> {
  const headers = { 'x-csrf-token': await csrfOf(request) };
  const doc = (await (await request.get(`${API}/api/v1/sites/${siteId}/widget-config`)).json()).data as WidgetConfigDoc;
  const live = (doc.published ?? doc.draft)!.config;
  const next = structuredClone(live);
  change(next);
  const draft = await request.put(`${API}/api/v1/sites/${siteId}/widget-config`, { data: { config: next }, headers });
  expect(draft.ok(), await draft.text()).toBe(true);
  const published = await request.post(`${API}/api/v1/sites/${siteId}/widget-config/publish`, { data: { revision: (await draft.json()).data.revision }, headers });
  expect(published.ok(), await published.text()).toBe(true);
  return live;
}

const view = (page: Page) => page.evaluate(() => (window as unknown as { Talkivio: (c: string) => { view: string } }).Talkivio('getState').view);
const state = (page: Page) => page.evaluate(() => (window as unknown as { Talkivio: (c: string) => { view: string; connection: string; chat: { id: string; status: string } | null } }).Talkivio('getState'));
const events = (page: Page) => page.evaluate(() => (window as unknown as { __events: Array<[string, Record<string, unknown>]> }).__events);

test('AUD-71-07 visitor: prechat, queued, active, reconnect, closed, rating and offline states', async ({ browser, page, request, baseURL }) => {
  test.setTimeout(180_000);
  const site = await demoSite(request);
  const headers = { 'x-csrf-token': await csrfOf(request) };
  for (const v of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${v}`)).json()).data as Array<{ id: string }>;
    for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  const before = await publishConfig(request, site.id, (c) => {
    // Wire format (snake_case), as the API returns and accepts it.
    c.behavior.prechat_form = { ...c.behavior.prechat_form, enabled: true, name: 'required', email: 'optional', phone: 'hidden', department: 'hidden' };
    c.behavior.ratings = { enabled: true };
    c.behavior.offline_form = { ...c.behavior.offline_form, enabled: true };
  });
  // The agent works in a separate browser (context), so cutting the visitor's connection does not touch it.
  let agentContext: BrowserContext | null = await browser.newContext({ baseURL, storageState: AUTH_FILE });
  const agent = await agentContext.newPage();
  await agent.goto('/inbox');
  await settle(agent);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });

  // The visitor's realtime connection runs through a proxy that can cut it and refuse reconnection for a while.
  let blocked = false;
  const live = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
    if (blocked) return void ws.close({ code: 1006, reason: 'network down (test)' });
    live.add(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => live.delete(ws));
  });
  // Long-polling fallback is refused while the network is "down" too.
  await page.route(/\/realtime\/v1\/\?.*transport=polling/, (route) => (blocked ? route.abort('internetdisconnected') : route.continue()));

  let chatId = '';
  try {
    await page.goto(`${DEMO}/sdk-host.html?${new URLSearchParams({ key: site.public_key, api: API })}`);
    await expect.poll(async () => (await events(page)).some(([n]) => n === 'ready'), { timeout: 30_000 }).toBe(true);
    const frame = page.frameLocator('iframe[title="Chat"]');

    // ── prechat
    await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => Promise<unknown> }).Talkivio('open'));
    await expect.poll(() => view(page), { message: 'prechat form first' }).toBe('prechat');
    await expect(frame.getByRole('button', { name: 'Start chat' })).toBeVisible();
    await frame.getByRole('button', { name: 'Start chat' }).click();
    await expect(frame.getByText('Required').first(), 'the required name is enforced').toBeVisible();
    await frame.getByLabel('Name').fill('Pat Prechat');
    await frame.getByLabel('Message').fill('Hello from the prechat form');
    await frame.getByRole('button', { name: 'Start chat' }).click();

    // ── queued
    await expect.poll(() => view(page), { message: 'queued after the prechat submit' }).toBe('queued');
    await expect(frame.getByText('Waiting for the team')).toBeVisible();
    chatId = (await state(page)).chat!.id;
    const stored = (await (await request.get(`${API}/api/v1/chats/${chatId}`)).json()).data;
    expect(stored.status, 'the chat waits in the queue').toBe('queued');

    // ── active
    expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
    await expect.poll(() => view(page), { message: 'active once an agent accepts' }).toBe('active');
    expect((await request.post(`${API}/api/v1/chats/${chatId}/messages`, { data: { client_message_id: crypto.randomUUID(), body: 'Hi Pat, how can I help?' }, headers })).ok()).toBe(true);
    await expect(frame.getByRole('log').getByText('Hi Pat, how can I help?')).toBeVisible();

    // ── reconnect: cut the link, keep it down while the agent writes, then let it back.
    blocked = true;
    for (const ws of [...live]) await ws.close({ code: 1006, reason: 'network down (test)' });
    await expect.poll(async () => (await state(page)).connection, { message: 'the widget notices the lost connection' }).not.toBe('connected');
    await expect(frame.getByText('Connection lost. Reconnecting…')).toBeVisible();
    expect((await request.post(`${API}/api/v1/chats/${chatId}/messages`, { data: { client_message_id: crypto.randomUUID(), body: 'Sent while you were offline' }, headers })).ok()).toBe(true);
    await page.waitForTimeout(1_500);
    await expect(frame.getByRole('log').getByText('Sent while you were offline'), 'not delivered while disconnected').toHaveCount(0);
    blocked = false;
    await expect.poll(async () => (await state(page)).connection, { timeout: 45_000, message: 'reconnected' }).toBe('connected');
    await expect(frame.getByRole('log').getByText('Sent while you were offline'), 'replayed exactly once after reconnecting').toHaveCount(1);
    await expect(frame.getByText('Connection lost. Reconnecting…')).toHaveCount(0);
    const conn = (await events(page)).filter(([n]) => n === 'connection.changed').map(([, p]) => p.state);
    expect(conn.slice(-2).includes('connected') && conn.some((s) => s !== 'connected'), `connection.changed went down and back up (${conn.join(' → ')})`).toBe(true);

    // ── closed → rating
    expect((await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers })).ok()).toBe(true);
    await expect.poll(() => view(page), { message: 'rating offered when the agent ends the chat' }).toBe('rating');
    const prompt = String(before.content?.rating_prompt ?? '');
    await expect(frame.getByRole('group', { name: prompt }), `the rating card asks "${prompt}"`).toBeVisible();
    await frame.getByRole('button', { name: 'Good' }).click();
    await expect.poll(() => view(page), { message: 'ended once rated' }).toBe('ended');
    await expect.poll(async () => (await events(page)).some(([n, p]) => n === 'rating.changed' && p.chatId === chatId)).toBe(true);
    const rated = (await (await request.get(`${API}/api/v1/chats/${chatId}`)).json()).data;
    expect(rated.rating?.value ?? rated.rating, 'the rating is stored').toBeTruthy();

    // ── offline: the only agent leaves; the next chat request becomes the offline form.
    await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'invisible' }, headers });
    await agentContext.close();
    agentContext = null;
    await expect.poll(async () => (await events(page)).some(([n, p]) => n === 'availability.changed' && p.state === 'offline'), { timeout: 60_000, message: 'availability goes offline' }).toBe(true);
    await frame.getByRole('button', { name: 'Start a new chat' }).click();
    await expect.poll(() => view(page), { message: 'offline form when nobody can answer' }).toBe('offline');
    await frame.getByLabel('Name').fill('Pat Offline');
    await frame.getByLabel('Email').fill('pat.offline@example.com');
    await frame.getByLabel('Message').fill('Please call me back tomorrow');
    await frame.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => view(page), { message: 'confirmation after the offline form' }).toBe('offline_success');
    await expect(frame.getByText('Message sent')).toBeVisible();
    const submitted = (await events(page)).find(([n]) => n === 'offline.submitted')?.[1];
    expect(typeof submitted?.reference === 'string' && (submitted.reference as string).length > 3, 'offline.submitted carries the reference').toBe(true);
    await expect(frame.getByText(submitted!.reference as string)).toBeVisible();
  } finally {
    await agentContext?.close();
    await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
    if (chatId) await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
    await publishConfig(request, site.id, (c) => Object.assign(c, structuredClone(before)));
  }
});
