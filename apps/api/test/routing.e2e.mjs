// Routing, capacity and offers (ROUTE01, ROUTE02, ROUTE03, CHAT03, AUD-71-15, AUD-71-16) — end-to-end
// against a running api + worker (node test/routing.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis.
//   * global capacity: one agent serving two assigned departments never exceeds active + reserved ≤ capacity
//   * 30 concurrent requests, 4 agents × capacity 3, seeded declines and a disconnect: no capacity violation
//     (sampled through psql while routing runs), no double ownership, every request assigned or queued
//   * deterministic queue order (priority desc, requested_at asc, id asc) in the queue view and in routing;
//     aging (effective priority) per ch. 31
//   * tie breaking between equally loaded agents: normalized load, assignment recency (never first), id
//   * offer expiry (30 s) re-offers to the next agent; away / disconnect withdraws the offer exactly once;
//     stale accepts are refused with OFFER_EXPIRED / OFFER_WITHDRAWN; accept revalidates capacity
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const OFFER_TTL_MS = 30_000; // features/chats/routing.service.ts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const knownFails = [];
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
function known(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
    return true;
  }
  knownFails.push(msg);
  console.log(`  ✗ KNOWN FAIL: ${msg}`);
  return false;
}
const sql = (q) =>
  execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const execFileP = promisify(execFile);
/** Non-blocking psql (the socket handlers keep running while the monitor samples). */
const sqlAsync = async (q) =>
  (await execFileP('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q])).stdout.trim();
const ids = (arr) => `ARRAY[${arr.map((x) => `'${x}'`).join(',')}]::uuid[]`;
function clearRateLimits(...patterns) {
  for (const p of patterns) {
    const keys = execFileSync('redis-cli', ['--scan', '--pattern', p]).toString().split('\n').filter(Boolean);
    if (keys.length) execFileSync('redis-cli', ['del', ...keys]);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
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
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
      else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) =>
  sql(
    `SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
const tokenFrom = (text, param) =>
  decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket },
    forceNew: true,
    reconnection: false,
  });
  s.frames = [];
  s.controls = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('control', (f) => s.controls.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const command = (s, type, payload) =>
  s.emitWithAck('command', { v: 1, command_id: randomUUID(), type, payload });
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
/** Seeded PRNG (mulberry32) so the decline pattern is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:widget-session:*', 'rl:ws-agent-connect:*');
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `route-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', {
  email: ownerEmail,
  password: 'correct horse battery',
  tenant_name: `Routing ${stamp}`,
  timezone: 'UTC',
});
const T = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', {
  token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token'),
});
await owner.must('PUT', '/agents/me/presence', { status: 'away' }); // the owner never takes chats here
const site = await owner.must('POST', '/sites', {
  name: 'Routing store',
  origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
});
let support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
support = await owner.must('PATCH', `/departments/${support.id}`, {
  routing_mode: 'assigned',
  max_wait_seconds: 0,
});
const sales = await owner.must('POST', '/departments', {
  name: 'Sales',
  public_label: 'Sales',
  routing_mode: 'assigned',
  max_wait_seconds: 0,
});
ok(
  support.routing_mode === 'assigned' && sales.routing_mode === 'assigned',
  'Support and Sales use assigned routing (offers with reservations)',
);

