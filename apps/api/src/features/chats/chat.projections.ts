/**
 * Resource projections for chats and messages (ch. 40 shared shapes). Staff
 * projections include internal context; public projections are what a visitor
 * may see — internal notes and selection traces never appear in them.
 */
import type { Attachment, Chat, Message, Prisma } from '@prisma/client';
import { avatarColor, generatedVisitorName, truncate } from '@talkivio/contracts';

export const staffChatInclude = {
  participants: { where: { leftAt: null }, select: { membershipId: true, role: true, actorType: true, lastReadSeq: true } },
  tags: { select: { tagId: true } },
  rating: { select: { rating: true, comment: true, submittedAt: true, revisedAt: true } },
} satisfies Prisma.ChatInclude;
export type StaffChatRow = Prisma.ChatGetPayload<{ include: typeof staffChatInclude }>;

export const messageInclude = {
  attachments: { include: { attachment: true }, orderBy: { ordinal: 'asc' } },
} satisfies Prisma.MessageInclude;
export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

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
  status: Chat['status'];
  ownerMembershipId: string | null;
  collaboratorIds: string[];
  requestedAt: Date;
  firstAssignedAt: Date | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  priority: number;
  version: number;
  lastSeq: number;
  startedBy: string;
  routeReason: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string;
  lastPublicSenderType: string | null;
  awaitingReply: boolean;
  pageUrl: string | null;
  tags: TagRef[];
  rating: { rating: string; comment: string | null; submittedAt: Date } | null;
  visitor: VisitorSummary;
  unreadCount?: number;
}

export interface PublicAgentProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
}

export interface PublicChat {
  id: string;
  status: Chat['status'];
  version: number;
  lastSeq: number;
  requestedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  agents: PublicAgentProfile[];
  rating: { rating: string; comment: string | null } | null;
  queue: { position: number; approximate: true } | null;
}

export interface AttachmentRef {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  state: string;
  isImage: boolean;
}

export interface MessageResource {
  id: string;
  chatId: string;
  seq: number;
  clientMessageId: string | null;
  sender: { type: Message['senderType']; id: string | null; displayName: string };
  automated: boolean;
  visibility: Message['visibility'];
  type: Message['type'];
  body: string | null;
  options: string[];
  systemEvent: { kind: string; data: Record<string, unknown>; params?: Record<string, string> } | null;
  attachments: AttachmentRef[];
  sentAt: Date;
  redacted: boolean;
}

export function visitorDisplayName(v: { id: string; name: string | null; anonymousLabel?: string | null }): string {
  return v.name?.trim() || v.anonymousLabel || generatedVisitorName(v.id);
}

export function attachmentRef(a: Attachment): AttachmentRef {
  return {
    id: a.id,
    name: a.originalName,
    sizeBytes: Number(a.sizeBytes),
    mime: a.detectedMime ?? a.declaredMime,
    state: a.state,
    isImage: (a.detectedMime ?? a.declaredMime).startsWith('image/'),
  };
}

export function messageResource(m: MessageRow): MessageResource {
  const redacted = !!m.redactedAt;
  return {
    id: m.id,
    chatId: m.chatId,
    seq: Number(m.seq),
    clientMessageId: m.clientMessageId,
    sender: {
      type: m.senderType,
      id: m.senderType === 'agent' ? m.senderMembershipId : m.senderType === 'visitor' ? m.senderVisitorId : null,
      displayName: m.senderNameSnapshot,
    },
    automated: m.automated,
    visibility: m.visibility,
    type: m.type,
    body: redacted ? null : m.body,
    options: m.options,
    systemEvent: (m.systemEvent as MessageResource['systemEvent']) ?? null,
    attachments: redacted ? [] : m.attachments.map((x) => attachmentRef(x.attachment)),
    sentAt: m.sentAt,
    redacted,
  };
}

/** Visitor-visible system events (public projection). */
export const PUBLIC_SYSTEM_EVENTS = new Set([
  'chat.agent_joined',
  'chat.agent_left',
  'chat.transferred',
  'chat.closed',
  'chat.rating_requested',
  'chat.queued',
]);

export function publicMessage(m: MessageResource): MessageResource | null {
  if (m.visibility !== 'public') return null;
  if (m.type === 'system' && !PUBLIC_SYSTEM_EVENTS.has(m.systemEvent?.kind ?? '')) return null;
  return {
    ...m,
    // Public: display params only (names/labels the visitor already sees), never ids or reasons.
    systemEvent: m.systemEvent ? { kind: m.systemEvent.kind, data: {}, params: m.systemEvent.params ?? {} } : null,
  };
}

export function previewOf(body: string | null, attachmentCount: number): string {
  if (body) return truncate(body, 140);
  if (attachmentCount) return attachmentCount === 1 ? 'Attachment' : `${attachmentCount} attachments`;
  return '';
}

export function staffChat(c: StaffChatRow, visitor: { id: string; name: string | null; anonymousLabel: string; verified: boolean; countryCode: string | null }, tags: TagRef[]): StaffChat {
  const owner = c.ownerMembershipId;
  return {
    id: c.id,
    number: c.number,
    siteId: c.siteId,
    visitorId: c.visitorId,
    departmentId: c.departmentId,
    status: c.status,
    ownerMembershipId: owner,
    collaboratorIds: c.participants.filter((p) => p.role === 'collaborator' && p.membershipId).map((p) => p.membershipId!),
    requestedAt: c.requestedAt,
    firstAssignedAt: c.firstAssignedAt,
    firstResponseAt: c.firstResponseAt,
    closedAt: c.closedAt,
    closeReason: c.closeReason,
    priority: c.priority,
    version: c.version,
    lastSeq: Number(c.nextSeq) - 1,
    startedBy: c.startedBy,
    routeReason: c.routeReason,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    lastPublicSenderType: c.lastPublicSenderType,
    awaitingReply: c.status === 'active' && c.lastPublicSenderType === 'visitor',
    pageUrl: c.pageUrl,
    tags,
    rating: c.rating ? { rating: c.rating.rating, comment: c.rating.comment, submittedAt: c.rating.submittedAt } : null,
    visitor: {
      id: visitor.id,
      displayName: visitorDisplayName(visitor),
      verified: visitor.verified,
      countryCode: visitor.countryCode,
      avatarColor: avatarColor(visitor.id),
    },
  };
}
