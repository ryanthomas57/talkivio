#!/usr/bin/env node
// Re-apply recorded privacy erasures after restoring a database backup (ch. 53, PRIV02).
// Run BEFORE the restored environment accepts traffic. Idempotent: a second run changes nothing.
//
// Reads the external erasure ledger (object storage, outside the database backup scope)
// plus any `subject_tombstones` rows, matches subjects by pseudonymous hash, re-runs the
// erasure steps without emitting events, and restores missing tombstone rows. Then replays the
// workspace-deletion ledger: a workspace deleted after the backup was taken is destroyed again.
//
// Usage (env: DATABASE_URL, REDIS_URL, APP_SECRET and storage settings of the restored environment):
//   node scripts/replay-tombstones.mjs [--build-dir dist] [--tenant <uuid>] [--source ledger|db|both] [--dry-run] [--json]
// Exit codes: 0 ok, 1 error, 2 completed with unconfirmed targets.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const flag = (name) => args.includes(`--${name}`);

const buildDir = resolve(process.cwd(), opt('build-dir', resolve(here, '../dist')));
const tenantId = opt('tenant');
const source = opt('source', 'both');
if (!['ledger', 'db', 'both'].includes(source)) throw new Error('--source must be ledger, db or both');
if (tenantId && !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('--tenant must be a UUID');
if (!existsSync(resolve(buildDir, 'modules.js'))) {
  console.error(
    `No compiled API found in ${buildDir}. Build first (tsc -p tsconfig.build.json --outDir <dir>) and pass --build-dir.`,
  );
  process.exit(1);
}

// Never start queue workers or the outbox publisher from this process.
process.env.TALKIVIO_PROCESS = 'replay';
const require = createRequire(resolve(buildDir, 'modules.js'));
require(resolve(buildDir, 'config/load-env.js'));
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { WorkerModule } = require(resolve(buildDir, 'modules.js'));
const { TombstoneService } = require(resolve(buildDir, 'features/privacy/tombstones.service.js'));
const { TenantDestroyer } = require(resolve(buildDir, 'features/tenant-deletion/tenant-destroyer.js'));

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
let code = 0;
try {
  const report = await app
    .get(TombstoneService)
    .replay({ tenantId: tenantId ?? undefined, dryRun: flag('dry-run'), source });
  // Whole-workspace deletions (external ledger): destroy any workspace the restore brought back.
  report.tenantDeletions = await app.get(TenantDestroyer).replayLedger({ dryRun: flag('dry-run'), tenantId: tenantId ?? undefined });
  report.failures.push(...report.tenantDeletions.failures);
  if (flag('json')) console.log(JSON.stringify(report));
  else {
    console.log(
      `Tombstone replay${report.dryRun ? ' (dry run)' : ''}: ${report.ledgerEntries} ledger entries, ${report.dbTombstones} DB tombstones, ${report.tenants} tenants`,
    );
    console.log(
      `  visitors matched ${report.visitorsMatched}, changed ${report.visitorsChanged}; offline submissions erased ${report.offlineSubmissionsErased}; tombstones restored ${report.tombstonesRestored}`,
    );
    for (const [k, n] of Object.entries(report.counts)) console.log(`  ${k}: ${n}`);
    const td = report.tenantDeletions;
    console.log(`  workspace deletions: ${td.entries} ledger entries, ${td.resurrected.length} restored by the backup, ${td.destroyed.length} destroyed again`);
    if (report.failures.length) console.log(`  UNCONFIRMED: ${report.failures.join(', ')}`);
  }
  if (report.failures.length) code = 2;
} catch (err) {
  console.error(`Replay failed: ${err.message}`);
  code = 1;
} finally {
  await app.close();
}
process.exit(code);
