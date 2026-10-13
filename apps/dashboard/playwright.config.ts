import { defineConfig } from '@playwright/test';
import { AUTH_FILE, RESULTS_DIR } from './e2e/paths';

/**
 * Browser e2e + accessibility evidence (A11Y01–04, AUD-71-35, AUD-72-23/24). Runs against the local dev
 * stack: dashboard :3000, api :4000 (worker running), using the installed Chrome (no browser download).
 *   pnpm --filter @talkivio/dashboard e2e
 */
export default defineConfig({
  testDir: './e2e',
  // macOS writes AppleDouble `._*` companions on non-APFS volumes; they are not tests.
  testIgnore: ['**/._*'],
  outputDir: `${RESULTS_DIR}/artifacts`,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `${RESULTS_DIR}/results.json` }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: true,
    storageState: AUTH_FILE,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
});
