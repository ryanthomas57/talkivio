/**
 * Privacy policy settings (ch. 53), read from `process.env` with privacy-favouring
 * defaults. Tenants cannot yet override these per workspace (no settings schema
 * for them exists); the effective policy is recorded in every privacy report.
 *
 *   TALKIVIO_ERASURE_TRANSCRIPT_POLICY   subject_chats (default) | subject_messages
 *       subject_chats:    in chats that belong to the subject, redact every message except
 *                         those written by another visitor (staff replies and internal notes
 *                         about the subject are personal data too); elsewhere redact only the
 *                         subject's own messages.
 *       subject_messages: redact only messages the subject wrote.
 *   TALKIVIO_ACCESS_EXPORT_INCLUDE_NOTES  false (default) — staff notes excluded from access exports
 *   TALKIVIO_PRIVACY_EXPORT_TTL_DAYS      7 (1–30) — access export object lifetime
 *   TALKIVIO_PROOF_RETENTION_DAYS         30 (1–365) — verification evidence reference retention
 *   TALKIVIO_RETENTION_BATCH              200 (10–5000) — rows per retention batch
 *   TALKIVIO_RETENTION_INTERVAL_MINUTES   10 (1–1440) — minimum interval between retention runs
 *   TALKIVIO_WEBHOOK_DELIVERY_RETENTION_DAYS 30 (1–365) — finished webhook delivery history
 */

export type TranscriptPolicy = 'subject_chats' | 'subject_messages';

export interface PrivacyConfig {
  transcriptPolicy: TranscriptPolicy;
  accessExportIncludeNotes: boolean;
  exportTtlDays: number;
  proofRetentionDays: number;
  retentionBatch: number;
  retentionIntervalMinutes: number;
  webhookDeliveryRetentionDays: number;
}

function int(source: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = source[name];
  const v = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function loadPrivacyConfig(source: NodeJS.ProcessEnv = process.env): PrivacyConfig {
  return {
    transcriptPolicy:
      source.TALKIVIO_ERASURE_TRANSCRIPT_POLICY === 'subject_messages'
        ? 'subject_messages'
        : 'subject_chats',
    accessExportIncludeNotes: source.TALKIVIO_ACCESS_EXPORT_INCLUDE_NOTES === 'true',
    exportTtlDays: int(source, 'TALKIVIO_PRIVACY_EXPORT_TTL_DAYS', 7, 1, 30),
    proofRetentionDays: int(source, 'TALKIVIO_PROOF_RETENTION_DAYS', 30, 1, 365),
    retentionBatch: int(source, 'TALKIVIO_RETENTION_BATCH', 200, 10, 5000),
    retentionIntervalMinutes: int(source, 'TALKIVIO_RETENTION_INTERVAL_MINUTES', 10, 1, 1440),
    webhookDeliveryRetentionDays: int(source, 'TALKIVIO_WEBHOOK_DELIVERY_RETENTION_DAYS', 30, 1, 365),
  };
}

let cached: PrivacyConfig | null = null;
export function privacyConfig(): PrivacyConfig {
  return (cached ??= loadPrivacyConfig());
}
