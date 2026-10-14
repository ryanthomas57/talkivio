/**
 * Data transfer objects returned by the REST API and pushed over WebSockets.
 * Dates are ISO-8601 strings on the wire.
 */
import type {
  AgentStatus,
  AuthorType,
  ConversationChannel,
  ConversationStatus,
  DeviceType,
  MessageType,
  Priority,
  Rating,
  Role,
  StartedBy,
} from './enums';
import type { WeeklySchedule } from './logic/hours';

export interface AttachmentDTO {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  url: string;
  isImage: boolean;
}

export interface MessageEventDTO {
  kind: string;
  data: Record<string, unknown>;
  /** Public-safe display values (name, department, variant, by) for rendering the line in the reader's language. */
  params?: Record<string, string>;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  type: MessageType;
  authorType: AuthorType;
  agentId: string | null;
  authorName: string;
  authorAvatarUrl: string | null;
  body: string;
  attachments: AttachmentDTO[];
  event: MessageEventDTO | null;
  options: string[];
  clientId: string | null;
  createdAt: string;
  readByVisitorAt: string | null;
}

export interface VisitorBrief {
  id: string;
  name: string;
  email: string | null;
  countryCode: string | null;
  online: boolean;
  avatarColor: string;
}

export interface ConversationListItem {
  id: string;
  number: number;
  status: ConversationStatus;
  channel: ConversationChannel;
  priority: Priority;
  subject: string | null;
  missed: boolean;
  startedBy: StartedBy;
  websiteId: string;
  departmentId: string | null;
  assigneeId: string | null;
  participantIds: string[];
  tags: string[];
  visitor: VisitorBrief;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageAuthorType: AuthorType | null;
  unreadCount: number;
  rating: Rating | null;
  createdAt: string;
  firstResponseAt: string | null;
  endedAt: string | null;
}

export interface ConversationDetail extends ConversationListItem {
  ratingComment: string | null;
  websiteName: string;
  departmentName: string | null;
  durationSeconds: number | null;
  waitSeconds: number | null;
  visitorLastReadAt: string | null;
}

export interface VisitorDTO {
  id: string;
  websiteId: string;
  name: string;
  isNamed: boolean;
  email: string | null;
  phone: string | null;
  notes: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  externalId: string | null;
  countryCode: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  deviceType: DeviceType | null;
  language: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  visitCount: number;
  totalPageViews: number;
  chatCount: number;
  banned: boolean;
  online: boolean;
  avatarColor: string;
}

export type LiveVisitorState = 'browsing' | 'idle' | 'incoming' | 'chatting' | 'waiting';

export interface LiveVisitor {
  id: string;
  sessionId: string;
  websiteId: string;
  name: string;
  email: string | null;
  isNamed: boolean;
  state: LiveVisitorState;
  currentUrl: string;
  currentTitle: string;
  referrer: string | null;
  landingPage: string | null;
  countryCode: string | null;
  city: string | null;
  deviceType: DeviceType | null;
  browser: string | null;
  os: string | null;
  sessionStartedAt: string;
  pageEnteredAt: string;
  lastActivityAt: string;
  pageViews: number;
  visitCount: number;
  tabs: number;
  tags: string[];
  conversationId: string | null;
  conversationStatus: ConversationStatus | null;
  assigneeId: string | null;
  avatarColor: string;
  lastGreeting: string | null;
}

export interface PageViewDTO {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  durationSeconds: number | null;
}

export interface VisitorSessionDTO {
  id: string;
  startedAt: string;
  endedAt: string | null;
  referrer: string | null;
  landingPage: string | null;
  pageViewCount: number;
  durationSeconds: number;
  pages: PageViewDTO[];
}

export interface AgentDTO {
  id: string;
  userId: string;
  name: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  title: string | null;
  role: Role;
  status: AgentStatus;
  connected: boolean;
  activeChats: number;
  maxChats: number | null;
  departmentIds: string[];
  disabled: boolean;
  lastSeenAt: string | null;
}

export interface DepartmentDTO {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  memberIds: string[];
  online: boolean;
  scheduleEnabled: boolean;
  schedule: WeeklySchedule | null;
}

export interface WebsiteDTO {
  id: string;
  name: string;
  domain: string;
  publicId: string;
  allowedOrigins: string[];
  configVersion: number;
  installedAt: string | null;
  lastSeenAt: string | null;
  identitySecretSet: boolean;
  createdAt: string;
}

export interface MeDTO {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    emailVerified: boolean;
    mfaEnabled: boolean;
    createdAt: string;
  };
  memberships: Array<{
    id: string;
    orgId: string;
    orgName: string;
    orgSlug: string;
    role: Role;
    /** starter, team, business or enterprise. */
    plan: string;
    onboardingCompleted: boolean;
  }>;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