async function makeAgent(name, deptIds, capacity) {
  const email = `route-${name.toLowerCase()}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', {
    email,
    role: 'agent',
    department_ids: deptIds,
    capacity,
  });
  const c = new Client(name);
  await c.must('POST', '/agents/invitations/accept', {
    token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'),
    display_name: name,
    password: 'agent passphrase long',
  });
  const id = (await c.must('GET', '/agents/me')).agent.id;
  return {
    name,
    c,
    id,
    sock: null,
    autoAccept: false,
    declineRate: 0,
    rand: rng(1),
    offers: [],
    withdrawn: [],
    acks: [],
  };
}
function onFrame(a, f) {
  if (f.type === 'assignment.withdrawn') a.withdrawn.push(f.payload);
  if (f.type !== 'assignment.offered' || f.payload.offer.mode !== 'assigned') return;
  const offer = f.payload.offer;
  a.offers.push(offer);
  if (!a.autoAccept) return;
  const s = a.sock;
  // Each agent declines its first offer, then a seeded share: declines are exercised whatever the timing.
  if (a.declineRate && (!a.declinedOnce || a.rand() < a.declineRate)) {
    a.declinedOnce = true;
    void command(s, 'offer.decline', { offer_id: offer.id, reason: 'seeded decline' }).then(
      (r) => a.acks.push({ kind: 'decline', offer: offer.id, r }),
      (e) => a.acks.push({ kind: 'decline', offer: offer.id, r: { type: 'transport', code: e.message } }),
    );
  } else {
    void command(s, 'offer.accept', { chat_id: offer.chat_id, offer_id: offer.id }).then(
      (r) => a.acks.push({ kind: 'accept', offer: offer.id, r }),
      (e) => a.acks.push({ kind: 'accept', offer: offer.id, r: { type: 'transport', code: e.message } }),
    );
  }
}
async function connect(a) {
  a.sock = await socket('/agent', (await a.c.must('POST', '/socket-ticket')).ticket);
  a.sock.on('event', (f) => onFrame(a, f));
}
const presence = (a, status) => a.c.must('PUT', '/agents/me/presence', { status });

async function newVisitor() {
  const v = new Client('visitor');
  const s = await v.must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: ORIGIN,
    consent: { analytics: false, policy_version: '2026-10' },
  });
  v.auth = { authorization: `Bearer ${s.capability}` };
  v.visitorId = s.visitor?.id ?? s.visitor_id;
  return v;
}
const requestChat = (v, departmentId, message = 'Hello, I need some help with an order') =>
  v.call(
    'POST',
    '/widget/v1/chats',
    { client_request_id: randomUUID(), message, department_id: departmentId },
    v.auth,
  );
async function chatIn(departmentId) {
  const r = await requestChat(await newVisitor(), departmentId);
  if (r.status !== 201) throw new Error(`chat request → ${r.status} ${JSON.stringify(r.error)}`);
  return r.data.chat.id;
}
const closeChat = (id) => owner.call('POST', `/chats/${id}/close`, { reason: 'resolved' });
async function closeAllOpen() {
  for (const id of sql(`SELECT id FROM chats WHERE tenant_id = '${T}' AND status <> 'closed'`)
    .split('\n')
    .filter(Boolean))
    await closeChat(id);
}
const pendingOfferFor = (chatId) =>
  sql(
    `SELECT id || '|' || membership_id FROM assignment_offers WHERE chat_id = '${chatId}' AND status = 'pending'`,
  );
const waitOffer = async (chatId, ms = 8000) =>
  (await waitFor(() => pendingOfferFor(chatId), ms, `pending offer for ${chatId}`)).split('|');

/** Per-agent usage = active owned + unexpired assigned/transfer reservations + collaborations, vs capacity. */
const LOAD_SQL = (tenantId) => `
  SELECT m.id, m.capacity,
    (SELECT count(*) FROM chats c WHERE c.tenant_id = m.tenant_id AND c.owner_membership_id = m.id AND c.status = 'active'),
    (SELECT count(*) FROM assignment_offers o WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id AND o.status = 'pending' AND o.mode IN ('assigned','transfer') AND o.expires_at > now()),
    (SELECT count(*) FROM chat_participants p JOIN chats c2 ON c2.id = p.chat_id WHERE p.tenant_id = m.tenant_id AND p.membership_id = m.id AND p.role = 'collaborator' AND p.left_at IS NULL AND c2.status <> 'closed')
  FROM memberships m WHERE m.tenant_id = '${tenantId}'`;
function startMonitor() {
  const m = { maxOver: -Infinity, worst: null, samples: 0, stop: false, doubleOwner: 0 };
  m.done = (async () => {
    while (!m.stop) {
      const rows = (await sqlAsync(LOAD_SQL(T)))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('|'));
      for (const [id, cap, active, reserved, collab] of rows) {
        const over = Number(active) + Number(reserved) + Number(collab) - Number(cap);
        if (over > m.maxOver) {
          m.maxOver = over;
          m.worst = {
            id,
            cap: Number(cap),
            active: Number(active),
            reserved: Number(reserved),
            collab: Number(collab),
          };
        }
      }
      m.doubleOwner += Number(
        await sqlAsync(
          `SELECT count(*) FROM (SELECT chat_id FROM chat_participants WHERE tenant_id = '${T}' AND role = 'primary' AND left_at IS NULL GROUP BY chat_id HAVING count(*) > 1) x`,
        ),
      );
      m.samples++;
      await sleep(25);
    }
  })();
  return m;
}
const activeOf = (a) =>
  Number(
    sql(
      `SELECT count(*) FROM chats WHERE tenant_id = '${T}' AND owner_membership_id = '${a.id}' AND status = 'active'`,
    ),
  );

// Four agents: A1 serves Support + Sales, the others Support only.
const A1 = await makeAgent('Ava', [support.id, sales.id], 2);
const A2 = await makeAgent('Ben', [support.id], 3);
const A3 = await makeAgent('Cyd', [support.id], 3);
const A4 = await makeAgent('Dee', [support.id], 3);
const agents = [A1, A2, A3, A4];
for (const a of [A2, A3, A4]) await presence(a, 'away');
for (const a of agents) await connect(a);
await presence(A1, 'online');
ok(
  agents.every((a) => a.sock.connected),
  'four agents connected; A1 (capacity 2) serves Support and Sales, A2–A4 are away',
);

// ═══════════════════════════ CHAT03 / AUD-71-15: global capacity across departments ═══════════════════════════
console.log('One agent, two departments, global capacity 2 (CHAT03, AUD-71-15)');
A1.autoAccept = true;
const visitors1 = await Promise.all(Array.from({ length: 6 }, () => newVisitor()));
let mon = startMonitor();
const created1 = await Promise.all(
  visitors1.map((v, i) =>
    requestChat(v, i % 2 ? sales.id : support.id, `Request ${i} for ${i % 2 ? 'Sales' : 'Support'}`),
  ),
);
ok(
  created1.every((r) => r.status === 201),
  'six concurrent chat requests (3 Support, 3 Sales) admitted with 201',
);
const chats1 = created1.map((r) => r.data.chat.id);
await waitFor(
  () =>
    activeOf(A1) === 2 &&
    sql(`SELECT count(*) FROM assignment_offers WHERE tenant_id = '${T}' AND status = 'pending'`) === '0',
  15_000,
  'A1 at capacity',
);
await sleep(1500);
mon.stop = true;
await mon.done;
ok(
  mon.samples > 5 && mon.maxOver <= 0,
  `active + reserved never exceeded capacity for any agent while routing (${mon.samples} psql samples, worst ${JSON.stringify(mon.worst)})`,
);
ok(mon.doubleOwner === 0, 'no chat ever had two primary owners');
const byDept = Object.fromEntries(
  sql(
    `SELECT d.name, count(*) FILTER (WHERE c.status = 'active'), count(*) FILTER (WHERE c.status = 'queued') FROM chats c JOIN departments d ON d.id = c.department_id WHERE c.id = ANY(${ids(chats1)}) GROUP BY d.name`,
  )
    .split('\n')
    .map((l) => {
      const [n, a, q] = l.split('|');
      return [n, { active: Number(a), queued: Number(q) }];
    }),
);
ok(
  activeOf(A1) === 2 &&
    byDept.Support.active + byDept.Sales.active === 2 &&
    byDept.Support.queued + byDept.Sales.queued === 4,
  `A1 owns exactly 2 chats; the other 4 wait (${JSON.stringify(byDept)})`,
);
ok(
  byDept.Support.queued >= 1 && byDept.Sales.queued >= 1,
  'both departments have chats waiting on the same full agent (no per-department double allocation)',
);
ok(
  sql(`SELECT count(*) FROM assignment_offers WHERE tenant_id = '${T}' AND membership_id = '${A1.id}'`) ===
    '2',
  'exactly two offers were ever made to A1 (one per free slot)',
);
const queuedSales = sql(
  `SELECT id FROM chats WHERE id = ANY(${ids(chats1)}) AND status = 'queued' AND department_id = '${sales.id}' LIMIT 1`,
);
const pickup = await A1.c.call('POST', `/chats/${queuedSales}/accept`, {});
ok(
  pickup.status === 409 && pickup.error.code === 'CAPACITY_EXCEEDED',
  'manual pickup of a queued Sales chat by the full agent → 409 CAPACITY_EXCEEDED',
);
const avail = await visitors1[0].must('GET', '/widget/v1/availability', undefined, visitors1[0].auth);
const deptStates = Object.fromEntries((avail.departments ?? []).map((d) => [d.id, d.state]));
ok(
  deptStates[support.id] === 'busy' && deptStates[sales.id] === 'busy',
  'availability reports both departments busy (the shared agent has no free slot)',
);

const expectedNext = sql(
  `SELECT id FROM chats WHERE id = ANY(${ids(chats1)}) AND status = 'queued' ORDER BY priority DESC, requested_at ASC, id ASC LIMIT 1`,
);
const firstActive = sql(
  `SELECT id FROM chats WHERE id = ANY(${ids(chats1)}) AND status = 'active' ORDER BY id LIMIT 1`,
);
mon = startMonitor();
ok((await closeChat(firstActive)).status === 200, "closing one of A1's chats frees a slot");
await waitFor(
  () => sql(`SELECT status FROM chats WHERE id = '${expectedNext}'`) === 'active',
  10_000,
  'next chat assigned',
);
await sleep(1000);
mon.stop = true;
await mon.done;
ok(
  activeOf(A1) === 2 && mon.maxOver <= 0,
  `the freed slot went to the oldest waiting chat across both departments, still never above capacity (worst ${JSON.stringify(mon.worst)})`,
);
A1.autoAccept = false;
await presence(A1, 'away');
await closeAllOpen();

// ═══════════════════════════ ROUTE01: many concurrent requests ═══════════════════════════
console.log('30 concurrent requests, 4 agents × capacity 3, seeded declines, one disconnect (ROUTE01)');
await owner.must('PATCH', `/agents/${A1.id}`, { capacity: 3 });
const seeds = { [A1.id]: 11, [A2.id]: 22, [A3.id]: 33, [A4.id]: 44 };
for (const a of agents) {
  a.autoAccept = true;
  a.declineRate = 0.2;
  a.rand = rng(seeds[a.id]);
  a.acks = [];
}
clearRateLimits('rl:widget-session:*');
const visitors2 = await Promise.all(Array.from({ length: 30 }, () => newVisitor()));
for (const a of agents) await presence(a, 'online');
mon = startMonitor();
const created2 = await Promise.all(
  visitors2.map((v, i) => requestChat(v, support.id, `Concurrent request number ${i}`)),
);
ok(
  created2.every((r) => r.status === 201),
  `all 30 concurrent requests admitted (201): ${[...new Set(created2.map((r) => r.status))].join(',')}`,
);
const chats2 = created2.map((r) => r.data.chat.id);
A4.sock.disconnect(); // an agent drops mid-routing …
await sleep(400);
await connect(A4); // … and comes back
const settled = await waitFor(
  async () => {
    const [act, q, off, pend] = (
      await sqlAsync(
        `SELECT count(*) FILTER (WHERE status = 'active'), count(*) FILTER (WHERE status = 'queued'), count(*) FILTER (WHERE status = 'offered'), (SELECT count(*) FROM assignment_offers WHERE tenant_id = '${T}' AND status = 'pending') FROM chats WHERE id = ANY(${ids(chats2)})`,
      )
    )
      .split('|')
      .map(Number);
    return act === 12 && q === 18 && off === 0 && pend === 0 ? { act, q } : null;
  },
  80_000,
  'routing to settle',
);
await sleep(2000);
mon.stop = true;
await mon.done;
ok(!!settled, '12 chats active and 18 queued, no offer left pending');
ok(
  mon.samples > 20 && mon.maxOver <= 0,
  `no agent exceeded capacity (active + reserved) in ${mon.samples} samples taken while routing ran (worst ${JSON.stringify(mon.worst)})`,
);
ok(mon.doubleOwner === 0, 'no chat had two primary owners in any sample');
ok(
  agents.every((a) => activeOf(a) === 3),
  `every agent ends at exactly 3 active chats (${agents.map((a) => activeOf(a)).join(',')})`,
);
ok(
  new Set(chats2).size === 30 &&
    sql(
      `SELECT count(*) FROM chats WHERE tenant_id = '${T}' AND visitor_id = ANY(${ids(visitors2.map((v) => v.visitorId))})`,
    ) === '30',
  'exactly 30 chats exist for the 30 visitors (none lost, none duplicated)',
);
ok(
  sql(
    `SELECT count(*) FROM chats c WHERE c.id = ANY(${ids(chats2)}) AND c.status = 'active' AND (SELECT count(*) FROM chat_participants p WHERE p.chat_id = c.id AND p.role = 'primary' AND p.left_at IS NULL AND p.membership_id = c.owner_membership_id) <> 1`,
  ) === '0',
  'each active chat has exactly one primary participant, equal to its owner',
);
ok(
  sql(
    `SELECT count(*) FROM (SELECT chat_id FROM assignment_history WHERE chat_id = ANY(${ids(chats2)}) AND reason IN ('offer_accepted','picked_up') GROUP BY chat_id HAVING count(*) <> 1) x`,
  ) === '0' &&
    sql(
      `SELECT count(DISTINCT chat_id) FROM assignment_history WHERE chat_id = ANY(${ids(chats2)}) AND reason IN ('offer_accepted','picked_up')`,
    ) === '12',
  'assignment history: exactly one acceptance per assigned chat, none for queued ones',
);
const allAcks = agents.flatMap((a) => a.acks);
const declines = allAcks.filter((x) => x.kind === 'decline' && x.r.type === 'command.ack').length;
const accepts = allAcks.filter((x) => x.kind === 'accept' && x.r.type === 'command.ack').length;
const errors = allAcks.filter((x) => x.r.type === 'command.error').map((x) => x.r.code);
const cut = allAcks.filter((x) => x.r.type === 'transport').length;
ok(
  declines > 0 &&
    accepts + allAcks.filter((x) => x.kind === 'accept' && x.r.type === 'transport').length >= 12,
  `seeded run exercised declines (${declines}) and accepts (${accepts} acked; an accept in flight when the socket dropped still commits once)`,
);
ok(
  errors.every((c) => c === 'OFFER_WITHDRAWN' || c === 'OFFER_EXPIRED'),
  `the only refused commands were stale offers (${errors.join(',') || 'none'}; ${cut} cut by the disconnect) — never CAPACITY_EXCEEDED`,
);
const offerStates = Object.fromEntries(
  sql(`SELECT status, count(*) FROM assignment_offers WHERE chat_id = ANY(${ids(chats2)}) GROUP BY status`)
    .split('\n')
    .map((l) => l.split('|'))
    .map(([s, n]) => [s, Number(n)]),
);
ok(
  offerStates.accepted === 12 && (offerStates.declined ?? 0) === declines,
  `offer ledger reconciles (${JSON.stringify(offerStates)})`,
);
for (const a of agents) {
  a.autoAccept = false;
  a.declineRate = 0;
  await presence(a, 'away');
}
await closeAllOpen();

// ═══════════════════════════ AUD-71-16: deterministic queue order ═══════════════════════════
console.log('Queue order: priority, requested_at, id — in the queue view and in routing (AUD-71-16)');
await owner.must('PATCH', `/agents/${A1.id}`, { capacity: 1 });
A1.autoAccept = true;
await presence(A1, 'online');
const chat0 = await chatIn(support.id);
await waitFor(
  () => sql(`SELECT status FROM chats WHERE id = '${chat0}'`) === 'active',
  10_000,
  'chat0 active',
);
const Q = {};
for (const k of ['a', 'b', 'c', 'd', 'e']) Q[k] = await chatIn(support.id);
await waitFor(
  () =>
    sql(`SELECT count(*) FROM chats WHERE id = ANY(${ids(Object.values(Q))}) AND status = 'queued'`) === '5',
  8000,
  'five queued',
);
const base = Date.now() - 5000;
const at = (ms) => new Date(base + ms).toISOString();
sql(`UPDATE chats SET priority = 60, requested_at = '${at(2000)}' WHERE id = '${Q.a}'`);
sql(`UPDATE chats SET priority = 50, requested_at = '${at(0)}' WHERE id = '${Q.b}'`);
sql(`UPDATE chats SET priority = 50, requested_at = '${at(1000)}' WHERE id IN ('${Q.c}', '${Q.d}')`);
sql(`UPDATE chats SET priority = 40, requested_at = '${at(-2000)}' WHERE id = '${Q.e}'`);
const [lo, hi] = [Q.c, Q.d].sort();
const expectedOrder = [Q.a, Q.b, lo, hi, Q.e];
const views = [];
for (let i = 0; i < 3; i++)
  views.push(
    (await owner.must('GET', '/chats/queue')).map((c) => c.id).filter((id) => expectedOrder.includes(id)),
  );
ok(
  JSON.stringify(views[0]) === JSON.stringify(expectedOrder),
  'queue view: priority 60 first, then oldest of priority 50, equal timestamps by id ascending, priority 40 last',
);
ok(
  views.every((v) => JSON.stringify(v) === JSON.stringify(views[0])),
  'queue view order is identical on repeated reads',
);
const routed = [];
let holding = chat0;
for (let i = 0; i < 5; i++) {
  await closeChat(holding);
  const prev = holding;
  holding = await waitFor(
    () => {
      const id = sql(
        `SELECT id FROM chats WHERE tenant_id = '${T}' AND owner_membership_id = '${A1.id}' AND status = 'active'`,
      );
      return id && id !== prev ? id : null;
    },
    10_000,
    `next routed chat ${i}`,
  );
  routed.push(holding);
}
ok(
  JSON.stringify(routed) === JSON.stringify(expectedOrder),
  'routing offers the freed slot in exactly the same order (priority, requested_at, id)',
);

// Aging (ch. 31): effective priority = min(100, base + floor(wait_seconds / 60)).
const Qf = await chatIn(support.id);
const Qg = await chatIn(support.id);
sql(`UPDATE chats SET priority = 50, requested_at = now() - interval '10 minutes' WHERE id = '${Qf}'`);
sql(`UPDATE chats SET priority = 55, requested_at = now() WHERE id = '${Qg}'`);
const agedView = (await owner.must('GET', '/chats/queue'))
  .map((c) => c.id)
  .filter((id) => id === Qf || id === Qg);
ok(
  JSON.stringify(agedView) === JSON.stringify([Qf, Qg]),
  'queue view applies aging: priority 50 waiting 10 min (effective 60) ranks above a fresh priority 55',
);
await closeChat(holding);
const agedPick = await waitFor(
  () =>
    sql(
      `SELECT chat_id FROM assignment_offers WHERE membership_id = '${A1.id}' AND chat_id IN ('${Qf}', '${Qg}') ORDER BY created_at LIMIT 1`,
    ),
  10_000,
  'aged pick',
);
ok(
  agedPick === Qf,
  `routing applies the same aging as the queue view — the aged chat is offered first (offered ${agedPick === Qf ? 'aged' : 'fresh priority-55'} chat; drainQueue orders by base priority)`,
);
A1.autoAccept = false;
await presence(A1, 'away');
await closeAllOpen();

// ═══════════════════════════ ROUTE02: tie breaking ═══════════════════════════
console.log('Tie breaking: normalized load, assignment recency (never-assigned first), id (ROUTE02)');
for (const a of agents) await owner.must('PATCH', `/agents/${a.id}`, { capacity: 3 });
for (const a of agents) await presence(a, 'online');
const setLast = (a, expr) => sql(`UPDATE memberships SET last_assignment_at = ${expr} WHERE id = '${a.id}'`);
async function firstPick() {
  const chat = await chatIn(support.id);
  const [, target] = await waitOffer(chat);
  await closeChat(chat);
  return target;
}
setLast(A1, "now() - interval '10 minutes'");
setLast(A2, "now() - interval '20 minutes'");
setLast(A3, "now() - interval '5 minutes'");
setLast(A4, "now() - interval '15 minutes'");
const rec1 = [await firstPick(), await firstPick()];
ok(
  rec1.every((t) => t === A2.id),
  'equal load: the agent with the earliest last assignment (A2, 20 min ago) gets the offer — twice in a row',
);
setLast(A3, 'NULL');
const rec2 = [await firstPick(), await firstPick()];
ok(
  rec2.every((t) => t === A3.id),
  'a never-assigned agent (last_assignment_at NULL) ranks before every assigned one — twice in a row',
);
const sortedAgents = [...agents].sort((x, y) => (x.id < y.id ? -1 : 1));
const [U1, U2, U3, U4] = sortedAgents;
async function loadSequence() {
  sql(
    `UPDATE memberships SET last_assignment_at = '2026-01-01T00:00:00Z' WHERE id = ANY(${ids(agents.map((a) => a.id))})`,
  );
  await owner.must('PATCH', `/agents/${U4.id}`, { capacity: 6 });
  const picks = [];
  const open = [];
  for (let i = 0; i < 6; i++) {
    const chat = await chatIn(support.id);
    open.push(chat);
    picks.push((await waitOffer(chat))[1]);
  }
  for (const c of open) await closeChat(c);
  await owner.must('PATCH', `/agents/${U4.id}`, { capacity: 3 });
  return picks;
}
const expectedPicks = [U1.id, U2.id, U3.id, U4.id, U4.id, U1.id];
const run1 = await loadSequence();
ok(
  JSON.stringify(run1) === JSON.stringify(expectedPicks),
  'equal recency: offers go U1, U2, U3, U4 by id; then U4 again (capacity 6 → load 1/6 < 1/3); then U1 (all at 1/3, id tie)',
);
const run2 = await loadSequence();
ok(
  JSON.stringify(run2) === JSON.stringify(run1),
  'the repeated run produces the identical assignment sequence',
);
for (const a of agents) await presence(a, 'away');
await closeAllOpen();

// ═══════════════════════════ AUD-71-16 / ROUTE03: offer expiry ═══════════════════════════
console.log('Offer expiry re-offers to the next agent; stale accepts are refused (AUD-71-16, ROUTE03)');
await presence(A1, 'online');
await presence(A2, 'online');
setLast(A1, "now() - interval '20 minutes'");
setLast(A2, "now() - interval '10 minutes'");
const E = await chatIn(support.id);
const [o1, o1Target] = await waitOffer(E);
ok(o1Target === A1.id, 'first offer goes to A1');
const ttl = Number(
  sql(
    `SELECT round(extract(epoch FROM expires_at - created_at) * 1000) FROM assignment_offers WHERE id = '${o1}'`,
  ),
);
ok(Math.abs(ttl - OFFER_TTL_MS) <= 5, `offer reservation lasts OFFER_TTL_MS = 30 s (${ttl} ms)`);
console.log('    … waiting for the 30 s offer to expire');
const o1State = await waitFor(
  () => {
    const r = sql(
      `SELECT status || '|' || coalesce(decision_reason, '') FROM assignment_offers WHERE id = '${o1}'`,
    );
    return r.startsWith('pending') ? null : r;
  },
  50_000,
  'offer expiry',
);
ok(o1State === 'expired|timeout', 'unanswered offer → expired (reason timeout)');
const [o2, o2Target] = await waitOffer(E, 10_000);
ok(o2 !== o1 && o2Target === A2.id, 'the chat is re-offered to the next agent (A2)');
const wFrame = await waitFor(
  () => A1.withdrawn.find((p) => p.offer_id === o1),
  5000,
  'A1 withdrawn frame',
).catch((e) => {
  console.log(
    'DEBUG',
    A1.sock.connected,
    JSON.stringify(A1.withdrawn),
    A1.sock.frames.slice(-6).map((f) => f.type + ':' + f.occurred_at),
  );
  throw e;
});
ok(wFrame.reason === 'expired' && wFrame.chat_id === E, 'A1 receives assignment.withdrawn {reason: expired}');
ok(
  sql(
    `SELECT count(DISTINCT event_id) FROM outbox_events WHERE event_type = 'assignment.withdrawn' AND aggregate_id = '${o1}'`,
  ) === '1' && sql(`SELECT version FROM assignment_offers WHERE id = '${o1}'`) === '2',
  'the expired reservation was released exactly once (timer and sweep never double-expire)',
);
const staleExpired = await A1.c.call('POST', `/chats/${E}/accept`, { offer_id: o1 });
ok(
  staleExpired.status === 409 && staleExpired.error.code === 'OFFER_EXPIRED',
  'stale accept of the expired offer → 409 OFFER_EXPIRED',
);
const sockStale = await command(A1.sock, 'offer.accept', { chat_id: E, offer_id: o1 });
ok(
  sockStale.type === 'command.error' && sockStale.code === 'OFFER_EXPIRED',
  'same over the socket: command.error OFFER_EXPIRED',
);
const grab = await A1.c.call('POST', `/chats/${E}/accept`, {});
ok(
  grab.status === 409 && grab.error.code === 'CHAT_ALREADY_ASSIGNED',
  'A1 cannot grab the chat while A2 holds the live offer (409 CHAT_ALREADY_ASSIGNED)',
);
ok((await A2.c.call('POST', `/offers/${o2}/decline`, { reason: 'busy' })).status === 200, 'A2 declines');
await waitFor(
  () => sql(`SELECT status FROM chats WHERE id = '${E}'`) === 'queued' && !pendingOfferFor(E),
  5000,
  'E queued',
);
ok(
  sql(`SELECT count(*) FROM assignment_history WHERE chat_id = '${E}' AND reason = 'queued_no_candidate'`) !==
    '0',
  'with A1 cooling down (expired) and A2 declined, the chat waits in the queue',
);
const staleDeclined = await A2.c.call('POST', `/chats/${E}/accept`, { offer_id: o2 });
ok(
  staleDeclined.status === 409 && staleDeclined.error.code === 'OFFER_WITHDRAWN',
  'accepting your own declined offer → 409 OFFER_WITHDRAWN',
);
ok(
  sql(`SELECT owner_membership_id IS NULL FROM chats WHERE id = '${E}'`) === 't',
  'no stale accept produced an owner',
);
await closeChat(E);

// ═══════════════════════════ ROUTE03: away / disconnect during an offer ═══════════════════════════
console.log('Away or disconnect during an offer withdraws it exactly once (ROUTE03)');
setLast(A1, "now() - interval '20 minutes'");
setLast(A2, "now() - interval '10 minutes'");
A1.withdrawn = [];
A2.withdrawn = [];
const W = await chatIn(support.id);
const [w1, w1Target] = await waitOffer(W);
ok(w1Target === A1.id, 'offer w1 → A1');
await presence(A1, 'away');
ok(
  sql(`SELECT status || '|' || decision_reason FROM assignment_offers WHERE id = '${w1}'`) ===
    'withdrawn|agent_away',
  'A1 going away withdraws w1 (agent_away)',
);
const [w2, w2Target] = await waitOffer(W);
ok(w2Target === A2.id, 'the chat is re-offered to A2');
await sleep(800);
ok(
  A1.withdrawn.filter((p) => p.offer_id === w1).length === 1 &&
    A1.withdrawn.find((p) => p.offer_id === w1).reason === 'agent_away',
  'A1 receives exactly one assignment.withdrawn for w1',
);
ok(
  sql(
    `SELECT count(DISTINCT event_id) FROM outbox_events WHERE event_type = 'assignment.withdrawn' AND aggregate_id = '${w1}'`,
  ) === '1' && sql(`SELECT version FROM assignment_offers WHERE id = '${w1}'`) === '2',
  'the reservation was released exactly once (one withdrawn event, offer version 1 → 2)',
);
const staleAway = await A1.c.call('POST', `/chats/${W}/accept`, { offer_id: w1 });
ok(
  staleAway.status === 409 && staleAway.error.code === 'OFFER_WITHDRAWN',
  'stale accept after going away → 409 OFFER_WITHDRAWN',
);
await presence(A1, 'online');
await sleep(300);
ok(pendingOfferFor(W).startsWith(w2), "A1 coming back online does not disturb A2's live offer");
A2.sock.disconnect();
const w2State = await waitFor(
  () => {
    const r = sql(
      `SELECT status || '|' || coalesce(decision_reason, '') FROM assignment_offers WHERE id = '${w2}'`,
    );
    return r.startsWith('pending') ? null : r;
  },
  10_000,
  'w2 withdrawn on disconnect',
);
ok(w2State === 'withdrawn|agent_disconnected', 'A2 disconnecting withdraws w2 (agent_disconnected)');
const [w3, w3Target] = await waitOffer(W);
ok(w3Target === A1.id, 'the chat is re-offered to A1');
ok(
  sql(
    `SELECT count(DISTINCT event_id) FROM outbox_events WHERE event_type = 'assignment.withdrawn' AND aggregate_id = '${w2}'`,
  ) === '1' && sql(`SELECT version FROM assignment_offers WHERE id = '${w2}'`) === '2',
  'w2 released exactly once',
);
await connect(A2);
const staleDisc = await A2.c.call('POST', `/chats/${W}/accept`, { offer_id: w2 });
ok(
  staleDisc.status === 409 && staleDisc.error.code === 'OFFER_WITHDRAWN',
  'A2 reconnects; its stale accept → 409 OFFER_WITHDRAWN',
);
const acc = await command(A1.sock, 'offer.accept', { chat_id: W, offer_id: w3 });
ok(acc.type === 'command.ack' && acc.result.owner_membership_id === A1.id, 'A1 accepts the live offer w3');
ok(
  sql(
    `SELECT count(*) FROM chat_participants WHERE chat_id = '${W}' AND role = 'primary' AND left_at IS NULL`,
  ) === '1' &&
    sql(
      `SELECT string_agg(status::text, ',' ORDER BY created_at) FROM assignment_offers WHERE chat_id = '${W}'`,
    ) === 'withdrawn,withdrawn,accepted',
  'one owner; offer ledger withdrawn → withdrawn → accepted',
);

console.log('Accept revalidates capacity');
await presence(A2, 'away');
await owner.must('PATCH', `/agents/${A1.id}`, { capacity: 2 });
const V = await chatIn(support.id);
const [v1, v1Target] = await waitOffer(V);
ok(v1Target === A1.id, 'A1 (1 of 2 used) gets the offer for V');
await owner.must('PATCH', `/agents/${A1.id}`, { capacity: 1 });
const over = await A1.c.call('POST', `/chats/${V}/accept`, { offer_id: v1 });
ok(
  over.status === 409 && over.error.code === 'CAPACITY_EXCEEDED',
  'capacity lowered to 1 while the offer was pending → accept refused with CAPACITY_EXCEEDED',
);
ok(
  sql(`SELECT status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${V}'`) ===
    'offered|-' && activeOf(A1) === 1,
  'V is not assigned and A1 stays at 1 active chat',
);
await closeAllOpen();

for (const a of agents) a.sock.disconnect();
console.log(`\nROUTING E2E PASSED (${passed} checks)`);
if (knownFails.length) {
  console.log(`KNOWN FAILS (${knownFails.length}):`);
  for (const k of knownFails) console.log(`  - ${k}`);
}
process.exit(0);
