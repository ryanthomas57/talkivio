import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { APP_ROUTES, PUBLIC_ROUTES, settle } from './routes';
import { RESULTS_DIR } from './paths';

/**
 * A11Y03 / AUD-72-23 (RTL): the dashboard in Arabic — <html lang="ar" dir="rtl">, no horizontal overflow at
 * phone and desktop widths, axe clean, and no untranslated interface copy (headings, labels, buttons, tabs,
 * table headers, navigation). User content is excluded: it is marked dir="auto"/"ltr" or <bdi>.
 */
const ROUTES = APP_ROUTES.filter((r) => r !== '/design-system');
// Product and protocol names that stay Latin inside Arabic copy.
const ALLOWED = /\b(Talkivio|API|CSV|HTTPS?|JSON|Webhooks?|CSAT|URL|UTC|IP|MFA|TOTP|ID|PDF|PNG|JPE?G|SMTP|DNS|SSO|SAML|OIDC|HMAC|SHA-256|localhost|Alt|alt|Shift|Enter|Esc|Tab|Ctrl|Cmd)\b/g;

test.use({ locale: 'ar-AE' });

async function arabic(page: Page): Promise<void> {
  await page.context().addCookies([{ name: 'rd_locale', value: 'ar', url: process.env.DASHBOARD_URL ?? 'http://localhost:3000' }]);
}

/** Interface text with Latin words left in it (likely untranslated). */
async function untranslated(page: Page): Promise<string[]> {
  return page.evaluate((allowed) => {
    const re = new RegExp(allowed, 'g');
    const skip = (el: Element | null): boolean => !!el?.closest('[dir="auto"], [dir="ltr"], bdi, code, pre, kbd, [data-user-content], .sr-only-focusable[lang]');
    const out = new Set<string>();
    const check = (text: string | null | undefined, where: string) => {
      const clean = (text ?? '').replace(/[⁦-⁩][^⁦-⁩]*⁩/g, ' ').replace(re, ' ');
      if (/[A-Za-z]{3,}/.test(clean)) out.add(`${where}: ${(text ?? '').trim().slice(0, 80)}`);
    };
    const chrome = 'h1, h2, h3, label, legend, th, button, [role="tab"], [role="menuitem"], nav a, [role="status"], [role="alert"]';
    for (const el of Array.from(document.querySelectorAll(chrome))) {
      if (skip(el) || (el as HTMLElement).offsetParent === null) continue;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(' ');
      check(own, el.tagName.toLowerCase());
    }
    for (const el of Array.from(document.querySelectorAll('[aria-label], [placeholder], [title]'))) {
      if (skip(el)) continue;
      for (const attr of ['aria-label', 'placeholder', 'title']) {
        const v = el.getAttribute(attr);
        // Example values in placeholders (an address, a URL, a token like utm_source) are data, not copy.
        if (v === null || /^https?:\/\//.test(v) || (attr === 'placeholder' && /^\S+$/.test(v.trim()))) continue;
        check(v, `@${attr}`);
      }
    }
    return [...out];
  }, ALLOWED.source);
}

for (const width of [375, 1280]) {
  test(`Arabic RTL at ${width}px: direction, no overflow, no untranslated interface copy`, async ({ page }) => {
    test.setTimeout(ROUTES.length * 30_000);
    await arabic(page);
    await page.setViewportSize({ width, height: 800 });
    const problems: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      await settle(page);
      const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
      if (html.lang !== 'ar' || html.dir !== 'rtl') problems.push(`${route}: html lang=${html.lang} dir=${html.dir}`);
      if (html.sw > html.cw + 1) problems.push(`${route}: overflow ${html.sw} > ${html.cw}`);
      for (const u of await untranslated(page)) problems.push(`${route}: untranslated ${u}`);
    }
    expect(problems).toEqual([]);
  });
}

for (const route of [...ROUTES, ...PUBLIC_ROUTES]) {
  test(`axe ar ${route}`, async ({ page, browser }) => {
    const isPublic = (PUBLIC_ROUTES as readonly string[]).includes(route);
    const ctx = isPublic ? await browser.newContext({ storageState: undefined, locale: 'ar-AE' }) : null;
    const p = ctx ? await ctx.newPage() : page;
    await arabic(p);
    await p.goto(route);
    await settle(p);
    const scan = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const violations = scan.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(`${RESULTS_DIR}/a11y.jsonl`, `${JSON.stringify({ route, theme: 'light-ar', at: new Date().toISOString(), violations, passes: scan.passes.length, incomplete: scan.incomplete.length })}\n`);
    await ctx?.close();
    const blocking = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
}

test('Arabic shell mirrors at phone width (navigation trigger at the inline start)', async ({ page }) => {
  await arabic(page);
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto('/inbox?view=queue');
  await settle(page);
  // The shell mirrors: navigation drawer trigger sits at the inline start (right edge in RTL).
  const trigger = page.getByRole('button', { name: 'فتح قائمة التنقل' });
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  expect(box && box.x > 375 / 2, 'drawer trigger is on the right in RTL').toBe(true);
});
