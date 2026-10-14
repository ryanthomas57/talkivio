import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { settle } from './routes';

/**
 * DOCK01/DOCK02: Zendesk-style chat windows. An agent clicks a browsing visitor on the Visitors list and a chat
 * window opens at the bottom of the screen; the first message starts the chat in the visitor's widget. A chat
 * request pops up with Accept on any page, and accepting it opens the chat in a docked window. The visitor uses
 * the widget on the demo storefront in a separate browser context.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
const stamp = Date.now().toString(36);

async function csrf(request: APIRequestContext) {
  return {
    'x-csrf-token': (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '',
  };
}
async function demoSite(request: APIRequestContext) {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
    public_key: string;
    origins: Array<{ origin: string }>;
  }>;
  const site = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  test.skip(!site, 'no site lists the widget demo origin (run widget-states.spec first)');
  return site!;
}
/** Close every open chat this agent holds or could pick, so capacity and the request list start clean. */
async function closeOpenChats(request: APIRequestContext, headers: Record<string, string>) {
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{
      id: string;
    }>;
    for (const c of list ?? [])
      await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
}
/** A visitor on the demo storefront who consented to analytics and gave a name (so the agent can find them). */
async function visitorPage(vpage: Page, siteKey: string, name: string) {
  await vpage.goto(`${DEMO}/sdk-host.html?${new URLSearchParams({ key: siteKey, api: API })}`);
  await vpage.waitForFunction(
    () =>
      (window as unknown as { Talkivio?: (c: string) => { ready: boolean } }).Talkivio?.('getState')
        ?.ready === true,
    undefined,
    { timeout: 20_000 },
  );
  await vpage.evaluate(async (n) => {
    const T = (window as unknown as { Talkivio: (c: string, a?: unknown) => Promise<unknown> }).Talkivio;
    await T('setConsent', { analytics: true, policyVersion: '2026-10' });
    await T('identify', { name: n });
  }, name);
}
async function openWidget(vpage: Page): Promise<FrameLocator> {
  await vpage.evaluate(() =>
    (window as unknown as { Talkivio: (c: string) => Promise<void> }).Talkivio('open'),
  );
  return vpage.frameLocator('iframe[title="Chat"]');
}
const widgetChatId = (vpage: Page) =>
  vpage.evaluate(
    () =>
      (window as unknown as { Talkivio: (c: string) => { chat: { id: string } | null } }).Talkivio('getState')
        .chat?.id ?? '',
  );

test('DOCK01 clicking a browsing visitor opens a chat window; the first message starts the chat in their widget', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await demoSite(request);
  const headers = await csrf(request);
  await closeOpenChats(request, headers);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  const name = `Dock ${stamp}`;
  const vctx = await browser.newContext({ storageState: undefined });
  const vpage = await vctx.newPage();
  try {
    await visitorPage(vpage, site.public_key, name);
    await page.goto('/visitors');
    await settle(page);

    // One click on the visitor: a new-chat window at the bottom of the screen.
    const visitorButton = page.getByRole('button', { name: `Chat with ${name}` });
    await expect(visitorButton, 'the visitor appears in the live list without a reload').toBeVisible({
      timeout: 20_000,
    });
    await visitorButton.click();
    const dock = page.getByRole('region', { name: 'Chat windows' });
    const first = dock.getByRole('textbox', { name: `First message to ${name}` });
    await expect(first).toBeVisible();
    const hello = `Hello from the dock ${stamp}`;
    await first.fill(hello);
    await dock.getByRole('button', { name: 'Start chat' }).click();

    // The window turns into the chat itself: the message in its transcript and a reply box.
    const log = dock.getByRole('log', { name: `Conversation with ${name}` });
    await expect(log).toContainText(hello, { timeout: 15_000 });
    await expect(dock.getByRole('textbox', { name: `Reply to ${name}` })).toBeVisible();

    // The visitor's widget picked up the chat (no reload) and shows the agent's message; their reply comes back.
    await expect.poll(() => widgetChatId(vpage), { timeout: 15_000 }).not.toBe('');
    const ui = await openWidget(vpage);
    await expect(ui.getByRole('log').first()).toContainText(hello, { timeout: 15_000 });
    const back = `Thanks, dock ${stamp}`;
    await ui.getByRole('textbox', { name: 'Message' }).fill(back);
    await ui.getByRole('button', { name: 'Send message' }).click();
    await expect(log).toContainText(back, { timeout: 15_000 });

    // The window stays open while the agent moves around the dashboard, and minimizes to its header.
    await page.getByRole('link', { name: 'History' }).first().click();
    await expect(page).toHaveURL(/\/history/);
    await expect(dock.getByRole('log', { name: `Conversation with ${name}` })).toContainText(back);
    await dock.getByRole('button', { name: 'Minimize chat window' }).click();
    await expect(dock.getByRole('log')).toHaveCount(0);
    await dock.getByRole('button', { name: 'Expand chat window' }).click();
    await expect(dock.getByRole('log', { name: `Conversation with ${name}` })).toBeVisible();
  } finally {
    const id = await widgetChatId(vpage).catch(() => '');
    if (id) await request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
    await vctx.close();
  }
});

