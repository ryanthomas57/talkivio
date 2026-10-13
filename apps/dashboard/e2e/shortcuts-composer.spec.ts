import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { settle, startVisitorChat } from './routes';

/**
 * SHORT01 (ch. 18) in the agent's browser: choosing a slash shortcut inserts its text into the composer and never
 * sends it; allowlisted placeholders are filled from the chat (visitor, agent, site) as plain text, so a visitor
 * name containing markup is shown literally in the composer and in the sent bubble; an unresolved placeholder
 * (anonymous visitor) stays visible, is flagged and blocks sending until it is replaced, while a fallback
 * ({{visitor.name|there}}) resolves. Personal-reply privacy between agents is proven at the API level
 * (apps/api/test/shortcuts.e2e.mjs: another agent's personal reply is 404 and never listed).
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const stamp = Date.now().toString(36);

async function csrf(request: APIRequestContext) {
  return { 'x-csrf-token': (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '' };
}

async function visitorChat(page: Page, request: APIRequestContext, name: string | null, message: string) {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{ public_key: string; origins: Array<{ origin: string }> }>;
  const site = sites.find((s) => s.origins?.length) ?? sites[0];
  test.skip(!site, 'no site for the UI test owner');
  const sess = (await (await request.post(`${API}/widget/v1/sessions`, { data: { site_key: site!.public_key, host_origin: site!.origins?.[0]?.origin ?? 'http://localhost:5173', consent: { analytics: false, policy_version: '2026-10' } } })).json()).data;
  const visitor = { authorization: `Bearer ${sess.capability}` };
  if (name) expect((await request.post(`${API}/widget/v1/identity`, { headers: visitor, data: { name } })).ok()).toBe(true);
  const chatId = await startVisitorChat(request, API, visitor, message);
  expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers: await csrf(request) })).ok()).toBe(true);
  await page.goto(`/inbox/${chatId}`);
  await settle(page);
  return chatId;
}

const storedBodies = async (request: APIRequestContext, chatId: string) =>
  ((await (await request.get(`${API}/api/v1/chats/${chatId}/messages?limit=100`)).json()).data.items as Array<{ body: string | null; sender_type?: string }>).map((m) => m.body);

test('SHORT01 composer: slash shortcuts insert (never send), fill placeholders as text and block unresolved ones', async ({ page, request }) => {
  test.setTimeout(120_000);
  const headers = await csrf(request);
  await page.goto('/inbox');
  await settle(page);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{ id: string }>;
    for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  const me = (await (await request.get(`${API}/api/v1/agents/me`)).json()).data;
  const agentName = me.agent?.display_name || me.user?.display_name;
  const created: string[] = [];
  const shortcut = async (slug: string, body: string) => {
    const r = await request.post(`${API}/api/v1/shortcuts`, { data: { slug, title: `Audit ${slug}`, body, scope_type: 'tenant' }, headers });
    expect(r.ok(), await r.text()).toBe(true);
    created.push((await r.json()).data.id);
  };
  await shortcut(`sg${stamp}`, 'Hi {{visitor.name}}, I am {{agent.display_name}} from {{site.name}}.');
  await shortcut(`sf${stamp}`, 'Hi {{visitor.name|there}}, one moment please.');
  const chats: string[] = [];
  try {
    // 1. A named visitor whose name contains markup.
    const hostile = `<b>Zoë</b> & “co” ${stamp}`;
    const named = await visitorChat(page, request, hostile, `Named visitor ${stamp}`);
    chats.push(named);
    const composer = page.locator(`#composer-${named}`);
    const before = (await storedBodies(request, named)).length;
    await composer.fill('');
    await composer.pressSequentially(`/sg${stamp}`);
    const option = page.getByRole('listbox', { name: /suggest/i }).getByRole('option').first();
    await expect(option).toContainText(`sg${stamp}`);
    await composer.press('Enter');
    const siteName = (await (await request.get(`${API}/api/v1/sites`)).json()).data.find((s: { origins: unknown[] }) => (s.origins as unknown[])?.length)?.name;
    const expected = `Hi ${hostile}, I am ${agentName} from ${siteName}.`;
    await expect(composer, 'the shortcut is inserted with its placeholders filled in').toHaveValue(expected);
    await page.waitForTimeout(1_500);
    expect((await storedBodies(request, named)).length, 'choosing a shortcut sends nothing').toBe(before);
    await expect(page.getByRole('log').getByText(expected)).toHaveCount(0);

    await composer.press('Enter'); // the agent's own Enter sends it
    const bubble = page.getByRole('log').getByText(expected, { exact: true });
    await expect(bubble, 'sent once, shown as literal text').toHaveCount(1);
    expect(await bubble.evaluate((el) => el.querySelector('b') === null && el.textContent?.includes('<b>Zoë</b>')), 'markup in the visitor name is text, not HTML').toBe(true);
    await expect.poll(async () => (await storedBodies(request, named)).filter((b) => b === expected).length).toBe(1);

    // 2. An anonymous visitor: {{visitor.name}} cannot be resolved.
    const anon = await visitorChat(page, request, null, `Anonymous visitor ${stamp}`);
    chats.push(anon);
    const composer2 = page.locator(`#composer-${anon}`);
    const before2 = (await storedBodies(request, anon)).length;
    await composer2.fill('');
    await composer2.pressSequentially(`/sg${stamp}`);
    await expect(page.getByRole('listbox', { name: /suggest/i }).getByRole('option').first()).toContainText(`sg${stamp}`);
    await composer2.press('Enter');
    await expect(composer2).toHaveValue(/\{\{visitor\.name\}\}/);
    await expect(page.getByText('Replace the highlighted {{placeholder}} before sending.'), 'the unresolved placeholder is flagged').toBeVisible();
    await expect(page.getByRole('button', { name: 'Send reply' }), 'and sending is blocked').toBeDisabled();
    await composer2.press('Enter');
    await page.waitForTimeout(1_500);
    expect((await storedBodies(request, anon)).length, 'Enter does not send an unresolved reply').toBe(before2);

    // 3. The fallback form resolves for the same anonymous visitor.
    await composer2.fill('');
    await composer2.pressSequentially(`/sf${stamp}`);
    await expect(page.getByRole('listbox', { name: /suggest/i }).getByRole('option').first()).toContainText(`sf${stamp}`);
    await composer2.press('Enter');
    await expect(composer2).toHaveValue('Hi there, one moment please.');
    await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled();
    await composer2.press('Enter');
    await expect.poll(async () => (await storedBodies(request, anon)).filter((b) => b === 'Hi there, one moment please.').length).toBe(1);
  } finally {
    for (const id of chats) await request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
    for (const id of created) await request.post(`${API}/api/v1/shortcuts/${id}/archive`, { data: {}, headers });
  }
});
