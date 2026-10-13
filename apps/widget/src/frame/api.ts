/**
 * Talkivio widget API v2 client: REST under `/widget/v1`, snake_case wire format with
 * `{data, meta}` / `{error}` envelopes, plus adapters from the v2 public resources to the
 * UI state shapes used by the components.
 */
import type { AccountAvailability, PublicConversation, Rating } from '@talkivio/contracts/protocol';
import type { UiAttachment, UiMessage } from './state';

// ── Wire conversion ─────────────────────────────────────────────────────
const OPAQUE = new Set(['custom_fields', 'customFields', 'fields', 'attributes', 'metadata', 'field_errors', 'fieldErrors', 'details']);
const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function camelize<T = unknown>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => camelize(x)) as T;
  if (!isPlain(v)) return v as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[camelKey(k)] = OPAQUE.has(k) ? x : camelize(x);
  return out as T;
}

export function snakeize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeize);
  if (!isPlain(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[snakeKey(k)] = OPAQUE.has(k) ? x : snakeize(x);
  return out;
}

// ── v2 resources (camelCased) ───────────────────────────────────────────
export interface V2Department {
  id: string;
  label: string;
  state: string;
  nextOpenAt: string | null;
}
export interface V2Availability {
  state: 'available' | 'busy' | 'offline';
  nextOpenAt: string | null;
  acceptsQueue: boolean;
  departments: V2Department[];
}
export interface V2Bootstrap {
  siteId: string;
  configVersion: number;
  config: unknown;
  availability: V2Availability;
  consent: { analyticsRequired: boolean };
  chat: { readReceipts: boolean; reconnectGraceSeconds: number; allowFiles: boolean; maxFileMb: number };
}
export interface V2Agent {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
}
export interface V2Chat {
  id: string;
  status: 'queued' | 'offered' | 'active' | 'closed';
  version: number;
  lastSeq: number;
  requestedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  agents: V2Agent[];
  rating: { rating: 'good' | 'bad'; comment: string | null } | null;
  queue: { position: number; approximate: boolean } | null;
}
export interface V2Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  /** initiated | uploading | uploaded | scanning | clean | rejected | expired */
  state?: string;
  isImage: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
}
export interface V2UploadInit {
  uploadId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
  attachment: V2Attachment;
}
export interface V2Grant {
  url: string;
  method?: string;
  expiresAt: string;
  name?: string;
  filename?: string;
}
export interface V2Export {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  progress: number;
  errorCode: string | null;
}
export interface V2OfflineReceipt {
  id: string;
  reference: string;
  status: string;
  createdAt: string;
}
export interface V2Message {
  id: string;
  chatId: string;
  seq: number;
  clientMessageId: string | null;
  sender: { type: 'visitor' | 'agent' | 'system'; id: string | null; displayName: string };
  automated: boolean;
  visibility: string;
  type: 'text' | 'attachment' | 'system';
  body: string | null;
  options: string[];
  systemEvent: { kind: string; params?: Record<string, string> } | null;
  attachments: V2Attachment[];
  sentAt: string;
  /** Body removed (privacy erasure); render a tombstone. */
  redacted?: boolean;
}
export interface V2Session {
  visitor: { id: string; displayName: string; verified: boolean; hasName: boolean };
  sessionId: string;
  sessionKey: string | null;
  anonymousToken: string | null;
  /** 'session' when analytics consent is not granted: keep the token out of localStorage. */
  anonymousTokenPersistence?: 'persistent' | 'session';
  anonymousTokenExpiresAt?: string | null;
  capability: string;
  capabilityExpiresAt: string;
  consent: { analytics: 'granted' | 'denied' | 'unknown' | string };
  activeChat: V2Chat | null;
}
export interface V2MessagePage {
  items: V2Message[];
  throughSeq: number;
  lastSeq: number;
  hasMore: boolean;
}
/** Durable realtime frame (`event`). */
export interface V2Frame {
  v: number;
  eventId: string;
  type: string;
  scope: { kind: string; id: string };
  cursor: string;
  occurredAt: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
}

// ── Errors & client ─────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly details: Record<string, unknown> | null = null,
    /** Validation errors keyed by wire (snake_case) field name. */
    readonly fieldErrors: Record<string, string[]> | null = null,
  ) {
    super(message);
  }
}

export class WidgetApi {
  capability: string | null = null;

