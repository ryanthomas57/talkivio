/**
 * Tiny typed fetch wrapper over the generated OpenAPI `paths` (contracts/openapi.yaml).
 *
 *   const api = createClient({ baseUrl: 'https://api.example.com', credentials: 'include', csrf: readCsrfCookie });
 *   const { data: chat } = await api.get('/api/v1/chats/{id}', { params: { id } });
 *   await api.post('/api/v1/chats/{id}/messages', { params: { id }, body: { clientMessageId, body: 'Hi' } });
 *
 * Request bodies and query parameters are written in camelCase and sent as snake_case;
 * `data` / `page` come back camelCased (opaque maps untouched) — see `wire.ts`.
 * Non-2xx responses throw `TalkivioError` carrying the `{error, meta}` envelope.
 */
import type { components, paths } from './generated/openapi.ts';
import { fromWire, toWire, type Camelize } from './wire.ts';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 206;

/** Paths that support `M`. */
export type PathsFor<M extends HttpMethod> = { [P in keyof paths]: [NonNullable<paths[P][M]>] extends [never] ? never : P }[keyof paths];
/** Operation object for a path + method. */
export type Operation<P extends keyof paths, M extends HttpMethod> = NonNullable<paths[P][M]>;

type PathParamsOf<O> = O extends { parameters: { path: infer X } } ? X : never;
type QueryOf<O> = O extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;
type RequiredBodyOf<O> = O extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
type OptionalBodyOf<O> = O extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;
type ResponsesOf<O> = O extends { responses: infer R } ? R : never;
type SuccessBody<O> = {
  [S in keyof ResponsesOf<O>]: S extends SuccessStatus ? (ResponsesOf<O>[S] extends { content: { 'application/json': infer B } } ? B : never) : never;
}[keyof ResponsesOf<O>];

/** Wire (snake_case) `data` type of an operation's success envelope. */
export type WireData<O> = SuccessBody<O> extends { data: infer D } ? D : undefined;
/** camelCase `data` type of an operation's success envelope. */
export type ResponseData<O> = Camelize<WireData<O>>;
type PageOf<O> = SuccessBody<O> extends { page: infer Pg } ? Camelize<Pg> : undefined;

export type RequestOptions<O> = ([PathParamsOf<O>] extends [never] ? { params?: undefined } : { params: PathParamsOf<O> }) &
  ([QueryOf<O>] extends [never] ? { query?: undefined } : { query?: Camelize<QueryOf<O>> }) &
  ([RequiredBodyOf<O>] extends [never]
    ? [OptionalBodyOf<O>] extends [never]
      ? { body?: undefined }
      : { body?: Camelize<OptionalBodyOf<O>> }
    : { body: Camelize<RequiredBodyOf<O>> }) & {
    /** Extra request headers. */
    headers?: Record<string, string>;
    /** `Idempotency-Key` for command POSTs (16–128 URL-safe characters). */
    idempotencyKey?: string;
    /** `If-Match` entity version for versioned writes. */
    ifMatch?: string | number;
    signal?: AbortSignal;
  };

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Args<O> = [RequiredKeys<RequestOptions<O>>] extends [never] ? [options?: RequestOptions<O>] : [options: RequestOptions<O>];

export interface ApiResponse<O> {
  status: number;
  data: ResponseData<O>;
  /** Present on paged lists (`{data, page:{next_cursor,has_more}, meta}`). */
  page: PageOf<O>;
  requestId: string | undefined;
  headers: Headers;
}

export type ErrorCode = components['schemas']['ErrorCode'];

/** Non-2xx response (`{error:{code,message,retryable,field_errors?}, meta}`). */
export class TalkivioError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK';
  readonly retryable: boolean;
  /** snake_case field path → messages. */
  readonly fieldErrors: Record<string, string[]> | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(status: number, body: { error?: { code?: string; message?: string; retryable?: boolean; field_errors?: Record<string, string[]>; details?: unknown }; meta?: { request_id?: string } } | null, retryAfter?: number) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = 'TalkivioError';
    this.status = status;
    this.code = (body?.error?.code as ErrorCode | undefined) ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
    this.retryable = body?.error?.retryable ?? status >= 500;
    this.fieldErrors = body?.error?.field_errors;
    this.details = body?.error?.details === undefined ? undefined : fromWire(body.error.details);
    this.requestId = body?.meta?.request_id;
    this.retryAfter = retryAfter;
  }
}

