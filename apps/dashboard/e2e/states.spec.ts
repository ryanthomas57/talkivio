import { expect, test } from '@playwright/test';

/**
 * AUD-72-09 (ch. 50/51): monitor and analytics show stale and unavailable data truthfully. The API side — reports
 * flag their own lag while facts are behind, monitor snapshots carry as_of / stale — is proven in
 * apps/api/test/analytics.e2e.mjs; here the real responses are altered in flight to put the dashboard in each state.
 */
const MONITOR = /\/api\/v1\/monitor(\?|$)/;
const CHATS_REPORT = /\/api\/v1\/analytics\/chats(\?|$)/;
const unavailable = { status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Reporting is temporarily unavailable.', retryable: true } } };

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('analytics: a report that says its facts are behind shows the lag, not a silent number', async ({ page }) => {
  await page.route(CHATS_REPORT, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    const asOf = Date.parse(json.data.freshness.as_of);
    json.data.freshness = { ...json.data.freshness, stale: true, status: 'lagging', lag_ms: 180_000, pending_facts: 3, source_watermark: new Date(asOf - 180_000).toISOString() };
    await route.fulfill({ response: res, json });
  });
  await page.goto('/analytics');
  await expect(page.getByText('Report data is behind')).toBeVisible();
  await expect(page.getByText(/3 chats are still being processed/)).toBeVisible();
});

test('analytics: an unavailable report shows an error with retry, not zeros', async ({ page }) => {
  await page.route(CHATS_REPORT, (route) => route.fulfill(unavailable));
  await page.goto('/analytics');
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Reporting is temporarily unavailable.').first()).toBeVisible();
});

test('monitor: a snapshot the server marked stale is labelled stale', async ({ page }) => {
  // Without the live connection a fresher pushed snapshot cannot (legitimately) replace the stale one mid-test.
  await page.route('**/realtime/v1/**', (route) => route.abort());
  await page.routeWebSocket(/\/realtime\/v1\//, () => undefined);
  await page.route(MONITOR, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.data.stale = true;
    json.data.as_of = new Date(Date.now() - 120_000).toISOString();
    await route.fulfill({ response: res, json });
  });
  await page.goto('/monitor');
  await expect(page.getByText('Showing stale data')).toBeVisible();
  await expect(page.getByText(/The server marked this snapshot as stale/)).toBeVisible();
});

test('monitor: when updates stop arriving the page says so', async ({ page }) => {
  // No live connection (polling and WebSocket blocked) and no answer to later refreshes: nothing new arrives.
  await page.route('**/realtime/v1/**', (route) => route.abort());
  await page.routeWebSocket(/\/realtime\/v1\//, () => undefined);
  let served = false;
  await page.route(MONITOR, async (route) => {
    if (served) return; // left pending on purpose
    served = true;
    const res = await route.fetch();
    const json = await res.json();
    json.data.thresholds.stale_after_ms = 3_000; // the server's threshold, shortened so the test does not wait 15 s
    await route.fulfill({ response: res, json });
  });
  await page.goto('/monitor');
  await expect(page.getByText('Showing stale data')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/No update for more than 3 s/)).toBeVisible();
});

test('monitor: an unavailable snapshot shows an error with retry, not zeros', async ({ page }) => {
  // Both channels down: pushed snapshots over the live connection would otherwise (truthfully) keep the page live.
  await page.route('**/realtime/v1/**', (route) => route.abort());
  await page.routeWebSocket(/\/realtime\/v1\//, () => undefined);
  await page.route(MONITOR, (route) => route.fulfill(unavailable));
  await page.goto('/monitor');
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Reporting is temporarily unavailable.').first()).toBeVisible();
});