  constructor(
    readonly base: string,
    /** Called once on AUTH_REQUIRED/401 to refresh the visitor session; returns true when refreshed. */
    private readonly refresh: () => Promise<boolean>,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; retried?: boolean } = {}): Promise<T> {
    const auth = opts.auth !== false;
    let res: Response;
    try {
      res = await fetch(`${this.base}/widget/v1${path}`, {
        method,
        credentials: 'omit',
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(auth && this.capability ? { authorization: `Bearer ${this.capability}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(snakeize(body)) : undefined,
      });
    } catch {
      throw new ApiError('NETWORK', 'Network error', 0, true);
    }
    let json: { data?: unknown; error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown>; field_errors?: Record<string, string[]> } } | null = null;
    try {
      json = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (res.ok) return camelize<T>(json?.data ?? null);
    const err = json?.error;
    const code = err?.code || (res.status === 404 ? 'NOT_FOUND' : res.status === 401 ? 'AUTH_REQUIRED' : res.status === 429 ? 'RATE_LIMITED' : 'INTERNAL');
    if (auth && (res.status === 401 || code === 'AUTH_REQUIRED') && !opts.retried && (await this.refresh())) {
      return this.call<T>(method, path, body, { ...opts, retried: true });
    }
    const retryable = err?.retryable ?? (res.status === 429 || res.status >= 500);
    throw new ApiError(code, err?.message || code, res.status, retryable, err?.details ?? null, err?.field_errors ?? null);
  }
}

// ── Adapters (v2 → UI shapes) ───────────────────────────────────────────
export function toConversation(c: V2Chat): PublicConversation {
  return {
    id: c.id,
    status: c.status === 'closed' ? 'RESOLVED' : c.status === 'active' ? 'ACTIVE' : 'WAITING',
    agents: (c.agents ?? []).map((a) => ({ id: a.id, name: a.displayName, avatarUrl: a.avatarUrl, title: a.title })),
    rating: c.rating ? (c.rating.rating.toUpperCase() as Rating) : null,
    ratingComment: c.rating?.comment ?? null,
    queuePosition: c.queue?.position ?? null,
  };
}

export function toAccount(a: V2Availability): AccountAvailability {
  const up = (s: string) => s === 'available' || s === 'busy';
  return {
    online: a.state === 'available' || (a.state === 'busy' && a.acceptsQueue),
    departments: (a.departments ?? []).map((d) => ({ id: d.id, name: d.label, online: up(d.state) })),
    nextOpenAt: a.nextOpenAt ?? null,
  };
}

/** Attachments carry no URL: clean files are fetched through a short-lived download grant. */
export function toAttachment(a: V2Attachment): UiAttachment {
  return { id: a.id, name: a.name, size: a.sizeBytes, mimeType: a.mime, url: '', isImage: !!a.isImage, state: a.state ?? 'clean', errorCode: a.errorCode ?? null };
}

export function toMessage(m: V2Message, agents: V2Agent[] | PublicConversation['agents'] = [], readThroughSeq = 0): UiMessage {
  const s = m.sender ?? { type: 'system', id: null, displayName: '' };
  const authorType = s.type === 'visitor' ? 'VISITOR' : s.type === 'agent' ? 'AGENT' : m.automated ? 'TRIGGER' : 'SYSTEM';
  const agent = s.type === 'agent' ? (agents as Array<{ id: string; avatarUrl: string | null }>).find((a) => a.id === s.id) : undefined;
  const isEvent = m.type === 'system' && !m.automated;
  return {
    id: m.id,
    conversationId: m.chatId,
    type: isEvent ? 'EVENT' : 'TEXT',
    authorType,
    agentId: s.type === 'agent' ? s.id : null,
    authorName: s.displayName || '',
    authorAvatarUrl: agent?.avatarUrl ?? null,
    body: m.redacted ? '' : (m.body ?? ''),
    attachments: m.redacted ? [] : (m.attachments ?? []).map(toAttachment),
    event: isEvent && m.systemEvent ? { kind: m.systemEvent.kind, data: {}, params: m.systemEvent.params ?? {} } : null,
    options: m.options ?? [],
    clientId: m.clientMessageId,
    createdAt: m.sentAt,
    readByVisitorAt: authorType !== 'VISITOR' && m.seq <= readThroughSeq ? m.sentAt : null,
    seq: m.seq,
    ...(m.redacted ? { redacted: true } : {}),
  };
}

export const ratingToWire = (r: Rating): 'good' | 'bad' => (r === 'GOOD' ? 'good' : 'bad');
