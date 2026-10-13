/**
 * Domain enumerations shared by the API, dashboard and widget.
 * Values mirror the Prisma enums in apps/api/prisma/schema.prisma.
 */

export const ROLES = ['OWNER', 'ADMIN', 'AGENT'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_STATUSES = ['ONLINE', 'AWAY', 'INVISIBLE', 'OFFLINE'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const CONVERSATION_STATUSES = ['WAITING', 'ACTIVE', 'PENDING', 'RESOLVED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_CHANNELS = ['CHAT', 'OFFLINE_MESSAGE', 'API'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MESSAGE_TYPES = ['TEXT', 'NOTE', 'EVENT'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const AUTHOR_TYPES = ['VISITOR', 'AGENT', 'SYSTEM', 'TRIGGER'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const RATINGS = ['GOOD', 'BAD'] as const;
export type Rating = (typeof RATINGS)[number];

export const ROUTING_MODES = ['BROADCAST', 'ASSIGNED'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const STARTED_BY = ['VISITOR', 'AGENT', 'TRIGGER', 'API'] as const;
export type StartedBy = (typeof STARTED_BY)[number];

/** Inbox views shown in the dashboard conversation list. */
export const INBOX_VIEWS = [
  'all',
  'unassigned',
  'mine',
  'team',
  'waiting',
  'active',
  'pending',
  'resolved',
  'missed',
  'offline',
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'bot', 'unknown'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** System event kinds rendered inline in a transcript. */
export const CONVERSATION_EVENTS = [
  'chat.started',
  'chat.agent_joined',
  'chat.agent_left',
  'chat.agent_invited',
  'chat.assigned',
  'chat.unassigned',
  'chat.transferred',
  'chat.department_changed',
  'chat.priority_changed',
  'chat.tagged',
  'chat.untagged',
  'chat.status_changed',
  'chat.ended',
  'chat.reopened',
  'chat.missed',
  'chat.rated',
  'chat.visitor_left',
  'chat.visitor_returned',
  'chat.transcript_sent',
  'chat.rating_requested',
  'visitor.banned',
  'visitor.navigated',
] as const;
export type ConversationEventKind = (typeof CONVERSATION_EVENTS)[number];

/** Event kinds that are shown to the visitor in the widget transcript. */
export const VISITOR_VISIBLE_EVENTS: ConversationEventKind[] = [
  'chat.agent_joined',
  'chat.agent_left',
  'chat.transferred',
  'chat.ended',
  'chat.reopened',
  'chat.rating_requested',
];

/** Webhook / domain events emitted by the platform. */
export const WEBHOOK_EVENTS = [
  'conversation.created',
  'conversation.assigned',
  'conversation.transferred',
  'conversation.status_changed',
  'conversation.closed',
  'conversation.missed',
  'conversation.rated',
  'message.created',
  'offline_message.created',
  'visitor.identified',
  'visitor.banned',
  'agent.status_changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_KEY_SCOPES = ['read', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const PLANS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  agents: number;
  websites: number;
  historyDays: number | null;
  triggers: number;
  apiAccess: boolean;
  webhooks: boolean;
  removeBranding: boolean;
  priceMonthlyPerAgent: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    agents: 1,
    websites: 1,
    historyDays: 30,
    triggers: 3,
    apiAccess: false,
    webhooks: false,
    removeBranding: false,
    priceMonthlyPerAgent: 0,
  },
  TEAM: {
    agents: 10,
    websites: 3,
    historyDays: 365,
    triggers: 25,
    apiAccess: true,
    webhooks: true,
    removeBranding: false,
    priceMonthlyPerAgent: 19,
  },
  BUSINESS: {
    agents: 100,
    websites: 20,
    historyDays: null,
    triggers: 200,
    apiAccess: true,
    webhooks: true,
    removeBranding: true,
    priceMonthlyPerAgent: 49,
  },
  ENTERPRISE: {
    agents: 10_000,
    websites: 1_000,
    historyDays: null,
    triggers: 10_000,
    apiAccess: true,
    webhooks: true,
    removeBranding: true,
    priceMonthlyPerAgent: 99,
  },
};

export const ROLE_RANK: Record<Role, number> = { AGENT: 1, ADMIN: 2, OWNER: 3 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
