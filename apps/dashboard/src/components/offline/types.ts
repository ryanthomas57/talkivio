/** Offline submissions (camelCase) — mirror OfflineSummary/OfflineDetail in apps/api/src/features/offline/offline.service.ts. */
import type { MessageKey } from '@/i18n';

export type OfflineStatus = 'received' | 'handled' | 'exported' | 'erased' | string;

export interface OfflineSummary {
  id: string;
  reference: string;
  siteId: string;
  departmentId: string | null;
  visitorId: string | null;
  name: string | null;
  emailMasked: string;
  messagePreview: string;
  status: OfflineStatus;
  sourceChatId: string | null;
  conversionReason: string | null;
  handledAt: string | null;
  handledById: string | null;
  createdAt: string;
  version: number;
}

export interface OfflineReply {
  id: string;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  /** Text of the email as sent ("[erased]" after a privacy erasure). */
  emailText: string | null;
}

export interface OfflineDetail extends Omit<OfflineSummary, 'messagePreview'> {
  email: string | null;
  phone: string | null;
  message: string;
  customFields: Record<string, unknown>;
  handledBy: { id: string; displayName: string } | null;
  replies: OfflineReply[];
}

/** Payload of durable `offline.submitted` / `offline.updated` (summary without email or preview). */
export interface OfflineEventPayload {
  submission: Omit<OfflineSummary, 'emailMasked' | 'messagePreview'> & { emailMasked?: string; messagePreview?: string };
}

/** Catalog keys for why a queued chat became an offline message (translated at render time). */
export const CONVERSION_REASONS: Record<string, MessageKey> = {
  max_wait_exceeded: 'offline.conversion.maxWait',
  visitor_requested: 'offline.conversion.visitorRequested',
};
