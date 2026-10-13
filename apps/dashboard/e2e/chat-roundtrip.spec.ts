import { expect, test, type APIRequestContext, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { settle } from './routes';

/**
 * CHAT01 (ch. 13/14): a visitor (widget on the demo storefront, its own browser context — no shared cookies or
 * storage) and an agent (dashboard) exchange Unicode and multiline text through the real UIs:
 *  - every message arrives on the other side exactly once, in order, with its line breaks, and is stored
 *    byte-for-byte (no normalization of combining marks, emoji sequences, RTL or CJK text);
 *  - delivery state is visible to the sender: the agent's bubble moves to Read when the visitor's open widget shows
 *    it; the visitor's last message shows Delivered/Read;
 *  - hostile markup is rendered as text in both apps (no element is created, no script runs);
 *  - reloading either browser restores the same conversation, in the same order, with no duplicates.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
const stamp = Date.now().toString(36);
const V1 = `Привет 👋🏽 مرحبا بكم 你好 ${stamp}\nsecond line\n\nfourth line after a blank one`;
const A1 = `Ответ ${stamp}: <script>alert(1)</script> & <img src=x onerror=alert(2)>\n**not markdown** · ZWJ 👩‍💻 · flag 🇦🇪`;
const V2 = `Combining é vs é, 𝔘𝔫𝔦𝔠𝔬𝔡𝔢, Hindi नमस्ते ${stamp}\n— end —`;

async function csrf(request: APIRequestContext) {
  return { 'x-csrf-token': (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '' };
}
async function demoSite(request: APIRequestContext) {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{ public_key: string; origins: Array<{ origin: string }> }>;
  const site = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  test.skip(!site, 'no site lists the widget demo origin (run widget-states.spec first)');
  return site!;
}
/** The conversation as the reader sees it: the visible text of the log, with its line breaks. */
const logText = (scope: Page | Frame) => scope.getByRole('log').first().evaluate((el) => (el as HTMLElement).innerText);
const hostileNodes = (scope: Page | Frame) => scope.getByRole('log').first().evaluate((el) => el.querySelectorAll('script, img[src="x"], img[onerror]').length);
function inOrder(text: string, parts: string[]) {
  const idx = parts.map((p) => text.indexOf(p));
  const once = parts.every((p) => text.split(p).length === 2);
  return { idx, once, ordered: idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]!)) };
}
async function widgetFrame(vpage: Page): Promise<{ frame: Frame; ui: FrameLocator }> {
  await vpage.waitForFunction(() => (window as unknown as { Talkivio?: (c: string) => { ready: boolean } }).Talkivio?.('getState')?.ready === true, undefined, { timeout: 20_000 });
  await vpage.evaluate(() => (window as unknown as { Talkivio: (c: string) => Promise<void> }).Talkivio('open'));
  const frame = vpage.frames().find((f) => f.url().includes('/widget/'))!;
  return { frame, ui: vpage.frameLocator('iframe[title="Chat"]') };
}

test('CHAT01 visitor and agent in independent browsers: Unicode and multiline text, order, delivery state, safe rendering, durable reload', async ({ browser, page, request }) => {
  test.setTimeout(150_000);
  const site = await demoSite(request);
  const headers = await csrf(request);
  const dialogs: string[] = [];
  page.on('dialog', (d) => void (dialogs.push(d.message()), d.dismiss()));
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{ id: string }>;
    for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  await page.goto('/inbox');
  await settle(page);
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });

  const vctx = await browser.newContext({ storageState: undefined });
  const vpage = await vctx.newPage();
  vpage.on('dialog', (d) => void (dialogs.push(d.message()), d.dismiss()));
  let chatId = '';
  try {
    await vpage.goto(`${DEMO}/sdk-host.html?${new URLSearchParams({ key: site.public_key, api: API })}`);
    let { frame, ui } = await widgetFrame(vpage);
    // The visitor writes the first message in the widget (prechat form when the site asks for it, else the composer).
    const startButton = ui.getByRole('button', { name: 'Start chat' });
    if (await startButton.isVisible().catch(() => false)) {
      if (await ui.getByLabel('Name').isVisible().catch(() => false)) await ui.getByLabel('Name').fill(`Uni ${stamp}`);
      await ui.getByRole('textbox', { name: 'Message' }).fill(V1);
      await startButton.click();
    } else {
      await ui.getByRole('textbox', { name: 'Message' }).fill(V1);
      await ui.getByRole('button', { name: 'Send message' }).click();
    }
    chatId = await expect
      .poll(() => vpage.evaluate(() => (window as unknown as { Talkivio: (c: string) => { chat: { id: string } | null } }).Talkivio('getState').chat?.id ?? ''), { timeout: 20_000 })
      .not.toBe('')
      .then(() => vpage.evaluate(() => (window as unknown as { Talkivio: (c: string) => { chat: { id: string } } }).Talkivio('getState').chat.id));
    expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
    await page.goto(`/inbox/${chatId}`);
    await settle(page);
    await expect.poll(() => logText(page), { message: "the visitor's first message reaches the agent with its line breaks" }).toContain(V1);

    // The agent answers with hostile markup and an emoji sequence.
    const composer = page.locator(`#composer-${chatId}`);
    await composer.fill(A1);
    await composer.press('Enter');
    await expect.poll(() => logText(frame), { message: "the agent's reply reaches the visitor intact", timeout: 20_000 }).toContain(A1);
    // Read receipts: the visitor's widget is open and showing the reply.
    await expect(page.getByRole('log').getByText('Read', { exact: true }), "the agent's bubble moves to Read").toBeVisible({ timeout: 20_000 });

    await ui.getByRole('textbox', { name: 'Message' }).fill(V2);
    await ui.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => logText(page), { timeout: 20_000 }).toContain(V2);
    await expect(ui.locator('.rd-status').last(), "the visitor sees their message's delivery state").toHaveText(/Delivered|Read/, { timeout: 20_000 });

    for (const [who, scope] of [['agent', page], ['visitor', frame]] as const) {
      const r = inOrder(await logText(scope), [V1, A1, V2]);
      expect(r.once, `${who}: every message shown exactly once`).toBe(true);
      expect(r.ordered, `${who}: in send order ${JSON.stringify(r.idx)}`).toBe(true);
      expect(await hostileNodes(scope), `${who}: markup rendered as text (no script/img element)`).toBe(0);
    }
    const stored = ((await (await request.get(`${API}/api/v1/chats/${chatId}/messages?limit=100`)).json()).data.items as Array<{ body: string | null; seq: number }>).filter((m) => [V1, A1, V2].includes(m.body ?? ''));
    expect(stored.map((m) => m.body), 'stored byte-for-byte, in seq order').toEqual([V1, A1, V2]);
    expect(stored.every((m, i) => i === 0 || m.seq > stored[i - 1]!.seq)).toBe(true);

    // Durable: reload both browsers.
    await page.reload();
    await settle(page);
    await vpage.reload();
    ({ frame, ui } = await widgetFrame(vpage));
    for (const [who, scope] of [['agent', page], ['visitor', frame]] as const) {
      await expect.poll(() => logText(scope), { message: `${who}: conversation restored after reload`, timeout: 20_000 }).toContain(V2);
      const r = inOrder(await logText(scope), [V1, A1, V2]);
      expect(r.once && r.ordered, `${who}: after reload every message once, in order ${JSON.stringify(r.idx)}`).toBe(true);
      expect(await hostileNodes(scope)).toBe(0);
    }
    expect(dialogs, 'no script ran in either browser').toEqual([]);
  } finally {
    if (chatId) await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
    await vctx.close();
  }
});
