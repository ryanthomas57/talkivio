/**
 * Visitor monitoring and record shapes (camelCase after wire conversion). They
 * mirror `apps/api/src/features/visitors/*` — keep in sync with the projections in
 * `visitor-monitor.service.ts` (live) and `visitor-records.service.ts` (records).
 */
import type { MessageKey } from '@/i18n';
import type { TagRef } from '@/lib/types';

export type LiveGroup = 'incoming' | 'served' | 'browsing' | 'idle';
export const LIVE_GROUPS: LiveGroup[] = ['incoming', 'served', 'browsing', 'idle'];
export const HIGH_LOAD_GROUPS: LiveGroup[] = ['incoming', 'served'];

export const GROUP_LABEL: Record<LiveGroup, MessageKey> = {
  incoming: 'visitors.group.incoming',
  served: 'visitors.group.served',
  browsing: 'visitors.group.browsing',
  idle: 'visitors.group.idle',
};

export const GROUP_HINT: Record<LiveGroup, MessageKey> = {
  incoming: 'visitors.groupHint.incoming',
  served: 'visitors.groupHint.served',
  browsing: 'visitors.groupHint.browsing',
  idle: 'visitors.groupHint.idle',
};

export interface LiveSession {
  sessionId: string;
  siteId: string;
  connections: number;
  visible: boolean;
  mostRecent: boolean;
  browsingHidden: boolean;
  startedAt: string | null;
  currentUrl: string | null;
  currentTitle: string | null;
  referrerOrigin: string | null;
  pageEnteredAt: string | null;
  pageDwellMs: number | null;
}

export interface LiveChatRef {
  id: string;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  ownerMembershipId: string | null;
  requestedAt: string;
  waitMs: number;
}

export interface LiveVisitor {
  visitorId: string;
  group: LiveGroup;
  displayName: string;
  anonymousLabel: string;
  identity: { verified: boolean; identified: boolean };
  siteId: string | null;
  online: boolean;
  connections: number;
  browsingHidden: boolean;
  currentUrl: string | null;
  currentTitle: string | null;
  referrerOrigin: string | null;
  mostRecentSessionId: string | null;
  pageEnteredAt: string | null;
  pageDwellMs: number | null;
  arrivedAt: string | null;
  timeOnSiteMs: number | null;
  country: string | null;
  /** Address and network owner of the most recent session; null unless the workspace shows visitor IPs (Settings, General). */
  ipAddress: string | null;
  network: string | null;
  deviceCategory: string | null;
  sessionCount: number | null;
  lastActivityAt: string | null;
  idle: boolean;
  tags: TagRef[];
  chat: LiveChatRef | null;
  sessions: LiveSession[];
}

export interface LiveSnapshot {
  items: LiveVisitor[];
  asOf: string;
  snapshotCursor: string;
  nextCursor: string | null;
  hasMore: boolean;
  mode: 'normal' | 'high_load';
  omittedBrowsing: boolean;
  counts: Partial<Record<LiveGroup, number>>;
  idleAfterMs: number;
}

/** `visitor.updated` ephemeral frame (allowed_patch null → hidden, restricted or gone). */
export interface VisitorUpdatedFrame {
  visitorId: string;
  allowedPatch: LiveVisitor | null;
  asOf: string;
}

export interface VisitorSessionLeftFrame {
  visitorId: string;
  sessionId: string;
  lastSeenAt: string;
}

export interface VisitorTag extends TagRef {
  source: string;
}

/** `visitor` = the site's page through the SDK (unverified), `agent` = staff (membership id), `trigger` = automation. */
export interface FieldProvenance {
  source: 'visitor' | 'agent' | 'trigger';
  by: string | null;
  at: string;
}

export interface FieldValue {
  value: string | null;
  verified: boolean;
}

export interface VisitorProfile {
  id: string;
  siteId: string | null;
  displayName: string;
  anonymousLabel: string;
  verified: boolean;
  identityVerified: boolean;
  identities: Array<{ issuerSiteId: string; verificationMethod: string; linkedAt: string }>;
  /** Opaque map on the wire (keys kept): name / email / phone. */
  fields: Record<string, FieldValue | undefined>;
  allowedContactFields: string[];
  tags: VisitorTag[];
  customFields: Record<string, unknown>;
  /** Opaque map on the wire: who set each custom-field value. */
  customFieldSources: Record<string, FieldProvenance | undefined>;
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
  chatCount: number;
  location: {
    countryCode: string | null;
    region: string | null;
    city: string | null;
    approximate: true;
  } | null;
  device: { category: string | null; browser: string | null; os: string | null };
  language: string | null;
  timezone: string | null;
  online: boolean;
  sessionSummary: { total: number; open: number; lastStartedAt: string | null };
  erased: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimelinePage {
  url: string;
  title: string | null;
  enteredAt: string;
  leftAt: string | null;
  dwellMs: number;
}

export interface VisitorSessionRecord {
  id: string;
  siteId: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  live: boolean;
  analyticsConsent: string;
  browsingHidden: boolean;
  device: { category: string | null; browser: string | null; os: string | null };
  country: string | null;
  referrerOrigin: string | null;
  landingUrl: string | null;
  pageViewCount: number | null;
  pages: TimelinePage[];
  pagesTruncated: boolean;
  visibleMs: number | null;
  exclusiveVisibleMs: number | null;
  isPreview: boolean;
}

export interface VisitorListItem {
  id: string;
  siteId: string | null;
  displayName: string;
  anonymousLabel: string;
  verified: boolean;
  identityVerified: boolean;
  email: string | null;
  tags: VisitorTag[];
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
  chatCount: number;
  countryCode: string | null;
  online: boolean;
}

export interface MergeRequestResult {
  id: string;
  kind: string;
  state: string;
  reviewState: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export const visitorKeys = {
  profile: (id: string) => ['visitor', id] as const,
  sessions: (id: string) => ['visitor', id, 'sessions'] as const,
  chats: (id: string) => ['visitor', id, 'chats'] as const,
};
