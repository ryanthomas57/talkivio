/** Attachments, exports and transcript e-mail jobs (ch. 44/46). */
import { z } from 'zod';
import { DateTime, Uuid } from './common.ts';

export const AttachmentStateSchema = z.enum(['initiated', 'uploading', 'uploaded', 'scanning', 'clean', 'rejected', 'expired']);

export const AttachmentSchema = z.object({
  id: Uuid,
  chatId: Uuid.nullable(),
  name: z.string(),
  sizeBytes: z.number().int(),
  mime: z.string(),
  state: AttachmentStateSchema,
  isImage: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  sha256: z.string().nullable(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

/** Upload descriptor: PUT the bytes to `url` with exactly `headers`, then finalize. */
export const UploadInitSchema = z.object({
  uploadId: Uuid,
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string()),
  expiresAt: DateTime,
  maxBytes: z.number().int(),
  attachment: AttachmentSchema,
});

export const AttachmentDownloadGrantSchema = z.object({ url: z.string(), method: z.literal('GET'), expiresAt: DateTime, name: z.string(), sizeBytes: z.number().int(), mime: z.string() });

/** Transcript export job (staff `POST /exports`, public `POST /widget/v1/chats/{id}/exports`). */
export const ExportSchema = z.object({
  id: Uuid,
  state: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  format: z.enum(['csv', 'txt', 'json', 'pdf']),
  timezone: z.string(),
  includeInternal: z.boolean(),
  progress: z.number(),
  itemCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  expiresAt: DateTime,
  createdAt: DateTime,
  completedAt: DateTime.nullable(),
  errorCode: z.string().nullable(),
});

export const ExportPreviewSchema = z.object({ reason: z.string().optional(), count: z.number().int(), limit: z.number().int(), maxRangeDays: z.number().int(), allowed: z.boolean() });

export const TranscriptEmailJobSchema = z.object({
  id: Uuid,
  chatId: Uuid,
  state: z.string(),
  format: z.enum(['txt', 'pdf']),
  recipientKind: z.enum(['visitor', 'self']),
  includeInternal: z.boolean(),
  acceptedAt: DateTime.nullable(),
  deliveredAt: DateTime.nullable(),
  duplicate: z.boolean(),
  createdAt: DateTime,
});
export const PublicTranscriptEmailJobSchema = z.object({ id: Uuid, state: z.string(), format: z.enum(['txt', 'pdf']), duplicate: z.boolean() });

export type Attachment = z.infer<typeof AttachmentSchema>;
export type UploadInit = z.infer<typeof UploadInitSchema>;
export type Export = z.infer<typeof ExportSchema>;
