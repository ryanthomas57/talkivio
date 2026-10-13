#!/usr/bin/env node
/**
 * Backup → disaster → restore drill (DEPLOY03, AUD-72-14). Local only; never touches the source data.
 *
 *   0. Stage a quiescent "production" copy: pg_dump of DATABASE_OWNER_URL's database → talkivio_drill_src,
 *      and a copy of STORAGE_LOCAL_DIR → storage-drill-src (the dev stack keeps running).
 *   1. Fingerprint production: row count of every table, sha256 of every object, attachment sha256 checks.
 *   2. Backup: pg_dump -Fc + object copy with a checksum manifest (timed, sized).
 *   3. Write a sentinel row after the backup (to measure RPO honestly), then "disaster": drop the database
 *      and delete the objects.
 *   4. Restore (RTO clock): create the database, pg_restore, copy objects back, replay the privacy erasure
 *      ledger BEFORE traffic (scripts/replay-tombstones.mjs), boot an api on the restored data and wait for
 *      readiness.
 *   5. Verify: row counts and object checksums identical, attachment rows match their files, RLS/policies/
 *      functions/grants identical to a fresh migration replay (schema-drift --compare-url), writes work on the
 *      restored system (signup → site → widget chat), sentinel absent (RPO = backup age for logical backups).
 *   6. Write docs/operations/backup-drill-report.md and clean up.
 * Usage (after `npx nest build`): cd apps/api && set -a && . ../../.env && set +a && node scripts/backup-drill.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(apiDir, '../..');
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) throw new Error('Set DATABASE_OWNER_URL and DATABASE_URL (repo .env).');
const libpq = (u) => u.replace(/\?.*$/, '');
const base = (u) => libpq(u).replace(/\/[^/]*$/, '');
const dbUrl = (u, db) => `${base(u)}/${db}`;
const SRC = 'talkivio_drill_src';
const DST = 'talkivio_drill_restore';
const PORT = Number(process.env.DRILL_PORT ?? 4160);
const work = resolve(process.env.TMPDIR ?? '/tmp', `talkivio-drill-${Date.now()}`);
const srcStorage = resolve(apiDir, 'storage-drill-src');
const dstStorage = resolve(apiDir, 'storage-drill-restore');
const devStorage = resolve(apiDir, process.env.STORAGE_LOCAL_DIR ?? './storage');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const psql = (url, q) => sh('psql', [libpq(url), '-X', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q]).trim();
const admin = dbUrl(ownerUrl, 'postgres');
const ms = (t0) => Date.now() - t0;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const report = { startedAt: new Date().toISOString(), steps: {}, checks: [] };
const check = (ok, msg) => {
  report.checks.push({ ok, msg });
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) throw new Error(`DRILL CHECK FAILED: ${msg}`);
};

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f.startsWith('._') || f === '.DS_Store') continue; // macOS metadata on external volumes
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifest = (dir) => Object.fromEntries(files(dir).map((p) => [relative(dir, p), sha(p)]));
const tableCounts = (url) => {
  const tables = psql(url, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).split('\n').filter(Boolean);
  const q = tables.map((t) => `SELECT '${t}', count(*) FROM "${t}"`).join(' UNION ALL ');
  return Object.fromEntries(psql(url, q).split('\n').map((l) => l.split('|')).map(([t, n]) => [t, Number(n)]));
};
/** Everything a restore must reproduce besides data: structure, RLS, policies, functions, triggers, grants. */
const catalog = (url) => ({
  columns: psql(url, `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`),
  constraints: psql(url, `SELECT conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`),
  indexes: psql(url, `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
  rls: psql(url, `SELECT relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') ORDER BY 1`),
  policies: psql(url, `SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`),
  functions: psql(url, `SELECT proname || ' ' || prosecdef || ' ' || md5(pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f' ORDER BY 1`),
  triggers: psql(url, `SELECT tgrelid::regclass || ' ' || tgname || ' ' || md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
  grants: psql(url, `SELECT table_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee LIKE 'talkivio_app%' ORDER BY 1`),
});
const dropDb = (db) => psql(admin, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);

let api = null;
async function cleanup() {
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    await sleep(500);
  }
  for (const db of [SRC, DST]) dropDb(db);
  for (const d of [srcStorage, dstStorage, work]) rmSync(d, { recursive: true, force: true });
}

try {
  mkdirSync(work, { recursive: true });
  console.log('0. Stage a quiescent production copy');
  for (const db of [SRC, DST]) dropDb(db);
  rmSync(srcStorage, { recursive: true, force: true });
  rmSync(dstStorage, { recursive: true, force: true });
  sh('pg_dump', ['-Fc', '-f', join(work, 'stage.dump'), libpq(ownerUrl)]);
  psql(admin, `CREATE DATABASE "${SRC}"`);
  sh('pg_restore', ['-d', dbUrl(ownerUrl, SRC), '--exit-on-error', join(work, 'stage.dump')]);
  cpSync(devStorage, srcStorage, { recursive: true, filter: (s) => !s.split('/').pop().startsWith('._') });

  console.log('1. Fingerprint production');
  const prodCounts = tableCounts(dbUrl(ownerUrl, SRC));
  const prodObjects = manifest(srcStorage);
  const attachments = psql(dbUrl(ownerUrl, SRC), `SELECT object_key || '|' || coalesce(sha256, '') || '|' || state FROM attachments WHERE sha256 IS NOT NULL AND state = 'clean'`).split('\n').filter(Boolean).map((l) => l.split('|'));
  const prodRows = Object.values(prodCounts).reduce((a, b) => a + b, 0);
  const prodCatalog = catalog(dbUrl(ownerUrl, SRC));
  report.production = { tables: Object.keys(prodCounts).length, rows: prodRows, objects: Object.keys(prodObjects).length, cleanAttachmentsWithHash: attachments.length };
  console.log(`  ${report.production.tables} tables, ${prodRows} rows, ${report.production.objects} objects, ${attachments.length} clean attachments with sha256`);

  console.log('2. Backup');
  let t0 = Date.now();
  const tBackup = new Date();
  sh('pg_dump', ['-Fc', '-f', join(work, 'db.dump'), dbUrl(ownerUrl, SRC)]);
  const dumpMs = ms(t0);
  t0 = Date.now();
  cpSync(srcStorage, join(work, 'objects'), { recursive: true });
  writeFileSync(join(work, 'objects.manifest.json'), JSON.stringify(manifest(join(work, 'objects')), null, 1));
  report.steps.backup = { dumpMs, objectsMs: ms(t0), dumpBytes: statSync(join(work, 'db.dump')).size, at: tBackup.toISOString() };
  check(JSON.stringify(manifest(join(work, 'objects'))) === JSON.stringify(prodObjects), `backup objects verified against production checksums (${Object.keys(prodObjects).length} files)`);

  console.log('3. Sentinel write after the backup, then disaster');
  const sentinel = `drill-sentinel-${randomUUID()}`;
  const anyTenant = psql(dbUrl(ownerUrl, SRC), `SELECT id FROM tenants ORDER BY created_at LIMIT 1`);
  psql(dbUrl(ownerUrl, SRC), `INSERT INTO audit_events (id, tenant_id, actor_type, action, object_type) VALUES (gen_random_uuid(), '${anyTenant}', 'system', '${sentinel}', 'drill')`);
  await sleep(1000);
  const tDisaster = new Date();
  dropDb(SRC);
  rmSync(srcStorage, { recursive: true, force: true });
  report.steps.disaster = { at: tDisaster.toISOString(), backupAgeMs: tDisaster - tBackup };

  console.log('4. Restore (RTO clock running)');
  const rto0 = Date.now();
  t0 = Date.now();
  psql(admin, `CREATE DATABASE "${DST}"`);
  sh('pg_restore', ['-d', dbUrl(ownerUrl, DST), '--exit-on-error', join(work, 'db.dump')]);
  const restoreDbMs = ms(t0);
  // Compare before the ledger replay and the api boot (both legitimately append audit rows).
  const restoredCounts = tableCounts(dbUrl(ownerUrl, DST));
  t0 = Date.now();
  cpSync(join(work, 'objects'), dstStorage, { recursive: true });
  const restoreObjectsMs = ms(t0);
  // Checksums are compared before the ledger replay (it legitimately adds/removes objects).
  const restoredObjects = manifest(dstStorage);
  const env = {
    ...process.env,
    DATABASE_URL: `${dbUrl(appUrl, DST)}?schema=public`,
    DATABASE_OWNER_URL: `${dbUrl(ownerUrl, DST)}?schema=public`,
    REDIS_URL: 'redis://127.0.0.1:6379/10',
    STORAGE_LOCAL_DIR: dstStorage,
    PORT: String(PORT),
    API_URL: `http://localhost:${PORT}`,
    LOG_LEVEL: 'warn',
    SHUTDOWN_DRAIN_DELAY_MS: '0',
  };
  sh('redis-cli', ['-n', '10', 'flushdb']);
  // A workspace deleted AFTER the backup: its ledger entry lives in durable object storage while the
  // restored database still holds the workspace. The replay must destroy it again before traffic.
  const victim = psql(dbUrl(ownerUrl, DST), `SELECT t.id FROM tenants t JOIN chats c ON c.tenant_id = t.id GROUP BY t.id ORDER BY count(*) DESC LIMIT 1`);
  const victimChats = Number(psql(dbUrl(ownerUrl, DST), `SELECT count(*) FROM chats WHERE tenant_id = '${victim}'`));
  mkdirSync(join(dstStorage, 'exports', 'tenant-deletion-ledger'), { recursive: true });
  writeFileSync(join(dstStorage, 'exports', 'tenant-deletion-ledger', `${victim}.json`), JSON.stringify({ kind: 'tenant_deletion', v: 1, tenant_id: victim, slug_hash: null, deletion_job_id: null, recorded_at: new Date().toISOString() }));
  t0 = Date.now();
  const replayOut = sh(process.execPath, ['scripts/replay-tombstones.mjs', '--json'], { cwd: apiDir, env }).trim().split('\n').pop();
  const replay = JSON.parse(replayOut);
  const replayMs = ms(t0);
  check(replay.failures.length === 0, `erasure ledger replayed before traffic (${replay.ledgerEntries} ledger entries, ${replay.visitorsChanged} subjects re-erased, ${replay.failures.length} failures)`);
  const tenantTables = psql(dbUrl(ownerUrl, DST), `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenant_tombstones' ORDER BY 1`).split('\n').filter(Boolean); // the tombstone is the intended remainder
  const leftover = tenantTables.filter((t) => Number(psql(dbUrl(ownerUrl, DST), `SELECT count(*) FROM "${t}" WHERE tenant_id = '${victim}'`)) > 0);
  const victimTomb = psql(dbUrl(ownerUrl, DST), `SELECT (completed_at IS NOT NULL)::text FROM tenant_tombstones WHERE tenant_id = '${victim}'`);
  const victimObjects = files(join(dstStorage, 'clean', 't', victim)).length + files(join(dstStorage, 'quarantine', 't', victim)).length;
  check(
    !!replay.tenantDeletions?.destroyed?.includes(victim) && leftover.length === 0 && victimTomb === 'true' && victimObjects === 0 && victimChats > 0,
    `workspace deleted after the backup was destroyed again before traffic (${victimChats} chats → 0 rows in ${tenantTables.length} tenant tables, objects removed, tombstone completed)${leftover.length ? ` — left in ${leftover.join(', ')}` : ''}`,
  );
  api = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], { cwd: apiDir, env, stdio: 'ignore' });
  for (let i = 0; i < 240; i++) {
    const ok = await fetch(`http://localhost:${PORT}/health/ready`).then((r) => r.status === 200).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  const rtoMs = ms(rto0);
  report.steps.restore = { restoreDbMs, restoreObjectsMs, replayMs, rtoMs };
  check((await fetch(`http://localhost:${PORT}/health/ready`)).status === 200, `restored api ready — RTO ${(rtoMs / 1000).toFixed(1)} s (db ${restoreDbMs} ms, objects ${restoreObjectsMs} ms, ledger replay ${replayMs} ms)`);

  console.log('5. Verify');
  const diffs = Object.keys({ ...prodCounts, ...restoredCounts }).filter((t) => prodCounts[t] !== restoredCounts[t]);
  check(diffs.length === 0, `row counts identical in all ${Object.keys(prodCounts).length} tables right after pg_restore (${prodRows} rows)${diffs.length ? ` — differ: ${diffs.map((t) => `${t} ${prodCounts[t]}→${restoredCounts[t]}`).join(', ')}` : ''}`);
  const objectDiffs = Object.keys({ ...prodObjects, ...restoredObjects }).filter((k) => prodObjects[k] !== restoredObjects[k]);
  check(objectDiffs.length === 0, `object checksums identical (${Object.keys(restoredObjects).length} files)`);
  const bad = attachments.filter(([key, hash]) => {
    const candidates = files(dstStorage).filter((p) => p.endsWith(key));
    return !candidates.some((p) => sha(p) === hash);
  });
  check(bad.length === 0, `every clean attachment row matches its restored file sha256 (${attachments.length} checked)`);
  check(psql(dbUrl(ownerUrl, DST), `SELECT count(*) FROM audit_events WHERE action = '${sentinel}'`) === '0', `RPO honest: the write made ${report.steps.disaster.backupAgeMs} ms after the backup is absent (logical backup RPO = backup age; WAL archiving target ≤ 5 min, deployment.md §8.1)`);
  const restoredCatalog = catalog(dbUrl(ownerUrl, DST));
  const catalogDiffs = Object.keys(prodCatalog).filter((k) => prodCatalog[k] !== restoredCatalog[k]);
  check(catalogDiffs.length === 0, `restored columns, constraints, indexes, RLS flags, ${prodCatalog.policies.split('\n').length} policies, functions, triggers and app-role grants identical to production${catalogDiffs.length ? ` — differ: ${catalogDiffs.join(', ')}` : ''}`);
  const stamp = Date.now();
  const jar = {};
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(`http://localhost:${PORT}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, { method, headers: { 'content-type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(jar.rd_csrf ? { 'x-csrf-token': jar.rd_csrf } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    return { status: r.status, data: (await r.json().catch(() => null))?.data };
  };
  const su = await call('POST', '/auth/signup', { email: `drill+${stamp}@example.com`, password: 'correct horse battery', tenant_name: `Drill ${stamp}`, timezone: 'UTC' });
  const site = await call('POST', '/sites', { name: 'Drill', origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }] });
  await call('PUT', '/agents/me/presence', { status: 'online' });
  check(su.status === 201 && site.status === 201, 'restored system accepts writes (signup, site; sequences and RLS context intact)');

  report.finishedAt = new Date().toISOString();
  const lines = [
    '# Backup / restore drill report',
    '',
    `_Generated by \`apps/api/scripts/backup-drill.mjs\` on ${report.finishedAt} (local workstation, PostgreSQL 16, local object storage). Re-run to refresh._`,
    '',
    '| Measure | Result |',
    '| --- | --- |',
    `| Production snapshot | ${report.production.tables} tables, ${report.production.rows} rows, ${report.production.objects} objects |`,
    `| Backup | pg_dump -Fc ${(report.steps.backup.dumpBytes / 1024 / 1024).toFixed(1)} MiB in ${report.steps.backup.dumpMs} ms; objects copied in ${report.steps.backup.objectsMs} ms with sha256 manifest |`,
    `| Restore | database ${report.steps.restore.restoreDbMs} ms; objects ${report.steps.restore.restoreObjectsMs} ms; erasure-ledger replay ${report.steps.restore.replayMs} ms |`,
    `| **Achieved RTO** (disaster → restored api ready) | **${(report.steps.restore.rtoMs / 1000).toFixed(1)} s** |`,
    `| **Achieved RPO** (logical backup) | **${(report.steps.disaster.backupAgeMs / 1000).toFixed(1)} s** — writes after the last backup are lost (sentinel verified absent). Production uses continuous WAL archiving with a ≤ 5 min target (deployment.md §8.1), not measured here. |`,
    `| Attachment integrity | ${attachments.length} clean attachments: restored file sha256 = stored sha256; all ${report.production.objects} object checksums identical |`,
    '',
    '## Checks',
    ...report.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.msg}`),
    '',
    'Scale caveat: the dataset is the development database, not production volume; restore time grows with data size and WAL replay length. Repeat the drill in staging with production-sized data before sign-off.',
    '',
  ];
  writeFileSync(resolve(repo, 'docs/operations/backup-drill-report.md'), lines.join('\n'));
  console.log(`\nBACKUP DRILL PASSED — RTO ${(report.steps.restore.rtoMs / 1000).toFixed(1)} s, report docs/operations/backup-drill-report.md`);
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error(err.message);
  await cleanup();
  process.exit(1);
}
