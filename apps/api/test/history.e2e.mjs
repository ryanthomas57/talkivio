// History search across DST bounds with exact raw-row reconciliation (HIST01, ch. 17) — node test/history.e2e.mjs
// against a running api + worker (repo .env sourced: chat times are placed and reconciled with psql).
//   * Eleven chats sit on both sides of the London DST days of 2026: 2026-03-29 (23 hours, 00:00 GMT → 00:00 BST)
//     and 2026-10-25 (25 hours, 00:00 BST → 00:00 GMT, with "01:30" occurring twice), alternating Support and Sales.
//   * The dashboard sends each local day as half-open UTC instants (apps/dashboard/src/components/history/tz.ts,
//     unit-tested in tz.test.ts); here those instants select exactly the chats inside the day — first instant
//     included, first instant of the next day excluded — on the list path and the full-text path, page by page.
//   * Every result equals the raw rows: a direct SQL query over chats with the same bounds and the same
//     department rule (an agent sees their departments, unassigned chats and chats they own or joined).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
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
    return { status: res.status, data: json?.data, error: json?.error, page: json?.page };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
function socket(ticket) {
  const s = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  });
}

// ═══════════════════════════ Setup ═══════════════════════════
const stamp = Date.now();
const term = `dstprobe${stamp.toString(36)}`;
console.log('Setup: a London workspace with Support (owner) and Sales (an agent)');
const owner = new Client('owner');
const ownerEmail = `history-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'history owner passphrase', tenant_name: `History ${stamp}`, timezone: 'Europe/London' });
const T = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const ownerMembership = (await owner.must('GET', '/agents/me')).agent.id;
const site = await owner.must('POST', '/sites', { name: 'History store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const sales = await owner.must('POST', '/departments', { name: 'Sales', public_label: 'Sales' });
await owner.must('PUT', `/departments/${support.id}/members`, { members: [{ membership_id: ownerMembership, can_serve: true }] });
const agentEmail = `history-agent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [sales.id], capacity: 3 });
const agent = new Client('agent');
await agent.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'), display_name: 'Sam Sales', password: 'history agent passphrase' });
const agentMembership = (await agent.must('GET', '/agents/me')).agent.id;
const sockets = [await socket((await owner.must('POST', '/socket-ticket')).ticket), await socket((await agent.must('POST', '/socket-ticket')).ticket)];
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
await agent.must('PUT', '/agents/me/presence', { status: 'online' });
ok(T && support && sales && agentMembership, 'tenant (Europe/London), Support with the owner, Sales with an agent');