test('DOCK02 a chat request pops up with Accept on any page and opens in a docked window', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await demoSite(request);
  const headers = await csrf(request);
  await closeOpenChats(request, headers);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  const name = `Request ${stamp}`;
  const vctx = await browser.newContext({ storageState: undefined });
  const vpage = await vctx.newPage();
  try {
    await page.goto('/history');
    await settle(page);
    await visitorPage(vpage, site.public_key, name);
    const ui = await openWidget(vpage);
    const question = `Do you ship to Dubai? ${stamp}`;
    const startButton = ui.getByRole('button', { name: 'Start chat' });
    if (await startButton.isVisible().catch(() => false)) {
      if (
        await ui
          .getByLabel('Name')
          .isVisible()
          .catch(() => false)
      )
        await ui.getByLabel('Name').fill(name);
      await ui.getByRole('textbox', { name: 'Message' }).fill(question);
      await startButton.click();
    } else {
      await ui.getByRole('textbox', { name: 'Message' }).fill(question);
      await ui.getByRole('button', { name: 'Send message' }).click();
    }

    // The request pops up on the page the agent is on (not only in the Inbox), with Accept.
    const accept = page.getByRole('button', { name: `Accept chat with ${name}` });
    await expect(accept).toBeVisible({ timeout: 20_000 });
    await accept.click();
    await expect(page, 'accepting does not navigate away').toHaveURL(/\/history/);
    const dock = page.getByRole('region', { name: 'Chat windows' });
    const log = dock.getByRole('log', { name: `Conversation with ${name}` });
    await expect(log).toContainText(question, { timeout: 15_000 });

    const answer = `Yes, we ship to Dubai ${stamp}`;
    await dock.getByRole('textbox', { name: `Reply to ${name}` }).fill(answer);
    await dock.getByRole('button', { name: 'Send reply' }).click();
    await expect(ui.getByRole('log').first()).toContainText(answer, { timeout: 15_000 });
  } finally {
    const id = await widgetChatId(vpage).catch(() => '');
    if (id) await request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
    await vctx.close();
  }
});

test('DOCK03 files both ways: a visitor attaches before chatting, the agent replies with a file from the docked window', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await demoSite(request);
  const headers = await csrf(request);
  await closeOpenChats(request, headers);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  const name = `Files ${stamp}`;
  const vctx = await browser.newContext({ storageState: undefined });
  const vpage = await vctx.newPage();
  try {
    await page.goto('/history');
    await settle(page);
    await visitorPage(vpage, site.public_key, name);
    const ui = await openWidget(vpage);
    const receipt = {
      name: `receipt-${stamp}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('Order 1234 receipt'),
    };
    const startButton = ui.getByRole('button', { name: 'Start chat' });
    if (await startButton.isVisible().catch(() => false)) {
      // A site with a pre-chat form starts the chat from the form; the file follows.
      if (
        await ui
          .getByLabel('Name')
          .isVisible()
          .catch(() => false)
      )
        await ui.getByLabel('Name').fill(name);
      await ui.getByRole('textbox', { name: 'Message' }).fill('Here is my receipt');
      await startButton.click();
      await expect.poll(() => widgetChatId(vpage), { timeout: 15_000 }).not.toBe('');
    }
    // The paperclip is there before any chat exists; a file sent first starts the chat.
    await ui.locator('input[type="file"]').setInputFiles(receipt);

    const accept = page.getByRole('button', { name: `Accept chat with ${name}` });
    await expect(accept).toBeVisible({ timeout: 20_000 });
    await accept.click();
    const dock = page.getByRole('region', { name: 'Chat windows' });
    const log = dock.getByRole('log', { name: `Conversation with ${name}` });
    await expect(log, "the visitor's file reaches the agent").toContainText(receipt.name, {
      timeout: 20_000,
    });

    const invoice = {
      name: `invoice-${stamp}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('Invoice 1234'),
    };
    await dock.locator('input[type="file"]').setInputFiles(invoice);
    const send = dock.getByRole('button', { name: 'Send reply' });
    await expect(send, 'the file is uploaded and scanned before it can be sent').toBeEnabled({
      timeout: 20_000,
    });
    await send.click();
    await expect(ui.getByRole('log').first(), "the agent's file reaches the visitor").toContainText(
      invoice.name,
      { timeout: 20_000 },
    );
  } finally {
    const id = await widgetChatId(vpage).catch(() => '');
    if (id) await request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
    await vctx.close();
  }
});
