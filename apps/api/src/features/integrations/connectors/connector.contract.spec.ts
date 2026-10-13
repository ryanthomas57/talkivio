/**
 * Connector contract tests (ch. 55/56). Every adapter must pass this suite against
 * its provider double: success, idempotent retry, retry classification (429/5xx),
 * permanent failure, invalid credentials and subject deletion — without ever
 * reporting success the provider did not state. The provider here is the in-process
 * TEST-ONLY mock; no real provider is contacted or claimed to work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ConnectorAdapter,
  type ConnectorContext,
  ConnectorError,
  classifyProviderStatus,
  type TicketInput,
} from './connector';
import { CONNECTOR_CATALOG, ConnectorRegistry } from './connectors.service';
import { MockTicketAdapter, type MockProvider, startMockProvider } from './mock-provider.testonly';

const ticket: TicketInput = {
  sourceType: 'chat',
  sourceId: '00000000-0000-4000-8000-000000000001',
  subject: 'Chat #1',
  publicTranscript: [{ at: '2026-10-12T08:00:00Z', author: 'visitor', text: 'Hello' }],
  requester: { verified: false, displayName: 'Visitor', email: null },
  siteId: '00000000-0000-4000-8000-000000000002',
  departmentId: null,
  tags: [],
};

async function expectKind(p: Promise<unknown>, kind: ConnectorError['kind']): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).kind).toBe(kind);
    return err as ConnectorError;
  }
  throw new Error(`expected ${kind}`);
}

function contract(
  name: string,
  setup: () => Promise<{
    adapter: ConnectorAdapter;
    provider: MockProvider;
    ctx: (key?: string) => ConnectorContext;
  }>,
) {
  describe(`${name} connector contract`, () => {
    let env: Awaited<ReturnType<typeof setup>>;
    beforeAll(async () => {
      env = await setup();
    });
    afterAll(async () => env.provider.close());

    it('authenticates and health-checks', async () => {
      await expect(env.adapter.authenticate(env.ctx())).resolves.toEqual({
        accountLabel: expect.stringContaining('test mode'),
      });
      await expect(env.adapter.healthCheck(env.ctx())).resolves.toEqual({ healthy: true, detail: 'ok' });
    });

    it('creates a ticket and returns the same external id on retry with the same idempotency key', async () => {
      const a = await env.adapter.createTicket!(env.ctx('k-1'), ticket);
      const b = await env.adapter.createTicket!(env.ctx('k-1'), ticket);
      expect(a.created).toBe(true);
      expect(b).toEqual({ externalId: a.externalId, created: false });
      expect(env.provider.requests.filter((r) => r.idempotencyKey === 'k-1')).toHaveLength(2);
    });

    it('classifies 429 (with Retry-After) and 5xx as retryable', async () => {
      env.provider.failNext(429, 7);
      const e = await expectKind(env.adapter.createTicket!(env.ctx('k-2'), ticket), 'retryable');
      expect(e.retryAfterMs).toBe(7000);
      env.provider.failNext(503);
      await expectKind(env.adapter.createTicket!(env.ctx('k-2'), ticket), 'retryable');
      const ok = await env.adapter.createTicket!(env.ctx('k-2'), ticket);
      expect(ok.created).toBe(true);
    });

    it('classifies validation errors as permanent', async () => {
      await expectKind(env.adapter.createTicket!(env.ctx('k-3'), { ...ticket, subject: '' }), 'permanent');
    });

    it('reports invalid credentials distinctly and the health check fails honestly', async () => {
      const bad = { ...env.ctx(), credentials: { api_key: 'wrong' } };
      await expectKind(env.adapter.authenticate(bad), 'invalid_credentials');
      await expect(env.adapter.healthCheck(bad)).resolves.toEqual({
        healthy: false,
        detail: 'invalid_credentials',
      });
    });

    it('distinguishes confirmed deletion from an accepted (pending) request', async () => {
      const { externalId } = await env.adapter.createTicket!(env.ctx('k-4'), ticket);
      env.provider.setErasureMode('accepted');
      const accepted = await env.adapter.eraseSubject!(env.ctx('e-1'), {
        externalIds: [externalId],
        subjectRef: 'v:abc',
      });
      expect(accepted.status).toBe('accepted');
      expect(env.provider.tickets.has(externalId)).toBe(true);
      env.provider.setErasureMode('confirmed');
      const confirmed = await env.adapter.eraseSubject!(env.ctx('e-2'), {
        externalIds: [externalId],
        subjectRef: 'v:abc',
      });
      expect(confirmed.status).toBe('confirmed');
      expect(env.provider.tickets.has(externalId)).toBe(false);
    });

    it('treats network failures as retryable', async () => {
      const down = new MockTicketAdapter('http://127.0.0.1:9');
      await expectKind(down.createTicket(env.ctx('k-5'), ticket), 'retryable');
    });
  });
}

contract('mock ticketing (TEST MODE)', async () => {
  const provider = await startMockProvider();
  const adapter = new MockTicketAdapter(provider.url);
  return {
    adapter,
    provider,
    ctx: (key = 'k-0') => ({
      tenantId: 't-1',
      credentials: { api_key: provider.apiKey },
      idempotencyKey: key,
      timeoutMs: 2000,
    }),
  };
});

describe('connector framework', () => {
  it('classifies provider statuses', () => {
    expect(classifyProviderStatus(201)).toBe('ok');
    expect(classifyProviderStatus(401)).toBe('invalid_credentials');
    expect(classifyProviderStatus(429)).toBe('retryable');
    expect(classifyProviderStatus(502)).toBe('retryable');
    expect(classifyProviderStatus(422)).toBe('permanent');
  });

  it('ships no working third-party adapter and refuses test doubles in production', () => {
    const registry = new ConnectorRegistry();
    for (const d of CONNECTOR_CATALOG) expect(registry.adapter(d.key)).toBeNull();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => registry.register(new MockTicketAdapter('http://127.0.0.1:1'))).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
