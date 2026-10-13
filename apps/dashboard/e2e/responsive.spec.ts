import { expect, test } from '@playwright/test';
import { APP_ROUTES, settle } from './routes';

/** A11Y03 / AUD-72-24: 320/375/768/1024/1440 widths and 200 % zoom keep content reachable without horizontal scrolling. */
const WIDTHS = [320, 375, 768, 1024, 1440];
const KEY_ROUTES = APP_ROUTES.filter((r) => r !== '/design-system');

for (const width of WIDTHS) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    test.setTimeout(KEY_ROUTES.length * 30_000);
    await page.setViewportSize({ width, height: 800 });
    const overflowing: string[] = [];
    for (const route of KEY_ROUTES) {
      await page.goto(route);
      await settle(page);
      const o = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      if (o.sw > o.cw + 1) overflowing.push(`${route} (${o.sw} > ${o.cw})`);
    }
    expect(overflowing).toEqual([]);
  });
}

test('200 % zoom (CSS px 640) keeps navigation and main content reachable', async ({ page }) => {
  // 1280 px viewport at 200 % zoom renders like a 640 px CSS viewport with doubled device pixels.
  await page.setViewportSize({ width: 640, height: 400 });
  for (const route of ['/inbox', '/visitors', '/team', '/settings/general']) {
    await page.goto(route);
    await settle(page);
    const o = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
    expect(o.sw, `${route} overflows at 200 % zoom`).toBeLessThanOrEqual(o.cw + 1);
    await expect(page.getByRole('main')).toBeVisible();
  }
});
