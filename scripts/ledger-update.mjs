#!/usr/bin/env node
/**
 * Update rows of docs/traceability.csv and re-sync the "Ledger pointer" column of docs/release-audit.md.
 *
 *   node scripts/ledger-update.mjs updates.json        # {"AUTH01": {"status": "verified", "evidence_path": "…", …}, …}
 *                                                      # a new row: {"FILE01.scan": {"add": true, "after": "FILE01", …all columns}}
 *   node scripts/ledger-update.mjs --sync-only         # only re-sync release-audit.md from the CSV
 *
 * Columns: requirement_id, chapter, mandatory_or_optional, feature_flag, description, acceptance_test,
 * implementation_paths, status, evidence_path, last_verified_commit, known_issue, dependency_ids.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = resolve(root, 'docs/traceability.csv');
const auditPath = resolve(root, 'docs/release-audit.md');

function parse(text) {
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
    } else if (c !== '\r') f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

const rows = parse(readFileSync(csvPath, 'utf8'));
const head = rows[0];
const col = Object.fromEntries(head.map((h, i) => [h, i]));

const arg = process.argv[2];
if (arg && arg !== '--sync-only') {
  const updates = JSON.parse(readFileSync(arg, 'utf8'));
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const u = updates[r[0]];
    if (!u) continue;
    seen.add(r[0]);
    for (const [k, v] of Object.entries(u)) {
      if (!(k in col)) throw new Error(`unknown column ${k}`);
      r[col[k]] = v;
    }
  }
  // New rows are appended only when asked for explicitly ("add": true), after the row of their "after" id if given.
  let added = 0;
  for (const [id, u] of Object.entries(updates)) {
    if (seen.has(id) || !u.add) continue;
    const row = rows[0].map(() => '');
    row[0] = id;
    for (const [k, v] of Object.entries(u)) {
      if (k === 'add' || k === 'after') continue;
      if (!(k in col)) throw new Error(`unknown column ${k}`);
      row[col[k]] = v;
    }
    const at = u.after ? rows.findLastIndex((r) => r[0] === u.after || r[0].startsWith(`${u.after}.`)) : -1;
    rows.splice(at >= 0 ? at + 1 : rows.length, 0, row);
    seen.add(id);
    added++;
  }
  const missing = Object.keys(updates).filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`rows not found: ${missing.join(', ')} (pass "add": true to append a new requirement)`);
  writeFileSync(csvPath, rows.map((r) => r.map(esc).join(',')).join('\n') + '\n');
  console.log(`updated ${seen.size - added} rows, added ${added}`);
}

// Release audit: the last table cell of each "| ID | … |" row is "<status>: <first evidence path>".
const byId = new Map(rows.slice(1).map((r) => [r[0], r]));
let synced = 0;
const md = readFileSync(auditPath, 'utf8')
  .split('\n')
  .map((line) => {
    const m = /^\| (\S+)\s*\|/.exec(line);
    const r = m && byId.get(m[1]);
    if (!r) return line;
    const cells = line.split('|');
    // ['', ' ID ', …, ' pointer ', ''] — the pointer is the second-to-last element.
    const i = cells.length - 2;
    const width = cells[i].length;
    const evidence = (r[col.evidence_path] || '').split(';')[0].trim() || '—';
    const text = ` ${r[col.status]}: ${evidence}`;
    cells[i] = text.length + 1 > width ? `${text} ` : text.padEnd(width);
    synced++;
    return cells.join('|');
  })
  .join('\n');
writeFileSync(auditPath, md);
console.log(`synced ${synced} release-audit pointers`);
