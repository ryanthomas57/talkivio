import { expect, test, type Page } from '@playwright/test';
import { APP_ROUTES, settle } from './routes';

/**
 * Every dropdown menu opens without a client exception. scripts/dead-controls.mjs checks menu items statically, but a
 * menu that throws while rendering only shows up when it is opened: the account menu's link items (an icon beside a
 * Radix asChild link) used to replace the whole page with Next's "Application error" screen.
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('account menu opens and its links work', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/overview');
  await settle(page);
  await page.getByRole('button', { name: /^Account menu for/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const profile = menu.getByRole('menuitem', { name: /^Profile/ });
  await expect(profile).toBeVisible();
  // The icon sits inside the link, so the whole row is the link.
  await expect(profile.locator('svg')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Create workspace' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await profile.click();
  await page.waitForURL('**/settings/account');
  await expect(page.getByText(/Application error/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('every menu on every dashboard route opens without an exception', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  let opened = 0;
  for (const route of APP_ROUTES) {
    await page.goto(route);
    await settle(page);
    const triggers = page.locator('[aria-haspopup="menu"]:visible');
    const count = await triggers.count();
    for (let i = 0; i < count; i++) {
      const trigger = triggers.nth(i);
      if (await trigger.isDisabled()) continue;
      await trigger.click();
      await expect(page.getByRole('menu'), `menu ${i + 1} on ${route}`).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      opened++;
      expect(errors, `opening menu ${i + 1} on ${route}`).toEqual([]);
    }
  }
  // The top bar alone has the status and account menus on every route.
  expect(opened).toBeGreaterThanOrEqual(APP_ROUTES.length * 2);
});