// Chat placement: [label, requested_at, department] — `in` marks the local day each chat belongs to.
const PLACEMENT = [
  ['s0 Mar 28 23:59:59.999 GMT', '2026-03-28T23:59:59.999Z', 'support', null],
  ['s1 Mar 29 00:00 GMT (first instant)', '2026-03-29T00:00:00.000Z', 'sales', 'spring'],
  ['s2 Mar 29 03:00 BST (after the gap)', '2026-03-29T02:00:00.000Z', 'support', 'spring'],
  ['s3 Mar 29 23:59:59.999 BST (last instant)', '2026-03-29T22:59:59.999Z', 'sales', 'spring'],
  ['s4 Mar 30 00:00 BST (next day)', '2026-03-29T23:00:00.000Z', 'support', null],
  ['a0 Oct 24 23:59:59.999 BST', '2026-10-24T22:59:59.999Z', 'sales', null],
  ['a1 Oct 25 00:00 BST (first instant)', '2026-10-24T23:00:00.000Z', 'support', 'autumn'],
  ['a2 Oct 25 01:30 BST (first 01:30)', '2026-10-25T00:30:00.000Z', 'sales', 'autumn'],
  ['a3 Oct 25 01:30 GMT (second 01:30)', '2026-10-25T01:30:00.000Z', 'support', 'autumn'],
  ['a4 Oct 25 23:59:59.999 GMT (last instant)', '2026-10-25T23:59:59.999Z', 'sales', 'autumn'],
  ['a5 Oct 26 00:00 GMT (next day)', '2026-10-26T00:00:00.000Z', 'support', null],
];
const chats = [];
for (const [label, at, dept, day] of PLACEMENT) {
  const visitor = new Client('visitor');
  const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
  const departmentId = dept === 'sales' ? sales.id : support.id;
  const id = await waitFor(async () => (await visitor.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Question ${term} ${label}`, department_id: departmentId }, { authorization: `Bearer ${sess.capability}` })).data?.chat?.id, 10000, `chat ${label} admitted`);
  chats.push({ id, label, at, departmentId, day });
}
for (const c of chats) {
  await owner.call('POST', `/chats/${c.id}/close`, { reason: 'resolved' });
  sql(`UPDATE chats SET requested_at = '${c.at}' WHERE id = '${c.id}'`);
}
ok(sql(`SELECT count(*) FROM chats WHERE tenant_id = '${T}' AND id IN (${chats.map((c) => `'${c.id}'`).join(',')})`) === String(chats.length), `${chats.length} chats placed around both DST days`);

// The local days as the dashboard sends them (tz.ts zonedRange; asserted in tz.test.ts).
const DAYS = {
  spring: { from: '2026-03-29T00:00:00.000Z', to: '2026-03-29T23:00:00.000Z', hours: 23 },
  autumn: { from: '2026-10-24T23:00:00.000Z', to: '2026-10-26T00:00:00.000Z', hours: 25 },
};

/** Every page of a history query (small pages, so the keyset cursor crosses the DST instants). */
async function allPages(c, params) {
  const ids = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ ...params, limit: '2', ...(cursor ? { cursor } : {}) });
    const r = await c.call('GET', `/chats/history?${qs}`);
    if (r.status !== 200) throw new Error(`history → ${r.status} ${JSON.stringify(r.error)}`);
    ids.push(...r.data.map((x) => x.id));
    cursor = r.page?.has_more ? r.page.next_cursor : null;
    if (!cursor) break;
  }
  return ids;
}
/** The raw rows: the same half-open bounds and department rule, straight from chats. */
function rawIds(day, scope) {
  const scopeSql =
    scope === 'all'
      ? ''
      : `AND (c.department_id IS NULL OR c.department_id IN (${scope.departments.map((d) => `'${d}'`).join(',')}) OR c.owner_membership_id = '${scope.membership}' OR EXISTS (SELECT 1 FROM chat_participants p WHERE p.chat_id = c.id AND p.membership_id = '${scope.membership}'))`;
  return sql(`SELECT c.id FROM chats c WHERE c.tenant_id = '${T}' AND c.is_preview = false AND c.requested_at >= '${day.from}' AND c.requested_at < '${day.to}' ${scopeSql} ORDER BY c.requested_at DESC, c.id DESC`)
    .split('\n')
    .filter(Boolean);
}
const labels = (ids) => ids.map((id) => chats.find((c) => c.id === id)?.label ?? id);

for (const [name, day] of Object.entries(DAYS)) {
  console.log(`${name === 'spring' ? '2026-03-29 (23 hours)' : '2026-10-25 (25 hours)'} in Europe/London`);
  ok((Date.parse(day.to) - Date.parse(day.from)) / 3600_000 === day.hours, `the local day spans ${day.hours} hours`);
  const expected = chats.filter((c) => c.day === name).sort((a, b) => b.at.localeCompare(a.at)).map((c) => c.id);
  const sales_ = chats.filter((c) => c.day === name && c.departmentId === sales.id).sort((a, b) => b.at.localeCompare(a.at)).map((c) => c.id);
  for (const [path, extra] of [
    ['list', {}],
    ['full-text', { q: term }],
  ]) {
    const got = await allPages(owner, { from: day.from, to: day.to, ...extra });
    ok(JSON.stringify(got) === JSON.stringify(expected), `owner, ${path}: exactly the ${expected.length} chats of the day, newest first (first instant in, next day's first instant out)`, { got: labels(got), expected: labels(expected) });
    ok(JSON.stringify(got) === JSON.stringify(rawIds(day, 'all')), `owner, ${path}: equals the raw rows`);
    const agentGot = await allPages(agent, { from: day.from, to: day.to, ...extra });
    ok(JSON.stringify(agentGot) === JSON.stringify(sales_), `Sales agent, ${path}: only the day's Sales chats (${sales_.length}); Support chats never appear`, { got: labels(agentGot) });
    ok(JSON.stringify(agentGot) === JSON.stringify(rawIds(day, { departments: [sales.id], membership: agentMembership })), `Sales agent, ${path}: equals the raw rows under the department rule`);
  }
}

console.log('Neighbouring days and a range across both changes');
const neighbours = await allPages(owner, { from: '2026-03-28T00:00:00.000Z', to: '2026-03-29T00:00:00.000Z' });
ok(JSON.stringify(labels(neighbours)) === JSON.stringify(['s0 Mar 28 23:59:59.999 GMT']), 'Mar 28 holds only its last-instant chat');
const wide = await allPages(owner, { from: '2026-03-28T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z', q: term });
ok(wide.length === chats.length && new Set(wide).size === chats.length, `Mar 28 – Oct 26: all ${chats.length} chats once each across pages`);
ok(JSON.stringify(wide) === JSON.stringify(rawIds({ from: '2026-03-28T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z' }, 'all')), 'and equals the raw rows in order');

for (const s of sockets) s.disconnect();
console.log(`\nHISTORY E2E PASSED (${passed} checks)`);
process.exit(0);
