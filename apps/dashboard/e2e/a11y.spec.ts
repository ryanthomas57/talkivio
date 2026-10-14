import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { ANON_ROUTES, APP_ROUTES, settle } from './routes';
import { RESULTS_DIR } from './paths';

/**
 * axe-core WCAG 2.1 A/AA sweep of every static route (A11Y04, AUD-72-23). Critical and serious violations
 * fail the test; every finding is appended to e2e-results/a11y.jsonl (one line per route/theme) for the
 * accessibility report (scripts/a11y-report.mjs). Appending survives worker restarts after failures.
 */

for (const theme of ['light', 'dark'] as const) {
  for (const route of [...APP_ROUTES, ...ANON_ROUTES]) {
    test(`axe ${theme} ${route}`, async ({ page, browser }) => {
      const isPublic = ANON_ROUTES.includes(route);
      const ctx = isPublic ? await browser.newContext({ storageState: undefined, colorScheme: theme }) : null;
      const p = ctx ? await ctx.newPage() : page;
      // Signed out, the theme is the choice stored in the browser (the header switch), not the system setting.
      if (ctx) await p.addInitScript((t) => localStorage.setItem('tk_theme', t), theme);
      if (!ctx) await p.emulateMedia({ colorScheme: theme });
      await p.goto(route);
      await settle(p);
      const scan = await new AxeBuilder({ page: p })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = scan.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      }));
      mkdirSync(RESULTS_DIR, { recursive: true });
      appendFileSync(
        `${RESULTS_DIR}/a11y.jsonl`,
        `${JSON.stringify({ route, theme, at: new Date().toISOString(), violations, passes: scan.passes.length, incomplete: scan.incomplete.length })}\n`,
      );
      await ctx?.close();
      const blocking = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    });
  }
}
