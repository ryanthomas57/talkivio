#!/usr/bin/env node
/**
 * PostgreSQL failover and point-in-time-recovery drill (AUD-72-34, DEPLOY03). Local only: throwaway clusters under
 * $TMPDIR on their own ports; the dev database is never touched.
 *
 *   1. Primary: initdb, WAL archiving (archive_timeout 5 s), the Talkivio schema applied with `prisma migrate deploy`.
 *   2. Base backup (for PITR) and a streaming standby built with pg_basebackup.
 *   3. A writer commits one row every 10 ms (autocommit); half way it creates a named restore point.
 *   4. Disaster: the primary is killed (immediate shutdown — no checkpoint, the current WAL segment unarchived).
 *   5. Failover: the standby is promoted. RTO = crash → first committed write on the promoted standby;
 *      RPO = acknowledged writes missing on it (asynchronous replication).
 *   6. PITR to the restore point: base backup + archived WAL, recovery_target_name. Must hold exactly the rows
 *      acknowledged before the restore point — no more, no less.
 *   7. PITR to the end of the archive (no standby): RPO = acknowledged writes after the last archived segment,
 *      bounded by archive_timeout.
 *   8. The Talkivio catalog (tables, forced RLS, policies) is identical on every recovered cluster.
 * Writes docs/operations/failover-drill-report.md. Usage: cd apps/api && node scripts/failover-drill.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(apiDir, '../..');
const work = resolve(process.env.TMPDIR ?? '/tmp', `talkivio-failover-${Date.now()}`);
const archive = resolve(work, 'archive');
const USER = process.env.USER ?? 'postgres';
// macOS: a postmaster started without a valid LC_ALL aborts ("became multithreaded during startup").
process.env.LC_ALL = process.env.LC_ALL || 'C';
const PORTS = { primary: 5545, standby: 5546, pitr: 5547, latest: 5548 };
const DB = 'talkivio_drill';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
const psql = (port, sql, db = DB) => run('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', USER, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const dir = (name) => resolve(work, name);
const started = [];

function conf(name, port, extra = '') {
  writeFileSync(
    resolve(dir(name), 'postgresql.auto.conf'),
    [
      `port = ${port}`,
      "listen_addresses = '127.0.0.1'",
      `unix_socket_directories = '${work}'`,
      'wal_level = replica',
      'max_wal_senders = 5',
      'archive_mode = on',
      `archive_command = 'test ! -f ${archive}/%f && cp %p ${archive}/%f'`,
      'archive_timeout = 5s',
      'fsync = on',
      extra,
    ].join('\n') + '\n',
    { flag: 'a' },
  );
}
async function start(name) {
  run('pg_ctl', ['-D', dir(name), '-l', resolve(work, `${name}.log`), '-w', '-t', '120', 'start']);
  started.push(name);
}
function stop(name, mode = 'fast') {
  try {
    run('pg_ctl', ['-D', dir(name), '-m', mode, '-w', 'stop']);
  } catch {
    /* already down */
  }
}
async function waitFor(pred, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await pred();
      if (v) return v;
    } catch {
      /* not ready */
    }
    await sleep(50);
  }
  throw new Error(`timed out: ${label}`);
}
const catalog = (port) => psql(port, `SELECT (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity) || '/' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') || '/' || (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c')`);