export interface ClientOptions {
  /** API origin, e.g. `https://api.example.com` (paths already include `/api/v1` or `/widget/v1`). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Dashboard sessions: `credentials: 'include'` so the `rd_session` cookie is sent. */
  credentials?: RequestCredentials;
  /** Returns the session CSRF token (the `rd_csrf` cookie) for non-GET requests. */
  csrf?: () => string | null | undefined;
  /** `rdt_…` integration token or `rdv1.…` visitor capability. */
  bearer?: string | (() => string | null | undefined);
  headers?: Record<string, string>;
}

type AnyOptions = {
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  ifMatch?: string | number;
  signal?: AbortSignal;
};

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send(method: HttpMethod, path: string, o: AnyOptions = {}): Promise<Response> {
    const url = path.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = o.params?.[k];
      if (v === undefined) throw new Error(`Missing path parameter "${k}" for ${path}`);
      return encodeURIComponent(String(v));
    });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries((toWire(o.query ?? {}) as Record<string, unknown>) ?? {})) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers, ...o.headers };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    if (o.ifMatch !== undefined) headers['if-match'] = typeof o.ifMatch === 'number' ? `"${o.ifMatch}"` : o.ifMatch;
    const bearer = typeof options.bearer === 'function' ? options.bearer() : options.bearer;
    if (bearer && !headers.authorization) headers.authorization = `Bearer ${bearer}`;
    if (method !== 'get') {
      const csrf = options.csrf?.();
      if (csrf) headers['x-csrf-token'] = csrf;
    }
    const query = qs.toString();
    return doFetch(`${base}${url}${query ? `?${query}` : ''}`, {
      method: method.toUpperCase(),
      headers,
      credentials: options.credentials,
      body: o.body === undefined ? undefined : JSON.stringify(toWire(o.body)),
      signal: o.signal,
    });
  }

  async function request<O>(method: HttpMethod, path: string, o?: AnyOptions): Promise<ApiResponse<O>> {
    let res: Response;
    try {
      res = await send(method, path, o);
    } catch (err) {
      const e = new TalkivioError(0, { error: { code: 'SERVICE_UNAVAILABLE', message: (err as Error).message, retryable: true } });
      Object.assign(e, { code: 'NETWORK' });
      throw e;
    }
    const text = res.status === 204 ? '' : await res.text();
    const json = text && (res.headers.get('content-type') ?? '').includes('json') ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      throw new TalkivioError(res.status, json as ConstructorParameters<typeof TalkivioError>[1], retryAfter);
    }
    const meta = (json?.meta ?? {}) as { request_id?: string };
    return {
      status: res.status,
      data: (json ? fromWire(json.data) : undefined) as ResponseData<O>,
      page: (json?.page ? fromWire(json.page) : undefined) as PageOf<O>,
      requestId: meta.request_id ?? res.headers.get('x-request-id') ?? undefined,
      headers: res.headers,
    };
  }

  return {
    get: <P extends PathsFor<'get'>>(path: P, ...args: Args<Operation<P, 'get'>>) => request<Operation<P, 'get'>>('get', path, args[0] as AnyOptions),
    post: <P extends PathsFor<'post'>>(path: P, ...args: Args<Operation<P, 'post'>>) => request<Operation<P, 'post'>>('post', path, args[0] as AnyOptions),
    put: <P extends PathsFor<'put'>>(path: P, ...args: Args<Operation<P, 'put'>>) => request<Operation<P, 'put'>>('put', path, args[0] as AnyOptions),
    patch: <P extends PathsFor<'patch'>>(path: P, ...args: Args<Operation<P, 'patch'>>) => request<Operation<P, 'patch'>>('patch', path, args[0] as AnyOptions),
    delete: <P extends PathsFor<'delete'>>(path: P, ...args: Args<Operation<P, 'delete'>>) => request<Operation<P, 'delete'>>('delete', path, args[0] as AnyOptions),
    /** Raw response (CSV, file downloads, redirects) with the same auth headers. */
    raw: (method: HttpMethod, path: string, o?: AnyOptions) => send(method, path, o),
  };
}

export type TalkivioClient = ReturnType<typeof createClient>;
