#!/usr/bin/env node
// Talkivio local webhook receiver — a dependency-free test double for the outbound
// webhook contract (ch. 55). Verifies X-Talkivio-Signature over the raw body, rejects
// timestamps older than 5 minutes, de-duplicates event ids, can simulate failures, and
// lists what it received at GET /events for end-to-end tests.
//
// Environment:
//   PORT=4196 HOST=127.0.0.1          listen address (use HOST=0.0.0.0 inside Compose)
//   WEBHOOK_SECRET=whsec_a,whsec_b     accepted signing secrets (comma separated)
//   FAIL_FIRST_N=0                     fail the first N attempts of every event id
//   FAIL_STATUS=500                    status used for simulated failures (500, 429, 503, 400 …)
//   RETRY_AFTER=                       Retry-After seconds sent with simulated 429/503
//   TOLERANCE_SECONDS=300              timestamp window
//   CONTROL_TOKEN=                     when set, /_control and DELETE /events require `Authorization: Bearer <token>`
//
// Endpoints:
//   POST /<any path>     webhook delivery
//   GET  /events         {received:[…unique events…], attempts:[…every attempt…], config:{…}}
//   DELETE /events       reset state
//   POST /_control       {secrets?, fail_first_n?, fail_status?, retry_after?} runtime reconfiguration
//   GET  /health         liveness
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const env = process.env;
const state = {
  secrets: (env.WEBHOOK_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  failFirstN: Number(env.FAIL_FIRST_N ?? 0) || 0,
  failStatus: Number(env.FAIL_STATUS ?? 500) || 500,
  retryAfter: env.RETRY_AFTER ? String(env.RETRY_AFTER) : null,
  tolerance: Number(env.TOLERANCE_SECONDS ?? 300) || 300,
  controlToken: env.CONTROL_TOKEN || null,
};
const MAX_BODY = 1024 * 1024;
let received = []; // first successful delivery per event id
let attempts = []; // every request, including rejected and failed ones
let seen = new Map(); // event id → attempt count

function sign(secret, timestamp, raw) {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

function verify(header, timestamp, raw) {
  if (!header || !timestamp || !/^\d{1,12}$/.test(timestamp)) return 'missing_signature';
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > state.tolerance) return 'stale_timestamp';
  const candidates = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='))
    .map((p) => Buffer.from(p.slice(3)));
  for (const secret of state.secrets) {
    const expected = Buffer.from(sign(secret, timestamp, raw));
    if (candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected))) return null;
  }
  return 'bad_signature';
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return !state.controlToken || req.headers.authorization === `Bearer ${state.controlToken}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/events') {
      return json(res, 200, {
        received,
        attempts,
        config: {
          secrets: state.secrets.length,
          fail_first_n: state.failFirstN,
          fail_status: state.failStatus,
          retry_after: state.retryAfter,
        },
      });
    }
    if (req.method === 'DELETE' && path === '/events') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      received = [];
      attempts = [];
      seen = new Map();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/_control') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (Array.isArray(body.secrets)) state.secrets = body.secrets.map(String);
      if (body.fail_first_n !== undefined) state.failFirstN = Number(body.fail_first_n) || 0;
      if (body.fail_status !== undefined) state.failStatus = Number(body.fail_status) || 500;
      if (body.retry_after !== undefined)
        state.retryAfter = body.retry_after === null ? null : String(body.retry_after);
      return json(res, 200, {
        ok: true,
        config: {
          secrets: state.secrets.length,
          fail_first_n: state.failFirstN,
          fail_status: state.failStatus,
          retry_after: state.retryAfter,
        },
      });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    const raw = (await readBody(req)).toString('utf8'); // verify the exact bytes received
    const eventId = String(req.headers['x-talkivio-event-id'] ?? '');
    const timestamp = String(req.headers['x-talkivio-timestamp'] ?? '');
    const attempt = {
      at: new Date().toISOString(),
      path,
      event_id: eventId,
      event_type: String(req.headers['x-talkivio-event-type'] ?? ''),
      delivery_attempt: Number(req.headers['x-talkivio-delivery-attempt'] ?? 0),
      outcome: '',
    };
    attempts.push(attempt);

    const problem = verify(req.headers['x-talkivio-signature'], timestamp, raw);
    if (problem) {
      attempt.outcome = `rejected:${problem}`;
      return json(res, 401, { error: problem });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      attempt.outcome = 'rejected:invalid_json';
      return json(res, 400, { error: 'invalid_json' });
    }
    if (body.id !== eventId) {
      attempt.outcome = 'rejected:event_id_mismatch';
      return json(res, 400, { error: 'event_id_mismatch' });
    }
    const count = (seen.get(eventId) ?? 0) + 1;
    seen.set(eventId, count);
    if (count <= state.failFirstN) {
      attempt.outcome = `simulated_${state.failStatus}`;
      const headers =
        state.retryAfter !== null && (state.failStatus === 429 || state.failStatus === 503)
          ? { 'retry-after': state.retryAfter }
          : {};
      return json(res, state.failStatus, { error: 'simulated failure', attempt: count }, headers);
    }
    if (received.some((e) => e.id === eventId)) {
      attempt.outcome = 'duplicate';
      return json(res, 200, { ok: true, duplicate: true });
    }
    received.push({
      id: body.id,
      type: body.type,
      version: body.version,
      occurred_at: body.occurred_at,
      tenant_id: body.tenant_id,
      data: body.data,
      received_at: attempt.at,
      attempts: count,
    });
    attempt.outcome = 'accepted';
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, err.message === 'too_large' ? 413 : 400, {
      error: err.message === 'too_large' ? 'too_large' : 'bad_request',
    });
  }
});

const port = Number(env.PORT ?? 4196);
const host = env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(
    `Talkivio webhook receiver listening on http://${host}:${port} (secrets: ${state.secrets.length}, fail_first_n: ${state.failFirstN}, fail_status: ${state.failStatus})`,
  );
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
