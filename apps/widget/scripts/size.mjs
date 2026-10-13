// Print raw + gzip sizes of the widget bundles and check them against the budgets.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const files = ['loader.js', 'frame/frame.js', 'frame/frame.css'];
const budgets = { loader: 6 * 1024, frame: 80 * 1024 };
const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

let failed = false;
const sizes = {};
console.log('file                 raw         gzip');
for (const f of files) {
  const p = resolve(dist, f);
  if (!existsSync(p)) {
    console.log(`${f.padEnd(20)} missing — run \`pnpm build\` first`);
    failed = true;
    continue;
  }
  const buf = readFileSync(p);
  const gz = gzipSync(buf, { level: 9 }).length;
  sizes[f] = gz;
  console.log(`${f.padEnd(20)} ${kb(buf.length).padEnd(11)} ${kb(gz)}`);
}
const frameTotal = (sizes['frame/frame.js'] ?? 0) + (sizes['frame/frame.css'] ?? 0);
console.log(`\nloader gzip ${kb(sizes['loader.js'] ?? 0)} (budget ${kb(budgets.loader)})`);
console.log(`frame  gzip ${kb(frameTotal)} js+css (budget ${kb(budgets.frame)})`);
if ((sizes['loader.js'] ?? 0) > budgets.loader) {
  console.log('✗ loader exceeds budget');
  failed = true;
}
if (frameTotal > budgets.frame) {
  console.log('✗ frame exceeds budget');
  failed = true;
}
if (!failed) console.log('✓ within budgets');
process.exitCode = failed ? 1 : 0;
