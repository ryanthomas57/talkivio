import { describe, expect, it } from 'vitest';
import { productionRefusals, tenantDeletionGraceSeconds } from '../../config/env';
import { BATCHED_TABLES, batchableTables, isTenantRedisKey, requestState, slugHash } from './policy';

/** Tables referenced by RESTRICT foreign keys in migrations 0001–0006 (pg_constraint confdeltype 'r', excluding self references). */
const RESTRICT_PARENTS = new Set(['departments', 'schedules', 'sites', 'tags', 'users']);

describe('batchableTables', () => {
  it('batches only tables that exist and are never the referenced side of a RESTRICT FK', () => {
    const present = new Set(['messages', 'chats', 'visitors', 'visitor_sessions', 'page_events']);
    expect(batchableTables(present, RESTRICT_PARENTS)).toEqual(['messages', 'page_events', 'chats', 'visitor_sessions', 'visitors']);
    expect(batchableTables(present, new Set([...RESTRICT_PARENTS, 'chats']))).not.toContain('chats');
    for (const t of BATCHED_TABLES) expect(RESTRICT_PARENTS.has(t)).toBe(false);
  });
});

describe('tenant deletion policy', () => {
  it('maps job states to request states', () => {
    expect(requestState('queued')).toBe('scheduled');
    expect(requestState('running')).toBe('running');
    expect(requestState('cancelled')).toBe('cancelled');
    expect(requestState('failed')).toBe('failed');
  });

  it('hashes the slug with the deployment secret (no plain slug in the tombstone)', () => {
    const h = slugHash('Acme-Support', 'x'.repeat(32));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(slugHash('acme-support', 'x'.repeat(32)));
    expect(h).not.toBe(slugHash('acme-support', 'y'.repeat(32)));
  });

  it('selects tenant Redis keys but leaves BullMQ internals to the queue API', () => {
    const t = '6f1c2a54-7a51-4e0e-9a43-0d6f3f1d2b11';
    expect(isTenantRedisKey(`vm:sig:${t}`, t)).toBe(true);
    expect(isTenantRedisKey(`pv:state:${t}:v1`, t)).toBe(true);
    expect(isTenantRedisKey(`rd:timers:${t}`, t)).toBe(false);
    expect(isTenantRedisKey('vm:sig:other', t)).toBe(false);
  });

  it('uses the configured window, the seconds override only outside production, and refuses the override in production', () => {
    expect(tenantDeletionGraceSeconds({ NODE_ENV: 'development', TENANT_DELETION_GRACE_DAYS: 14, TENANT_DELETION_GRACE_SECONDS: undefined })).toBe(14 * 86_400);
    expect(tenantDeletionGraceSeconds({ NODE_ENV: 'test', TENANT_DELETION_GRACE_DAYS: 14, TENANT_DELETION_GRACE_SECONDS: 5 })).toBe(5);
    expect(tenantDeletionGraceSeconds({ NODE_ENV: 'production', TENANT_DELETION_GRACE_DAYS: 2, TENANT_DELETION_GRACE_SECONDS: 5 })).toBe(2 * 86_400);
    expect(productionRefusals({ NODE_ENV: 'production', EMAIL_PROVIDER: 'smtp', SCAN_MODE: 'clamav', TENANT_DELETION_GRACE_SECONDS: 5 })).toEqual([expect.stringContaining('TENANT_DELETION_GRACE_SECONDS')]);
    expect(productionRefusals({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp', SCAN_MODE: 'clamav', TENANT_DELETION_GRACE_SECONDS: 5 })).toEqual([]);
  });
});
