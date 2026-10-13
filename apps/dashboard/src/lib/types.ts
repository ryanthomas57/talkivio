/**
 * Client-side resource shapes (camelCase after wire conversion). They mirror the
 * API projections in `apps/api/src` — keep them in sync when a projection changes.
 */
import type { MemberPreferences, OrgSettings } from '@talkivio/contracts';

export type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'analyst';
export type AgentStatus = 'online' | 'away' | 'invisible';
export type EffectiveStatus = AgentStatus | 'offline';

export interface MeUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface MeMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: Role;
  enabled: boolean;
  onboardingCompleted: boolean;
  plan: string;
}

export interface Me {
  user: MeUser;
  memberships: MeMembership[];
  activeTenantId: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
  plan: string;
  retentionDays: number;
  settings: OrgSettings;
  onboardingState: Record<string, unknown>;
  onboardingCompleted: boolean;
  version: number;
  createdAt: string;
}

export interface Agent {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  title: string | null;
  role: Role;
  enabled: boolean;
  desiredStatus: AgentStatus;
  effectiveStatus: EffectiveStatus;
  connected: boolean;
  activeChats: number;
  capacity: number;
  departmentIds: string[];
  lastSeenAt: string | null;
  /** Optimistic-concurrency version for PATCH /agents/:id and PUT /agents/:id/departments. */
  version: number;
}

export interface AgentMe {
  agent: Agent;
  preferences: MemberPreferences & Record<string, unknown>;
  permissions: string[];
  departmentScope: 'all' | string[];
}

export type ChatStatus = 'queued' | 'offered' | 'active' | 'closed';

export interface VisitorSummary {
  id: string;
  displayName: string;
  verified: boolean;
  countryCode: string | null;
  avatarColor: string;
  online?: boolean;
}

export interface TagRef {
  id: string;
  slug: string;
  label: string;
}

export interface StaffChat {
  id: string;
  number: number;
  siteId: string;
  visitorId: string;
  departmentId: string | null;
  status: ChatStatus;
  ownerMembershipId: string | null;
  collaboratorIds: string[];
  requestedAt: string;
  firstAssignedAt: string | null;
  firstResponseAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  priority: number;
  version: number;
  lastSeq: number;
  startedBy: string;
  routeReason: string | null;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastPublicSenderType: string | null;
  awaitingReply: boolean;
  pageUrl: string | null;
  tags: TagRef[];
  rating: { rating: 'good' | 'bad'; comment: string | null; submittedAt: string } | null;
  visitor: VisitorSummary;
  unreadCount?: number;
}

export interface AttachmentRef {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  state: string;
  isImage: boolean;
}

export type SenderType = 'visitor' | 'agent' | 'system' | 'trigger';

export interface Message {
  id: string;
  chatId: string;
  seq: number;
  clientMessageId: string | null;
  sender: { type: SenderType; id: string | null; displayName: string };
  automated: boolean;
  visibility: 'public' | 'internal';
  type: 'text' | 'attachment' | 'system' | 'options' | string;
  body: string | null;
  options: string[];
  systemEvent: { kind: string; data: Record<string, unknown>; params?: Record<string, string> } | null;
  attachments: AttachmentRef[];
  sentAt: string;
  redacted: boolean;
}

export interface MessagePage {
  items: Message[];
  throughSeq: number;
  lastSeq: number;
  hasMore: boolean;
}

export interface Offer {
  id: string;
  chatId: string;
  mode: 'assigned' | 'transfer';
  expiresAt: string;
  note: string | null;
  fromMembershipId: string | null;
  version: number;
}

export interface PendingOffer {
  offer: Offer;
  chatPreview: StaffChat;
}

export interface InboxCounts {
  mine: number;
  queue: number;
  all: number;
  pendingOffers: number;
  unreadMine: number;
  [key: string]: number;
}

export interface Department {
  id: string;
  name: string;
  publicLabel: string | null;
  description: string | null;
  enabled: boolean;
  scheduleId: string | null;
  routingMode: 'manual' | 'broadcast' | 'assigned';
  queueLimit: number;
  maxWaitSeconds: number;
  fallbackDepartmentId: string | null;
  version: number;
  archivedAt?: string | null;
  members?: Array<{ membershipId: string; canServe: boolean; canMonitor: boolean }>;
  [key: string]: unknown;
}

export interface SiteOrigin {
  origin: string;
  patternType: 'exact' | 'subdomain';
  verifiedAt: string | null;
}

export interface Site {
  id: string;
  name: string;
  publicKey: string;
  enabled: boolean;
  configRevision: number;
  defaultDepartmentId: string | null;
  scheduleId: string | null;
  origins: SiteOrigin[];
  identityVerificationEnabled: boolean;
  installedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOrigin: string | null;
  previousKeyExpiresAt: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
}

export interface Tag {
  id: string;
  slug: string;
  label: string;
  color?: string | null;
  archivedAt?: string | null;
}
