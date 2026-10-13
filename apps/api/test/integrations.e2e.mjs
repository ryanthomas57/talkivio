// Talkivio integrations + privacy end-to-end test (ch. 53/54/55/56; HOOK01, JOB01, PRIV01, PRIV02, SSRF).
// Real HTTP, PostgreSQL, Redis, BullMQ worker, object storage and a real webhook receiver — no mocks.
//
// Prerequisites (see docs/dev/backend-conventions.md "Running an isolated copy"):
//   API (with TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true, TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS=127.0.0.1:<RECEIVER_PORT>,
//        TALKIVIO_WEBHOOK_RETRY_SCHEDULE_MS=0,1000,2000,500,500,500,500,500) on API_URL,
//   the worker with the same environment, and a second API WITHOUT the private exception on API_URL_NO_PRIVATE.
// Env: API_URL, API_URL_NO_PRIVATE, DATABASE_OWNER_URL, REDIS_URL, STORAGE_LOCAL_DIR, BUILD_DIR, RECEIVER_PORT.
// The test starts its own webhook receiver (infra/webhook-receiver/server.mjs).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { io } from 'socket.io-client';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const API = process.env.API_URL ?? 'http://localhost:4106';
const API2 = process.env.API_URL_NO_PRIVATE ?? 'http://localhost:4107';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/6';
const STORAGE_DIR = resolve(apiRoot, process.env.STORAGE_LOCAL_DIR ?? './storage');
const BUILD_DIR = resolve(apiRoot, process.env.BUILD_DIR ?? '.build/integrations');
const RECEIVER_PORT = Number(process.env.RECEIVER_PORT ?? 4196);
const RECEIVER = `http://127.0.0.1:${RECEIVER_PORT}`;
if (!OWNER_DB) throw new Error('DATABASE_OWNER_URL is required (psql verification of stores)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const waitFor = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
};
const psql = (sql, db = OWNER_DB) =>
  execFileSync('psql', [db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]).toString().trim();

