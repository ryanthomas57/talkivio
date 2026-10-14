// Agent-started chats (Visitors list → chat window): POST /api/v1/visitors/:id/chats against a running api + worker.
// Real HTTP, real sockets, real database.
//
//   node test/engage.e2e.mjs
//
// Proves: the chat starts active and owned by the agent, with the agent's first message; the visitor's open tab
// receives chat.opened_by_agent (public projection only) and can read the conversation and reply; nobody else is
// alerted (no chat.requested); the request is idempotent; one open chat per visitor (CHAT_EXISTS with its id);
// offline visitors, consent-required visitors, full capacity, missing permission and other workspaces are refused.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-c', q]).toString().trim();
const latestEmail = (to, template) =>
  sql(
    `SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
const tokenFrom = (text, param) =>
  decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
const waitFor = async (pred, ms = 6000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

class Client {
  constructor(name, ip) {
    this.name = name;
    this.cookies = {};
    this.ip = ip;
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
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
    return { status: res.status, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
function socket(ns, ticket) {
  const s = io(`${API}${ns}`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket },
    forceNew: true,
    reconnection: false,
  });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}

const stamp = Date.now();
console.log('Setup — a workspace (owner, agent, analyst), a site, the agents online');
const owner = new Client('owner', '10.60.0.1');
const ownerEmail = `engage-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', {
  email: ownerEmail,
  password: 'engage passphrase long',
  tenant_name: `Engage ${stamp}`,
  timezone: 'UTC',
});
await owner.must('POST', '/auth/verify-email', {
  token: tokenFrom(
    await waitFor(() => latestEmail(ownerEmail, 'verify_email'), 5000, 'verification email'),
    'token',
  ),
});
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const members = {};
let n = 2;
for (const role of ['agent', 'analyst']) {
  const email = `engage-${role}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', {
    email,
    role,
    department_ids: role === 'agent' ? [support.id] : [],
    capacity: 2,
  });
  const c = new Client(role, `10.60.0.${n++}`);
  await c.must('POST', '/agents/invitations/accept', {
    token: tokenFrom(
      await waitFor(() => latestEmail(email, 'agent_invitation'), 5000, `${role} invitation`),
      'invite',
    ),
    display_name: `Engage ${role}`,
    password: 'engage passphrase long',
  });
  members[role] = c;
}
const site = await owner.must('POST', '/sites', {
  name: 'Engage store',
  origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
  default_department_id: support.id,
});
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
const agentSock = await socket('/agent', (await members.agent.must('POST', '/socket-ticket')).ticket);
for (const s of [ownerSock, agentSock])
  await s.emitWithAck('subscribe', {
    scopes: [
      { kind: 'queue', id: 'none' },
      { kind: 'queue', id: support.id },
    ],
  });
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
await members.agent.must('PUT', '/agents/me/presence', { status: 'online' });
ok(true, 'workspace with an owner, an agent and an analyst; both agents online with live sockets');

const visitorClient = new Client('visitor', '10.60.0.20');
const visit = async (title, consent = true, ip = '10.60.0.20') => {
  visitorClient.ip = ip;
  const sess = await visitorClient.must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: ORIGIN,
    ...(consent ? { consent: { analytics: true, policy_version: '2026-10' } } : {}),
    page: { url: `${ORIGIN}/${title.toLowerCase()}`, title },
  });
  const auth = { authorization: `Bearer ${sess.capability}` };
  const sock = await socket(
    '/visitor',
    (await visitorClient.must('POST', '/widget/v1/socket-ticket', undefined, auth)).ticket,
  );
  return { sess, auth, sock };
};

console.log('Starting a chat with a browsing visitor');
const a = await visit('Pricing');
const before = a.sock.frames.length;
const clientRequestId = randomUUID();
const started = await owner.call('POST', `/visitors/${a.sess.visitor.id}/chats`, {
  client_request_id: clientRequestId,
  message: 'Hi! Can I help you choose a plan?',
});
ok(started.status === 201, `the agent's request creates the chat (201)`);
const chat = started.data.chat;
ok(
  chat.status === 'active' && chat.started_by === 'agent' && !!chat.owner_membership_id,
  'the chat is active and owned by the agent who started it (started_by agent)',
);
ok(
  started.data.message.body === 'Hi! Can I help you choose a plan?' &&
    started.data.message.sender.type === 'agent',
  "the response carries the agent's first message",
);
const opened = await waitFor(
  () => a.sock.frames.find((f) => f.type === 'chat.opened_by_agent' && f.payload.chat.id === chat.id),
  6000,
  'chat.opened_by_agent on the visitor tab',
);
ok(opened && a.sock.frames.length > before, "the visitor's open tab receives chat.opened_by_agent");
ok(
  !JSON.stringify(opened.payload).includes('membership_id') &&
    !JSON.stringify(opened.payload).includes('route_reason'),
  'the visitor frame is the public projection (no membership ids or routing details)',
);
const history = await visitorClient.must(
  'GET',
  `/widget/v1/chats/${chat.id}/messages?limit=50`,
  undefined,
  a.auth,
);
ok(
  history.items.some((m) => m.body === 'Hi! Can I help you choose a plan?'),
  "the visitor can read the agent's message in their chat",
);
await a.sock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chat.id }] });
const reply = await visitorClient.must(
  'POST',
  `/widget/v1/chats/${chat.id}/messages`,
  { client_message_id: randomUUID(), body: 'Yes please, the team plan' },
  a.auth,
);
await waitFor(
  () =>
    ownerSock.frames.find((f) => f.type === 'message.created' && f.payload.message?.id === reply.id) || true,
  2000,
);
const staffMessages = await owner.must('GET', `/chats/${chat.id}/messages?limit=50`);
ok(
  staffMessages.items.some((m) => m.body === 'Yes please, the team plan'),
  "the visitor's reply lands in the agent's chat",
);
await sleep(800);
ok(
  !agentSock.frames.some((f) => f.type === 'chat.requested' && f.payload.chat?.id === chat.id) &&
    !ownerSock.frames.some((f) => f.type === 'chat.requested' && f.payload.chat?.id === chat.id),
  'nobody is alerted with chat.requested: the chat never entered the queue',
);
ok(
  sql(`SELECT reason FROM assignment_history WHERE chat_id = '${chat.id}'`) === 'agent_started',
  'assignment history records agent_started',
);
ok(
  sql(
    `SELECT actor_type || ':' || (safe_diff->>'visitor_id') FROM audit_events WHERE action = 'chat.started_by_agent' AND object_id = '${chat.id}'`,
  ) === `user:${a.sess.visitor.id}`,
  'the audit log records chat.started_by_agent with the visitor',
);

