import { Prisma } from '@prisma/client';
import type { Tx } from './tenant-db';

/** Tables whose rows carry an optimistic `version` checked by update commands. */
const LOCKABLE = new Set(['tenants', 'memberships', 'departments', 'sites', 'schedules', 'custom_field_definitions', 'visitors', 'offline_submissions', 'webhook_endpoints', 'canned_replies', 'triggers']);

/**
 * Take a row lock before an optimistic version check. Without it two concurrent
 * commands carrying the same `expected_version` both pass a read-then-update check
 * and the later write silently overwrites the earlier one; with it the second
 * command waits, re-reads the bumped version and gets VERSION_CONFLICT (ch. 40).
 * `tenants` rows are keyed by `id` only.
 */
export async function lockForUpdate(tx: Tx, table: string, tenantId: string, id: string): Promise<void> {
  if (!LOCKABLE.has(table)) throw new Error(`lockForUpdate: table ${table} is not lockable`);
  if (table === 'tenants') {
    await tx.$queryRaw`SELECT 1 FROM tenants WHERE id = ${id}::uuid FOR UPDATE`;
    return;
  }
  await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
}
