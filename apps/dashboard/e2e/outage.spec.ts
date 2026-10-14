import { expect, test } from '@playwright/test';
import { settle, startVisitorChat } from './routes';

/**
 * FAIL02 (ch. 67): a send that hits a dependency outage fails honestly and is recovered by Retry. The API side —
 * a real database outage answers 503 SERVICE_UNAVAILABLE (retryable, Retry-After) and the retried send stores exactly
 * one message — is proven in apps/api/test/outage.e2e.mjs; here the dashboard receives that response and must show
 * it as a failed bubble (error text, Retry, Copy, Discard) instead of a silent loss or a fake "sent", and Retry must
 * re-send the same message (same client_message_id) once the service is back.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const OUTAGE = {
  status: 503,
  headers: { 'retry-after': '5' },
  json: {
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is temporarily unavailable. Please retry shortly.',
      retryable: true,
    },
  },
};

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('inbox: a send during an outage shows Failed with the reason, and Retry delivers the same message once', async ({
  page,
  request,
}) => {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
    public_key: string;
    origins: Array<{ origin: string }>;
  }>;
  const site = sites.find((s) => s.origins?.length) ?? sites[0];
  test.skip(!site, 'no site for the UI test owner');
  await page.goto('/inbox');
  await settle(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  // Leftover chats from earlier runs would hold capacity (Accept → CAPACITY_EXCEEDED).
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{
      id: string;
    }>;
    for (const c of list ?? [])
      await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  const sess = await (
    await request.post(`${API}/widget/v1/sessions`, {
      data: {
        site_key: site!.public_key,
        host_origin: site!.origins?.[0]?.origin ?? 'http://localhost:5173',
        consent: { analytics: false, policy_version: '2026-10' },
      },
    })
  ).json();
  const chatId = await startVisitorChat(
    request,
    API,
    { authorization: `Bearer ${sess.data.capability}` },
    `Outage check ${Date.now().toString(36)}`,
  );
  expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);

  try {
    // Without a live socket the composer sends over REST; the first send meets the outage, later ones reach the API.
    // (page.route sees only HTTP, so the WebSocket transport is refused separately).
    await page.route('**/realtime/v1/**', (route) => route.abort());
    await page.routeWebSocket(/\/realtime\/v1\//, (ws) => ws.close());
    const sends: Array<{ client_message_id: string; body: string }> = [];
    await page.route(new RegExp(`/api/v1/chats/${chatId}/messages$`), async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sends.push(route.request().postDataJSON());
      if (sends.length === 1) return route.fulfill(OUTAGE);
      return route.fallback();
    });
    await page.goto(`/inbox/${chatId}`);
    await settle(page);
    const text = `Sent while the service was down ${Date.now().toString(36)}`;
    const composer = page.locator(`#composer-${chatId}`);
    await composer.fill(text);
    await composer.press('Enter');

    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Failed: The service is temporarily unavailable. Please retry shortly.' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(alert.getByRole('button', { name: /Copy text/i })).toBeVisible();
    await expect(page.getByText(text).first(), 'the unsent text stays on screen').toBeVisible();

    const retried = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/chats/${chatId}/messages`),
    );
    await alert.getByRole('button', { name: 'Retry' }).click();
    expect((await retried).status(), 'the retried send is accepted once the service is back').toBe(201);
    await expect(alert).toHaveCount(0);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.client_message_id, 'Retry re-sends the same message (same client_message_id)').toBe(
      sends[0]!.client_message_id,
    );
    const page1 = (await (await request.get(`${API}/api/v1/chats/${chatId}/messages?limit=50`)).json())
      .data as { items: Array<{ body: string | null; client_message_id: string | null }> };
    const stored = page1.items.filter((m) => m.body === text);
    expect(stored, 'stored exactly once').toHaveLength(1);
    expect(stored[0]!.client_message_id, 'under the client id of the failed attempt').toBe(
      sends[0]!.client_message_id,
    );
    await expect(
      page.getByRole('log').getByText(text),
      'one bubble in the conversation, no leftover failed copy',
    ).toHaveCount(1);
  } finally {
    await request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers });
  }
});
