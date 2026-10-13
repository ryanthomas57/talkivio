// ROUTE01 at the reference scale (ch. 15/16): 100 concurrent requests, 10 agents × capacity 3, two API processes and
// two workers — node test/routing-scale.e2e.mjs against a running api + worker (repo .env sourced; BUILD_DIR, default
// dist, is used to start the second API and worker).
//   * The 10 agents (the owner plus 9 invited agents, the plan's 10 seats) connect their sockets to two different
//     API processes; the 100 visitors request chats concurrently through both. Assigned routing offers each chat with
//     a reservation; agents accept from whichever process holds their socket, with seeded declines.
//   * While routing runs, psql samples every agent's active + reserved load: never above capacity, never two
//     primary owners. At rest: exactly 30 chats active (10 × 3), 70 queued, no offer pending; every chat accounted
//     for once; one accepted offer and one acceptance in the history per active chat.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const API2_PORT = Number(process.env.API2_PORT ?? 4031);
const API2 = `http://localhost:${API2_PORT}`;
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = resolve(apiDir, process.env.BUILD_DIR ?? 'dist');
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const REQUESTS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const execFileP = promisify(execFile);
const sqlAsync = async (q) => (await execFileP('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q])).stdout.trim();
const ids = (arr) => `ARRAY[${arr.map((x) => `'${x}'`).join(',')}]::uuid[]`;
function clearRateLimits(...patterns) {
  for (const p of patterns) {
    const keys = execFileSync('redis-cli', ['--scan', '--pattern', p]).toString().split('\n').filter(Boolean);
    if (keys.length) execFileSync('redis-cli', ['del', ...keys]);
  }
}
class Client {
  constructor(name, base = API) {
    this.name = name;
    this.base = base;
    this.cookies = {};
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${this.base}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}), ...extra },
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
    return { status: res.status, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
function socket(base, ticket) {
  const s = io(`${base}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  return new Promise((resolve_, reject) => {
    s.on('auth.ok', () => resolve_(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  });
}
const command = (s, type, payload) => s.emitWithAck('command', { v: 1, command_id: randomUUID(), type, payload });
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
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

// ═══════════════════════════ A second API process and a second worker ═══════════════════════════
const children = [];
function start(script, env, log) {
  const p = spawn(process.execPath, ['--enable-source-maps', resolve(BUILD_DIR, script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => log.push(String(d)));
  p.stderr.on('data', (d) => log.push(String(d)));
  children.push(p);
  return p;
}
const cleanup = () => {
  for (const p of children) p.kill('SIGTERM');
};
process.on('exit', cleanup);
const api2Log = [];
start('main.js', { PORT: String(API2_PORT), API_URL: API2 }, api2Log);
start('worker.js', { WORKER_HEALTH_PORT: String(API2_PORT + 1) }, []);
await waitFor(async () => (await fetch(`${API2}/health/ready`).catch(() => null))?.ok, 30_000, 'second API ready');
await waitFor(async () => (await fetch(`http://localhost:${API2_PORT + 1}/health/ready`).catch(() => null))?.ok, 30_000, 'second worker ready');
ok(true, `second API on :${API2_PORT} and second worker running beside the main stack`);

// ═══════════════════════════ Tenant, 10 agents ═══════════════════════════
const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:widget-session:*', 'rl:ws-agent-connect:*');
console.log('Setup: owner + 9 agents, Support with assigned routing');
const owner = new Client('owner');
const ownerEmail = `scale-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'scale owner passphrase', tenant_name: `Scale ${stamp}`, timezone: 'UTC', display_name: 'Owner' });
const T = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const site = await owner.must('POST', '/sites', { name: 'Scale store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
let support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
support = await owner.must('PATCH', `/departments/${support.id}`, { routing_mode: 'assigned', max_wait_seconds: 0 });
const ownerId = (await owner.must('GET', '/agents/me')).agent.id;
await owner.must('PATCH', `/agents/${ownerId}`, { capacity: 3 });
await owner.must('PUT', `/departments/${support.id}/members`, { members: [{ membership_id: ownerId, can_serve: true }] });
const agents = [{ name: 'Owner', c: owner, id: ownerId }];
for (let i = 1; i <= 9; i++) {
  const email = `scale-agent${i}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', { email, role: 'agent', department_ids: [support.id], capacity: 3 });
  const c = new Client(`agent${i}`);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'), display_name: `Agent ${i}`, password: 'scale agent passphrase' });
  agents.push({ name: `Agent ${i}`, c, id: (await c.must('GET', '/agents/me')).agent.id });
}
const seeds = Object.fromEntries(agents.map((a, i) => [a.id, 101 + i]));
for (const [i, a] of agents.entries()) {
  // Odd agents hold their socket on the second API process.
  a.base = i % 2 ? API2 : API;
  a.sock = await socket(a.base, (await a.c.must('POST', '/socket-ticket')).ticket);
  a.rand = rng(seeds[a.id]);
  a.acks = [];
  a.sock.on('event', (f) => {
    if (f.type !== 'assignment.offered' || f.payload.offer.mode !== 'assigned') return;
    const offer = f.payload.offer;
    const decline = a.rand() < 0.2;
    void command(a.sock, decline ? 'offer.decline' : 'offer.accept', decline ? { offer_id: offer.id, reason: 'seeded decline' } : { chat_id: offer.chat_id, offer_id: offer.id }).then(
      (r) => a.acks.push({ kind: decline ? 'decline' : 'accept', r }),
      (e) => a.acks.push({ kind: decline ? 'decline' : 'accept', r: { type: 'transport', code: e.message } }),
    );
  });
}
ok(agents.length === 10 && agents.filter((a) => a.base === API2).length === 5, '10 agents × capacity 3: 5 sockets on each API process');
const seats = sql(`SELECT count(*) FROM memberships WHERE tenant_id = '${T}' AND enabled`);
ok(seats === '10', `the plan's 10 seats are in use (${seats} enabled members)`);

// ═══════════════════════════ 100 concurrent requests ═══════════════════════════
console.log(`${REQUESTS} concurrent requests through both API processes`);
const visitors = await Promise.all(
  Array.from({ length: REQUESTS }, async (_, i) => {
    const v = new Client('visitor', i % 2 ? API2 : API);
    const s = await v.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
    v.auth = { authorization: `Bearer ${s.capability}` };
    v.visitorId = s.visitor?.id ?? s.visitor_id;
    return v;
  }),
);
for (const a of agents) await a.c.must('PUT', '/agents/me/presence', { status: 'online' });

const LOAD_SQL = `
  SELECT m.id, m.capacity,
    (SELECT count(*) FROM chats c WHERE c.tenant_id = m.tenant_id AND c.owner_membership_id = m.id AND c.status = 'active'),
    (SELECT count(*) FROM assignment_offers o WHERE o.tenant_id = m.tenant_id AND o.membership_id = m.id AND o.status = 'pending' AND o.mode IN ('assigned','transfer') AND o.expires_at > now())
  FROM memberships m WHERE m.tenant_id = '${T}'`;
const mon = { maxOver: -Infinity, worst: null, samples: 0, stop: false, doubleOwner: 0 };
mon.done = (async () => {
  while (!mon.stop) {
    for (const [id, cap, active, reserved] of (await sqlAsync(LOAD_SQL)).split('\n').filter(Boolean).map((l) => l.split('|'))) {
      const over = Number(active) + Number(reserved) - Number(cap);
      if (over > mon.maxOver) {
        mon.maxOver = over;
        mon.worst = { id, cap: Number(cap), active: Number(active), reserved: Number(reserved) };
      }
    }
    mon.doubleOwner += Number(await sqlAsync(`SELECT count(*) FROM (SELECT chat_id FROM chat_participants WHERE tenant_id = '${T}' AND role = 'primary' AND left_at IS NULL GROUP BY chat_id HAVING count(*) > 1) x`));
    mon.samples++;
    await sleep(25);
  }
})();
const t0 = Date.now();
const created = await Promise.all(visitors.map((v, i) => v.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Scale request ${i}`, department_id: support.id }, v.auth)));
ok(created.every((r) => r.status === 201), `all ${REQUESTS} concurrent requests admitted (201) in ${Date.now() - t0} ms: ${[...new Set(created.map((r) => r.status))].join(',')}`);
const chatIds = created.map((r) => r.data.chat.id);
const settled = await waitFor(
  async () => {
    const [act, q, off, pend] = (await sqlAsync(`SELECT count(*) FILTER (WHERE status = 'active'), count(*) FILTER (WHERE status = 'queued'), count(*) FILTER (WHERE status = 'offered'), (SELECT count(*) FROM assignment_offers WHERE tenant_id = '${T}' AND status = 'pending') FROM chats WHERE tenant_id = '${T}'`)).split('|').map(Number);
    return act === 30 && q === 70 && off === 0 && pend === 0 ? { act, q } : null;
  },
  120_000,
  'routing to settle at 30 active / 70 queued',
);
const settleMs = Date.now() - t0;
await sleep(2000);
mon.stop = true;
await mon.done;
ok(!!settled, `30 chats active and 70 queued, no offer pending (settled in ${settleMs} ms)`);
ok(mon.samples > 20 && mon.maxOver <= 0, `no agent above capacity (active + reserved) in ${mon.samples} samples while routing ran across two processes (worst ${JSON.stringify(mon.worst)})`);
ok(mon.doubleOwner === 0, 'no chat had two primary owners in any sample');
const perAgent = agents.map((a) => Number(sql(`SELECT count(*) FROM chats WHERE tenant_id = '${T}' AND owner_membership_id = '${a.id}' AND status = 'active'`)));
ok(perAgent.every((n) => n === 3), `every agent ends at exactly 3 active chats (${perAgent.join(',')})`);
ok(new Set(chatIds).size === REQUESTS && sql(`SELECT count(*) FROM chats WHERE tenant_id = '${T}' AND visitor_id = ANY(${ids(visitors.map((v) => v.visitorId))})`) === String(REQUESTS), `exactly ${REQUESTS} chats exist for the ${REQUESTS} visitors (none lost, none duplicated)`);
ok(sql(`SELECT count(*) FROM chats c WHERE c.id = ANY(${ids(chatIds)}) AND c.status = 'active' AND (SELECT count(*) FROM chat_participants p WHERE p.chat_id = c.id AND p.role = 'primary' AND p.left_at IS NULL AND p.membership_id = c.owner_membership_id) = 1`) === '30', 'each active chat has exactly one primary participant, its owner');
ok(sql(`SELECT count(*) FROM (SELECT chat_id FROM assignment_history WHERE chat_id = ANY(${ids(chatIds)}) AND reason IN ('offer_accepted','picked_up') GROUP BY chat_id HAVING count(*) <> 1) x`) === '0' && sql(`SELECT count(DISTINCT chat_id) FROM assignment_history WHERE chat_id = ANY(${ids(chatIds)}) AND reason IN ('offer_accepted','picked_up')`) === '30', 'assignment history: one acceptance per active chat, none for queued chats');
const acks = agents.flatMap((a) => a.acks);
const declines = acks.filter((x) => x.kind === 'decline' && x.r.type === 'command.ack').length;
const accepts = acks.filter((x) => x.kind === 'accept' && x.r.type === 'command.ack').length;
const errors = acks.filter((x) => x.r.type !== 'command.ack').map((x) => x.r.code ?? x.r.type);
ok(declines > 0 && accepts === 30, `seeded run: ${accepts} accepts acknowledged, ${declines} declines`);
ok(errors.every((c) => c === 'OFFER_WITHDRAWN' || c === 'OFFER_EXPIRED'), `the only refused commands were stale offers (${errors.join(',') || 'none'}) — never CAPACITY_EXCEEDED`);
const offerStates = Object.fromEntries(sql(`SELECT status, count(*) FROM assignment_offers WHERE chat_id = ANY(${ids(chatIds)}) GROUP BY status`).split('\n').map((l) => l.split('|')).map(([s, n]) => [s, Number(n)]));
ok(offerStates.accepted === 30 && (offerStates.declined ?? 0) === declines, `offer ledger reconciles (${JSON.stringify(offerStates)})`);
const viaApi2 = agents.filter((a) => a.base === API2).reduce((s, a) => s + a.acks.filter((x) => x.kind === 'accept' && x.r.type === 'command.ack').length, 0);
ok(viaApi2 > 0 && viaApi2 < 30, `accepts arrived through both processes (${viaApi2} via :${API2_PORT}, ${30 - viaApi2} via the main API)`);

for (const a of agents) a.sock.disconnect();
for (const id of sql(`SELECT id FROM chats WHERE tenant_id = '${T}' AND status <> 'closed'`).split('\n').filter(Boolean)) await owner.call('POST', `/chats/${id}/close`, { reason: 'resolved' });
cleanup();
console.log(`\nROUTING SCALE E2E PASSED (${passed} checks)`);
process.exit(0);
