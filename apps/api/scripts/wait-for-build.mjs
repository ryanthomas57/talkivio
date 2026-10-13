// Waits for the API's first TypeScript build so the worker can start in dev.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const target = new URL('../dist/worker.js', import.meta.url);
for (let i = 0; i < 600 && !existsSync(target); i++) await sleep(500);
if (!existsSync(target)) {
  console.error('Timed out waiting for dist/worker.js');
  process.exit(1);
}
