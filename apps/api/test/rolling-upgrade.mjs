// Rolling upgrade / rollback rehearsal client (DEPLOY02, AUD-72-33). Keeps one visitor ↔ agent conversation busy
// through the proxy while the caller replaces the worker, gateway and api containers (upgrade, rollback, roll
// forward). Every send is retried with its original client_message_id until it is acknowledged, so a restart may
// delay a message but must never lose or duplicate one. Runs until STOP_FILE exists, then proves:
//   - every message is in the durable transcript exactly once, in send order (seq strictly increasing);
//   - realtime recovered: both sockets receive the messages sent after the last restart.
//
//   API_URL=http://localhost:8080 STOP_FILE=/tmp/rehearsal.stop READY_FILE=/tmp/rehearsal.ready \
//     REPORT_FILE=reports/upgrade/traffic.json node apps/api/test/rolling-upgrade.mjs
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { io } from 'socket.io-client';

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const STOP_FILE = process.env.STOP_FILE ?? '/tmp/talkivio-rehearsal.stop';
const READY_FILE = process.env.READY_FILE ?? '';
const REPORT_FILE = process.env.REPORT_FILE ?? '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 200);
const SEND_DEADLINE_MS = Number(process.env.SEND_DEADLINE_MS ?? 180_000);
const ORIGIN = 'http://localhost:5173';
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

/** HTTP client with cookies + CSRF that rides out restarts: network errors, 429 and 5xx are retried as-is. */
class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
    this.retries = 0;
  }
  async once(method, path, body, extra = {}) {
    const res = await fetch(
      `${API}${path.startsWith('/widget') || path.startsWith('/health') ? '' : '/api/v1'}${path}`,
      {
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
        signal: AbortSignal.timeout(15_000),
      },
    );
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
      else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // a proxy error page while the upstream restarts
    }
    return { status: res.status, data: json?.data, error: json?.error };
  }
  /** The same request (same idempotency keys) until it succeeds; a 4xx other than 429 is a real failure. */
  async must(method, path, body, extra) {
    const deadline = Date.now() + SEND_DEADLINE_MS;
    let attempt = 0;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const r = await this.once(method, path, body, extra);
        if (r.status < 400) return { ...r, attempts: attempt + 1 };
        if (r.status !== 429 && r.status < 500)
          throw Object.assign(
            new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`),
            { fatal: true },
          );
        last = `${r.status} ${r.error?.code ?? ''}`;
      } catch (e) {
        if (e.fatal) throw e;
        last = e.cause?.code ?? e.name ?? String(e);
      }
      attempt++;
      this.retries++;
      await sleep(Math.min(250 * attempt, 1000));
    }
    throw new Error(
      `${this.name} ${method} ${path} did not succeed within ${SEND_DEADLINE_MS} ms (last: ${last})`,
    );
  }
}

/** A socket that re-authenticates with a fresh single-use ticket and re-subscribes after every reconnect. */
function liveSocket(label, ns, ticket, scopes) {
  const s = io(`${API}${ns}`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    // Own connection per socket, as in real clients (the agent and the visitor are different browsers).
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 250,
    reconnectionDelayMax: 2000,
    auth: (cb) =>
      ticket().then(
        (t) => cb({ ticket: t }),
        () => cb({ ticket: '' }),
      ),
  });
  // Own state lives under `delivered` / `authSessions`: `ids` is socket.io-client's internal ack counter.
  s.delivered = new Set();
  s.authSessions = 0;
  s.on('event', (f) => {
    if (f?.type === 'message.created' && f.payload?.message?.id) s.delivered.add(f.payload.message.id);
  });
  s.on('auth.ok', () => {
    s.authSessions++;
    if (s.authSessions > 1) log(`${label} socket re-authenticated (session ${s.authSessions})`);
    s.timeout(10_000)
      .emitWithAck('subscribe', { scopes })
      .catch(() => undefined);
  });
  s.on('disconnect', (reason, details) =>
    log(
      `${label} socket disconnected: ${reason}${details ? ` ${JSON.stringify({ message: details.message, description: String(details.description ?? ''), context: String(details.context?.statusText ?? '') })}` : ''}`,
    ),
  );
  s.on('control', (c) => log(`${label} socket control: ${JSON.stringify(c)}`));
  if (process.env.DEBUG_SOCKETS)
    s.onAny((ev, ...a) => log(`${label} ${ev} ${JSON.stringify(a).slice(0, 160)}`));
  s.on('connect_error', (e) => log(`${label} connect_error: ${e.message}`));
  return s;
}

// ── Setup: a fresh workspace, its owner online with a live socket, one visitor chat accepted ──
const owner = new Client('owner');
const signup = await owner.must('POST', '/auth/signup', {
  email: `rehearsal+${RUN}@example.com`,
  password: 'rolling upgrade passphrase',
  tenant_name: `Rehearsal ${RUN}`,
  timezone: 'UTC',
});
ok(signup.data.me.active_tenant_id, 'rehearsal workspace created');
const site = (
  await owner.must('POST', '/sites', {
    name: 'Rehearsal store',
    origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
  })
).data;
const agentTicket = async () => (await owner.must('POST', '/socket-ticket')).data.ticket;
const agentSock = liveSocket('agent', '/agent', agentTicket, [{ kind: 'queue', id: 'none' }]);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });

const visitor = new Client('visitor');
const sess = (
  await visitor.must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: ORIGIN,
    consent: { analytics: false, policy_version: '2026-10' },
    page: { url: `${ORIGIN}/`, title: 'Rehearsal' },
  })
).data;
const vauth = { authorization: `Bearer ${sess.capability}` };
let chatId = '';
const admitDeadline = Date.now() + 30_000;
while (!chatId) {
  // Admission needs the agent socket to be live; DEPARTMENT_UNAVAILABLE until it is.
  const r = await visitor
    .once(
      'POST',
      '/widget/v1/chats',
      { client_request_id: `rehearsal-${RUN}-admission`, message: `rehearsal ${RUN} opening` },
      vauth,
    )
    .catch(() => ({ status: 0 }));
  if (r.status === 201 || r.status === 200) chatId = r.data.chat.id;
  else if (Date.now() > admitDeadline)
    throw new Error(`admission failed: ${r.status} ${JSON.stringify(r.error)}`);
  else await sleep(500);
}
await owner.must('POST', `/chats/${chatId}/accept`, {});
const scopes = [{ kind: 'chat', id: chatId }];
agentSock
  .timeout(10_000)
  .emitWithAck('subscribe', { scopes })
  .catch(() => undefined);
agentSock.on('auth.ok', () =>
  agentSock
    .timeout(10_000)
    .emitWithAck('subscribe', { scopes })
    .catch(() => undefined),
);
const visitorTicket = async () =>
  (await visitor.must('POST', '/widget/v1/socket-ticket', undefined, vauth)).data.ticket;
const visitorSock = liveSocket('visitor', '/visitor', visitorTicket, scopes);
ok(true, `chat ${chatId} admitted and accepted; both sockets connecting`);

// ── Traffic: alternate visitor and agent sends until the caller drops the stop file ──
const sent = [];
const send = async (i) => {
  const by = i % 2 === 0 ? 'visitor' : 'agent';
  const cid = randomUUID();
  const body = `rehearsal ${RUN} #${i} from ${by}`;
  const t0 = Date.now();
  const r =
    by === 'visitor'
      ? await visitor.must(
          'POST',
          `/widget/v1/chats/${chatId}/messages`,
          { client_message_id: cid, body },
          vauth,
        )
      : await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: cid, body });
  const rec = { i, by, cid, body, id: r.data.id, seq: r.data.seq, ms: Date.now() - t0, attempts: r.attempts };
  sent.push(rec);
  if (r.attempts > 1) log(`#${i} (${by}) delivered after ${r.attempts} attempts in ${rec.ms} ms`);
  return rec;
};
if (READY_FILE) writeFileSync(READY_FILE, chatId);
log(`READY chat=${chatId} — sending every ${INTERVAL_MS} ms until ${STOP_FILE} exists`);
let i = 0;
while (!existsSync(STOP_FILE)) {
  await send(i++);
  await sleep(INTERVAL_MS);
}

