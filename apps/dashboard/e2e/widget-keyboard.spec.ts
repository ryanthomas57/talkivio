import { expect, test, type Frame, type Page } from '@playwright/test';
import { settle } from './routes';

/**
 * A11Y01 (visitor side): keyboard-only widget journey on the demo store (apps/widget demo, :5173) — Tab
 * into the launcher, open it, start a chat, send a message, minimize with Escape and land back on the
 * launcher (ch. 29/59: "close returns to host launcher"). Needs the widget demo server
 * (`pnpm --filter @talkivio/widget exec vite --config vite.demo.config.ts`).
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';

type Site = {
  id: string;
  public_key: string;
  version: number;
  origins: Array<{ origin: string; pattern_type: string }>;
};

async function demoSite(request: import('@playwright/test').APIRequestContext, csrf: string): Promise<Site> {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Site[];
  const ready = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  if (ready) return ready;
  // The UI test owner's first site gains the demo origin (test data only).
  const site = sites[0]!;
  const origins = [
    ...site.origins.map((o) => ({ origin: o.origin, pattern_type: o.pattern_type })),
    { origin: DEMO, pattern_type: 'exact' },
  ];
  const r = await request.patch(`${API}/api/v1/sites/${site.id}`, {
    data: { origins, expected_version: site.version },
    headers: { 'x-csrf-token': csrf },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).data as Site;
}

const widgetFrame = (page: Page): Frame | undefined =>
  page.frames().find((f) => f.url().includes('/widget/frame/'));

/** What has keyboard focus: the host element, and inside the widget frame when focus is in it. */
async function focus(page: Page): Promise<{ host: string; inner: string }> {
  const host = await page.evaluate(() => document.activeElement?.tagName ?? '');
  const f = widgetFrame(page);
  const inner =
    host === 'IFRAME' && f
      ? await f.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return `${el?.tagName ?? ''}|${el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 40) ?? ''}`;
        })
      : '';
  return { host, inner };
}

async function tabUntil(page: Page, match: (inner: string) => boolean, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (match((await focus(page)).inner)) return true;
  }
  return false;
}

test('keyboard-only visitor: open the widget, chat, minimize and return to the launcher', async ({
  page,
  request,
  context,
}) => {
  const up = await request
    .get(DEMO)
    .then((r) => r.ok())
    .catch(() => false);
  test.skip(!up, `widget demo server not running at ${DEMO}`);
  // An online agent with a live dashboard connection, so the widget offers chat (not the offline form).
  const agent = await context.newPage();
  await agent.goto('/inbox');
  await settle(agent);
  const csrf = (await context.cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
  await request.put(`${API}/api/v1/agents/me/presence`, {
    data: { status: 'online' },
    headers: { 'x-csrf-token': csrf },
  });
  const site = await demoSite(request, csrf);

  await page.bringToFront();
  await page.goto(`${DEMO}/?w=${encodeURIComponent(site.public_key)}`);
  await expect.poll(() => !!widgetFrame(page), { message: 'widget frame mounted' }).toBe(true);
  await expect(
    page.frameLocator('iframe[title="Chat"]').getByRole('button', { name: /open chat/i }),
  ).toBeVisible({ timeout: 20_000 });

  // Reach the launcher by Tab from the host page, open it with Enter.
  expect(await tabUntil(page, (inner) => /open chat/i.test(inner)), 'launcher reachable by Tab').toBe(true);
  await page.keyboard.press('Enter');

  // Pre-chat form (if the site asks for one) is filled by keyboard; then the composer takes the message.
  const frame = page.frameLocator('iframe[title="Chat"]');
  const message = `Keyboard visitor ${Date.now().toString(36)}`;
  const startChat = frame.getByRole('button', { name: /start chat/i });
  if (await startChat.isVisible({ timeout: 3_000 }).catch(() => false)) {
    expect(
      await tabUntil(page, (inner) => /^(INPUT|TEXTAREA)\|/.test(inner), 20),
      'pre-chat field reachable',
    ).toBe(true);
    await page.keyboard.type('Keyboard Visitor');
    expect(await tabUntil(page, (inner) => /start chat/i.test(inner), 20), 'Start chat reachable').toBe(true);
    await page.keyboard.press('Enter');
  }
  const composer = frame.getByRole('textbox', { name: /^message$/i });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  if (!/^TEXTAREA\|Message$/i.test((await focus(page)).inner))
    expect(
      await tabUntil(page, (inner) => /^TEXTAREA\|message$/i.test(inner), 60),
      'composer reachable by Tab',
    ).toBe(true);
  await page.keyboard.type(message);
  await page.keyboard.press('Enter');
  await expect(frame.getByText(message).first()).toBeVisible({ timeout: 15_000 });
  expect((await focus(page)).inner, 'focus stays in the composer after send').toMatch(/^TEXTAREA\|message$/i);

  // Escape minimizes; focus returns to the launcher.
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await focus(page)).inner, {
      message: 'focus returns to the launcher',
      timeout: 10_000,
    })
    .toMatch(/open chat/i);
});