console.log('Idempotency and one open chat per visitor');
const replay = await owner.call('POST', `/visitors/${a.sess.visitor.id}/chats`, {
  client_request_id: clientRequestId,
  message: 'Hi! Can I help you choose a plan?',
});
ok(
  replay.status === 201 && replay.data.chat.id === chat.id,
  'retrying with the same client_request_id returns the same chat',
);
const again = await members.agent.call('POST', `/visitors/${a.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hello from another agent',
});
ok(
  again.status === 409 && again.error.code === 'CHAT_EXISTS' && again.error.details?.chat_id === chat.id,
  'a second chat is refused with CHAT_EXISTS and the open chat id',
);
ok(
  sql(`SELECT count(*) FROM chats WHERE visitor_id = '${a.sess.visitor.id}'`) === '1',
  'exactly one chat exists for the visitor',
);

console.log('Refusals');
const b = await visit('Shop', true, '10.60.0.21');
b.sock.close();
await waitFor(
  async () =>
    !(await owner.must('GET', '/visitors/live')).items.some(
      (i) => i.visitor_id === b.sess.visitor.id && i.online,
    ),
  20_000,
  'the closed tab to leave the live list',
);
const gone = await owner.call('POST', `/visitors/${b.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Still there?',
});
ok(
  gone.status === 409 && gone.error.code === 'VISITOR_OFFLINE',
  `a visitor whose tab closed is refused with VISITOR_OFFLINE (got ${gone.status} ${gone.error?.code ?? ''})`,
);
const c = await visit('Blog', true, '10.60.0.22');
const analyst = await members.analyst.call('POST', `/visitors/${c.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hi',
});
ok(analyst.status === 403, 'a member without chats.serve cannot start chats (403)');
const beta = new Client('beta', '10.60.0.30');
await beta.must('POST', '/auth/signup', {
  email: `engage-beta+${stamp}@example.com`,
  password: 'engage passphrase long',
  tenant_name: `Engage Beta ${stamp}`,
});
const foreign = await beta.call('POST', `/visitors/${c.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hi',
});
ok(foreign.status === 404, "another workspace's visitor does not exist there (404)");
// Capacity: the agent (capacity 2) takes a chat with c, then a third visitor would exceed nothing yet; fill it with d.
const agentChat = await members.agent.call('POST', `/visitors/${c.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hi from the agent',
});
ok(
  agentChat.status === 201 && agentChat.data.chat.owner_membership_id !== chat.owner_membership_id,
  'another agent can start a chat with a different visitor',
);
const d = await visit('Docs', true, '10.60.0.23');
const e = await visit('Careers', true, '10.60.0.24');
ok(
  (
    await members.agent.call('POST', `/visitors/${d.sess.visitor.id}/chats`, {
      client_request_id: randomUUID(),
      message: 'Hi',
    })
  ).status === 201,
  "the agent's second chat fits capacity 2",
);
const full = await members.agent.call('POST', `/visitors/${e.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hi',
});
ok(
  full.status === 409 && full.error.code === 'CAPACITY_EXCEEDED',
  'a third chat beyond capacity is refused (CAPACITY_EXCEEDED)',
);
const t = await owner.must('GET', '/tenants/current');
await owner.must('PATCH', '/tenants/current', {
  settings: { tracking: { analytics_consent_required: true } },
  expected_version: t.version,
});
const f = await visit('Contact', false, '10.60.0.25');
const noConsent = await owner.call('POST', `/visitors/${f.sess.visitor.id}/chats`, {
  client_request_id: randomUUID(),
  message: 'Hi',
});
ok(
  noConsent.status === 409 && noConsent.error.code === 'VISITOR_OFFLINE',
  'while consent is required, a visitor without consent cannot be contacted',
);

for (const s of [ownerSock, agentSock, a.sock, c.sock, d.sock, e.sock, f.sock]) s.close();
console.log(`\nENGAGE E2E PASSED (${passed} checks)`);
process.exit(0);
