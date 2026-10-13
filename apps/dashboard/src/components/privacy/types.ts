/**
 * Client shapes for privacy requests and retention (camelCase after wire
 * conversion). Mirrors `apps/api/src/features/privacy/*` — keep in sync.
 * Note: `report` is not an opaque map on the wire, so its nested keys (including
 * per-store count names such as `page_events`) arrive camelCased (`pageEvents`).
 */

export type PrivacyKind = 'access' | 'erase';
export type PrivacyState = 'pending_verification' | 'queued' | 'running' | 'completed' | 'failed';

export interface StoreConfirmation {
  store: string;
  status: 'confirmed' | 'failed';
  detail: string;
}

export interface DownstreamErasure {
  provider: string;
  status: 'not_configured' | 'no_mapped_records' | 'pending_manual' | 'accepted' | 'confirmed' | 'failed';
  mappedRecords: number;
  detail: string;
}

export interface PrivacyReport {
  kind?: PrivacyKind;
  state?: PrivacyState;
  progress?: { step?: string; completedSteps?: number; totalSteps?: number };
  counts?: Record<string, number>;
  stores?: StoreConfirmation[];
  policy?: Record<string, string>;
  downstream?: DownstreamErasure[];
  webhookNotification?: string;
  legalHold?: { modeled: boolean; note: string };
  export?: { id: string; format: string; sizeBytes: number; sha256: string | null; expiresAt: string; includesStaffNotes: boolean };
  verification?: { method: string; verifiedBy: string | null };
  errorCode?: string | null;
  failedTargets?: string[];
  tombstonesWritten?: number;
  [key: string]: unknown;
}

export interface PrivacyRequest {
  id: string;
  kind: PrivacyKind;
  visitorId: string | null;
  state: PrivacyState;
  requestedBy: string | null;
  hasProof: boolean;
  verifiedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  job: { id: string; state: string; attempts: number; progress: number | null; errorCode: string | null } | null;
  report: PrivacyReport;
}

/** Subject of a request as resolved by GET /privacy/requests (list items only). */
export interface PrivacySubject {
  /** Visitor display name; null once the visitor record is gone. */
  displayName: string | null;
  /** The visitor record was erased (the request still names its id). */
  erased: boolean;
}

export interface PrivacyListItem extends PrivacyRequest {
  subject: PrivacySubject;
}

/** `privacy.updated` (durable, staff): sent to every privacy admin's agent scope on state changes and job steps. */
export interface PrivacyUpdatedPayload {
  requestId: string;
  kind: PrivacyKind;
  state: PrivacyState;
  completedAt: string | null;
  /** Job progress 0–100 during steps; null for plain state changes. */
  progress: number | null;
}

export interface VisitorListItem {
  id: string;
  siteId: string;
  displayName: string;
  anonymousLabel: string | null;
  verified: boolean;
  identityVerified: boolean;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
  chatCount: number;
  countryCode: string | null;
  online: boolean;
}

export interface VisitorProfile {
  id: string;
  displayName: string | null;
  anonymousLabel: string | null;
  [key: string]: unknown;
}

export interface RetentionReport {
  dryRun: boolean;
  generatedAt: string;
  policy: { transcriptRetentionDays: number; pageEventRetentionDays: number; webhookDeliveryRetentionDays: number; verificationEvidenceRetentionDays: number; batchSize: number };
  cutoffs: { transcripts: string; pageEvents: string; webhookDeliveries: string; verificationEvidence: string };
  targets: { closedChats: number; messages: number; attachments: number; transcriptExports: number; pageEvents: number; expiredPrivacyExports: number; webhookDeliveries: number; verificationEvidence: number };
  remainingAfterBatch: boolean;
  legalHolds: { modeled: false; note: string };
  failures: string[];
}

export const privacyKeys = {
  all: ['privacy-requests'] as const,
  lists: ['privacy-requests', 'list'] as const,
  list: (state: string | null, kind: string | null) => ['privacy-requests', 'list', { state, kind }] as const,
  detail: (id: string) => ['privacy-requests', 'detail', id] as const,
  visitor: (id: string) => ['privacy-visitor', id] as const,
  visitorSearch: (q: string) => ['privacy-visitor-search', q] as const,
  retention: ['privacy-retention-preview'] as const,
};

export const ACTIVE_STATES: ReadonlySet<PrivacyState> = new Set(['queued', 'running']);
