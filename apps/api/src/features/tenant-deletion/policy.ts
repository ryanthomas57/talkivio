/**
 * Tenant deletion policy (ch. 41 `POST /tenants/current/deletion-requests`, ch. 34 "tenant cascade
 * through owned data only in approved destruction job", ch. 53/54). Pure helpers shared by the
 * request service, the worker and unit tests.
 */
import type { JobState } from '@prisma/client';
import { hmacSha256 } from '../../common/crypto';
import { ROLE_EXPORT_LIMITS } from '../exports/exports.service';

export const TENANT_DELETION_KIND = 'tenant_deletion';
/** Dedupe key of the one active request per tenant (UNIQUE(tenant_id, kind, dedupe_key)). */
export const ACTIVE_DEDUPE_KEY = 'active';
/** A cancelled request releases the active key so the owner can request again later. */
export const cancelledDedupeKey = (jobId: string) => `cancelled:${jobId}`;
export const TIMER_NAME = 'tenant-deletion.run';
/** The workspace archive reuses the owner's bulk-export ceiling (newest chats first). */
export const ARCHIVE_CHAT_LIMIT = ROLE_EXPORT_LIMITS.owner.maxChats;

/** Durable request parameters (jobs.payload; never returned by any API). */
export interface DeletionPayload {
  destroy_after: string;
  window_seconds: number;
  export_id: string;
  export_job_id: string;
  total_chats: number;
  archived_chats: number;
  chat_limit: number;
}

export type DeletionState = 'scheduled' | 'running' | 'cancelled' | 'failed';

export function requestState(state: JobState): DeletionState {
  switch (state) {
    case 'queued':
      return 'scheduled';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      // `succeeded` is never observable: the job row is removed with the tenant.
      return 'running';
  }
}

/** Keyed hash of the slug for the tombstone: lets operators recognise a workspace without storing its name. */
export function slugHash(slug: string, appSecret: string): string {
  return hmacSha256(`tenant-tombstone:${appSecret}`, slug.toLowerCase());
}

export const ARCHIVE_SCOPE = {
  contents:
    'JSON transcripts (talkivio.transcript v1) of the newest chats: public messages, internal notes, system events, participants, rating, and attachment names and sizes.',
  excludes: [
    'attachment file contents',
    'visitor profiles, sessions and page history',
    'offline messages',
    'analytics and reports',
    'settings, sites, departments, triggers and shortcuts',
    'team members and the audit log',
  ],
} as const;

export const DELETION_POLICY = {
  destroys: [
    'every database row owned by the workspace (chats, messages, visitors, sessions, offline messages, settings, sites, departments, triggers, shortcuts, analytics facts, webhooks, tokens, jobs, exports and the workspace audit log)',
    'team memberships in this workspace',
    'stored files: attachments, quarantined uploads and export artifacts',
    'signed-in sessions whose active workspace is this one, and live sockets',
    'Redis presence and live-monitoring state, and queued background jobs',
    'outbound email records and pending invitation/verification tokens of this workspace',
  ],
  retains: [
    'user accounts: sign-in identities are global and may belong to other workspaces; only memberships are removed',
    'a tombstone with the workspace id, a keyed hash of its slug, timestamps and counts (no personal data)',
    'pseudonymous privacy-erasure ledger entries, so erasures can still be replayed if an older backup is restored',
  ],
} as const;

export function deletionPolicy(windowSeconds: number, cancellable: boolean) {
  return { windowSeconds, cancellable, destroys: [...DELETION_POLICY.destroys], retains: [...DELETION_POLICY.retains] };
}

/**
 * High-volume tables emptied in bounded batches (each its own short transaction) before the
 * final transaction. Every entry is only ever a child in RESTRICT relations, so deleting it early
 * cannot violate a foreign key; `batchableTables` re-checks this against the live catalog.
 */
export const BATCHED_TABLES = [
  'messages',
  'page_events',
  'outbox_events',
  'trigger_effects',
  'trigger_runs',
  'webhook_deliveries',
  'assignment_history',
  'metric_chat_facts',
  'notifications',
  'chats',
  'visitor_sessions',
  'visitors',
] as const;

/**
 * Batched tables present in this database that are safe to empty early: a table referenced by a
 * RESTRICT / NO ACTION foreign key must not be deleted in a transaction of its own before its
 * referencing rows, so it is left to the final cascade instead.
 */
export function batchableTables(present: ReadonlySet<string>, restrictParents: ReadonlySet<string>): string[] {
  return BATCHED_TABLES.filter((t) => present.has(t) && !restrictParents.has(t));
}

/** Redis sets that register tenant ids for presence / live-monitor sweeps. */
export const TENANT_REGISTRY_SETS = ['pa:tenants', 'pv:tenants', 'vm:dirty:tenants', 'vm:sig:tenants'] as const;

/** Keys the destroyer deletes by name: every tenant-scoped key embeds the tenant id; BullMQ keys (`rd:`) are removed through the queue API instead. */
export function isTenantRedisKey(key: string, tenantId: string): boolean {
  return key.includes(tenantId) && !key.startsWith('rd:');
}

export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
