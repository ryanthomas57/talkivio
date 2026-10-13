/**
 * REST client for the Talkivio API (ch. 40). All dashboard requests go through the
 * same-origin `/api/v1` proxy so the HttpOnly session cookie stays first-party; the
 * readable `rd_csrf` cookie is echoed in `x-csrf-token` on every mutation (double
 * submit, bound to the session server-side). No bearer token is ever stored in the
 * browser.
 */
import { fromWire, toSnakeKey, toWire } from './wire';
import { activeLocale, tStatic, type MessageKey } from '@/i18n';
import { en } from '@/i18n/messages/en';

export const API_BASE = '/api/v1';
const CSRF_COOKIE = 'rd_csrf';

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly fieldErrors: Record<string, string[]>;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(init: { status: number; code: string; message: string; retryable?: boolean; fieldErrors?: Record<string, string[]>; details?: Record<string, unknown>; requestId?: string | null }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.fieldErrors = init.fieldErrors ?? {};
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
  }

  /** First message for a snake_case wire field, if the server reported one. */
  field(name: string): string | undefined {
    return this.fieldErrors[name]?.[0] ?? this.fieldErrors[toSnakeKey(name)]?.[0];
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/**
 * Readable message for any thrown value — never leaks stack traces into the UI. English shows the server's
 * specific message; other languages show the localized message for the stable error code (ch. 45: machine
 * codes stay stable, human messages localize), falling back to the server text for unknown codes.
 */
export function errorMessage(e: unknown, fallback?: string): string {
  const generic = fallback ?? tStatic('common.errorGeneric');
  if (e instanceof ApiError) {
    const key = `common.error.${e.code}`;
    if (activeLocale() !== 'en' && key in en) return tStatic(key as MessageKey);
    return e.message || generic;
  }
  if (e instanceof TypeError) return tStatic('common.error.network');
  return generic;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    const key = toSnakeKey(k);
    if (Array.isArray(v)) v.forEach((x) => params.append(key, x));
    else params.set(key, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Session-expiry hook: the shell listens and shows a re-login dialog (drafts stay local). */
export const SESSION_EXPIRED_EVENT = 'talkivio:session-expired';
export const ACCESS_REVOKED_EVENT = 'talkivio:access-revoked';

interface RequestOptions {
  query?: Query;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string | number;
  signal?: AbortSignal;
  /** Do not broadcast session expiry (used by the session bootstrap itself). */
  quietAuth?: boolean;
}

interface Envelope {
  data?: unknown;
  page?: { next_cursor: string | null; has_more: boolean; total?: number };
  error?: { code: string; message: string; retryable?: boolean; field_errors?: Record<string, string[]>; details?: Record<string, unknown> };
  meta?: { request_id?: string };
}

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Envelope | null> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
    body: opts.body === undefined ? undefined : JSON.stringify(toWire(opts.body)),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json: Envelope | null = null;
  try {
    json = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error;
    const apiError = new ApiError({
      status: res.status,
      code: err?.code ?? (res.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'UNKNOWN'),
      message: err?.message ?? (res.status >= 500 ? tStatic('common.error.SERVICE_UNAVAILABLE') : tStatic('common.error.requestFailed', { status: String(res.status) })),
      retryable: err?.retryable ?? res.status >= 500,
      fieldErrors: err?.field_errors,
      details: err?.details ? fromWire<Record<string, unknown>>(err.details) : undefined,
      requestId: json?.meta?.request_id ?? res.headers.get('x-request-id'),
    });
    if (typeof window !== 'undefined' && !opts.quietAuth) {
      if (res.status === 401 && apiError.code === 'AUTH_REQUIRED') window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw apiError;
  }
  return json;
}

async function call<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
  const env = await send(method, path, opts);
  return fromWire<T>(env?.data ?? null);
}

async function paged<T>(path: string, query?: Query, signal?: AbortSignal): Promise<Paged<T>> {
  const env = await send('GET', path, { query, signal });
  const items = fromWire<T[]>(env?.data ?? []);
  return { items: Array.isArray(items) ? items : [], nextCursor: env?.page?.next_cursor ?? null, hasMore: !!env?.page?.has_more, total: env?.page?.total };
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'query' | 'body'>) => call<T>('GET', path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => call<T>('POST', path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => call<T>('PUT', path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => call<T>('PATCH', path, { ...opts, body: body ?? {} }),
  delete: <T = null>(path: string, opts?: RequestOptions) => call<T>('DELETE', path, opts),
  page: paged,
  /** Absolute same-origin URL for downloads (CSV exports, transcripts). */
  url: (path: string, query?: Query) => buildUrl(path, query),
};
