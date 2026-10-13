import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { RESULTS_DIR } from './paths';
import { APP_ROUTES, PUBLIC_ROUTES, settle } from './routes';

/**
 * A11Y04 (ch. 05): the reduced-motion and forced-colors (Windows High Contrast) reviews, automated in Chromium.
 *  - prefers-reduced-motion: reduce — on every dashboard route and in the visitor widget, no element keeps a
 *    transition or animation longer than 0.01 ms, nothing animates indefinitely, and smooth scrolling is off.
 *    Control: without the preference the same pages do have transitions, so the check is not vacuous.
 *  - forced-colors: active — on every route, each element reached with Tab shows a focus outline (box-shadow rings
 *    disappear in this mode), and the state of switches, checkboxes and tabs is still visible when the colours
 *    are replaced by system colours (the same control is captured before and after its state changes).
 * Findings are appended to <results>/motion-contrast.jsonl for the accessibility report.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
const ROUTES = [...APP_ROUTES, ...PUBLIC_ROUTES];

function record(entry: Record<string, unknown>) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(`${RESULTS_DIR}/motion-contrast.jsonl`, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

/** Elements whose computed transition/animation outlasts `maxMs`, plus animations that never end. */
function motionReport(page: Page | import('@playwright/test').Frame, maxMs: number) {
  return page.evaluate((max) => {
    const ms = (v: string) => Math.max(0, ...v.split(',').map((s) => (s.trim().endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000)));
    const slow: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const pseudo of [null, '::before', '::after'] as const) {
        const cs = getComputedStyle(el, pseudo);
        const t = cs.transitionProperty !== 'none' ? ms(cs.transitionDuration) : 0;
        const a = cs.animationName !== 'none' ? ms(cs.animationDuration) : 0;
        if (t > max || a > max) slow.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${pseudo ?? ''} transition ${t}ms animation ${a}ms`);
      }
    }
    const endless = document.getAnimations().filter((an) => {
      const timing = an.effect?.getComputedTiming();
      return an.playState === 'running' && (!timing || timing.iterations === Infinity || Number(timing.duration) > max);
    }).length;
    return { slow: slow.slice(0, 20), slowCount: slow.length, endless, smoothScroll: getComputedStyle(document.documentElement).scrollBehavior === 'smooth' };
  }, maxMs);
}

async function open(page: Page, browser: import('@playwright/test').Browser, route: string, media: Parameters<Page['emulateMedia']>[0]) {
  const isPublic = (PUBLIC_ROUTES as readonly string[]).includes(route);
  const ctx = isPublic ? await browser.newContext({ storageState: undefined }) : null;
  const p = ctx ? await ctx.newPage() : page;
  await p.emulateMedia(media);
  await p.goto(route);
  await settle(p);
  return { p, close: () => ctx?.close() };
}

test.describe('reduced motion', () => {
  for (const route of ROUTES) {
    test(`reduced motion ${route}`, async ({ page, browser }) => {
      const { p, close } = await open(page, browser, route, { reducedMotion: 'reduce' });
      await p.waitForTimeout(150);
      const r = await motionReport(p, 0.01);
      record({ check: 'reduced-motion', route, ...r });
      await close();
      expect(r.slow, `elements still moving on ${route}`).toEqual([]);
      expect(r.endless, 'no running animation outlasts the reduced-motion limit').toBe(0);
      expect(r.smoothScroll).toBe(false);
    });
  }

  test('control: without the preference the dashboard does use transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/settings/general');
    await settle(page);
    const r = await motionReport(page, 0.01);
    expect(r.slowCount, 'transitions exist, so the reduced-motion check above is meaningful').toBeGreaterThan(0);
  });

  test('visitor widget honours reduced motion inside its frame', async ({ page, request }) => {
    const site = await demoSite(request);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${DEMO}/sdk-host.html?${new URLSearchParams({ key: site.public_key, api: API })}`);
    await page.waitForFunction(() => (window as unknown as { Talkivio?: (c: string) => { ready: boolean } }).Talkivio?.('getState')?.ready === true, undefined, { timeout: 20_000 });
    await page.evaluate(() => (window as unknown as { Talkivio: (c: string) => Promise<void> }).Talkivio('open'));
    const frame = page.frames().find((f) => f.url().includes('/widget/'));
    expect(frame, 'widget frame').toBeTruthy();
    await frame!.waitForLoadState();
    await page.waitForTimeout(300);
    const r = await motionReport(frame!, 0.01);
    record({ check: 'reduced-motion', route: 'widget frame', ...r });
    expect(r.slow, 'widget elements still moving').toEqual([]);
    expect(r.endless).toBe(0);
  });
});

test.describe('forced colors', () => {
  for (const route of ROUTES) {
    test(`forced colors: focus is visible on ${route}`, async ({ page, browser }) => {
      const { p, close } = await open(page, browser, route, { forcedColors: 'active' });
      const missing: string[] = [];
      let reached = 0;
      for (let i = 0; i < 30; i++) {
        await p.keyboard.press('Tab');
        const f = await p.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
          const label = `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
          return { outline, label, inDialog: !!el.closest('[role=dialog]') };
        });
        if (!f) continue;
        reached++;
        if (!f.outline) missing.push(f.label);
      }
      record({ check: 'forced-colors-focus', route, reached, missing });
      await close();
      expect(reached, `Tab reaches controls on ${route}`).toBeGreaterThan(0);
      expect(missing, `focused controls without a visible outline in forced colors on ${route}`).toEqual([]);
    });
  }

  test('forced colors: switch, checkbox and tab states stay visible', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/design-system');
    await settle(page);
    const changed: Record<string, boolean> = {};
    const toggles: Array<[string, import('@playwright/test').Locator, () => Promise<void>]> = [
      ['switch', page.getByRole('switch', { name: 'Read receipts' }), () => page.getByRole('switch', { name: 'Read receipts' }).click()],
      ['checkbox', page.getByRole('checkbox', { name: 'Trust this device for 30 days' }), () => page.getByRole('checkbox', { name: 'Trust this device for 30 days' }).click()],
      ['tab', page.getByRole('tab', { name: 'General' }), () => page.getByRole('tab', { name: 'Agents' }).click()],
    ];
    for (const [name, control, change] of toggles) {
      await control.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const before = await control.screenshot({ animations: 'disabled' });
      await change();
      await page.mouse.move(0, 0);
      await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined); // drop focus rings from the comparison
      await page.waitForTimeout(200);
      const after = await control.screenshot({ animations: 'disabled' });
      changed[name] = !before.equals(after);
    }
    record({ check: 'forced-colors-state', route: '/design-system', changed });
    expect(changed, 'each control looks different once its state changes, with system colours only').toEqual({ switch: true, checkbox: true, tab: true });
  });
});

async function demoSite(request: APIRequestContext): Promise<{ public_key: string }> {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{ public_key: string; origins: Array<{ origin: string }> }>;
  const site = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  test.skip(!site, 'no site lists the widget demo origin (run widget-states.spec first)');
  return site!;
}
