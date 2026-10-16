import { defineConfig } from '@playwright/test';

/**
 * Desktop app checks: Playwright drives the built Electron app (dist/) against a dashboard, by default the local
 * development stack (http://localhost:3000); CI points TALKIVIO_URL at https://talkivio.com (signed-out checks only).
 *   npm test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
