/**
 * Worker job status (ch. 45 `GET /jobs/{id}`) and tenant deletion requests
 * (ch. 41 `/tenants/current/deletion-requests`).
 */
import { z } from 'zod';
import { DateTime, Uuid } from './common.ts';

// ───────── Jobs ─────────
/** Public worker status of a job. Never carries the job payload or result. */
export const JobStatusSchema = z.object({
  id: Uuid,
  kind: z.string(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: z.number().int().nullable(),
  attempts: z.number().int(),
  runAfter: DateTime,
  completedAt: DateTime.nullable(),
  createdAt: DateTime,
  lastErrorCode: z.string().nullable(),
});

// ───────── Tenant deletion ─────────
/** Owner-downloadable transcript archive started with a deletion request (download via `GET /exports/{id}/download`). */
export const WorkspaceArchiveSchema = z.object({
  id: Uuid,
  state: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  format: z.literal('json'),
  contents: z.string(),
  excludes: z.array(z.string()),
  includesInternalNotes: z.boolean(),
  /** Chats in the archive (newest first up to `chatLimit`). */
  chatCount: z.number().int(),
  totalChats: z.number().int(),
  chatLimit: z.number().int(),
  truncated: z.boolean(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  expiresAt: DateTime,
  downloadPath: z.string(),
});

export const TenantDeletionPolicySchema = z.object({
  windowSeconds: z.number().int(),
  cancellable: z.boolean(),
  destroys: z.array(z.string()),
  retains: z.array(z.string()),
});

export const TenantDeletionRequestSchema = z.object({
  id: Uuid,
  state: z.enum(['scheduled', 'running', 'cancelled', 'failed']),
  requestedAt: DateTime,
  /** Membership id of the requesting owner. */
  requestedBy: Uuid.nullable(),
  destroyAfter: DateTime,
  cancelBefore: DateTime,
  cancelledAt: DateTime.nullable(),
  policy: TenantDeletionPolicySchema,
  /** Null for members other than owners and admins. */
  export: WorkspaceArchiveSchema.nullable(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type WorkspaceArchive = z.infer<typeof WorkspaceArchiveSchema>;
export type TenantDeletionRequest = z.infer<typeof TenantDeletionRequestSchema>;
