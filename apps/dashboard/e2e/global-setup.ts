import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { UI_OWNER } from './fixtures';
import { AUTH_FILE, RESULTS_DIR } from './paths';

/** Signs the local UI test owner in through the real login page (creating the account on first run). */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const { baseURL, channel } = config.projects[0]!.use;
  rmSync(`${RESULTS_DIR}/a11y.jsonl`, { force: true });
  rmSync(`${RESULTS_DIR}/motion-contrast.jsonl`, { force: true });
  const api = process.env.API_URL ?? 'http://localhost:4000';
  // First run on a fresh database: create the owner through the public signup API.
  const signup = await fetch(`${api}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: UI_OWNER.email, password: UI_OWNER.password, tenant_name: UI_OWNER.workspace, display_name: UI_OWNER.name }),
  });
  // 409/422: the owner exists; 429: signup is rate limited for this address (the UI login below still verifies the owner).
  if (![201, 409, 422, 429].includes(signup.status)) throw new Error(`signup probe failed: ${signup.status}`);
  const browser = await chromium.launch({ channel: channel ?? 'chrome' });
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(UI_OWNER.email);
  await page.getByLabel(/password/i).first().fill(UI_OWNER.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  // A fresh database (CI): the visitor-facing specs need one site whose origin is the widget demo storefront.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
  const sites = (await (await page.request.get(`${api}/api/v1/sites`)).json()).data as unknown[];
  if (!sites?.length) {
    const origin = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
    const created = await page.request.post(`${api}/api/v1/sites`, { data: { name: 'UI test site', origins: [{ origin, pattern_type: 'exact' }] }, headers: { 'x-csrf-token': csrf } });
    if (!created.ok()) throw new Error(`creating the UI test site failed: ${created.status()} ${await created.text()}`);
  }
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
  await browser.close();
}
