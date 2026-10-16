import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The desktop app around the dashboard: it loads the dashboard and says it is the app, links off the dashboard open
 * in the browser, only notifications are allowed, the unread count reaches the app icon, closing the window keeps it
 * running, an unreachable dashboard shows the offline page, and (against the local stack) the Go menu navigates.
 */
const DASHBOARD = process.env.TALKIVIO_URL ?? 'http://localhost:3000';
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(DASHBOARD).origin);
const APP_DIR = resolve(__dirname, '..');

async function launch(
  url = DASHBOARD,
): Promise<{ app: ElectronApplication; page: Page; close: () => Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), 'talkivio-desktop-'));
  // TALKIVIO_APP_PATH: test an installed build (e.g. release/mac-universal/Talkivio.app/Contents/MacOS/Talkivio).
  const packaged = process.env.TALKIVIO_APP_PATH;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [APP_DIR]), `--user-data-dir=${profile}`],
    env: { ...process.env, TALKIVIO_URL: url },
  });
  const page = await app.firstWindow();
  // Record links handed to the browser instead of opening them.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { __opened: opened });
    shell.openExternal = async (u: string) => {
      opened.push(u);
    };
  });
  return {
    app,
    page,
    close: async () => {
      await app.evaluate(({ app: a }) => {
        a.emit('before-quit');
        a.quit();
      });
      await app.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const opened = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

test('opens the dashboard and identifies itself as the desktop app', async () => {
  const { page, close } = await launch();
  try {
    await page.waitForURL(/\/login/); // a fresh profile is signed out
    expect(await page.evaluate(() => navigator.userAgent)).toMatch(/TalkivioDesktop\/\d+\.\d+\.\d+/);
    const bridge = await page.evaluate(
      () => (window as unknown as { talkivioDesktop: Record<string, unknown> }).talkivioDesktop,
    );
    expect(bridge).toMatchObject({ isDesktop: true, version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(await page.evaluate(() => Notification.permission), 'notifications are allowed').toBe('granted');
    const geo = await page.evaluate(() =>
      navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state),
    );
    expect(geo, 'other permissions are refused').toBe('denied');
  } finally {
    await close();
  }
});

test('links off the dashboard open in the browser, never inside the app', async () => {
  const { app, page, close } = await launch();
  try {
    await page.waitForURL(/\/login/); // a fresh profile is signed out
    const here = page.url();
    expect(await page.evaluate(() => window.open('https://example.com/new-window') === null)).toBe(true);
    await page.evaluate(() => {
      location.href = 'https://example.org/navigate';
    });
    await expect
      .poll(() => opened(app))
      .toEqual(['https://example.com/new-window', 'https://example.org/navigate']);
    expect(page.url(), 'the window stays on the dashboard').toBe(here);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await close();
  }
});

test('the unread count in the title reaches the app icon', async () => {
  test.skip(
    process.platform !== 'darwin',
    'the Dock badge is readable on macOS; Windows uses a taskbar overlay',
  );
  const { app, page, close } = await launch();
  try {
    await page.waitForURL(/\/login/); // a fresh profile is signed out
    await page.evaluate(() => {
      document.title = '(3) Talkivio';
    });
    await expect.poll(() => app.evaluate(({ app: a }) => a.dock?.getBadge())).toBe('3');
    await page.evaluate(() => {
      document.title = 'Talkivio';
    });
    await expect.poll(() => app.evaluate(({ app: a }) => a.dock?.getBadge())).toBe('');
  } finally {
    await close();
  }
});

test('closing the window keeps the app running; opening it again shows the same window', async () => {
  const { app, page, close } = await launch();
  try {
    await page.waitForURL(/\/login/); // a fresh profile is signed out
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())),
      )
      .toEqual([false]);
    await app.evaluate(({ app: a }) => a.emit('activate'));
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())),
      )
      .toEqual([true]);
  } finally {
    await close();
  }
});

test('an unreachable dashboard shows the offline page with a retry', async () => {
  const { page, close } = await launch('http://127.0.0.1:9');
  try {
    await page.waitForURL(/offline\.html/);
    await expect(page.getByRole('heading', { name: "Can't reach Talkivio" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await close();
  }
});

test('signed in: the Go menu switches pages without reloading the dashboard', async () => {
  test.skip(!LOCAL, 'signs in with the local test owner; never against production');
  const { UI_OWNER_PASSWORD, UI_OWNER_EMAIL } = await import('./local-owner');
  const { app, page, close } = await launch();
  try {
    await page.waitForURL(/\/login/);
    await page.getByLabel(/email/i).fill(UI_OWNER_EMAIL);
    await page
      .getByLabel(/password/i)
      .first()
      .fill(UI_OWNER_PASSWORD);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/inbox/, { timeout: 30_000 });
    // Signing in ends with one more full load of the inbox; mark the document only after it settled.
    await expect(page.locator('a[href="/visitors"]').first()).toBeVisible();
    await page.waitForTimeout(1500);
    await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
    await app.evaluate(({ Menu }) => {
      const go = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Go')!;
      go.submenu!.items.find((i) => i.label === 'Visitors')!.click();
    });
    await page.waitForURL(/\/visitors/);
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);
  } finally {
    await close();
  }
});
