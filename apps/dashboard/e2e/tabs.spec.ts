import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { settle, startVisitorChat } from './routes';

/**
 * WS06 / AUD-71-22: with two dashboard tabs open, an incoming visitor message produces exactly one desktop
 * notification (the tab elected leader alerts, the other stays quiet). Closing the leader hands leadership to the
 * remaining tab, which alerts for the next message, and the agent stays online because a connection is still open.
 * Both election paths are covered: Web Locks (default) and the BroadcastChannel heartbeat fallback for browsers
 * without `navigator.locks`. Notifications are recorded by a stub instead of being shown, and the page reports no
 * focus, as when the agent is working in another application.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

type Shown = { title: string; body?: string; tag?: string };

async function csrfOf(request: APIRequestContext): Promise<string> {
  return (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '';
}

async function openTabs(browser: Browser, baseURL: string, withLocks: boolean): Promise<{ pages: Page[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL, storageState: 'e2e/.auth/owner.json' });
  await context.addInitScript((locks: boolean) => {
    const shown: Array<{ title: string; body?: string; tag?: string }> = [];
    (window as unknown as { __notifications: typeof shown }).__notifications = shown;
    class RecordedNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string; tag?: string }) {
        shown.push({ title, body: opts?.body, tag: opts?.tag });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = RecordedNotification;
    document.hasFocus = () => false;
    if (!locks) Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  }, withLocks);
  const pages = [await context.newPage(), await context.newPage()];
  for (const page of pages) {
    await page.goto('/inbox');
    await settle(page);
  }
  return { pages, close: () => context.close() };
}

const notificationsFor = (page: Page, chatId: string) =>
  page.evaluate((id) => (window as unknown as { __notifications: Shown[] }).__notifications.filter((n) => n.tag === `rd-message-${id}`).length, chatId).catch(() => 0);

for (const withLocks of [true, false]) {
  test(`two tabs (${withLocks ? 'Web Locks' : 'BroadcastChannel fallback'}): one alert per message; closing the leader hands over and the agent stays online`, async ({ browser, baseURL, request }) => {
    test.setTimeout(120_000);
    const headers = { 'x-csrf-token': await csrfOf(request) };
    const me = (await (await request.get(`${API}/api/v1/agents/me`)).json()).data;
    const prefsBefore = me.preferences as Record<string, unknown>;
    const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{ public_key: string; origins: Array<{ origin: string }> }>;
    const site = sites.find((s) => s.origins?.length) ?? sites[0];
    test.skip(!site, 'no site for the UI test owner');
    for (const view of ['mine', 'queue']) {
      const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{ id: string }>;
      for (const c of list ?? []) await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
    }
    expect((await request.patch(`${API}/api/v1/agents/me/preferences`, { data: { desktop_notifications: true, sound: false, privacy_mode: false }, headers })).ok()).toBe(true);

    const tabs = await openTabs(browser, baseURL!, withLocks);
    let chatId = '';
    try {
      await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
      const sess = (await (await request.post(`${API}/widget/v1/sessions`, { data: { site_key: site!.public_key, host_origin: site!.origins?.[0]?.origin ?? 'http://localhost:5173', consent: { analytics: false, policy_version: '2026-10' } } })).json()).data;
      const visitor = { authorization: `Bearer ${sess.capability}` };
      chatId = await startVisitorChat(request, API, visitor, `Two tabs ${Date.now().toString(36)}`);
      expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
      // Both tabs must know the chat before the visitor writes.
      for (const page of tabs.pages) await expect(page.getByRole('link', { name: new RegExp(sess.visitor?.display_name ?? 'Visitor') }).first()).toBeVisible({ timeout: 20_000 });

      const say = async (text: string) => expect((await request.post(`${API}/widget/v1/chats/${chatId}/messages`, { headers: visitor, data: { client_message_id: crypto.randomUUID(), body: text } })).ok()).toBe(true);
      await say('First message while two tabs are open');
      await expect.poll(async () => (await notificationsFor(tabs.pages[0]!, chatId)) + (await notificationsFor(tabs.pages[1]!, chatId)), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await tabs.pages[0]!.waitForTimeout(2_000);
      const counts = [await notificationsFor(tabs.pages[0]!, chatId), await notificationsFor(tabs.pages[1]!, chatId)];
      expect(counts[0]! + counts[1]!, `still exactly one notification across both tabs (per tab: ${counts.join(' + ')})`).toBe(1);

      const leaderIndex = counts[0] === 1 ? 0 : 1;
      const follower = tabs.pages[1 - leaderIndex]!;
      await tabs.pages[leaderIndex]!.close();
      // Web Locks hand the lock to the waiting tab as the holder closes; the fallback leader resigns on pagehide.
      await follower.bringToFront();
      await follower.waitForTimeout(1_500);
      await say('Second message after the leader tab closed');
      await expect.poll(() => notificationsFor(follower, chatId), { timeout: 15_000, message: 'the remaining tab became leader and alerted' }).toBe(1);

      const roster = (await (await request.get(`${API}/api/v1/agents`)).json()).data as Array<{ id: string; effective_status: string; connected: boolean }>;
      const mine = roster.find((a) => a.id === me.agent.id);
      expect(mine, 'the agent is still connected and online through the remaining tab').toMatchObject({ connected: true, effective_status: 'online' });
    } finally {
      await tabs.close();
      if (chatId) await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
      await request.patch(`${API}/api/v1/agents/me/preferences`, { data: { desktop_notifications: prefsBefore.desktop_notifications ?? false, sound: prefsBefore.sound ?? true, privacy_mode: prefsBefore.privacy_mode ?? false }, headers });
    }
  });
}
