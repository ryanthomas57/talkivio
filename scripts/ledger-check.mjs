#!/usr/bin/env node
/**
 * Traceability gate (AUD-72-35, ch. 70): every row of docs/traceability.csv points at evidence that still exists.
 *   - every repository path named in implementation_paths / evidence_path exists;
 *   - every quoted check message ("…") in evidence_path is still present in the test file it follows, so a renamed or
 *     deleted assertion cannot leave a row claiming it;
 *   - a verified row cites evidence; statuses are from the ledger vocabulary.
 * Usage: node scripts/ledger-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(resolve(root, 'docs/traceability.csv'), 'utf8');
const rows = [];
let row = [];
let f = '';
let q = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (q) {
    if (c === '"') {
      if (text[i + 1] === '"') {
        f += '"';
        i++;
      } else q = false;
    } else f += c;
  } else if (c === '"') q = true;
  else if (c === ',') {
    row.push(f);
    f = '';
  } else if (c === '\n') {
    row.push(f);
    rows.push(row);
    row = [];
    f = '';
  } else f += c;
}
const [header, ...data] = rows;
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const STATUSES = new Set(['verified', 'partial', 'not_verified', 'optional_disabled', 'blocked', 'failed']);
// A path starts at a top-level folder (not inside another path, so deploy/scripts/x.sh is not read as scripts/x.sh).
const PATH =
  /(?<![\w./-])((?:apps|packages|docs|scripts|infra|contracts|deploy|\.github)\/[\w./@-]+?\.(?:tsx|ts|mjs|json|js|md|csv|yaml|yml|sql|sh|prisma))(?![\w])/g;
const problems = [];
let paths = 0;
let messages = 0;
const cache = new Map();
const read = (p) => {
  if (!cache.has(p))
    cache.set(p, existsSync(resolve(root, p)) ? readFileSync(resolve(root, p), 'utf8') : null);
  return cache.get(p);
};
for (const r of data) {
  const id = r[col.requirement_id];
  if (!id) continue;
  const status = r[col.status];
  const evidence = r[col.evidence_path] ?? '';
  if (!STATUSES.has(status)) problems.push(`${id}: unknown status "${status}"`);
  if (status === 'verified' && !PATH.test(evidence)) problems.push(`${id}: verified without a cited file`);
  PATH.lastIndex = 0;
  for (const field of [r[col.implementation_paths] ?? '', evidence]) {
    for (const m of field.matchAll(PATH)) {
      const p = m[1].replace(/[.,;:)]+$/, '');
      paths++;
      if (read(p) === null) problems.push(`${id}: missing file ${p}`);
    }
  }
  // Quoted check messages: `path ("message"; "message")` — each must occur in that file.
  for (const m of evidence.matchAll(
    /((?:apps|packages)\/[\w./@-]+\.(?:mjs|ts|tsx))\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
  )) {
    const file = read(m[1]);
    if (file === null) continue;
    for (const qm of m[2].matchAll(/"([^"]{6,})"/g)) {
      messages++;
      if (!file.includes(qm[1])) problems.push(`${id}: "${qm[1].slice(0, 60)}" not found in ${m[1]}`);
    }
  }
}
console.log(
  `[ledger] ${data.filter((r) => r[0]).length} rows, ${paths} file references, ${messages} quoted check messages`,
);
if (problems.length) {
  console.error(`✗ ${problems.length} problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ every cited file exists and every quoted check is still in its test');
