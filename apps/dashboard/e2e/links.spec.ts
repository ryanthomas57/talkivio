import { expect, test } from '@playwright/test';
import { APP_ROUTES, PUBLIC_ROUTES, settle } from './routes';

/**
 * AUD-71-35 (links half; buttons and menu items are covered statically by scripts/dead-controls.mjs): every link a
 * user can see on every dashboard route leads somewhere real. Links are collected from the rendered pages (signed
 * in, and signed out for the public routes); each internal destination is then opened and must answer without an
 * HTTP error, Next's not-found page or an error boundary. External links must be absolute https URLs.
 */
const NOT_FOUND = /This page could not be found|404/;

async function collect(page: import('@playwright/test').Page, routes: readonly string[]) {
  const internal = new Map<string, string>(); // destination → first page it was seen on
  const external = new Set<string>();
  for (const route of routes) {
    await page.goto(route);
    await settle(page);
    // Sample content in the design-system gallery (marked data-demo) is example data, not navigation.
    const hrefs = await page.$$eval('a[href]', (as) => as.filter((a) => !a.closest('[data-demo]')).map((a) => a.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      if (/^(mailto|tel):/.test(href)) continue;
      if (href.startsWith('#')) {
        // In-page links (skip links): the target must exist on this page.
        const id = decodeURIComponent(href.slice(1));
        expect(id && (await page.locator(`[id="${id}"]`).count()) > 0, `"${href}" on ${route} points at an element that exists`).toBe(true);
        continue;
      }
      if (/^https?:\/\//.test(href)) {
        const u = new URL(href);
        if (u.origin === new URL(page.url()).origin) internal.set(u.pathname, internal.get(u.pathname) ?? route);
        else external.add(href);
        continue;
      }
      expect(href.startsWith('/'), `relative or empty link "${href}" on ${route}`).toBe(true);
      const path = href.split(/[?#]/)[0]!;
      if (!internal.has(path)) internal.set(path, route);
    }
  }
  return { internal, external };
}

async function visitAll(page: import('@playwright/test').Page, internal: Map<string, string>) {
  const broken: string[] = [];
  for (const [path, from] of internal) {
    if (path.startsWith('/api/')) {
      // Download links (CSV exports …) answer with a file, not a page.
      const r = await page.request.get(path);
      if (r.status() >= 400) broken.push(`${path} (linked from ${from}): HTTP ${r.status()}`);
      continue;
    }
    const res = await page.goto(path);
    await settle(page);
    const status = res?.status() ?? 0;
    const body = await page.locator('body').innerText();
    if (status >= 400 || NOT_FOUND.test(await page.title()) || /This page could not be found|Page not found/.test(body)) broken.push(`${path} (linked from ${from}): HTTP ${status}`);
    else if (/Something went wrong/.test(body) && !(await page.getByRole('button', { name: /retry|try again/i }).count())) broken.push(`${path} (linked from ${from}): error boundary`);
  }
  return broken;
}

test('every link on the signed-in dashboard leads to a real page', async ({ page }) => {
  test.setTimeout(240_000);
  const { internal, external } = await collect(page, APP_ROUTES);
  expect(internal.size, 'links were collected').toBeGreaterThan(20);
  const broken = await visitAll(page, internal);
  expect(broken, `${internal.size} internal destinations checked`).toEqual([]);
  const insecure = [...external].filter((h) => !h.startsWith('https://') || /example\.(com|org)/.test(h));
  expect(insecure, `${external.size} external links are https and not placeholders`).toEqual([]);
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('every link on the public pages leads to a real page', async ({ page }) => {
    const { internal, external } = await collect(page, PUBLIC_ROUTES);
    expect(internal.size).toBeGreaterThan(2);
    expect(await visitAll(page, internal)).toEqual([]);
    expect([...external].filter((h) => !h.startsWith('https://'))).toEqual([]);
  });
});
