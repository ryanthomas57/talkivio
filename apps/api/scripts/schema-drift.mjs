#!/usr/bin/env node
/**
 * Schema drift gate (release audit AUD-72-03 / AUD-72-30, ADR 0002).
 *
 *   1. Creates a throwaway database and applies every migration from empty with
 *      `prisma migrate deploy` (the same command production uses).
 *   2. Diffs that database against prisma/schema.prisma. The only difference allowed is the
 *      tenant-consistency foreign keys migrations add in SQL (named `*_fk`; Prisma's own are
 *      `*_fkey`) which the datamodel deliberately does not model. Anything else fails.
 *   3. Optionally (--compare-url / DRIFT_COMPARE_URL) compares a live database with the fresh
 *      one: Prisma's structural diff must be empty and the catalog objects Prisma cannot see —
 *      RLS flags, policies, CHECK constraints, functions, triggers and application-role grants — must match.
 *   4. Bounded text (ch. 48, AUD-72-01): every text column of the fresh database has a length bound — a varchar(n)
 *      type or a CHECK constraint on that column. A new unbounded column fails the gate.
 *
 * Usage:
 *   DATABASE_OWNER_URL=postgresql://owner@host/db?schema=public node scripts/schema-drift.mjs
 *     [--compare-url <url>] [--report <dir>] [--keep] [--emit <migration_name>]
 *
 *   DRIFT_ADMIN_URL   connection allowed to CREATE/DROP DATABASE (default: DATABASE_OWNER_URL);
 *                     when it is a different role the database is created OWNER <owner role>.
 *   --emit <name>     instead of failing on drift, write the unexpected statements as a new
 *                     migration (prisma/migrations/<date><seq>_<name>/migration.sql) for review.
 *                     Use this instead of `prisma migrate dev`, which would also drop the
 *                     tenant foreign keys.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaBin = resolve(apiDir, 'node_modules/.bin/prisma');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error('DATABASE_OWNER_URL is required (the migration owner connection).');
  process.exit(2);
}
const adminUrl = process.env.DRIFT_ADMIN_URL || ownerUrl;
const compareUrl = option('--compare-url') || process.env.DRIFT_COMPARE_URL || '';
const reportDir = option('--report');
const emitName = option('--emit');
if (emitName !== undefined && !/^[a-z0-9_]{3,60}$/.test(emitName)) {
  console.error('--emit needs a snake_case migration name (3-60 chars).');
  process.exit(2);
}

const libpq = (url) => url.replace(/\?.*$/, '');
const owner = new URL(ownerUrl);
const admin = new URL(adminUrl);
const tempDb = `talkivio_drift_${randomBytes(4).toString('hex')}`;
const tempUrl = new URL(ownerUrl);
tempUrl.pathname = `/${tempDb}`;

const quoteIdent = (s) => `"${s.replaceAll('"', '""')}"`;
function psql(url, sql) {
  return execFileSync('psql', [libpq(url), '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const rows = (url, sql) =>
  psql(url, sql)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));

function prisma(argv, env = {}) {
  const r = spawnSync(prismaBin, argv, {
    cwd: apiDir,
    encoding: 'utf8',
    env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', ...env },
  });
  if (r.status !== 0) throw new Error(`prisma ${argv.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** Splits `prisma migrate diff --script` output into statements (comments dropped). */
function statements(script) {
  return script
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean);
}

/** Catalog objects `prisma migrate diff` does not compare. Each entry is a sorted list of rows. */
function catalogFingerprint(url) {
  return {
    rls: rows(
      url,
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1`,
    ).map((r) => r.join(' ')),
    policies: rows(
      url,
      `SELECT tablename, policyname, permissive, roles::text, cmd, coalesce(qual,''), coalesce(with_check,'')
         FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`,
    ).map((r) => r.join(' | ')),
    checks: rows(
      url,
      `SELECT conrelid::regclass::text, conname, md5(pg_get_constraintdef(oid)) FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype = 'c' ORDER BY 1, 2`,
    ).map((r) => r.join(' ')),
    functions: rows(
      url,
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.prosecdef,
              md5(pg_get_functiondef(p.oid))
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ORDER BY 1`,
    ).map((r) => r.join(' ')),
    triggers: rows(
      url,
      `SELECT tgrelid::regclass::text, tgname, md5(pg_get_triggerdef(oid)) FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
        ORDER BY 1, 2`,
    ).map((r) => r.join(' ')),
    grants: rows(
      url,
      `SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee LIKE 'talkivio_app%'
        GROUP BY 1, 2 ORDER BY 1, 2`,
    ).map((r) => r.join(' ')),
  };
}

function setDiff(a, b) {
  const sb = new Set(b);
  return a.filter((x) => !sb.has(x));
}

function nextMigrationDir(name) {
  const dir = resolve(apiDir, 'prisma/migrations');
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let seq = 0;
  for (const d of readdirSync(dir)) {
    const m = /^(\d{8})(\d{6})_/.exec(d);
    if (m) seq = Math.max(seq, Number(m[2]));
  }
  return resolve(dir, `${today}${String(seq + 1).padStart(6, '0')}_${name}`);
}

const result = {
  generated_at: new Date().toISOString(),
  migrations_applied: 0,
  fresh_database: {},
  datamodel_diff: { allowed: 0, unexpected: [] },
  compare: null,
  passed: false,
};

const createSql =
  `CREATE DATABASE ${quoteIdent(tempDb)}` +
  (decodeURIComponent(admin.username) !== decodeURIComponent(owner.username)
    ? ` OWNER ${quoteIdent(decodeURIComponent(owner.username))}`
    : '');

