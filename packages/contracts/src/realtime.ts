/**
 * WebSocket protocol (Socket.IO). Two namespaces:
 *   /visitor — the embeddable widget (one socket per browser tab)
 *   /agent   — the agent dashboard (session-cookie authenticated)
 */
import type { AgentStatus, ConversationStatus, Rating } from './enums';
import type { WidgetConfig } from './widget-config';
import type {
  ConversationListItem,
  LiveVisitor,
  MessageDTO,
  NotificationDTO,
} from './dto';

export const VISITOR_NAMESPACE = '/visitor';
export const AGENT_NAMESPACE = '/agent';

/** Default heartbeat cadence for widget presence (ms). The server may override. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

export interface PageInfo {
  url: string;
  title: string;
  referrer: string | null;
}

export interface VisitorHandshake {
  widgetId: string;
  visitorToken: string | null;
  tabId: string;
  page: PageInfo;
  locale: string | null;
  timezone: string | null;
  screen: string | null;
  /** Signed identity token (JWT, HS256) issued by the customer's backend. */
  identityToken?: string | null;
  /** Origin of the page embedding the widget (from ancestorOrigins / referrer). */
  hostOrigin?: string | null;
  widgetVersion?: string;
}

export interface PublicAgent {
  id: string;
  name: string;
  avatarUrl: string | null;
  title: string | null;
}

export interface PublicDepartment {
  id: string;
  name: string;
  online: boolean;
}

export interface PublicConversation {
  id: string;
  status: ConversationStatus;
  agents: PublicAgent[];
  rating: Rating | null;
  ratingComment: string | null;
  queuePosition: number | null;
}

export interface VisitorSessionPayload {
  visitorToken: string;
  visitor: { id: string; name: string | null; email: string | null; phone: string | null };
  conversation: PublicConversation | null;
  messages: MessageDTO[];
  account: AccountAvailability;
  config: WidgetConfig;
  configVersion: number;
  heartbeatMs: number;
  banned: boolean;
  proactive: MessageDTO[];
  brandName: string;
}

export interface AccountAvailability {
  online: boolean;
  departments: PublicDepartment[];
  /** When the site (or its schedule) next opens, if closed. */
  nextOpenAt?: string | null;
}

export interface VisitorProfileInput {
  name?: string;
  email?: string;
  phone?: string;
}

export interface Ack<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface VisitorClientEvents {
  'page:view': (page: PageInfo) => void;
  heartbeat: (state: { visible: boolean; focused: boolean }) => void;
  'chat:message': (
    input: {
      clientId: string;
      body: string;
      attachmentIds?: string[];
      departmentId?: string | null;
      profile?: VisitorProfileInput;
    },
    ack: (res: Ack<{ message: MessageDTO; conversation: PublicConversation }>) => void,
  ) => void;
  'chat:typing': (input: { typing: boolean; preview?: string }) => void;
  'chat:read': (input: { messageId: string }) => void;
  'chat:end': (ack: (res: Ack) => void) => void;
  'chat:rate': (input: { rating: Rating | null; comment?: string }, ack: (res: Ack) => void) => void;
  'chat:transcript': (input: { email: string }, ack: (res: Ack) => void) => void;
  'visitor:identify': (input: VisitorProfileInput & { identityToken?: string }, ack: (res: Ack) => void) => void;
  'visitor:update': (
    input: { tags?: { add?: string[]; remove?: string[] }; attributes?: Record<string, unknown>; departmentId?: string | null },
    ack: (res: Ack) => void,
  ) => void;
  'offline:submit': (
    input: { name: string; email: string; phone?: string; departmentId?: string | null; message: string },
    ack: (res: Ack) => void,
  ) => void;
  'widget:event': (input: { type: 'open' | 'close' }) => void;
}

export interface VisitorServerEvents {
  session: (payload: VisitorSessionPayload) => void;
  'chat:message': (message: MessageDTO) => void;
  'chat:typing': (input: { agent: PublicAgent; typing: boolean }) => void;
  'chat:state': (conversation: PublicConversation | null) => void;
  'chat:read': (input: { messageId: string; at: string }) => void;
  'account:status': (availability: AccountAvailability) => void;
  'config:update': (input: { config: WidgetConfig; version: number }) => void;
  'proactive:message': (message: MessageDTO) => void;
  'widget:command': (input: { action: 'open' | 'close' | 'hide' | 'show' }) => void;
  banned: () => void;
  'session:error': (input: { code: string; message: string }) => void;
}

export interface TypingEvent {
  conversationId: string;
  actor: 'visitor' | 'agent';
  agentId?: string;
  agentName?: string;
  typing: boolean;
  preview?: string;
}

export interface AgentPresenceEvent {
  agentId: string;
  status: AgentStatus;
  connected: boolean;
  activeChats: number;
}

export interface AgentServerEvents {
  ready: (input: { agentId: string; status: AgentStatus; serverTime: string }) => void;
  'conversation:upsert': (conversation: ConversationListItem) => void;
  'conversation:incoming': (conversation: ConversationListItem) => void;
  'message:new': (input: { conversationId: string; message: MessageDTO }) => void;
  typing: (input: TypingEvent) => void;
  'conversation:read': (input: { conversationId: string; by: 'visitor'; messageId: string; at: string }) => void;
  'visitor:upsert': (visitor: LiveVisitor) => void;
  'visitor:remove': (input: { visitorId: string }) => void;
  'visitors:count': (input: { online: number; chatting: number; byWebsite: Record<string, number> }) => void;
  'agent:presence': (event: AgentPresenceEvent) => void;
  notification: (notification: NotificationDTO) => void;
  'session:revoked': () => void;
}

export interface AgentClientEvents {
  'status:set': (input: { status: AgentStatus }, ack: (res: Ack) => void) => void;
  'conversation:typing': (input: { conversationId: string; typing: boolean }) => void;
  'conversation:view': (input: { conversationId: string | null }) => void;
  'visitors:subscribe': (ack: (res: Ack<{ visitors: LiveVisitor[] }>) => void) => void;
  'visitors:unsubscribe': () => void;
  activity: () => void;
}

/** Messages exchanged between the host-page loader and the widget iframe via postMessage. */
export type HostToFrameMessage =
  | { source: 'talkivio-host'; type: 'init'; widgetId: string; page: PageInfo; isMobile: boolean; locale: string; timezone: string; screen: string }
  | { source: 'talkivio-host'; type: 'page'; page: PageInfo }
  | { source: 'talkivio-host'; type: 'visibility'; visible: boolean; focused: boolean }
  | { source: 'talkivio-host'; type: 'api'; id: number; method: string; args: unknown[] };

export type FrameToHostMessage =
  | { source: 'talkivio-frame'; type: 'ready' }
  | { source: 'talkivio-frame'; type: 'layout'; mode: 'hidden' | 'launcher' | 'greeting' | 'open'; width: number; height: number; position: 'bottom-right' | 'bottom-left'; offsetX: number; offsetY: number; fullscreen: boolean }
  | { source: 'talkivio-frame'; type: 'event'; name: string; payload: unknown }
  | { source: 'talkivio-frame'; type: 'api:result'; id: number; ok: boolean; result?: unknown; error?: string };
