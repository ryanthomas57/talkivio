// Webhooks end to end on the Docker Compose stack (DEPLOY01): a real chat lifecycle through the reverse proxy
// produces signed deliveries from the worker container to the `webhook-receiver` container, which verifies the
// HMAC signature over the raw body and the timestamp window. The receiver fails each event's first attempt, so a
// retry with the same event id is exercised too.
//
//   API_URL=http://localhost:8080 RECEIVER_URL=http://localhost:4196 node apps/api/test/compose-webhook.mjs
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const RECEIVER = (process.env.RECEIVER_URL ?? 'http://localhost:4196').replace(/\/$/, '');
const CONTROL_TOKEN = process.env.RD_WEBHOOK_CONTROL_TOKEN ?? 'local-dev-only-webhook-control';
// The address the worker container dials (docker-compose.yml allowlists exactly this private host).
const HOOK_URL = process.env.HOOK_URL ?? 'http://webhook-receiver:4196/hooks';
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const waitFor = async (pred, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  async must(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(this.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
      else delete this.cookies[pair.slice(0, i)];
    }
    const json = await res.json().catch(() => null);
    if (res.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${res.status} ${JSON.stringify(json?.error)}`);
    return json?.data;
  }
}
const control = async (method, path, body) => {
  const r = await fetch(`${RECEIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CONTROL_TOKEN}` },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`receiver ${method} ${path} → ${r.status}`);
  return r.json().catch(() => null);
};

const stamp = Date.now();
const owner = new Client('owner');
await owner.must('POST', '/auth/signup', {
  email: `webhooks+${stamp}@example.com`,
  password: 'compose webhook passphrase',
  tenant_name: `Webhooks ${stamp}`,
  timezone: 'UTC',
});
const site = await owner.must('POST', '/sites', {
  name: 'Webhook store',
  origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
});
const types = ['chat.requested', 'chat.started', 'chat.closed'];
const hook = await owner.must('POST', '/webhooks', {
  url: HOOK_URL,
  event_types: types,
  description: 'compose receiver',
});
ok(/^whsec_/.test(hook.secret), 'webhook endpoint created with a one-time signing secret');
await control('DELETE', '/events');
await control('POST', '/_control', { secrets: [hook.secret], fail_first_n: 1, fail_status: 500 });

const ticket = (await owner.must('POST', '/socket-ticket')).ticket;
const sock = io(`${API}/agent`, {
  path: '/realtime/v1',
  transports: ['websocket'],
  auth: { ticket },
  forceNew: true,
});
await new Promise((resolve, reject) => {
  sock.on('auth.ok', resolve);
  sock.on('connect_error', (e) => reject(new Error(`agent socket: ${e.message}`)));
});
await owner.must('PUT', '/agents/me/presence', { status: 'online' });

const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', {
  site_key: site.public_key,
  host_origin: ORIGIN,
  consent: { analytics: false, policy_version: '2026-10' },
});
const vauth = { authorization: `Bearer ${sess.capability}` };
const chat = await waitFor(
  () =>
    visitor
      .must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Webhook check' }, vauth)
      .catch(() => null),
  20_000,
  'admission once the agent socket is live',
);
const chatId = chat.chat.id;
await owner.must('POST', `/chats/${chatId}/accept`, {});
await owner.must('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
ok(true, `chat ${chatId} requested, accepted and closed through the proxy`);

const ev = await waitFor(
  async () => {
    const e = await control('GET', '/events');
    return types.every((t) => e.received.some((x) => x.type === t && x.data?.chat_id === chatId)) ? e : null;
  },
  90_000,
  'the three chat webhooks',
);
for (const type of types) {
  const e = ev.received.find((x) => x.type === type && x.data?.chat_id === chatId);
  const tries = ev.attempts.filter((a) => a.event_id === e.id).map((a) => a.outcome);
  ok(
    tries[0] === 'simulated_500' && tries.includes('accepted'),
    `${type}: signed delivery verified by the receiver after one retry (${tries.join(' → ')})`,
  );
}
ok(
  !ev.attempts.some((a) => a.outcome.startsWith('rejected')),
  'no delivery failed signature, timestamp or id verification (at-least-once redeliveries are de-duplicated)',
);
sock.close();
console.log(`\nCOMPOSE WEBHOOKS PASSED (${passed} checks)`);
process.exit(0);