// ── After the last restart: new messages must reach both sockets again ──
const tail = [];
for (let k = 0; k < 4; k++) tail.push(await send(i++));
const settleDeadline = Date.now() + 20_000;
while (
  Date.now() < settleDeadline &&
  !tail.every((m) => agentSock.delivered.has(m.id) && visitorSock.delivered.has(m.id))
)
  await sleep(200);
ok(
  tail.every((m) => agentSock.delivered.has(m.id)),
  `agent socket receives messages sent after the last restart (${agentSock.authSessions} socket sessions)`,
);
ok(
  tail.every((m) => visitorSock.delivered.has(m.id)),
  `visitor socket receives messages sent after the last restart (${visitorSock.authSessions} socket sessions)`,
);

// ── Durable transcript: each message exactly once, in send order ──
const items = [];
for (let after = 0; ;) {
  const page = (await owner.must('GET', `/chats/${chatId}/messages?after_seq=${after}&limit=100`)).data;
  items.push(...page.items);
  if (!page.has_more || !page.items.length) break;
  after = page.items[page.items.length - 1].seq;
}
const ours = items.filter((m) => typeof m.body === 'string' && m.body.startsWith(`rehearsal ${RUN} #`));
const byId = new Map(items.map((m) => [m.id, m]));
const missing = sent.filter((m) => !byId.has(m.id));
ok(missing.length === 0, `no acknowledged message is missing (${sent.length} sent)`);
ok(
  ours.length === sent.length,
  `no message is duplicated (${ours.length} rehearsal messages in the transcript)`,
);
ok(new Set(ours.map((m) => m.body)).size === ours.length, 'every rehearsal body appears once');
const order = ours.map((m) => Number(m.body.match(/#(\d+) /)[1]));
ok(
  order.every((n, k) => k === 0 || n > order[k - 1]),
  'transcript order matches send order',
);
ok(
  ours.every((m, k) => k === 0 || m.seq > ours[k - 1].seq),
  'seq strictly increases',
);

const retried = sent.filter((m) => m.attempts > 1);
const report = {
  chat_id: chatId,
  messages: sent.length,
  retried_sends: retried.length,
  total_retries: owner.retries + visitor.retries,
  slowest_send_ms: Math.max(...sent.map((m) => m.ms)),
  socket_sessions: { agent: agentSock.authSessions, visitor: visitorSock.authSessions },
  delayed: retried.map(({ i, by, ms, attempts }) => ({ i, by, ms, attempts })),
};
if (REPORT_FILE) {
  mkdirSync(dirname(REPORT_FILE), { recursive: true });
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
agentSock.close();
visitorSock.close();
console.log(
  `\nROLLING UPGRADE REHEARSAL PASSED (${passed} checks, ${sent.length} messages, zero lost or duplicated)`,
);
process.exit(0);