let exitCode = 1;
try {
  psql(adminUrl, createSql);
  console.log(`[drift] created ${tempDb}`);

  // 1. Migrations from empty.
  const deployOut = prisma(['migrate', 'deploy'], { DATABASE_URL: tempUrl.toString() });
  result.migrations_applied = (deployOut.match(/^Applying migration/gm) ?? []).length;
  const [[tables, rlsTables, forcedTables, policies, fks]] = rows(
    tempUrl.toString(),
    `SELECT
       (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
       (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity),
       (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity),
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
       (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f')`,
  );
  result.fresh_database = {
    tables: Number(tables),
    rls_tables: Number(rlsTables),
    forced_rls_tables: Number(forcedTables),
    policies: Number(policies),
    foreign_keys: Number(fks),
  };
  console.log(
    `[drift] applied ${result.migrations_applied} migrations from empty: ${tables} tables, ${rlsTables} with RLS (${forcedTables} forced), ${policies} policies, ${fks} foreign keys`,
  );

  // Bounded text: every text column needs a varchar(n) type or a CHECK constraint on that very column.
  result.unbounded_text_columns = rows(
    tempUrl.toString(),
    `SELECT c.relname || '.' || a.attname
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.atttypid = 'text'::regtype OR (a.atttypid = 'varchar'::regtype AND a.atttypmod < 0))
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c' AND a.attnum = ANY (k.conkey))
      ORDER BY 1`,
  ).map((r) => r[0]);
  console.log(`[drift] text columns without a length bound: ${result.unbounded_text_columns.length}`);
  for (const col of result.unbounded_text_columns) console.log(`  ✗ ${col}`);

  // 2. Fresh database vs datamodel.
  const sqlFks = new Set(
    rows(
      tempUrl.toString(),
      `SELECT conrelid::regclass::text || '.' || conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype = 'f' AND conname LIKE '%\\_fk'`,
    ).map((r) => r[0].replaceAll('"', '')),
  );
  const diffScript = prisma([
    'migrate',
    'diff',
    '--from-url',
    tempUrl.toString(),
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ]);
  for (const stmt of statements(diffScript)) {
    const m = /^ALTER TABLE "([^"]+)" DROP CONSTRAINT "([^"]+)"$/.exec(stmt);
    if (m && sqlFks.has(`${m[1]}.${m[2]}`)) result.datamodel_diff.allowed += 1;
    else result.datamodel_diff.unexpected.push(stmt);
  }
  console.log(
    `[drift] datamodel diff: ${result.datamodel_diff.allowed} SQL-only tenant foreign keys (expected, ${sqlFks.size} defined), ${result.datamodel_diff.unexpected.length} unexpected statements`,
  );
  for (const s of result.datamodel_diff.unexpected) console.log(`  ✗ ${s.split('\n')[0]}`);

  if (emitName && result.datamodel_diff.unexpected.length > 0) {
    const dir = nextMigrationDir(emitName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'migration.sql'),
      `-- Generated by scripts/schema-drift.mjs --emit (SQL-only tenant foreign keys excluded). Review before committing.\n${result.datamodel_diff.unexpected.map((s) => `${s};`).join('\n\n')}\n`,
    );
    console.log(`[drift] wrote ${dir}/migration.sql — review it, then rerun the gate`);
  }

  // 3. Live database vs fresh migrations.
  if (compareUrl) {
    const structural = statements(
      prisma(['migrate', 'diff', '--from-url', tempUrl.toString(), '--to-url', compareUrl, '--script']),
    );
    const fresh = catalogFingerprint(tempUrl.toString());
    const live = catalogFingerprint(compareUrl);
    const catalog = {};
    for (const key of Object.keys(fresh)) {
      const missing = setDiff(fresh[key], live[key]);
      const extra = setDiff(live[key], fresh[key]);
      if (missing.length || extra.length) catalog[key] = { missing_in_live: missing, extra_in_live: extra };
    }
    result.compare = {
      database: libpq(compareUrl).replace(/\/\/[^@]*@/, '//***@'),
      structural_statements: structural,
      catalog_differences: catalog,
      counts: Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.length])),
    };
    console.log(
      `[drift] live database ${result.compare.database}: ${structural.length} structural differences, catalog differences in [${Object.keys(catalog).join(', ') || 'none'}] (compared ${Object.entries(result.compare.counts).map(([k, v]) => `${v} ${k}`).join(', ')})`,
    );
    for (const s of structural) console.log(`  ✗ ${s.split('\n')[0]}`);
    for (const [k, v] of Object.entries(catalog)) {
      for (const x of v.missing_in_live) console.log(`  ✗ ${k} missing in live: ${x}`);
      for (const x of v.extra_in_live) console.log(`  ✗ ${k} only in live: ${x}`);
    }
  }

  result.passed =
    result.datamodel_diff.unexpected.length === 0 &&
    result.unbounded_text_columns.length === 0 &&
    (!result.compare ||
      (result.compare.structural_statements.length === 0 &&
        Object.keys(result.compare.catalog_differences).length === 0));
  exitCode = result.passed || (emitName && result.datamodel_diff.unexpected.length > 0) ? 0 : 1;
  console.log(result.passed ? '[drift] PASS' : '[drift] FAIL');
} catch (err) {
  console.error(`[drift] error: ${err.message}`);
  result.error = err.message;
  exitCode = 1;
} finally {
  if (flag('--keep')) console.log(`[drift] kept ${tempDb}`);
  else {
    try {
      psql(adminUrl, `DROP DATABASE IF EXISTS ${quoteIdent(tempDb)} WITH (FORCE)`);
    } catch (err) {
      console.error(`[drift] could not drop ${tempDb}: ${err.message}`);
    }
  }
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(resolve(reportDir, 'schema-drift.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
}
process.exit(exitCode);