const report = { at: new Date().toISOString(), postgres: run('postgres', ['--version']) };
try {
  mkdirSync(archive, { recursive: true });
  console.log(`[drill] work dir ${work}`);
  // 1. Primary with the real schema.
  run('initdb', ['-D', dir('primary'), '-U', USER, '--auth=trust', '-E', 'UTF8', '--locale=C']);
  conf('primary', PORTS.primary);
  await start('primary');
  run('psql', ['-h', '127.0.0.1', '-p', String(PORTS.primary), '-U', USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(apiDir, 'scripts/db-bootstrap.sql')]);
  psql(PORTS.primary, `CREATE DATABASE ${DB}`, 'postgres');
  const url = `postgresql://${USER}@127.0.0.1:${PORTS.primary}/${DB}?schema=public`;
  const deploy = run(resolve(apiDir, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], { cwd: apiDir, env: { ...process.env, DATABASE_URL: url } });
  report.migrations = (deploy.match(/^Applying migration/gm) ?? []).length || readdirSync(resolve(apiDir, 'prisma/migrations')).filter((d) => /^\d/.test(d)).length;
  psql(PORTS.primary, 'CREATE TABLE drill_writes (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp())');
  report.catalog = catalog(PORTS.primary);
  console.log(`[drill] primary :${PORTS.primary} with ${report.migrations} migrations (tables/forced-RLS/policies/checks ${report.catalog})`);

  // 2. Base backup (PITR) and a streaming standby.
  run('pg_basebackup', ['-h', '127.0.0.1', '-p', String(PORTS.primary), '-U', USER, '-D', dir('base'), '-X', 'stream', '-c', 'fast']);
  run('pg_basebackup', ['-h', '127.0.0.1', '-p', String(PORTS.primary), '-U', USER, '-D', dir('standby'), '-X', 'stream', '-c', 'fast', '-R']);
  conf('standby', PORTS.standby, "archive_mode = off\nhot_standby = on");
  await start('standby');
  await waitFor(() => psql(PORTS.primary, "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'", 'postgres') === '1', 30_000, 'standby streaming');
  console.log(`[drill] base backup taken; standby :${PORTS.standby} streaming`);

  // 3. Writer: one autocommitted INSERT … RETURNING id every 10 ms; a psql line back = an acknowledged commit.
  const writer = spawn('psql', ['-h', '127.0.0.1', '-p', String(PORTS.primary), '-U', USER, '-d', DB, '-At', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const acks = [];
  let restorePointAck = null;
  let buf = '';
  writer.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (/^\d+$/.test(line)) acks.push(Number(line));
      else if (/^[0-9A-F]+\/[0-9A-F]+$/.test(line)) restorePointAck = acks.at(-1) ?? 0;
    }
  });
  writer.stderr.on('data', () => {});
  writer.stdin.on('error', () => {});
  let writing = true;
  const tick = setInterval(() => writing && writer.stdin.write('INSERT INTO drill_writes DEFAULT VALUES RETURNING id;\n'), 10);
  await sleep(3000);
  writer.stdin.write("SELECT pg_create_restore_point('talkivio_drill');\n");
  await waitFor(() => restorePointAck !== null, 5000, 'restore point');
  await sleep(3000);

  // 4. Disaster.
  const tCrash = Date.now();
  stop('primary', 'immediate');
  writing = false;
  clearInterval(tick);
  // Commits the server acknowledged before it died may still sit in the pipe: drain them before counting.
  await sleep(300);
  writer.kill();
  const lastAckBeforeCrash = acks.at(-1);
  report.writes = { acknowledged: acks.length, last_ack: lastAckBeforeCrash, restore_point_after: restorePointAck };
  console.log(`[drill] primary killed after ${acks.length} acknowledged writes (restore point after #${restorePointAck})`);

  // 5. Failover: promote the standby.
  run('pg_ctl', ['-D', dir('standby'), '-w', 'promote']);
  await waitFor(() => psql(PORTS.standby, 'SELECT NOT pg_is_in_recovery()') === 't', 30_000, 'promotion');
  const firstWrite = psql(PORTS.standby, 'INSERT INTO drill_writes DEFAULT VALUES RETURNING id').split('\n')[0]; // psql also prints the command tag
  const tReady = Date.now();
  // The probe row is excluded: after promotion the sequence resumes from its last WAL-logged value, which can be
  // at or below the last acknowledged id.
  const onStandby = Number(psql(PORTS.standby, `SELECT count(*) FROM drill_writes WHERE id <= ${lastAckBeforeCrash} AND id <> ${Number(firstWrite)}`));
  const lostOnFailover = acks.filter((id) => id <= lastAckBeforeCrash).length - onStandby;
  report.failover = { rto_ms: tReady - tCrash, lost_acknowledged_writes: lostOnFailover, rpo_ms_upper_bound: lostOnFailover * 10, first_write_id: Number(firstWrite), catalog: catalog(PORTS.standby) };
  console.log(`[drill] failover: standby promoted and writing ${report.failover.rto_ms} ms after the crash; ${lostOnFailover} acknowledged writes lost`);
  stop('standby');

  // 6. PITR to the named restore point.
  const pitr = async (name, port, target) => {
    cpSync(dir('base'), dir(name), { recursive: true });
    chmodSync(dir(name), 0o700); // PostgreSQL refuses a data directory readable by others
    conf(name, port, [`restore_command = 'cp ${archive}/%f %p'`, target, "recovery_target_action = 'promote'", 'archive_mode = off'].filter(Boolean).join('\n'));
    writeFileSync(resolve(dir(name), 'recovery.signal'), '');
    const t0 = Date.now();
    await start(name);
    await waitFor(() => psql(port, 'SELECT NOT pg_is_in_recovery()') === 't', 120_000, `${name} recovery`);
    // Recovered rows are read before the probe write (whose id may fall inside the acknowledged range).
    const max = Number(psql(port, `SELECT coalesce(max(id), 0) FROM drill_writes WHERE id <= ${lastAckBeforeCrash}`));
    const count = Number(psql(port, `SELECT count(*) FROM drill_writes WHERE id <= ${lastAckBeforeCrash}`));
    psql(port, 'INSERT INTO drill_writes DEFAULT VALUES');
    return { ms: Date.now() - t0, max, count, catalog: catalog(port) };
  };
  const rp = await pitr('pitr', PORTS.pitr, "recovery_target_name = 'talkivio_drill'");
  const expectedAtRp = acks.filter((id) => id <= restorePointAck).length;
  report.pitr_restore_point = { ...rp, expected_rows: expectedAtRp, exact: rp.count === expectedAtRp && rp.max === restorePointAck };
  console.log(`[drill] PITR to the restore point: ${rp.count} rows (expected ${expectedAtRp}, exact ${report.pitr_restore_point.exact}) in ${rp.ms} ms`);
  stop('pitr');

  // 7. PITR to the end of the archive (the standby is gone too).
  const latest = await pitr('latest', PORTS.latest, '');
  const lostLatest = acks.length - latest.count;
  report.pitr_latest = { ...latest, lost_acknowledged_writes: lostLatest, rpo_ms_upper_bound: lostLatest * 10 };
  console.log(`[drill] PITR to the end of the archive: ${latest.count} of ${acks.length} acknowledged rows (${lostLatest} lost ≈ ${lostLatest * 10} ms, archive_timeout 5 s) in ${latest.ms} ms`);
  stop('latest');

  const same = [report.failover.catalog, report.pitr_restore_point.catalog, report.pitr_latest.catalog].every((c) => c === report.catalog);
  report.catalog_identical = same;
  const pass = report.pitr_restore_point.exact && same && report.failover.lost_acknowledged_writes >= 0 && report.pitr_latest.rpo_ms_upper_bound <= 5_000 + 1_000;
  report.passed = pass;

  const md = `# Failover and point-in-time-recovery drill

_Generated by \`apps/api/scripts/failover-drill.mjs\` on ${report.at} — throwaway PostgreSQL clusters on one laptop
(${report.postgres}); the Talkivio schema (${report.migrations} migrations; tables / forced-RLS tables / policies / CHECK
constraints = ${report.catalog}) with a writer committing one row every 10 ms. Local timings, not production scale._

| Scenario | Achieved RTO | Achieved RPO | Result |
| --- | --- | --- | --- |
| Primary killed (immediate shutdown), streaming standby promoted | ${report.failover.rto_ms} ms crash → first write on the promoted standby | ${report.failover.lost_acknowledged_writes} acknowledged writes lost (≤ ${report.failover.rpo_ms_upper_bound} ms, asynchronous replication) | catalog ${report.failover.catalog === report.catalog ? 'identical' : 'DIFFERENT'} |
| Restore base backup + archived WAL to a named restore point | ${report.pitr_restore_point.ms} ms restore start → writable | 0 — exactly the ${report.pitr_restore_point.expected_rows} rows committed before the restore point | ${report.pitr_restore_point.exact ? 'exact' : 'NOT EXACT'} |
| Restore base backup + archived WAL to the end of the archive (primary and standby lost) | ${report.pitr_latest.ms} ms | ${report.pitr_latest.lost_acknowledged_writes} acknowledged writes lost (≈ ${report.pitr_latest.rpo_ms_upper_bound} ms; bounded by \`archive_timeout\` = 5 s) | catalog ${report.pitr_latest.catalog === report.catalog ? 'identical' : 'DIFFERENT'} |

Writes acknowledged before the crash: ${report.writes.acknowledged}; restore point placed after write #${report.writes.restore_point_after}.

What this shows: promotion of an asynchronous streaming standby loses at most the writes still in flight (measured
above); PITR reproduces an exact point (named restore point or timestamp) from a base backup and the WAL archive;
without a standby, the RPO is the WAL not yet archived — bounded by \`archive_timeout\` (production: 60 s or a
continuous \`pg_receivewal\`/managed-service archive). Production-scale timing (database size, network, managed
failover) still has to be measured in staging (DEPLOY03; procedure: docs/operations/deployment.md §8).

Result: **${pass ? 'PASS' : 'FAIL'}**.
`;
  writeFileSync(resolve(repo, 'docs/operations/failover-drill-report.md'), md);
  writeFileSync(resolve(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[drill] ${pass ? 'PASS' : 'FAIL'} — docs/operations/failover-drill-report.md`);
  process.exitCode = pass ? 0 : 1;
} catch (err) {
  console.error(`[drill] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  for (const n of ['primary', 'standby', 'pitr', 'latest']) if (existsSync(resolve(dir(n), 'postmaster.pid'))) stop(n, 'immediate');
  if (!process.env.KEEP_DRILL) rmSync(work, { recursive: true, force: true });
}
