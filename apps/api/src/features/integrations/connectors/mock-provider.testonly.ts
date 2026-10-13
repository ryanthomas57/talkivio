/**
 * ⚠ TEST ONLY — in-process mock ticket/CRM provider and its adapter, used solely by
 * the connector contract tests (ch. 56: "mock provider servers only as test doubles
 * for adapter contract testing, visibly marked test mode"). Never imported by the
 * application module graph and refused by ConnectorRegistry in production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  type ChatExportInput,
  type ConnectorAdapter,
  type ConnectorContext,
  ConnectorError,
  classifyProviderStatus,
  type SubjectErasureInput,
  type SubjectErasureResult,
  type TicketInput,
} from './connector';

export interface MockProvider {
  url: string;
  apiKey: string;
  requests: Array<{ method: string; path: string; idempotencyKey: string | null }>;
  tickets: Map<string, { id: string; subject: string; revision: number }>;
  /** Queue one scripted response for the next request (status, optional Retry-After seconds). */
  failNext(status: number, retryAfterSeconds?: number): void;
  /** Make erasure answer 202 (accepted, pending) instead of 200 (confirmed). */
  setErasureMode(mode: 'confirmed' | 'accepted'): void;
  close(): Promise<void>;
}

export async function startMockProvider(apiKey = `mock_${randomUUID()}`): Promise<MockProvider> {
  const scripted: Array<{ status: number; retryAfter?: number }> = [];
  const requests: MockProvider['requests'] = [];
  const tickets = new Map<string, { id: string; subject: string; revision: number }>();
  const byIdempotency = new Map<string, string>();
  let erasureMode: 'confirmed' | 'accepted' = 'confirmed';

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-test-mode': 'mock-provider', ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const idem = (req.headers['idempotency-key'] as string | undefined) ?? null;
    requests.push({ method: req.method ?? 'GET', path, idempotencyKey: idem });
    if (req.headers.authorization !== `Bearer ${apiKey}`)
      return send(res, 401, { error: 'invalid_credentials' });
    const next = scripted.shift();
    if (next)
      return send(
        res,
        next.status,
        { error: 'scripted' },
        next.retryAfter !== undefined ? { 'retry-after': String(next.retryAfter) } : {},
      );
    const body = await readJson(req);
    if (req.method === 'GET' && path === '/me')
      return send(res, 200, { account: 'Mock Account (test mode)' });
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && path === '/tickets') {
      if (typeof body.subject !== 'string' || !body.subject)
        return send(res, 422, { error: 'subject_required' });
      if (idem && byIdempotency.has(idem))
        return send(res, 200, { id: byIdempotency.get(idem), created: false });
      const id = `T-${tickets.size + 1}`;
      tickets.set(id, { id, subject: body.subject, revision: 1 });
      if (idem) byIdempotency.set(idem, id);
      return send(res, 201, { id, created: true });
    }
    const patch = /^\/tickets\/([\w-]+)$/.exec(path);
    if (req.method === 'PATCH' && patch) {
      const t = tickets.get(patch[1]);
      if (!t) return send(res, 404, { error: 'not_found' });
      t.revision += 1;
      return send(res, 200, { id: t.id, revision: t.revision });
    }
    if (req.method === 'POST' && path === '/exports')
      return send(res, 201, { id: `E-${randomUUID().slice(0, 8)}` });
    if (req.method === 'POST' && path === '/subjects/erase') {
      const ids = Array.isArray(body.external_ids) ? body.external_ids : [];
      if (erasureMode === 'confirmed') {
        for (const id of ids) tickets.delete(String(id));
        return send(res, 200, { status: 'deleted', request_id: null });
      }
      return send(res, 202, { status: 'pending', request_id: `DR-${randomUUID().slice(0, 8)}` });
    }
    return send(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    tickets,
    failNext: (status, retryAfter) => scripted.push({ status, retryAfter }),
    setErasureMode: (m) => (erasureMode = m),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** ⚠ TEST ONLY adapter speaking the mock provider's API. */
export class MockTicketAdapter implements ConnectorAdapter {
  readonly key = 'mock-ticketing';
  readonly displayName = 'Mock ticketing provider (TEST MODE)';
  readonly category = 'test' as const;
  readonly capabilities = ['createTicket', 'updateTicket', 'exportChat', 'eraseSubject'] as const;
  readonly testOnly = true;

  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    ctx: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.credentials.api_key ?? ''}`,
          'idempotency-key': ctx.idempotencyKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    } catch (err) {
      throw new ConnectorError('retryable', `Network error: ${(err as Error).name}`);
    }
    const kind = classifyProviderStatus(res.status);
    if (kind !== 'ok') {
      const ra = res.headers.get('retry-after');
      throw new ConnectorError(
        kind,
        `Provider responded ${res.status}`,
        res.status,
        ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : null,
      );
    }
    return { status: res.status, json: (await res.json()) as T };
  }

  async authenticate(ctx: ConnectorContext) {
    const r = await this.call<{ account: string }>(ctx, 'GET', '/me');
    return { accountLabel: r.json.account };
  }

  async healthCheck(ctx: ConnectorContext) {
    try {
      await this.call(ctx, 'GET', '/health');
      return { healthy: true, detail: 'ok' };
    } catch (err) {
      return { healthy: false, detail: err instanceof ConnectorError ? err.kind : 'error' };
    }
  }

  async createTicket(ctx: ConnectorContext, input: TicketInput) {
    const r = await this.call<{ id: string; created: boolean }>(ctx, 'POST', '/tickets', {
      subject: input.subject,
      comments: input.publicTranscript.map((m) => ({ author: m.author, body: m.text, at: m.at })),
      requester: { name: input.requester.displayName, verified: input.requester.verified },
      tags: input.tags,
    });
    return { externalId: r.json.id, created: r.json.created };
  }

  async updateTicket(ctx: ConnectorContext, externalId: string) {
    const r = await this.call<{ id: string; revision: number }>(
      ctx,
      'PATCH',
      `/tickets/${encodeURIComponent(externalId)}`,
      {},
    );
    return { externalId: r.json.id, revision: r.json.revision };
  }

  async exportChat(ctx: ConnectorContext, input: ChatExportInput) {
    const r = await this.call<{ id: string }>(ctx, 'POST', '/exports', {
      chat_id: input.chatId,
      format: input.format,
      transcript: input.publicTranscript,
    });
    return { externalId: r.json.id };
  }

  async eraseSubject(ctx: ConnectorContext, input: SubjectErasureInput): Promise<SubjectErasureResult> {
    const r = await this.call<{ status: string; request_id: string | null }>(ctx, 'POST', '/subjects/erase', {
      external_ids: input.externalIds,
      subject_ref: input.subjectRef,
    });
    return r.status === 200 && r.json.status === 'deleted'
      ? { status: 'confirmed', externalRequestId: r.json.request_id }
      : { status: 'accepted', externalRequestId: r.json.request_id };
  }
}