class Client {
  constructor(name, base = API) {
    this.name = name;
    this.base = base;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  url(path) {
    return `${this.base}${path.startsWith('/widget') || path.startsWith('/health') ? '' : '/api/v1'}${path}`;
  }
  async raw(method, path, body, extra = {}) {
    const res = await fetch(this.url(path), {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: this.cookieHeader(),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) this.cookies[k] = decodeURIComponent(v);
      else delete this.cookies[k];
    }
    return res;
  }
  async call(method, path, body, extra = {}) {
    const res = await this.raw(method, path, body, extra);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: res.status,
      json,
      data: json?.data,
      error: json?.error,
      headers: res.headers,
      text,
      page: json?.page,
    };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

async function tokenCall(token, method, path, body) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const receiver = {
  async events() {
    return (await fetch(`${RECEIVER}/events`)).json();
  },
  async control(body) {
    const r = await fetch(`${RECEIVER}/_control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('receiver control failed');
  },
  async reset() {
    await fetch(`${RECEIVER}/events`, { method: 'DELETE' });
  },
};

// ───────────────────────── Start the local webhook receiver ─────────────────────────
const receiverProc = spawn(process.execPath, [resolve(apiRoot, '../../infra/webhook-receiver/server.mjs')], {
  env: {
    ...process.env,
    PORT: String(RECEIVER_PORT),
    HOST: '127.0.0.1',
    FAIL_FIRST_N: '2',
    FAIL_STATUS: '500',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const cleanup = () => receiverProc.kill('SIGTERM');
process.on('exit', cleanup);
await waitFor(
  async () => (await fetch(`${RECEIVER}/health`).catch(() => null))?.ok,
  5000,
  'webhook receiver',
);

const stamp = Date.now();
const CANARY = `zqx${stamp}canary`;
const SECOND = `secondvisitor${stamp}marker`;
const NOTE = `staffnote${stamp}marker`;

console.log('Setup — tenant, site, owner online');
const owner = new Client('owner');
const signup = await owner.must('POST', '/auth/signup', {
  email: `owner+int${stamp}@example.com`,
  password: 'correct horse battery staple',
  tenant_name: `Integrations ${stamp}`,
  timezone: 'UTC',
});
const tenantId = signup.me.active_tenant_id;
ok(!!tenantId, 'owner signed up with an active tenant');
const site = await owner.must('POST', '/sites', {
  name: 'Shop',
  origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }],
});
const ownerTicket = await owner.must('POST', '/socket-ticket');
const ownerSock = await new Promise((res, rej) => {
  const s = io(`${API}/agent`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket: ownerTicket.ticket },
    forceNew: true,
  });
  s.on('auth.ok', () => res(s));
  s.on('connect_error', (e) => rej(new Error(`agent socket: ${e.message}`)));
});
await owner.must('PUT', '/agents/me/presence', { status: 'online' });

// ───────────────────────── Integration tokens ─────────────────────────
console.log('Integration tokens (ch. 55)');
const created = await owner.call(
  'POST',
  '/integration-tokens',
  { name: 'CI reader', scopes: ['chats:read'] },
  { 'idempotency-key': `tok-${stamp}-0001` },
);
ok(
  created.status === 201 &&
    /^rdt_[0-9a-f]{8}_[\w-]{40,}$/.test(created.data.token) &&
    created.data.token_shown_once,
  'token created (201) in rdt_<prefix>_<secret> format, shown once',
);
const token = created.data.token;
ok(Date.parse(created.data.expires_at) - Date.now() > 89 * 86_400_000, 'default expiry is 90 days');
const replay = await owner.call(
  'POST',
  '/integration-tokens',
  { name: 'CI reader', scopes: ['chats:read'] },
  { 'idempotency-key': `tok-${stamp}-0001` },
);
ok(
  replay.status === 201 && replay.data.id === created.data.id && replay.data.token === null,
  'idempotent replay returns the same token metadata without the secret',
);
const listed = await owner.call('GET', '/integration-tokens');
ok(
  listed.data.some((t) => t.id === created.data.id && t.status === 'active') && !listed.text.includes(token),
  'list shows metadata only, never the secret',
);
const hashStored = psql(`SELECT secret_hash FROM integration_credentials WHERE id = '${created.data.id}'`);
ok(hashStored === createHash('sha256').update(token).digest('hex'), 'only sha256(token) is stored');
ok(
  (await owner.call('POST', '/integration-tokens', { name: 'bad', scopes: ['chats:read', 'root:all'] }))
    .status === 422,
  'unknown scope rejected (422)',
);

const inScope = await tokenCall(token, 'GET', '/chats/history');
ok(inScope.status === 200, 'token call within scope (chats:read → GET /chats/history) succeeds');
const outScope = await tokenCall(token, 'GET', '/webhooks');
ok(
  outScope.status === 403 && outScope.json.error.code === 'PERMISSION_DENIED',
  'token call outside scope (GET /webhooks) → 403',
);
ok(
  (await tokenCall(token, 'GET', '/audit-events')).status === 403,
  'audit trail is not available to integration tokens',
);
ok(
  (await tokenCall(token, 'POST', '/integration-tokens', { name: 'x', scopes: ['chats:read'] })).status ===
    403,
  'tokens cannot mint tokens',
);

const rotated = await owner.call('POST', `/integration-tokens/${created.data.id}/rotate`);
ok(
  rotated.status === 200 && rotated.data.token && rotated.data.token !== token,
  'rotation issues a new secret',
);
ok(
  (await tokenCall(token, 'GET', '/chats/history')).status === 401,
  'old secret stops working immediately after rotation',
);
const token2 = rotated.data.token;
ok((await tokenCall(token2, 'GET', '/chats/history')).status === 200, 'rotated secret works');
ok((await owner.call('DELETE', `/integration-tokens/${created.data.id}`)).status === 204, 'revoke → 204');
const afterRevoke = await tokenCall(token2, 'GET', '/chats/history');
ok(
  afterRevoke.status === 401 && afterRevoke.json.error.code === 'TOKEN_EXPIRED',
  'revoked token → 401 on the next request (guard re-resolves every request)',
);
ok(
  (await owner.call('DELETE', `/integration-tokens/${created.data.id}`)).status === 204,
  'revoke is idempotent',
);
const hookToken = (
  await owner.must('POST', '/integration-tokens', { name: 'Hook admin', scopes: ['webhooks:manage'] })
).token;
ok(
  (await tokenCall(hookToken, 'GET', '/webhooks')).status === 200,
  'webhooks:manage token may manage webhooks',
);

// ───────────────────────── Webhooks: SSRF ─────────────────────────
console.log('Webhooks — SSRF validation (save time)');
const allTypes = [
  'chat.requested',
  'chat.started',
  'chat.closed',
  'rating.updated',
  'offline.submitted',
  'privacy.erased',
  'trigger.webhook',
];
for (const url of [
  'http://169.254.169.254/latest/meta-data',
  'http://10.0.0.5/hook',
  `http://127.0.0.1:${RECEIVER_PORT + 1}/hook`,
  'http://[::ffff:127.0.0.1]/x',
  'ftp://example.com/x',
  'http://user:pass@example.com/x',
]) {
  const r = await owner.call('POST', '/webhooks', { url, event_types: ['chat.closed'] });
  ok(
    r.status === 422 && r.error.field_errors?.url,
    `rejected: ${url} (${r.error?.details?.reason ?? r.error?.code})`,
  );
}
const owner2 = new Client('owner@no-private-api', API2);
owner2.cookies = { ...owner.cookies };
for (const url of [`http://127.0.0.1:${RECEIVER_PORT}/hooks`, 'http://169.254.169.254/latest/meta-data']) {
  const r = await owner2.call('POST', '/webhooks', { url, event_types: ['chat.closed'] });
  ok(r.status === 422 && r.error.details?.reason === 'blocked_address', `private flag off: ${url} rejected`);
}

const hook = await owner.call('POST', '/webhooks', {
  url: `http://127.0.0.1:${RECEIVER_PORT}/hooks`,
  event_types: allTypes,
  description: 'local receiver',
});
ok(
  hook.status === 201 && /^whsec_/.test(hook.data.secret) && hook.data.secret_shown_once,
  'webhook created with a one-time signing secret',
);
const hookId = hook.data.id;
let secret = hook.data.secret;
await receiver.control({ secrets: [secret], fail_first_n: 2, fail_status: 500 });
const got = await owner.call('GET', `/webhooks/${hookId}`);
ok(
  !got.text.includes(secret) &&
    got.data.secret_hint.endsWith(secret.slice(-4)) &&
    got.headers.get('etag') === `"${got.data.version}"`,
  'GET never returns the secret (masked hint + ETag)',
);
ok(
  psql(
    `SELECT signing_key_ciphertext LIKE 'v1:%' AND position('${secret}' in signing_key_ciphertext) = 0 FROM webhook_endpoints WHERE id = '${hookId}'`,
  ) === 't',
  'secret encrypted at rest (versioned ciphertext)',
);
ok(
  (await owner.call('PATCH', `/webhooks/${hookId}`, { description: 'x' })).status === 428,
  'PATCH without If-Match → 428',
);
ok(
  (await owner.call('PATCH', `/webhooks/${hookId}`, { description: 'x' }, { 'if-match': '"999"' })).status ===
    409,
  'PATCH with stale If-Match → 409',
);
const patched = await owner.call(
  'PATCH',
  `/webhooks/${hookId}`,
  { description: 'Local receiver' },
  { 'if-match': `"${got.data.version}"` },
);
ok(
  patched.status === 200 && patched.data.version === got.data.version + 1,
  'PATCH with current If-Match → 200, version bumped',
);

// ───────────────────────── Webhooks: delivery with retries ─────────────────────────
console.log('Webhooks — signed delivery, FAIL_FIRST_N=2 (500) → one success, same event id');
const v1 = new Client('visitor1');
const sess1 = await v1.must('POST', '/widget/v1/sessions', {
  site_key: site.public_key,
  host_origin: 'http://localhost:5173',
  consent: { analytics: true, policy_version: '2026-10' },
  page: {
    url: `http://localhost:5173/orders/${CANARY}`,
    title: `Order ${CANARY}`,
    referrer: 'https://www.example.org/',
  },
});
const vauth1 = { authorization: `Bearer ${sess1.capability}` };
const visitorA = sess1.visitor.id;
await v1.must(
  'POST',
  '/widget/v1/identity',
  { name: `Ada ${CANARY}`, email: `${CANARY}@example.com` },
  vauth1,
);
await v1.call(
  'POST',
  '/widget/v1/events',
  {
    events: [
      {
        id: `pe-${stamp}`,
        kind: 'entered',
        url: `http://localhost:5173/help/${CANARY}`,
        title: `Help ${CANARY}`,
      },
    ],
  },
  vauth1,
);
const chatA = (
  await v1.must(
    'POST',
    '/widget/v1/chats',
    { client_request_id: randomUUID(), message: `Hello, my order code is ${CANARY}` },
    vauth1,
  )
).chat.id;
await owner.must('POST', `/chats/${chatA}/accept`, {});
await owner.must('POST', `/chats/${chatA}/messages`, {
  client_message_id: randomUUID(),
  body: `Thanks, I found order ${CANARY}`,
});
await owner.must('POST', `/chats/${chatA}/messages`, {
  client_message_id: randomUUID(),
  visibility: 'internal',
  body: `${NOTE} regarding ${CANARY}`,
});
await v1.must(
  'POST',
  `/widget/v1/chats/${chatA}/messages`,
  { client_message_id: randomUUID(), body: `My phone is 555-0100, ref ${CANARY}` },
  vauth1,
);
// Attachment uploaded by the subject (bytes stay in quarantine without a scanner — still must be erased).
let attachmentId = null;
const fileBody = Buffer.from(`attachment containing ${CANARY}\n`);
const up = await v1.call(
  'POST',
  '/widget/v1/uploads',
  { chat_id: chatA, name: `receipt-${CANARY}.txt`, size_bytes: fileBody.length, mime: 'text/plain' },
  vauth1,
);
if (up.status < 300) {
  const put = await fetch(up.data.url, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: fileBody,
  });
  attachmentId = up.data.upload_id;
  await v1.call(
    'POST',
    `/widget/v1/uploads/${attachmentId}/finalize`,
    { sha256: createHash('sha256').update(fileBody).digest('hex') },
    vauth1,
  );
  ok(
    put.status < 300 && psql(`SELECT count(*) FROM attachments WHERE id = '${attachmentId}'`) === '1',
    'subject uploaded an attachment containing the canary',
  );
} else {
  console.log(
    `  (attachment upload unavailable: ${up.status} ${up.error?.code}; attachment erasure checked by DB scan only)`,
  );
}
await owner.must('POST', `/chats/${chatA}/close`, { reason: 'resolved' });
await v1.must(
  'PUT',
  `/widget/v1/chats/${chatA}/rating`,
  { rating: 'good', comment: `Great help with ${CANARY}` },
  vauth1,
);

const delivered = await waitFor(
  async () => {
    const ev = await receiver.events();
    const mine = ev.received.filter((e) => e.data?.chat_id === chatA);
    return ['chat.requested', 'chat.started', 'chat.closed', 'rating.updated'].every((t) =>
      mine.some((e) => e.type === t),
    )
      ? ev
      : null;
  },
  30_000,
  'four chat webhooks after retries',
);
for (const type of ['chat.requested', 'chat.started', 'chat.closed', 'rating.updated']) {
  const e = delivered.received.find((x) => x.type === type && x.data.chat_id === chatA);
  const tries = delivered.attempts.filter((a) => a.event_id === e.id);
  ok(
    e.attempts === 3 &&
      tries.length === 3 &&
      tries.map((a) => a.outcome).join(',') === 'simulated_500,simulated_500,accepted' &&
      e.version === 1 &&
      e.tenant_id === tenantId,
    `${type}: 2×500 then accepted — one success, same event id ${e.id.slice(0, 8)} on all 3 attempts`,
  );
}
ok(
  !JSON.stringify(delivered.received).includes(CANARY),
  'webhook payloads carry identifiers only (no transcript text, names, emails or comments)',
);
const deliveries = await owner.must('GET', `/webhooks/${hookId}/deliveries?status=delivered`);
ok(
  deliveries.length >= 4 &&
    deliveries.every(
      (d) => d.attempts >= 3 && d.response_status === 200 && d.response_excerpt?.length <= 1000,
    ),
  'delivery history: delivered after 3 attempts with sanitized excerpt',
);
ok(
  psql(
    `SELECT count(*) FROM webhook_deliveries WHERE endpoint_id = '${hookId}' GROUP BY event_id HAVING count(*) > 1`,
  ) === '',
  'one delivery row per (endpoint, event id)',
);

console.log('Webhooks — test event, duplicate redelivery, 429 + Retry-After, permanent 4xx, dead letter');
await receiver.control({ fail_first_n: 0 });
const testDelivery = await owner.call('POST', `/webhooks/${hookId}/test`, {});
ok(
  testDelivery.status === 202 && testDelivery.data.event_type === 'webhook.test',
  'test endpoint → 202 with a safe sample event',
);
await waitFor(
  async () => (await receiver.events()).received.some((e) => e.id === testDelivery.data.event_id),
  10_000,
  'test event',
);
const retried = await owner.call('POST', `/webhook-deliveries/${testDelivery.data.id}/retry`, {});
ok(
  retried.status === 202 && retried.data.event_id === testDelivery.data.event_id,
  'manual retry → 202 with the same event id',
);
await waitFor(
  async () =>
    (await receiver.events()).attempts.some(
      (a) => a.event_id === testDelivery.data.event_id && a.outcome === 'duplicate',
    ),
  10_000,
  'duplicate redelivery',
);
ok(
  (await receiver.events()).received.filter((e) => e.id === testDelivery.data.event_id).length === 1,
  'receiver de-duplicated the redelivered event id',
);

await receiver.control({ fail_first_n: 1, fail_status: 429, retry_after: '2' });
const t429 = (await owner.must('POST', `/webhooks/${hookId}/test`, {})).event_id;
const e429 = await waitFor(
  async () => (await receiver.events()).received.find((e) => e.id === t429),
  15_000,
  '429 retry',
);
const a429 = (await receiver.events()).attempts.filter((a) => a.event_id === t429);
ok(
  a429[0].outcome === 'simulated_429' &&
    Date.parse(a429[1].at) - Date.parse(a429[0].at) >= 1800 &&
    e429.attempts === 2,
  '429 retried after the receiver’s Retry-After (≥2 s, bounded)',
);

await receiver.control({ fail_first_n: 1, fail_status: 400, retry_after: null });
const t400 = await owner.must('POST', `/webhooks/${hookId}/test`, {});
const failed400 = await waitFor(
  async () =>
    (await owner.must('GET', `/webhooks/${hookId}/deliveries?status=failed`)).find((d) => d.id === t400.id),
  10_000,
  'permanent failure',
);
ok(
  failed400.attempts === 1 && failed400.last_error === 'http_400',
  'non-retryable 4xx stops after one attempt (status failed)',
);

await receiver.control({ fail_first_n: 100, fail_status: 503 });
const tDead = await owner.must('POST', `/webhooks/${hookId}/test`, {});
const dead = await waitFor(
  async () =>
    (await owner.must('GET', `/webhooks/${hookId}/deliveries?status=dead`)).find((d) => d.id === tDead.id),
  30_000,
  'dead letter',
);
ok(
  dead.attempts === 8 && dead.response_status === 503,
  'retries exhausted after 8 attempts → dead letter visible in history',
);
await receiver.control({ fail_first_n: 0 });
await owner.must('POST', `/webhook-deliveries/${tDead.id}/retry`, {});
await waitFor(
  async () => (await receiver.events()).received.some((e) => e.id === tDead.event_id),
  10_000,
  'dead letter redelivery',
);
ok(true, 'dead-lettered delivery redelivered by an admin with the same event id');

console.log('Webhooks — secret rotation with bounded overlap');
const rot = await owner.call('POST', `/webhooks/${hookId}/rotate-secret`, { overlap_minutes: 5 });
ok(
  rot.status === 200 &&
    rot.data.secret !== secret &&
    rot.data.signing_generation === 2 &&
    rot.data.previous_secret_expires_at,
  'rotate-secret returns a new one-time secret and the overlap end',
);
await receiver.control({ secrets: [secret] });
const tOld = (await owner.must('POST', `/webhooks/${hookId}/test`, {})).event_id;
await waitFor(
  async () => (await receiver.events()).received.some((e) => e.id === tOld),
  10_000,
  'old-secret verification during overlap',
);
ok(
  true,
  'during the overlap a receiver holding only the previous secret still verifies (v1=<new>,v1=<previous>)',
);
const newSecret = rot.data.secret;
await receiver.control({ secrets: [newSecret] });
const tNew = (await owner.must('POST', `/webhooks/${hookId}/test`, {})).event_id;
await waitFor(
  async () => (await receiver.events()).received.some((e) => e.id === tNew),
  10_000,
  'new-secret verification',
);
ok(true, 'receiver holding only the new secret verifies');
const rot2 = await owner.must('POST', `/webhooks/${hookId}/rotate-secret`, { overlap_minutes: 0 });
await receiver.control({ secrets: [newSecret] });
const tRetired = await owner.must('POST', `/webhooks/${hookId}/test`, {});
const retiredFail = await waitFor(
  async () =>
    (await owner.must('GET', `/webhooks/${hookId}/deliveries?status=failed`)).find(
      (d) => d.id === tRetired.id,
    ),
  10_000,
  'retired key rejection',
);
ok(
  retiredFail.response_status === 401,
  'after overlap 0 the retired secret no longer signs (receiver rejects → 401, permanent)',
);
secret = rot2.secret;
await receiver.control({ secrets: [secret], fail_first_n: 0 });

// ───────────────────────── Connectors ─────────────────────────
console.log('Connector framework (ch. 56)');
const connectors = await owner.must('GET', '/integrations/connectors');
ok(
  connectors.length >= 3 &&
    connectors.every(
      (c) => c.status === 'disabled' && c.status_reason === 'adapter_not_available' && c.adapter_available === false,
    ),
  'catalog lists adapters with honest status disabled (adapter not available in this release)',
);
const hc = await owner.call('POST', '/integrations/connectors/zendesk/health-check', {});
ok(
  hc.status === 409 && hc.error.code === 'INTEGRATION_UNAVAILABLE',
  'health check of an unavailable adapter → 409 INTEGRATION_UNAVAILABLE (no false success)',
);

// ───────────────────────── Privacy: seed second visitor, access export ─────────────────────────
console.log('Privacy — access request (export) for the canary visitor');
const v2 = new Client('visitor2');
const sess2 = await v2.must('POST', '/widget/v1/sessions', {
  site_key: site.public_key,
  host_origin: 'http://localhost:5173',
  consent: { analytics: true, policy_version: '2026-10' },
  page: { url: 'http://localhost:5173/pricing' },
});
const vauth2 = { authorization: `Bearer ${sess2.capability}` };
ok(sess2.visitor.id !== visitorA, 'second visitor is a different subject');
// Trigger DSL action create_webhook_job → `trigger.webhook` delivered to subscribed endpoints.
const trig = await owner.must('POST', '/triggers', {
  name: `Webhook on request ${stamp}`,
  definition: {
    dsl_version: 1,
    event: 'chat.requested',
    priority: 100,
    all: [],
    any: [],
    actions: [{ type: 'create_webhook_job', event_name: 'vip_chat' }],
    stop_processing: false,
    cooldown_seconds: 0,
  },
});
await owner.must('POST', `/triggers/${trig.id}/publish`, { revision: 1, enabled: true });
const chatB = (
  await v2.must(
    'POST',
    '/widget/v1/chats',
    { client_request_id: randomUUID(), message: `Hi there ${SECOND}` },
    vauth2,
  )
).chat.id;
const trigEvent = await waitFor(
  async () =>
    (await receiver.events()).received.find((e) => e.type === 'trigger.webhook' && e.data.chat_id === chatB),
  20_000,
  'trigger.webhook delivery',
);
ok(
  trigEvent.data.event_name === 'vip_chat' &&
    trigEvent.data.trigger_id === trig.id &&
    trigEvent.data.source_event_type === 'chat.requested',
  'trigger create_webhook_job delivered as signed `trigger.webhook` event',
);
await owner.must('POST', `/chats/${chatB}/accept`, {});
await owner.must('POST', `/chats/${chatB}/messages`, {
  client_message_id: randomUUID(),
  body: `Hello ${SECOND} reply`,
});
// A file in chat B: retention must remove its bytes with the transcript (no scanner here, so it stays in quarantine).
const retBody = Buffer.from(`invoice for ${SECOND}\n`);
const retUp = await v2.call(
  'POST',
  '/widget/v1/uploads',
  { chat_id: chatB, name: `invoice-${SECOND}.txt`, size_bytes: retBody.length, mime: 'text/plain' },
  vauth2,
);
const retAttachment = retUp.status < 300 ? retUp.data.upload_id : null;
if (retAttachment) {
  await fetch(retUp.data.url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: retBody });
  await v2.call(
    'POST',
    `/widget/v1/uploads/${retAttachment}/finalize`,
    { sha256: createHash('sha256').update(retBody).digest('hex') },
    vauth2,
  );
}
await owner.must('POST', `/chats/${chatB}/close`, { reason: 'resolved' });

const msgsBefore = (await owner.must('GET', `/chats/${chatA}/messages?limit=100`)).items;
const acc = await owner.call('POST', '/privacy/requests', {
  kind: 'access',
  visitor_id: visitorA,
  proof_reference: `TICKET-${stamp}`,
});
ok(
  acc.status === 202 && acc.data.state === 'pending_verification',
  'access request created → 202 pending_verification',
);
ok(
  (await owner.call('GET', `/privacy/requests/${acc.data.id}/export`)).status === 409,
  'no export before verification',
);
const accV = await owner.call('POST', `/privacy/requests/${acc.data.id}/verify`, {
  method: 'email_confirmation',
});
ok(accV.status === 202 && accV.data.state === 'queued', 'verification moves the request to queued (202)');
const accDone = await waitFor(
  async () => {
    const r = await owner.must('GET', `/privacy/requests/${acc.data.id}`);
    return r.state === 'completed' ? r : null;
  },
  30_000,
  'access export',
);
ok(
  accDone.report.export?.expires_at &&
    accDone.report.counts.messages >= 3 &&
    accDone.job.state === 'succeeded',
  'access job completed with a private, expiring export and safe counts',
);
const exportRes = await owner.call('GET', `/privacy/requests/${acc.data.id}/export`);
ok(
  exportRes.status === 200 &&
    exportRes.text.includes(CANARY) &&
    exportRes.json.subject.email === `${CANARY}@example.com`,
  'export contains the subject’s identity, messages and profile',
);
ok(
  !exportRes.text.includes(NOTE) && !exportRes.text.includes(SECOND),
  'export excludes staff internal notes and other visitors',
);
ok(
  exportRes.json.sessions.length >= 1 &&
    exportRes.json.consent_records.length >= 1 &&
    exportRes.json.chats[0].rating?.comment?.includes(CANARY),
  'export includes sessions, consent records and ratings',
);

// Backup BEFORE erasure (PRIV02 restore simulation).
const backupFile = join(BUILD_DIR, `prerase-${stamp}.dump`);
execFileSync('pg_dump', ['-Fc', '-f', backupFile, OWNER_DB]);
ok(existsSync(backupFile), 'database backup taken before erasure');

// ───────────────────────── Privacy: erasure ─────────────────────────
console.log('Privacy — erasure of the canary visitor (PRIV01)');
await receiver.reset();
await receiver.control({ secrets: [secret], fail_first_n: 0 });
const er = await owner.call('POST', '/privacy/requests', {
  kind: 'erase',
  visitor_id: visitorA,
  proof_reference: `TICKET-${stamp}-E`,
});
ok(
  er.status === 202 && er.data.state === 'pending_verification',
  'erasure request created → pending_verification',
);
ok(
  (
    await owner.call('POST', '/privacy/requests', {
      kind: 'erase',
      visitor_id: visitorA,
      proof_reference: 'dup',
    })
  ).status === 409,
  'duplicate open erasure request → 409',
);
await owner.must('POST', `/privacy/requests/${er.data.id}/verify`, { method: 'verified_identity' });
const erDone = await waitFor(
  async () => {
    const r = await owner.must('GET', `/privacy/requests/${er.data.id}`);
    if (r.state === 'failed') throw new Error(`erasure failed: ${JSON.stringify(r.report)}`);
    return r.state === 'completed' ? r : null;
  },
  60_000,
  'erasure',
);
const rep = erDone.report;
ok(
  rep.counts.messages_redacted >= 3 &&
    rep.counts.page_events_deleted >= 1 &&
    rep.counts.visitor_profiles_scrubbed === 1 &&
    rep.counts.exports_invalidated >= 1,
  `erasure report counts (messages ${rep.counts.messages_redacted}, page events ${rep.counts.page_events_deleted}, exports ${rep.counts.exports_invalidated})`,
);
ok(
  rep.stores.every((s) => s.status === 'confirmed') && rep.stores.some((s) => s.store === 'tombstone_ledger'),
  'every store confirmed (DB, search index, object storage, redis, ledger) before completion',
);
ok(
  rep.legal_hold?.modeled === false && rep.downstream.every((d) => d.status === 'not_configured'),
  'report states legal holds and downstream connectors honestly',
);
ok(!JSON.stringify(erDone).includes(CANARY), 'progress report contains no erased text');

const histCanary = await owner.must('GET', `/chats/history?q=${CANARY}`);
ok(histCanary.length === 0, 'search: GET /chats/history?q=<canary> returns nothing');
const histSecond = await owner.must('GET', `/chats/history?q=${SECOND}`);
ok(
  histSecond.some((c) => c.id === chatB),
  'search still finds the second visitor’s chat',
);
const chatAView = await owner.must('GET', `/chats/${chatA}`);
ok(
  chatAView.visitor.display_name === 'Erased visitor' && !JSON.stringify(chatAView).includes(CANARY),
  'visitor profile in the chat view is erased',
);
const msgsAfter = (await owner.must('GET', `/chats/${chatA}/messages?limit=100`)).items;
ok(
  msgsAfter.length === msgsBefore.length &&
    msgsAfter.every((m, i) => m.seq === msgsBefore[i].seq) &&
    !JSON.stringify(msgsAfter).includes(CANARY),
  'transcript rows keep seq with redaction tombstones; no canary text',
);
ok(
  msgsAfter.filter((m) => m.redacted).length >= 4,
  'subject messages, staff replies and the note in the subject’s chat are redacted',
);
const msgsB = JSON.stringify((await owner.must('GET', `/chats/${chatB}/messages?limit=100`)).items);
ok(
  msgsB.includes(`Hi there ${SECOND}`) && msgsB.includes(`Hello ${SECOND} reply`),
  'second visitor’s chat stays intact',
);
const gone = await owner.call('GET', `/privacy/requests/${acc.data.id}/export`);
ok(
  gone.status === 410 && gone.error.code === 'EXPORT_EXPIRED',
  'exports referencing the subject are invalidated (410)',
);
const oldCap = await v1.call('GET', `/widget/v1/chats/${chatA}/messages`, undefined, vauth1);
ok(!oldCap.text.includes(CANARY), 'a still-valid visitor capability cannot read erased text');
const reconnect = await new Client('visitor1-again').must('POST', '/widget/v1/sessions', {
  site_key: site.public_key,
  host_origin: 'http://localhost:5173',
  anonymous_token: sess1.anonymous_token,
});
ok(
  reconnect.visitor.id !== visitorA,
  'the subject’s browser credential is gone: a new anonymous visitor is created',
);
const erasedHook = await waitFor(
  async () =>
    (await receiver.events()).received.find(
      (e) => e.type === 'privacy.erased' && e.data.visitor_id === visitorA,
    ),
  15_000,
  'privacy.erased webhook',
);
ok(
  erasedHook.data.request_id === er.data.id,
  'privacy.erased webhook delivered (signed) with request and visitor ids',
);

// Every active store: whole-database scan, object storage, Redis.
const scanDb = (db) => {
  const tables = psql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`, db)
    .split('\n')
    .filter(Boolean);
  const hits = [];
  for (const t of tables) {
    const n = Number(psql(`SELECT count(*) FROM "${t}" x WHERE x::text LIKE '%${CANARY}%'`, db));
    if (n) hits.push(`${t}:${n}`);
  }
  return hits;
};
const hits = scanDb(OWNER_DB);
ok(hits.length === 0, `PostgreSQL: canary absent from every table (${hits.join(', ') || 'all clean'})`);
const files = [];
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(STORAGE_DIR);
const fileHits = files.filter(
  (f) => readFileSync(f).toString('latin1').includes(CANARY) || f.includes(CANARY),
);
ok(fileHits.length === 0, `object storage: no object contains the canary (${files.length} objects scanned)`);
ok(
  !attachmentId ||
    psql(
      `SELECT deleted_at IS NOT NULL AND original_name = '[erased]' AND sha256 IS NULL FROM attachments WHERE id = '${attachmentId}'`,
    ) === 't',
  'attachment erased via the files service (bytes gone, row kept as an erased tombstone)',
);
const redis = new IORedis(REDIS_URL);
let redisHits = 0;
let redisKeys = 0;
for await (const keys of redis.scanStream({ count: 500 })) {
  for (const key of keys) {
    redisKeys++;
    const type = await redis.type(key);
    let blob = '';
    if (type === 'string') blob = (await redis.get(key)) ?? '';
    else if (type === 'hash') blob = JSON.stringify(await redis.hgetall(key));
    else if (type === 'list') blob = JSON.stringify(await redis.lrange(key, 0, -1));
    else if (type === 'set') blob = JSON.stringify(await redis.smembers(key));
    else if (type === 'zset') blob = JSON.stringify(await redis.zrange(key, 0, -1));
    else if (type === 'stream') blob = JSON.stringify(await redis.xrange(key, '-', '+'));
    if (blob.includes(CANARY)) redisHits++;
  }
}
await redis.quit();
ok(redisHits === 0, `Redis: canary absent from all ${redisKeys} keys (presence, queue job payloads)`);

// ───────────────────────── Tombstone replay (PRIV02) ─────────────────────────
console.log('Tombstone replay — idempotent on the live database, removes data from a restored backup');
const replayCmd = (dbUrl) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve(apiRoot, 'scripts/replay-tombstones.mjs'),
        '--build-dir',
        BUILD_DIR,
        '--tenant',
        tenantId,
        '--json',
      ],
      {
        env: { ...process.env, ...(dbUrl ? { DATABASE_URL: dbUrl } : {}), LOG_LEVEL: 'error' },
        cwd: apiRoot,
      },
    )
      .toString()
      .trim()
      .split('\n')
      .pop(),
  );
const live = replayCmd();
const liveOk =
  live.visitorsMatched === 1 &&
  live.visitorsChanged === 0 &&
  live.failures.length === 0 &&
  live.ledgerEntries >= 1;
ok(
  liveOk,
  `replay on the live database: subject matched by hash, nothing left to change (idempotent)${liveOk ? '' : ` ${JSON.stringify(live)}`}`,
);
const restoreDb = `talkivio_integrations_restore_${stamp}`;
const adminUrl = OWNER_DB.replace(/\/[^/]+$/, '/postgres');
psql(`CREATE DATABASE "${restoreDb}"`, adminUrl);
try {
  const restoreOwner = OWNER_DB.replace(/\/[^/]+$/, `/${restoreDb}`);
  execFileSync('pg_restore', ['--no-owner', '-d', restoreOwner, backupFile]);
  ok(scanDb(restoreOwner).length > 0, 'restored pre-erasure backup contains the canary again');
  const restoreApp = (process.env.DATABASE_URL ?? '').replace(/\/[^/?]+(\?|$)/, `/${restoreDb}$1`);
  const first = replayCmd(restoreApp);
  const firstOk =
    first.visitorsMatched === 1 &&
    first.visitorsChanged === 1 &&
    first.tombstonesRestored >= 1 &&
    first.failures.length === 0;
  ok(
    firstOk,
    `replay against the restored backup re-erased the subject (${Object.values(first.counts).reduce((a, b) => a + b, 0)} rows) and restored ${first.tombstonesRestored} tombstones from the external ledger${firstOk ? '' : ` ${JSON.stringify(first)}`}`,
  );
  const restoredHits = scanDb(restoreOwner);
  ok(
    restoredHits.length === 0,
    `restored database: canary absent from every table (${restoredHits.join(', ') || 'all clean'})`,
  );
  const second = replayCmd(restoreApp);
  const secondOk =
    second.visitorsChanged === 0 && second.tombstonesRestored === 0 && second.failures.length === 0;
  ok(secondOk, `second replay changes nothing (idempotent)${secondOk ? '' : ` ${JSON.stringify(second)}`}`);
  ok(
    psql(`SELECT count(*) FROM messages WHERE body LIKE '%${SECOND}%'`, restoreOwner) === '2',
    'restored second visitor’s messages untouched by replay',
  );
} finally {
  psql(`DROP DATABASE IF EXISTS "${restoreDb}" WITH (FORCE)`, adminUrl);
  rmSync(backupFile, { force: true }); // the pre-erasure backup holds erased data: never leave it behind
}

// ───────────────────────── JOB01: crash recovery ─────────────────────────
console.log('JOB01 — worker crash after claim / after external acceptance (sweep recovers, one result)');
const tCrash = await owner.must('POST', `/webhooks/${hookId}/test`, {});
await waitFor(
  async () => (await receiver.events()).received.some((e) => e.id === tCrash.event_id),
  10_000,
  'crash-test event delivered',
);
const seenBefore = (await receiver.events()).attempts.filter((a) => a.event_id === tCrash.event_id).length;
// Crash after the receiver accepted but before the outcome was recorded: row left in `sending` with an expired lease.
const attemptsBefore = Number(psql(`SELECT attempts FROM webhook_deliveries WHERE id = '${tCrash.id}'`));
psql(
  `UPDATE webhook_deliveries SET status = 'sending', next_attempt_at = now() - interval '1 minute' WHERE id = '${tCrash.id}'`,
);
// Privacy job claimed by a worker that died: request running, job running with an expired lease, nothing queued in Redis.
const accB = await owner.must('POST', '/privacy/requests', {
  kind: 'access',
  visitor_id: sess2.visitor.id,
  proof_reference: `TICKET-${stamp}-B`,
});
const crashJobId = randomUUID();
psql(`UPDATE privacy_requests SET state = 'running', verified_at = now() WHERE id = '${accB.id}';
      INSERT INTO jobs (id, tenant_id, kind, dedupe_key, state, payload, attempts, run_after, lease_until, updated_at)
      VALUES ('${crashJobId}', '${tenantId}', 'privacy.access', '${accB.id}', 'running', '{"request_id":"${accB.id}","visitor_id":"${sess2.visitor.id}"}', 1, now(), now() - interval '1 minute', now())`);
const [recovered, recoveredJob] = await Promise.all([
  waitFor(
    async () =>
      (await owner.must('GET', `/webhooks/${hookId}/deliveries?status=delivered`)).find(
        (d) => d.id === tCrash.id && d.attempts === attemptsBefore + 1,
      ),
    120_000,
    'webhook sweep recovery',
  ),
  waitFor(
    async () => {
      const r = await owner.must('GET', `/privacy/requests/${accB.id}`);
      return r.state === 'completed' ? r : null;
    },
    120_000,
    'privacy sweep recovery',
  ),
]);
const after = (await receiver.events()).attempts.filter((a) => a.event_id === tCrash.event_id);
ok(
  recovered && after.length === seenBefore + 1 && after[after.length - 1].outcome === 'duplicate',
  'stale `sending` delivery re-sent by the sweep with the same event id; receiver de-duplicates (one result)',
);
ok(
  (await receiver.events()).received.filter((e) => e.id === tCrash.event_id).length === 1,
  'receiver still holds exactly one copy of the event',
);
ok(
  recoveredJob.job.state === 'succeeded' &&
    recoveredJob.job.attempts === 2 &&
    psql(`SELECT count(*) FROM exports WHERE job_id = '${crashJobId}'`) === '1',
  'expired privacy lease recovered by the sweep: completed once, exactly one export',
);

// ───────────────────────── Retention ─────────────────────────
console.log('Retention — dry run and bounded batch');
const retExport = await owner.call('POST', '/exports', { chat_ids: [chatB], format: 'txt' });
const retReady = await waitFor(
  async () => {
    const r = await owner.must('GET', `/exports/${retExport.data.id}`);
    return ['ready', 'failed'].includes(r.state) ? r : null;
  },
  30_000,
  'export of chat B',
);
const retGrant = await owner.must('GET', `/exports/${retExport.data.id}/download`);
ok(retReady.state === 'ready' && (await fetch(retGrant.url)).status === 200, 'an export covering chat B is downloadable before retention');
ok(
  !retAttachment || psql(`SELECT count(*) FROM attachments WHERE id = '${retAttachment}' AND deleted_at IS NULL`) === '1',
  'chat B holds a live attachment before retention',
);
psql(`UPDATE chats SET closed_at = now() - interval '400 days' WHERE id = '${chatB}'`);
const preview = await owner.must('GET', '/privacy/retention/preview');
ok(
  preview.dry_run === true &&
    preview.targets.closed_chats >= 1 &&
    preview.targets.messages >= 2 &&
    preview.legal_holds.modeled === false,
  'preview (dry run) reports the expired transcript without deleting it',
);
ok(psql(`SELECT count(*) FROM messages WHERE chat_id = '${chatB}'`) !== '0', 'dry run deleted nothing');
const run = await owner.must('POST', '/privacy/retention/run', {});
ok(
  run.dry_run === false && run.targets.closed_chats >= 1 && run.failures.length === 0,
  'retention batch purged the expired transcript',
);
ok(
  psql(`SELECT count(*) FROM messages WHERE chat_id = '${chatB}'`) === '0' &&
    psql(`SELECT count(*) FROM chats WHERE id = '${chatB}'`) === '1',
  'messages deleted; chat row kept as non-identifying metadata',
);
ok(run.targets.transcript_exports >= 1 && preview.targets.transcript_exports >= 1, `preview and run count the covering transcript export (${run.targets.transcript_exports})`);
ok(
  (await owner.call('GET', `/exports/${retExport.data.id}/download`)).status === 410 &&
    (await fetch(retGrant.url)).status !== 200 &&
    psql(`SELECT erased_at IS NOT NULL AND object_key IS NULL FROM exports WHERE id = '${retExport.data.id}'`) === 't',
  'the export covering the expired chat is invalidated and its earlier grant no longer serves bytes',
);
if (retAttachment) {
  const retKey = psql(`SELECT object_key FROM attachments WHERE id = '${retAttachment}'`);
  ok(
    psql(`SELECT deleted_at IS NOT NULL AND original_name = '[erased]' AND sha256 IS NULL FROM attachments WHERE id = '${retAttachment}'`) === 't' &&
      !existsSync(join(STORAGE_DIR, 'quarantine', retKey)) &&
      !existsSync(join(STORAGE_DIR, 'clean', retKey)),
    'the expired chat’s attachment is scrubbed and its bytes are gone from every area',
  );
}

// AUD-72-12: copies of the expired transcript held by derived stores (published outbox payloads, idempotent replies,
// job payloads/results) go with their own expiry run. The rows are aged past their windows instead of waiting a day,
// then the real `purge` maintenance job runs in the worker.
console.log('Retention — derived copies of the expired transcript are purged by their own expiry (AUD-72-12)');
const expiredTexts = [`Hi there ${SECOND}`, `Hello ${SECOND} reply`];
const holds = (col) => `(${expiredTexts.map((t) => `${col} LIKE '%${t}%'`).join(' OR ')})`;
const derivedCopies = () =>
  psql(
    `SELECT (SELECT count(*) FROM outbox_events WHERE ${holds('payload::text')}) || '|' || (SELECT count(*) FROM command_idempotency WHERE ${holds("coalesce(response_body::text, '')")}) || '|' || (SELECT count(*) FROM jobs WHERE ${holds("payload::text || coalesce(result::text, '')")})`,
  )
    .split('|')
    .map(Number);
const copiesBefore = derivedCopies();
ok(copiesBefore[0] > 0, `the expired messages still have derived copies before their expiry (outbox ${copiesBefore[0]}, idempotency ${copiesBefore[1]}, jobs ${copiesBefore[2]})`);
psql(`UPDATE outbox_events SET occurred_at = now() - interval '25 hours' WHERE published_at IS NOT NULL AND ${holds('payload::text')}`);
psql(`UPDATE command_idempotency SET expires_at = now() - interval '1 minute' WHERE ${holds("coalesce(response_body::text, '')")}`);
const maintenanceRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const maintenance = new Queue('maintenance', { connection: maintenanceRedis, prefix: 'rd' });
await maintenance.add('purge', {}, { jobId: `purge-${stamp}`, removeOnComplete: true });
const copiesAfter = await waitFor(() => {
  const c = derivedCopies();
  return c[0] === 0 && c[1] === 0 ? c : null;
}, 30_000, 'purge maintenance run');
ok(copiesAfter.every((n) => n === 0), 'after the outbox and idempotency expiry run, no outbox, idempotency or job row holds the expired transcript');
await maintenance.close();
await maintenanceRedis.quit();

// ───────────────────────── Audit administration ─────────────────────────
console.log('Audit trail (ch. 54)');
const tokCreated = await owner.must('GET', '/audit-events?action=integration_token.created');
ok(
  tokCreated.length >= 2 &&
    tokCreated.every((e) => e.actor.type === 'user' && Array.isArray(e.safe_diff.scopes)),
  'token creation is audited with safe diff (scopes, no secret)',
);
const denied = await owner.must('GET', '/audit-events?outcome=denied&action=authorization.denied');
ok(
  denied.some(
    (e) =>
      e.actor.type === 'integration_token' &&
      e.safe_diff.permission === 'integrations.manage' &&
      e.safe_diff.route.includes('/webhooks'),
  ),
  'failed authorization recorded as safe security telemetry (outcome denied)',
);
const p1 = await owner.call('GET', '/audit-events?limit=2');
const p2 = await owner.call('GET', `/audit-events?limit=2&cursor=${encodeURIComponent(p1.page.next_cursor)}`);
ok(p1.data.length === 2 && p2.data.length === 2 && p2.data[0].id !== p1.data[0].id, 'cursor paging');
ok(
  (
    await owner.call(
      'GET',
      `/audit-events?limit=2&action=webhook.created&cursor=${encodeURIComponent(p1.page.next_cursor)}`,
    )
  ).status === 422,
  'cursor from another filter rejected',
);
const csvRes = await owner.raw('GET', '/audit-events/export.csv');
const csv = await csvRes.text();
ok(
  csvRes.status === 200 &&
    csvRes.headers.get('content-type').startsWith('text/csv') &&
    csv.startsWith('"occurred_at","actor_type"'),
  'CSV export (RFC 4180 header, quoted fields)',
);
for (const action of [
  'integration_token.created',
  'integration_token.rotated',
  'integration_token.revoked',
  'webhook.created',
  'webhook.updated',
  'webhook.secret_rotated',
  'authorization.denied',
  'privacy.request_verified',
  'privacy.erasure_completed',
]) {
  ok(csv.includes(`"${action}"`), `CSV contains ${action}`);
}
ok(
  !csv.includes(token) && !csv.includes(token2) && !csv.includes(secret) && !csv.includes(CANARY),
  'CSV contains no tokens, secrets or personal text',
);
ok(
  (await owner.must('GET', '/audit-events?action=audit.exported')).length >= 1,
  'the export itself is audited',
);

// ───────────────────────── Cross-tenant ─────────────────────────
console.log('Cross-tenant isolation');
const beta = new Client('beta');
await beta.must('POST', '/auth/signup', {
  email: `beta+int${stamp}@example.com`,
  password: 'another strong passphrase',
  tenant_name: `Beta ${stamp}`,
});
ok((await beta.call('GET', `/webhooks/${hookId}`)).status === 404, 'other tenant: webhook → 404');
ok(
  (await beta.call('GET', `/webhooks/${hookId}/deliveries`)).status === 404,
  'other tenant: deliveries → 404',
);
ok(
  (await beta.call('POST', `/webhook-deliveries/${testDelivery.data.id}/retry`, {})).status === 404,
  'other tenant: delivery retry → 404',
);
ok(
  (await beta.call('GET', `/privacy/requests/${er.data.id}`)).status === 404,
  'other tenant: privacy request → 404',
);
ok(
  (
    await beta.call('POST', '/privacy/requests', {
      kind: 'erase',
      visitor_id: sess2.visitor.id,
      proof_reference: 'x',
    })
  ).status === 404,
  'other tenant cannot erase our visitor (404)',
);
const betaAudit = await beta.must('GET', '/audit-events?action=authorization.denied');
ok(
  betaAudit.length >= 3 && betaAudit.every((e) => e.safe_diff.reason === 'not_found'),
  'probes recorded in the prober’s own tenant only',
);
ok(
  !(await owner.must('GET', '/audit-events?limit=100')).some((e) =>
    JSON.stringify(e).includes(`beta+int${stamp}`),
  ),
  'nothing about the other tenant appears in our trail',
);

ownerSock.close();
cleanup();
console.log(`\nINTEGRATIONS + PRIVACY E2E PASSED (${passed} checks)`);
process.exit(0);
