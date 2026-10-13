// Talkivio security end-to-end tests — release-audit evidence for AUD-72-10, SEC02, SEC03 and
// part of SEC01 ("Security tests cover IDOR, CSRF, XSS, SQL injection, SSRF and socket boundaries").
// Runs against a live api (:4000) + worker (:4010): real HTTP, real sockets, PostgreSQL, Redis — no mocks.
//
//   cd apps/api && set -a && . ../../.env && set +a && node test/security.e2e.mjs
//
// Between many runs, clear the signup/login rate limits:
//   redis-cli --scan --pattern 'rl:*' | xargs -r redis-cli del
//
// `ok()` aborts on an unexpected failure (a regression or a test bug). `known()` records a genuine,
// documented gap as "KNOWN FAIL" without aborting; the run exits 1 while any known failure remains.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const WORKER = process.env.WORKER_URL ?? 'http://localhost:4010';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN_A = 'http://localhost:5173';
const ORIGIN_B = 'http://localhost:5174';
const PASSWORD = 'correct horse battery staple';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');

let passed = 0;
const knownFails = [];
const notes = [];
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
/** Genuine gap: report it, keep going, fail the run at the end. */
function known(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
    return true;
  }
  const line = `${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;
  knownFails.push(line);
  console.log(`  ✗ KNOWN FAIL: ${line}`);
  return false;
}
function note(msg) {
  notes.push(msg);
  console.log(`  · NOTE: ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-c', q]).toString().trim();

// ───────────────────────── HTTP client (cookies + CSRF + /api/v1 prefix) ─────────────────────────
class Client {
  constructor(name, opts = {}) {
    this.name = name;
    this.cookies = {};
    this.bearer = opts.bearer ?? null;
    this.ip = opts.ip ?? null;
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  url(path) {
    return `${API}${path.startsWith('/widget') || path.startsWith('/health') ? '' : '/api/v1'}${path}`;
  }
  /** `extra` header values of null remove a default header (e.g. `{ 'x-csrf-token': null }`). */
  async call(method, path, body, extra = {}) {
    const headers = {
      'content-type': 'application/json',
      ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
      ...(Object.keys(this.cookies).length ? { cookie: this.cookieHeader() } : {}),
      ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
      ...(this.ip ? { 'x-forwarded-for': this.ip } : {}),
      ...extra,
    };
    for (const [k, v] of Object.entries(headers)) if (v === null || v === undefined) delete headers[k];
    const res = await fetch(this.url(path), { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) this.cookies[k] = decodeURIComponent(v);
      else delete this.cookies[k];
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, data: json?.data, error: json?.error, headers: res.headers, text, setCookies };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const idem = () => ({ 'idempotency-key': `sec-${randomUUID()}` });

const latestEmail = (to, template) =>
  sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

// ───────────────────────── sockets (path /realtime/v1, namespaces /agent and /visitor) ─────────────────────────
function socket(ns, ticket, opts = {}) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false, ...opts });
  s.frames = [];
  s.ephemeral = [];
  s.controls = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('ephemeral', (f) => s.ephemeral.push(f));
  s.on('control', (f) => s.controls.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => {
      s.close();
      reject(new Error(`${ns} connect_error: ${e.message}`));
    });
  });
}
/** Resolves to the connect_error message, or null if the socket authenticated. */
const connectError = (ns, ticket, opts) =>
  socket(ns, ticket, opts).then(
    (s) => {
      s.close();
      return null;
    },
    (e) => e.message,
  );
const ack = (s, event, payload) => s.timeout(5000).emitWithAck(event, payload);
const cmd = (s, type, payload) => ack(s, 'command', { v: 1, command_id: randomUUID(), type, payload });
const agentTicket = async (c) => (await c.must('POST', '/socket-ticket')).ticket;
const visitorTicket = async (v) => (await v.must('POST', '/widget/v1/socket-ticket')).ticket;

// ───────────────────────── fixtures ─────────────────────────
const stamp = Date.now();
// Signup/login/reset limits are per client address; TRUST_PROXY=loopback honours X-Forwarded-For,
// so every principal in this run gets its own address and never trips another agent's buckets.
const ipBase = `10.${(stamp >> 16) & 255}.${(stamp >> 8) & 255}`;
const ip = (n) => `${ipBase}.${n}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function signupOwner(label, addr) {
  const c = new Client(`owner-${label}`, { ip: addr });
  const email = `sec-${label}+${stamp}@example.com`;
  const tenantName = `Sec ${label} ${stamp}`;
  const s = await c.must('POST', '/auth/signup', { email, password: PASSWORD, tenant_name: tenantName, timezone: 'UTC' });
  const text = await waitFor(() => latestEmail(email, 'verify_email'), 5000, `${label} verification email`);
  await c.must('POST', '/auth/verify-email', { token: tokenFrom(text, 'token') });
  Object.assign(c, { email, tenantName, tenantId: s.me.active_tenant_id, userId: s.user_id });
  c.membershipId = (await c.must('GET', '/agents/me')).agent.id;
  return c;
}
async function newVisitor(site, origin, name, addr) {
  const anon = new Client(name, { ip: addr });
  const sess = await anon.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: origin, consent: { analytics: false, policy_version: '2026-10' } });
  const v = new Client(name, { bearer: sess.capability, ip: addr });
  v.session = sess;
  v.visitorId = sess.visitor.id;
  return v;
}

console.log('Setup — tenant A (owner, agent, site, chats) and tenant B (owner, site, chat)');
const ownerA = await signupOwner('alpha', ip(11));
const ownerB = await signupOwner('beta', ip(12));
const supportA = (await ownerA.must('GET', '/departments')).find((d) => d.name === 'Support');
const supportB = (await ownerB.must('GET', '/departments')).find((d) => d.name === 'Support');
const siteA = await ownerA.must('POST', '/sites', { name: `Alpha Store ${stamp}`, origins: [{ origin: ORIGIN_A, pattern_type: 'exact' }] });
const siteB = await ownerB.must('POST', '/sites', { name: `Beta Store ${stamp}`, origins: [{ origin: ORIGIN_B, pattern_type: 'exact' }] });
const agentEmail = `sec-agent+${stamp}@example.com`;
await ownerA.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [supportA.id], capacity: 3 });
const agentA = new Client('agentA', { ip: ip(13) });
const inviteText = await waitFor(() => latestEmail(agentEmail, 'agent_invitation'), 5000, 'agent invitation');
await agentA.must('POST', '/agents/invitations/accept', { token: tokenFrom(inviteText, 'invite'), display_name: 'Agnes Agent', password: PASSWORD });
agentA.membershipId = (await agentA.must('GET', '/agents/me')).agent.id;

// Minted now, presented after its 30 s TTL in section 9.
const expiringTicket = await agentTicket(ownerA);
const expiringMintedAt = Date.now();

const ownerASock = await socket('/agent', await agentTicket(ownerA));
await ack(ownerASock, 'subscribe', { scopes: [{ kind: 'queue', id: 'none' }, { kind: 'queue', id: supportA.id }] });
await ownerA.must('PUT', '/agents/me/presence', { status: 'online' });
const ownerBSock = await socket('/agent', await agentTicket(ownerB));
await ack(ownerBSock, 'subscribe', { scopes: [{ kind: 'queue', id: 'none' }, { kind: 'queue', id: supportB.id }] });
await ownerB.must('PUT', '/agents/me/presence', { status: 'online' });

const MARK = `alphasecret${stamp}`;
const visitorA1 = await newVisitor(siteA, ORIGIN_A, 'visitorA1', ip(21));
const chatA1 = (await visitorA1.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Hi, I need a refund for order ${MARK}` })).chat.id;
await waitFor(async () => (await ownerA.call('POST', `/chats/${chatA1}/accept`, {})).status === 200, 8000, 'owner A accepts chat A1');
await ownerA.must('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: `Happy to help with ${MARK}` });
const noteCmid = randomUUID();
await ownerA.must('POST', `/chats/${chatA1}/messages`, { client_message_id: noteCmid, visibility: 'internal', body: `NOTE ${MARK} handle gently` });
const visitorA2 = await newVisitor(siteA, ORIGIN_A, 'visitorA2', ip(22));
const chatA2 = (await visitorA2.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Second visitor in tenant A' })).chat.id;
const visitorB = await newVisitor(siteB, ORIGIN_B, 'visitorB', ip(23));
const chatB1 = (await visitorB.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Beta visitor says hello refund' })).chat.id;
await waitFor(async () => (await ownerB.call('POST', `/chats/${chatB1}/accept`, {})).status === 200, 8000, 'owner B accepts chat B1');
const a1Count = () => sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}'`);
ok(ownerA.tenantId !== ownerB.tenantId && chatA1 && chatA2 && chatB1 && agentA.membershipId, 'tenants A and B with owners, a tenant A agent, sites and chats with messages');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. IDOR / tenant isolation — tenant B gets 404 on tenant A resources by id');
const fx = {};
fx.schedule = (await ownerA.call('GET', '/schedules')).data[0];
fx.dept = await ownerA.must('POST', '/departments', { name: `Alpha Sec Dept ${stamp}` });
fx.field = await ownerA.must('POST', '/custom-fields', { key: `sec_${stamp}`, label: `Alpha Field ${stamp}`, data_type: 'string' });
fx.ban = await ownerA.must('POST', '/bans', { ip: '198.51.100.77', reason: `Alpha ban ${stamp}` });
const TRIGGER_DEF = { dsl_version: 1, event: 'chat.requested', priority: 100, all: [], any: [], actions: [{ type: 'add_tag', tag: 'sec' }], stop_processing: false, cooldown_seconds: 0 };
fx.trigger = await ownerA.must('POST', '/triggers', { name: `Alpha Trigger ${stamp}`, definition: TRIGGER_DEF });
fx.shortcut = await ownerA.must('POST', '/shortcuts', { slug: `sec${stamp % 1000000}`, title: `Alpha Shortcut ${stamp}`, body: 'Hello from tenant A', scope_type: 'tenant' });
const HOOK_URL = `https://93.184.215.14/talkivio-sec-${stamp}`; // public IP literal: no DNS needed; event type never fires
fx.webhook = await ownerA.must('POST', '/webhooks', { url: HOOK_URL, event_types: ['privacy.erased'], description: `Alpha hook ${stamp}` });
fx.token = await ownerA.must('POST', '/integration-tokens', { name: `Alpha token ${stamp}`, scopes: ['chats:read'] });
fx.tag = await ownerA.must('POST', '/tags', { label: `alpha-sec-${stamp}` });
fx.invite = await ownerA.must('POST', '/agents/invitations', { email: `sec-pending+${stamp}@example.com`, role: 'agent' });
fx.export = await ownerA.must('POST', '/exports', { chat_ids: [chatA1], format: 'txt' });
const today = new Date().toISOString().slice(0, 10);
fx.analytics = await ownerA.must('POST', '/analytics/exports', { report: 'chats', format: 'csv', filters: { from: '2026-01-01', to: today, timezone: 'UTC' } }, idem());
fx.privacy = await ownerA.must('POST', '/privacy/requests', { kind: 'access', visitor_id: visitorA1.visitorId, proof_reference: `ticket-${stamp}` }, idem());
fx.closure = await ownerA.must('POST', '/emergency-closures', { department_id: fx.dept.id, reason: `Alpha closure ${stamp}` }, idem());
fx.upload = await ownerA.must('POST', '/attachments/uploads', { chat_id: chatA1, name: 'alpha.png', size_bytes: PNG.length, mime: 'image/png', sha256: sha(PNG) });
fx.transcript = await ownerA.must('POST', `/chats/${chatA1}/transcript-email`, { recipient: ownerA.email, format: 'txt' }, idem());
fx.session = (await ownerA.must('GET', '/auth/sessions')).find((s) => s.current);
const offline = await visitorA2.call('POST', '/widget/v1/offline-submissions', { client_request_id: `sec-${randomUUID()}`, name: 'Olive', email: 'olive@example.com', message: `Offline ${MARK}` });
fx.offline = offline.status < 300 ? sql(`SELECT id FROM offline_submissions WHERE tenant_id = '${ownerA.tenantId}' ORDER BY created_at DESC LIMIT 1`) : '';
if (!fx.offline) note(`offline submission fixture unavailable (${offline.status} ${offline.error?.code}); offline-submission IDOR routes skipped`);
// An "assigned" routing department yields a real offer row, and a chat outside agent A's department.
fx.assignedDept = await ownerA.must('POST', '/departments', { name: `Alpha Assigned ${stamp}`, routing_mode: 'assigned' });
await ownerA.must('PUT', `/departments/${fx.assignedDept.id}/members`, { members: [{ membership_id: ownerA.membershipId, can_serve: true }] });
const visitorA3 = await newVisitor(siteA, ORIGIN_A, 'visitorA3', ip(24));
const chatA3 = (await visitorA3.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Assigned routing please ${MARK}`, department_id: fx.assignedDept.id })).chat.id;
fx.offer = await waitFor(() => sql(`SELECT id FROM assignment_offers WHERE chat_id = '${chatA3}' AND status = 'pending' LIMIT 1`), 8000, 'assigned offer for owner A').catch(() => '');
fx.notification = await waitFor(() => sql(`SELECT id FROM notifications WHERE tenant_id = '${ownerA.tenantId}' ORDER BY created_at DESC LIMIT 1`), 4000, 'a tenant A notification').catch(() => '');
const aCfg = await ownerA.must('GET', `/sites/${siteA.id}/widget-config`);
const bCfg = await ownerB.must('GET', `/sites/${siteB.id}/widget-config`);
const validConfig = bCfg.published?.config ?? bCfg.draft?.config;
ok(Object.values(fx).filter((v) => v === undefined).length === 0 && validConfig, 'tenant A fixtures: schedule, department, custom field, ban, trigger, shortcut, webhook, token, tag, invitation, exports, privacy request, closure, upload, transcript job');

// Strings that only tenant A knows; no tenant B response may contain them.
const A_SECRETS = [ownerA.tenantName, ownerA.email, siteA.name, siteA.public_key, MARK, `Alpha Sec Dept ${stamp}`, `Alpha Field ${stamp}`, `Alpha Trigger ${stamp}`, `Alpha Shortcut ${stamp}`, HOOK_URL, `Alpha hook ${stamp}`, `Alpha token ${stamp}`, `alpha-sec-${stamp}`, `Alpha ban ${stamp}`, `Alpha closure ${stamp}`, 'Agnes Agent', agentEmail, `ticket-${stamp}`];
async function expect404(client, method, path, body, headers = {}) {
  const r = await client.call(method, path, body, headers);
  const leaked = A_SECRETS.filter((s) => s && r.text.includes(s));
  const label = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
  known(r.status === 404 && leaked.length === 0, `tenant B ${label} → 404 without tenant A data`, r.status === 404 ? `leaks ${leaked.join(', ')}` : `${r.status} ${r.text.slice(0, 160)}`);
}
const B = ownerB;
const ifm = (v = 1) => ({ 'if-match': `"${v}"` });
// Chats + messages
await expect404(B, 'GET', `/chats/${chatA1}`);
await expect404(B, 'GET', `/chats/${chatA1}/messages`);
await expect404(B, 'POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'tenant B was here' });
await expect404(B, 'POST', `/chats/${chatA1}/messages`, { client_message_id: noteCmid, visibility: 'internal', body: 'replay of a tenant A client_message_id' });
await expect404(B, 'POST', `/chats/${chatA2}/accept`, {});
await expect404(B, 'PUT', `/chats/${chatA1}/read-cursor`, { last_read_seq: 1 });
await expect404(B, 'POST', `/chats/${chatA1}/transfers`, { target_department_id: supportB.id }, idem());
await expect404(B, 'POST', `/chats/${chatA1}/collaborators`, { membership_id: ownerB.membershipId });
await expect404(B, 'DELETE', `/chats/${chatA1}/collaborators/${ownerA.membershipId}`);
await expect404(B, 'POST', `/chats/${chatA1}/close`, {});
await expect404(B, 'POST', `/chats/${chatA1}/request-rating`);
await expect404(B, 'PUT', `/chats/${chatA1}/tags`, { tag_ids: [] });
await expect404(B, 'POST', `/chats/${chatA1}/transcript-email`, { recipient: ownerB.email, format: 'txt' }, idem());
await expect404(B, 'GET', `/chats/${chatA1}/transcript-emails/${fx.transcript.id}`);
if (fx.offer) {
  // routing.decline answers every offer that is not the caller's (unknown, other tenant, other agent) with the same
  // 409 OFFER_WITHDRAWN, so compare against a random id: identical answer = no existence oracle, no data.
  const foreign = await B.call('POST', `/offers/${fx.offer}/decline`, {});
  const random = await B.call('POST', `/offers/${randomUUID()}/decline`, {});
  ok(foreign.status === random.status && foreign.error?.code === random.error?.code && foreign.error?.message === random.error?.message && !A_SECRETS.some((x) => foreign.text.includes(x)), `tenant B POST /offers/:id/decline on a tenant A offer → same ${foreign.status} ${foreign.error?.code} as an unknown id (no oracle, no tenant A data)`);
  if (foreign.status !== 404) note(`POST /offers/:id/decline returns ${foreign.status} ${foreign.error?.code} (not 404) for unknown/foreign offers — uniform, no leak (routing.service.ts decline)`);
  const otherAgent = await agentA.call('POST', `/offers/${fx.offer}/decline`, {});
  ok([403, 404, 409].includes(otherAgent.status), `a same-tenant agent cannot decline someone else's offer (${otherAgent.status} ${otherAgent.error?.code})`);
  ok(sql(`SELECT status FROM assignment_offers WHERE id = '${fx.offer}'`) === 'pending', 'the offer is still pending (psql)');
} else note('no tenant A assignment offer was created; POST /offers/:id/decline IDOR skipped');
// Visitors
const vA1 = visitorA1.visitorId;
await expect404(B, 'GET', `/visitors/${vA1}`);
await expect404(B, 'PATCH', `/visitors/${vA1}`, { display_name: 'Hacked' }, ifm());
await expect404(B, 'GET', `/visitors/${vA1}/sessions`);
await expect404(B, 'GET', `/visitors/${vA1}/chats`);
await expect404(B, 'PUT', `/visitors/${vA1}/tags`, { tag_ids: [] });
await expect404(B, 'POST', '/visitors/merge-requests', { source_id: visitorA2.visitorId, target_id: vA1, proof_reference: 'ticket 99', reason: 'same person' });
// Sites + widget config
await expect404(B, 'GET', `/sites/${siteA.id}`);
await expect404(B, 'PATCH', `/sites/${siteA.id}`, { name: 'Hacked' });
await expect404(B, 'POST', `/sites/${siteA.id}/archive`);
await expect404(B, 'POST', `/sites/${siteA.id}/key-rotation`, {});
await expect404(B, 'GET', `/sites/${siteA.id}/widget-config`);
await expect404(B, 'PUT', `/sites/${siteA.id}/widget-config`, { config: validConfig, base_etag: null });
await expect404(B, 'DELETE', `/sites/${siteA.id}/widget-config/draft`);
await expect404(B, 'POST', `/sites/${siteA.id}/widget-config/publish`, { revision: aCfg.published?.revision ?? 1 });
await expect404(B, 'GET', `/sites/${siteA.id}/installation-status`);
await expect404(B, 'POST', `/sites/${siteA.id}/identity-secret`);
await expect404(B, 'DELETE', `/sites/${siteA.id}/identity-secret`);
// Departments
await expect404(B, 'GET', `/departments/${fx.dept.id}`);
await expect404(B, 'PATCH', `/departments/${fx.dept.id}`, { name: 'Hacked', expected_version: fx.dept.version });
await expect404(B, 'POST', `/departments/${fx.dept.id}/archive`);
await expect404(B, 'PUT', `/departments/${fx.dept.id}/members`, { members: [] });
// Agents + invitations
await expect404(B, 'PATCH', `/agents/${agentA.membershipId}`, { display_name: 'Hacked' });
await expect404(B, 'PATCH', `/agents/${agentA.membershipId}`, { role: 'admin' });
await expect404(B, 'PUT', `/agents/${agentA.membershipId}/departments`, { departments: [] });
await expect404(B, 'DELETE', `/agents/invitations/${fx.invite.id}`);
await expect404(B, 'POST', '/tenants/current/ownership-transfer', { target_membership_id: agentA.membershipId, reason: 'takeover' });
// Schedules + closures
await expect404(B, 'GET', `/schedules/${fx.schedule.id}`);
await expect404(B, 'PATCH', `/schedules/${fx.schedule.id}`, { name: 'Hacked' }, ifm(fx.schedule.version));
await expect404(B, 'POST', `/schedules/${fx.schedule.id}/archive`, {});
await expect404(B, 'PUT', `/schedules/${fx.schedule.id}/exceptions/2026-12-25`, { intervals: [] });
await expect404(B, 'DELETE', `/schedules/${fx.schedule.id}/exceptions/2026-12-25`);
await expect404(B, 'GET', `/schedules/${fx.schedule.id}/preview`);
await expect404(B, 'DELETE', `/emergency-closures/${fx.closure.id}`);
// Custom fields
await expect404(B, 'PATCH', `/custom-fields/${fx.field.id}`, { label: 'Hacked' }, ifm(fx.field.version));
await expect404(B, 'POST', `/custom-fields/${fx.field.id}/archive`);
// Bans
await expect404(B, 'DELETE', `/bans/${fx.ban.id}`);
await expect404(B, 'POST', '/bans', { visitor_id: vA1, reason: 'cross-tenant ban' });
// Triggers
await expect404(B, 'GET', `/triggers/${fx.trigger.id}`);
await expect404(B, 'PATCH', `/triggers/${fx.trigger.id}`, { name: 'Hacked' }, ifm(fx.trigger.version ?? 1));
await expect404(B, 'DELETE', `/triggers/${fx.trigger.id}`);
await expect404(B, 'PUT', `/triggers/${fx.trigger.id}/draft`, { definition: TRIGGER_DEF });
await expect404(B, 'POST', `/triggers/${fx.trigger.id}/simulate`, { event: 'chat.requested', snapshot: {} });
await expect404(B, 'POST', `/triggers/${fx.trigger.id}/publish`, { revision: 1, enabled: true });
await expect404(B, 'POST', `/triggers/${fx.trigger.id}/restore`, { revision: 1 });
await expect404(B, 'GET', `/triggers/${fx.trigger.id}/runs`);
await expect404(B, 'GET', `/triggers/${fx.trigger.id}/funnel`);
// Shortcuts / canned replies
await expect404(B, 'GET', `/shortcuts/${fx.shortcut.id}`);
await expect404(B, 'PATCH', `/shortcuts/${fx.shortcut.id}`, { title: 'Hacked' }, ifm(fx.shortcut.version ?? 1));
await expect404(B, 'POST', `/shortcuts/${fx.shortcut.id}/archive`, {});
await expect404(B, 'POST', `/shortcuts/${fx.shortcut.id}/render`, {});
// Webhooks + integration tokens
await expect404(B, 'GET', `/webhooks/${fx.webhook.id}`);
await expect404(B, 'PATCH', `/webhooks/${fx.webhook.id}`, { description: 'Hacked' }, ifm(fx.webhook.version));
await expect404(B, 'DELETE', `/webhooks/${fx.webhook.id}`, undefined, ifm(fx.webhook.version));
await expect404(B, 'POST', `/webhooks/${fx.webhook.id}/rotate-secret`, {}, idem());
await expect404(B, 'POST', `/webhooks/${fx.webhook.id}/test`, undefined, idem());
await expect404(B, 'GET', `/webhooks/${fx.webhook.id}/deliveries`);
await expect404(B, 'DELETE', `/integration-tokens/${fx.token.id}`);
await expect404(B, 'POST', `/integration-tokens/${fx.token.id}/rotate`, undefined, idem());
// Exports
await expect404(B, 'GET', `/exports/${fx.export.id}`);
await expect404(B, 'GET', `/exports/${fx.export.id}/download`);
await expect404(B, 'POST', '/exports', { chat_ids: [chatA1], format: 'json' });
await expect404(B, 'POST', '/exports/preview', { chat_ids: [chatA1] });
await expect404(B, 'GET', `/analytics/exports/${fx.analytics.id}`);
await expect404(B, 'GET', `/analytics/exports/${fx.analytics.id}/download`);
// Offline submissions
if (fx.offline) {
  await expect404(B, 'GET', `/offline-submissions/${fx.offline}`);
  await expect404(B, 'POST', `/offline-submissions/${fx.offline}/reply`, { body: 'tenant B reply' });
  await expect404(B, 'PATCH', `/offline-submissions/${fx.offline}`, { status: 'handled' }, ifm());
}
// Attachments, tags, privacy, sessions, notifications, workspace switch
await expect404(B, 'GET', `/attachments/${fx.upload.upload_id}`);
await expect404(B, 'GET', `/attachments/${fx.upload.upload_id}/download`);
await expect404(B, 'POST', `/attachments/${fx.upload.upload_id}/finalize`, { sha256: sha(PNG) });
await expect404(B, 'DELETE', `/attachments/${fx.upload.upload_id}`);
await expect404(B, 'POST', '/attachments/uploads', { chat_id: chatA1, name: 'x.png', size_bytes: PNG.length, mime: 'image/png' });
await expect404(B, 'POST', `/tags/${fx.tag.id}/archive`);
await expect404(B, 'PUT', `/chats/${chatB1}/tags`, { tag_ids: [fx.tag.id] });
await expect404(B, 'GET', `/privacy/requests/${fx.privacy.id}`);
await expect404(B, 'POST', `/privacy/requests/${fx.privacy.id}/verify`, { method: 'other', proof_reference: 'x' });
await expect404(B, 'POST', `/privacy/requests/${fx.privacy.id}/resume`);
await expect404(B, 'GET', `/privacy/requests/${fx.privacy.id}/export`);
await expect404(B, 'POST', '/privacy/requests', { kind: 'erase', visitor_id: vA1, proof_reference: 'ticket 1' }, idem());
await expect404(B, 'DELETE', `/auth/sessions/${fx.session.id}`);
if (fx.notification) await expect404(B, 'POST', `/notifications/${fx.notification}/read`);
else note('no tenant A notification row exists; POST /notifications/:id/read IDOR skipped');
await expect404(B, 'POST', '/tenants/switch', { tenant_id: ownerA.tenantId });
// Cross-tenant references inside tenant B's own commands
const visitorB2 = await newVisitor(siteB, ORIGIN_B, 'visitorB2', ip(25));
const xDept = await visitorB2.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'route me', department_id: supportA.id });
known([404, 409, 422].includes(xDept.status) && !A_SECRETS.some((s) => xDept.text.includes(s)) && !(xDept.error?.details?.departments ?? []).some((d) => d.id === supportA.id), `tenant B visitor cannot route a chat to a tenant A department (${xDept.status} ${xDept.error?.code}, no tenant A departments listed)`, `${xDept.status}`);
ok(sql(`SELECT count(*) FROM chats WHERE department_id = '${supportA.id}' AND tenant_id = '${ownerB.tenantId}'`) === '0', 'no tenant B chat references a tenant A department (psql)');

console.log('1b. Widget capabilities are bound to their own visitor and tenant');
for (const [who, v] of [
  ['tenant B visitor', visitorB],
  ['another tenant A visitor', visitorA2],
]) {
  const reads = [
    await v.call('GET', `/widget/v1/chats/${chatA1}`),
    await v.call('GET', `/widget/v1/chats/${chatA1}/messages`),
    await v.call('POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'intrusion' }),
    await v.call('PUT', `/widget/v1/chats/${chatA1}/read-cursor`, { last_read_seq: 1 }),
    await v.call('PUT', `/widget/v1/chats/${chatA1}/rating`, { rating: 'bad' }),
    await v.call('POST', `/widget/v1/chats/${chatA1}/close`),
    await v.call('POST', `/widget/v1/chats/${chatA1}/exports`, { format: 'txt' }),
    await v.call('POST', `/widget/v1/chats/${chatA1}/transcript-email`, { email: 'x@example.com' }),
    await v.call('POST', '/widget/v1/uploads', { chat_id: chatA1, name: 'x.png', size_bytes: PNG.length, mime: 'image/png' }),
  ];
  const bad = reads.filter((r) => r.status !== 404 || r.text.includes(MARK));
  known(bad.length === 0, `${who} gets 404 on chat A1 via /widget/v1 (read, send, cursor, rating, close, export, email, upload)`, bad.map((r) => r.status));
}
known((await visitorB.call('GET', '/visitors/' + vA1)).status === 401, 'a visitor capability is not accepted on the agent API (401)');
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}' AND body LIKE '%intrusion%'`) === '0', 'no foreign-visitor message reached chat A1');

console.log('1c. Tenant A state unchanged after tenant B attempts (psql)');
const aState = sql(`SELECT (SELECT name FROM sites WHERE id = '${siteA.id}') || '|' || (SELECT status FROM chats WHERE id = '${chatA1}') || '|' || (SELECT name FROM departments WHERE id = '${fx.dept.id}') || '|' || (SELECT role FROM memberships WHERE id = '${agentA.membershipId}') || '|' || (SELECT coalesce(description,'') FROM webhook_endpoints WHERE id = '${fx.webhook.id}') || '|' || (SELECT name FROM triggers WHERE id = '${fx.trigger.id}') || '|' || (SELECT title FROM canned_replies WHERE id = '${fx.shortcut.id}') || '|' || (SELECT (revoked_at IS NULL)::text FROM bans WHERE id = '${fx.ban.id}')`);
ok(aState === `${siteA.name}|active|Alpha Sec Dept ${stamp}|agent|Alpha hook ${stamp}|Alpha Trigger ${stamp}|Alpha Shortcut ${stamp}|true`, 'site, chat, department, agent role, webhook, trigger, shortcut and ban are untouched', aState);
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}' AND body LIKE '%tenant B%'`) === '0' && sql(`SELECT count(*) FROM exports WHERE tenant_id = '${ownerB.tenantId}'`) === '0', 'no tenant B message in chat A1 and no tenant B export of tenant A chats');
const betaHist = await ownerB.must('GET', `/chats/history?q=${encodeURIComponent(MARK)}`);
ok(Array.isArray(betaHist) && betaHist.length === 0, 'tenant B history search for a tenant A marker returns nothing');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n2. Role enforcement — an agent-role member gets 403 on admin routes (AUD-71-03)');
const agentProbes = [
  ['PATCH', '/tenants/current', { name: 'Agent takeover' }],
  ['PATCH', '/tenants/current', { settings: { security: { require_mfa: false } } }],
  ['POST', '/agents/invitations', { email: `sec-evil+${stamp}@example.com`, role: 'admin' }],
  ['GET', '/agents/invitations'],
  ['DELETE', `/agents/invitations/${fx.invite.id}`],
  ['PATCH', `/agents/${ownerA.membershipId}`, { enabled: false }],
  ['PATCH', `/agents/${agentA.membershipId}`, { role: 'admin' }],
  ['PATCH', `/agents/${agentA.membershipId}`, { capacity: 20 }],
  ['PUT', `/agents/${agentA.membershipId}/departments`, { departments: [{ department_id: fx.dept.id, can_serve: true, can_monitor: true }] }],
  ['POST', '/sites', { name: 'Agent site', origins: [] }],
  ['PATCH', `/sites/${siteA.id}`, { name: 'Agent rename' }],
  ['POST', `/sites/${siteA.id}/key-rotation`, {}],
  ['PUT', `/sites/${siteA.id}/widget-config`, { config: validConfig, base_etag: null }],
  ['POST', `/sites/${siteA.id}/identity-secret`],
  ['POST', '/webhooks', { url: 'https://93.184.215.14/agent', event_types: ['chat.closed'] }],
  ['GET', '/webhooks'],
  ['PATCH', `/webhooks/${fx.webhook.id}`, { enabled: false }, ifm(fx.webhook.version)],
  ['POST', '/integration-tokens', { name: 'agent token', scopes: ['chats:read'] }],
  ['GET', '/audit-events'],
  ['GET', '/audit-events/export.csv'],
  ['POST', '/privacy/requests', { kind: 'erase', visitor_id: vA1, proof_reference: 'ticket 1' }],
  ['GET', '/privacy/requests'],
  ['POST', '/privacy/retention/run', {}],
  ['POST', '/departments', { name: 'Agent dept' }],
  ['POST', '/bans', { ip: '198.51.100.99', reason: 'agent ban' }],
  ['POST', '/schedules', { name: 'Agent schedule', timezone: 'UTC', weekly_intervals: {} }],
  ['POST', '/triggers', { name: 'Agent trigger', definition: TRIGGER_DEF }],
  ['POST', '/custom-fields', { key: 'agent_field', label: 'Agent', data_type: 'string' }],
  ['POST', '/tenants/current/ownership-transfer', { target_membership_id: agentA.membershipId, reason: 'mine now' }],
  ['GET', '/analytics/chats?from=2026-01-01&to=2026-12-31'],
  ['POST', '/exports', { chat_ids: [chatA1], format: 'json', include_internal: true }],
];
for (const [method, path, body, headers] of agentProbes) {
  const r = await agentA.call(method, path, body, headers);
  known(r.status === 403, `agent ${method} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')} → 403`, `${r.status} ${r.error?.code}`);
}
const agentRow = sql(`SELECT role || '|' || enabled || '|' || capacity FROM memberships WHERE id = '${agentA.membershipId}'`);
const ownerRow = sql(`SELECT role || '|' || enabled FROM memberships WHERE id = '${ownerA.membershipId}'`);
ok(agentRow === 'agent|true|3' && ownerRow === 'owner|true', `agent cannot PATCH their own role/capacity or suspend the owner (db: ${agentRow}, ${ownerRow})`);
ok(sql(`SELECT name FROM tenants WHERE id = '${ownerA.tenantId}'`) === ownerA.tenantName && sql(`SELECT count(*) FROM sites WHERE tenant_id = '${ownerA.tenantId}'`) === '1', 'tenant name and site list unchanged (psql)');
const selfPrefs = await agentA.call('PATCH', '/agents/me/preferences', { role: 'admin' });
const selfProfile = await agentA.call('PATCH', '/auth/profile', { role: 'owner', email: 'x@example.com' });
ok(selfPrefs.status === 422 && selfProfile.status === 422, 'role cannot be smuggled through /agents/me/preferences or /auth/profile (strict 422)');
const agentPublic = await agentA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'not my chat' });
const agentNote = await agentA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), visibility: 'internal', body: 'note on a chat I am not in' });
ok(agentPublic.status === 403 && agentNote.status === 403, 'non-participant agent cannot reply or add an internal note (notes need participation or supervision)');
if (fx.offer) {
  await ownerA.must('POST', `/chats/${chatA3}/accept`, { offer_id: fx.offer });
  const note3Cmid = randomUUID();
  await ownerA.must('POST', `/chats/${chatA3}/messages`, { client_message_id: note3Cmid, visibility: 'internal', body: `DEPTNOTE ${MARK} refund approved by finance` });
  const outOfScope = await agentA.call('GET', `/chats/${chatA3}/messages`);
  ok(outOfScope.status === 404, 'agent A (Support only) cannot read a chat in another department (404)');
  const replay = await agentA.call('POST', `/chats/${chatA3}/messages`, { client_message_id: note3Cmid, visibility: 'public', body: 'x' });
  known([403, 404].includes(replay.status) && !replay.text.includes('DEPTNOTE'), 'out-of-department agent replaying an existing client_message_id is refused (no stored message returned)', `${replay.status} ${replay.text.slice(0, 140)}`);
  const fresh = await agentA.call('POST', `/chats/${chatA3}/messages`, { client_message_id: randomUUID(), body: 'x' });
  ok([403, 404].includes(fresh.status), `out-of-department agent cannot post into the chat (${fresh.status})`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n3. CSRF — cookie-authenticated mutations need the session-bound x-csrf-token');
const deptCount = () => sql(`SELECT count(*) FROM departments WHERE tenant_id = '${ownerA.tenantId}' AND name = 'CSRF dept'`);
for (const [label, hdr] of [
  ['without x-csrf-token', { 'x-csrf-token': null }],
  ['with a wrong x-csrf-token', { 'x-csrf-token': 'not-the-token-0123456789abcdef' }],
  ["with another session's x-csrf-token", { 'x-csrf-token': ownerB.cookies.rd_csrf }],
]) {
  const post = await ownerA.call('POST', '/departments', { name: 'CSRF dept' }, hdr);
  const patch = await ownerA.call('PATCH', '/tenants/current', { name: 'CSRF pwned' }, hdr);
  const del = await ownerA.call('DELETE', `/bans/${fx.ban.id}`, undefined, hdr);
  const put = await ownerA.call('PUT', '/agents/me/presence', { status: 'away' }, hdr);
  ok([post, patch, del, put].every((r) => r.status === 403 && r.error?.code === 'PERMISSION_DENIED'), `POST/PATCH/DELETE/PUT ${label} → 403`);
}
ok(deptCount() === '0' && sql(`SELECT name FROM tenants WHERE id = '${ownerA.tenantId}'`) === ownerA.tenantName && sql(`SELECT revoked_at IS NULL FROM bans WHERE id = '${fx.ban.id}'`) === 't', 'no state changed by the forged requests (psql)');
const getNoToken = await ownerA.call('GET', '/tenants/current', undefined, { 'x-csrf-token': null });
ok(getNoToken.status === 200, 'GET without a CSRF token still works');
const logoutNoToken = await ownerA.call('POST', '/auth/logout', undefined, { 'x-csrf-token': null });
ok(logoutNoToken.status === 403 && (await ownerA.call('GET', '/auth/me')).status === 200, 'logout without CSRF is refused and the session survives (no logout CSRF)');
const bearerPlusCookie = await ownerA.call('PATCH', '/tenants/current', { name: 'via token' }, { authorization: 'Bearer rdt_forged_token_value' });
ok(bearerPlusCookie.status === 401, 'a forged integration bearer next to a valid cookie is rejected (no fallback to the cookie)');
const evilPre = await fetch(`${API}/api/v1/departments`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-csrf-token' } });
const evilGet = await fetch(`${API}/api/v1/tenants/current`, { headers: { origin: 'https://evil.example', cookie: ownerA.cookieHeader() } });
ok(!evilPre.headers.get('access-control-allow-origin') && !evilGet.headers.get('access-control-allow-origin') && !evilGet.headers.get('access-control-allow-credentials'), 'credentialed CORS is not granted to a foreign origin');
const okPre = await fetch(`${API}/api/v1/departments`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
ok(okPre.headers.get('access-control-allow-origin') === 'http://localhost:3000' && okPre.headers.get('access-control-allow-credentials') === 'true', 'the dashboard origin gets credentialed CORS');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n4. Sessions (SEC02) — cookie attributes, fixation, brute force, reset replay, revocation');
const cookieAttrs = (setCookies, name) => (setCookies.find((c) => c.startsWith(`${name}=`)) ?? '').split(';').map((p) => p.trim().toLowerCase());
const loginB = new Client('owner-beta-2', { ip: ip(12) });
const planted = `planted-by-attacker-${randomUUID()}`;
loginB.cookies.rd_session = planted;
const login1 = await loginB.call('POST', '/auth/login', { email: ownerB.email, password: PASSWORD });
ok(login1.status === 200, 'login with a planted (unknown) rd_session cookie succeeds');
const sess = cookieAttrs(login1.setCookies, 'rd_session');
const csrf = cookieAttrs(login1.setCookies, 'rd_csrf');
ok(sess.includes('httponly') && sess.includes('samesite=lax') && sess.includes('path=/'), `rd_session is HttpOnly; SameSite=Lax; Path=/ (${sess.slice(1).join('; ')})`);
ok(csrf.includes('samesite=lax') && !csrf.includes('httponly'), 'rd_csrf is SameSite=Lax and readable by the dashboard (double-submit token, not HttpOnly)');
if (sess.includes('secure')) ok(true, 'rd_session carries Secure');
else note('rd_session has no Secure attribute: expected in local development (NODE_ENV=development, COOKIE_SECURE unset); production sets Secure');
ok(loginB.cookies.rd_session && loginB.cookies.rd_session !== planted && loginB.cookies.rd_session !== ownerB.cookies.rd_session, 'login issues a fresh session token (never the planted or a pre-existing one)');
const plantedOnly = new Client('planted', { ip: ip(12) });
plantedOnly.cookies.rd_session = planted;
ok((await plantedOnly.call('GET', '/auth/me')).status === 401, 'the planted session value is not honoured');
const firstToken = loginB.cookies.rd_session;
const firstCsrf = loginB.cookies.rd_csrf;
const login2 = await loginB.call('POST', '/auth/login', { email: ownerB.email, password: PASSWORD });
ok(login2.status === 200 && loginB.cookies.rd_session !== firstToken && loginB.cookies.rd_csrf !== firstCsrf, 'logging in again rotates both the session token and the CSRF token');

console.log('4b. Brute force → RATE_LIMITED (429) with Retry-After');
const bf = await signupOwner('bruteforce', ip(31));
const attacker = new Client('attacker', { ip: ip(32) });
let limited = null;
let attempts = 0;
for (; attempts < 25 && !limited; attempts++) {
  const r = await attacker.call('POST', '/auth/login', { email: bf.email, password: `wrong-password-${attempts}` });
  if (r.status === 429) limited = r;
  else ok(r.status === 401 && r.error.code === 'INVALID_CREDENTIALS', `wrong password #${attempts + 1} → 401 INVALID_CREDENTIALS`);
}
ok(limited && limited.error.code === 'RATE_LIMITED' && limited.error.retryable === true, `after ${attempts - 1} wrong passwords the account is RATE_LIMITED (429)`);
const retryAfter = Number(limited.headers.get('retry-after'));
ok(retryAfter > 0 && retryAfter <= 300, `Retry-After header present (${retryAfter} s, ≤ the 300 s window)`);
if (limited.error.retry_after === undefined && limited.error.details?.retry_after === undefined) note('RATE_LIMITED body carries retryable:true but no retry_after field; the delay is in the Retry-After header (as the OpenAPI contract specifies)');
const rightPw = await new Client('bf-right', { ip: ip(33) }).call('POST', '/auth/login', { email: bf.email, password: PASSWORD });
ok(rightPw.status === 429, 'the per-account limit also holds against the correct password from a new address (no credential-stuffing bypass)');

console.log('4c. Password reset — single-use token; other sessions revoked (HTTP 401 + socket access.revoked)');
const ru = await signupOwner('reset', ip(41));
const ru2 = new Client('reset-2', { ip: ip(42) });
await ru2.must('POST', '/auth/login', { email: ru.email, password: PASSWORD });
const ruSock = await socket('/agent', await agentTicket(ru2));
ok((await ru.call('GET', '/auth/me')).status === 200 && (await ru2.call('GET', '/auth/me')).status === 200, 'reset user has two live sessions and an open agent socket');
const anonReset = new Client('anon-reset', { ip: ip(43) });
const rq = await anonReset.call('POST', '/auth/password/reset-request', { email: ru.email });
ok(rq.status === 202, 'reset request accepted (202, generic)');
const resetText = await waitFor(() => latestEmail(ru.email, 'password_reset'), 8000, 'password reset email');
const resetToken = tokenFrom(resetText, 'token');
ok(resetToken.length > 20, 'reset token delivered by email');
const NEWPW = 'a brand new passphrase 2026';
const reset1 = await anonReset.call('POST', '/auth/password/reset', { token: resetToken, new_password: NEWPW });
ok(reset1.status === 204, 'reset with the token succeeds (204)');
const reset2 = await anonReset.call('POST', '/auth/password/reset', { token: resetToken, new_password: 'yet another new passphrase' });
ok(reset2.status === 422 && reset2.error.code === 'TOKEN_USED', 'replaying the reset token fails (422 TOKEN_USED)');
ok((await ru.call('GET', '/auth/me')).status === 401 && (await ru2.call('GET', '/auth/me')).status === 401, 'every pre-existing session gets 401 after the reset');
const revoked = await waitFor(() => ruSock.controls.find((c) => c.type === 'access.revoked'), 5000, 'access.revoked on the reset user socket').catch(() => null);
known(revoked && revoked.payload.reason === 'session_revoked' && revoked.payload.relogin_required === true, 'the open socket receives access.revoked {reason: session_revoked, relogin_required: true} within 5 s', revoked);
await waitFor(() => ruSock.disconnected, 3000, 'reset user socket disconnect').catch(() => null);
ok(ruSock.disconnected, 'and the revoked socket is disconnected');
const oldPw = await new Client('ru-old', { ip: ip(44) }).call('POST', '/auth/login', { email: ru.email, password: PASSWORD });
const newPw = await new Client('ru-new', { ip: ip(45) }).call('POST', '/auth/login', { email: ru.email, password: NEWPW });
ok(oldPw.status === 401 && newPw.status === 200, 'old password rejected, new password accepted');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n5. Privileged write rejection (SEC03) — visitor/widget payloads cannot set privileged fields');
const vA1Row = () => sql(`SELECT verified || '|' || coalesce(name, '') FROM visitors WHERE id = '${vA1}'`);
const before5 = { visitor: vA1Row(), chat: sql(`SELECT priority || '|' || status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${chatA1}'`), msgs: a1Count() };
const priv = [
  ['identity verified', 'POST', '/widget/v1/identity', { name: 'Mallory', verified: true }],
  ['identity vip', 'POST', '/widget/v1/identity', { name: 'Mallory', vip: true }],
  ['identity role', 'POST', '/widget/v1/identity', { role: 'admin' }],
  ['session verified', 'POST', '/widget/v1/sessions', { site_key: siteA.public_key, host_origin: ORIGIN_A, verified: true }],
  ['chat priority', 'POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'hi', priority: 100 }],
  ['chat vip', 'POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'hi', vip: true }],
  ['chat fields.verified', 'POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'hi', fields: { name: 'M', verified: true } }],
  ['message visibility internal', 'POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'PRIV internal', visibility: 'internal' }],
  ['message sender_type agent', 'POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'PRIV agent', sender_type: 'agent' }],
  ['message role', 'POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'PRIV role', role: 'agent' }],
  ['custom field vip', 'PUT', '/widget/v1/visitor/custom-fields', { custom_fields: { vip: true } }],
  ['custom field verified', 'PUT', '/widget/v1/visitor/custom-fields', { custom_fields: { verified: true } }],
  ['offline fields.priority', 'POST', '/widget/v1/offline-submissions', { client_request_id: `sec-${randomUUID()}`, email: 'o@example.com', message: 'hi', fields: { priority: 'urgent' } }],
];
for (const [label, method, path, body] of priv) {
  const r = await visitorA1.call(method, path, body);
  known(r.status === 422, `widget ${label} → 422`, `${r.status} ${r.error?.code}`);
}
const ignoredRating = await visitorA1.call('PUT', `/widget/v1/chats/${chatA1}/rating`, { rating: 'good', sender_type: 'agent' });
ok(ignoredRating.status === 422, 'rating with sender_type → 422');
const vSock1 = await socket('/visitor', await visitorTicket(visitorA1));
const sInternal = await cmd(vSock1, 'message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'PRIV socket internal', visibility: 'internal' });
const sAgent = await cmd(vSock1, 'message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'PRIV socket agent', sender_type: 'agent' });
ok(sInternal.type === 'command.error' && sInternal.code === 'VALIDATION_FAILED' && sAgent.type === 'command.error' && sAgent.code === 'VALIDATION_FAILED', 'visitor socket message.send with visibility internal / sender_type agent → VALIDATION_FAILED');
const after5 = { visitor: vA1Row(), chat: sql(`SELECT priority || '|' || status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${chatA1}'`), msgs: a1Count() };
ok(JSON.stringify(before5) === JSON.stringify(after5), `visitor verified/name, chat priority/status/owner and message count unchanged (psql: ${after5.visitor} / ${after5.chat} / ${after5.msgs})`);
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}' AND (body LIKE 'PRIV%' OR (sender_visitor_id IS NOT NULL AND (sender_type <> 'visitor' OR visibility <> 'public')))`) === '0', 'no visitor-authored message is stored as agent or internal (psql)');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n6. XSS — hostile text is stored and returned verbatim as JSON strings, never HTML');
const XSS = [
  ['script tag', '<script>alert(document.cookie)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['markdown javascript: link', '[click me](javascript:alert(1))'],
  ['bare javascript: URL', 'javascript:alert(1)//https://example.com'],
  ['RTL override', 'invoice‮gnp.exe'],
  ['5k-char body', `${'<b>bold</b>'.repeat(450)}${'x'.repeat(5000 - 450 * 11)}`],
];
const sent = [];
for (const [label, body] of XSS) {
  const viaVisitor = await visitorA1.call('POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body });
  const viaAgent = await ownerA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body });
  ok(viaVisitor.status === 201 && viaAgent.status === 201 && /application\/json/.test(viaVisitor.headers.get('content-type')) && /application\/json/.test(viaAgent.headers.get('content-type')), `${label}: accepted from visitor and agent (201, application/json)`);
  sent.push([label, body, viaVisitor.data.id, viaAgent.data.id]);
}
const staffPage = await ownerA.call('GET', `/chats/${chatA1}/messages?limit=100`);
const visitorPage = await visitorA1.call('GET', `/widget/v1/chats/${chatA1}/messages?limit=100`);
ok(/^application\/json/.test(staffPage.headers.get('content-type')) && /^application\/json/.test(visitorPage.headers.get('content-type')), 'message history is served as application/json (staff and visitor)');
for (const [label, body, vid, aid] of sent) {
  for (const [who, pg] of [
    ['staff', staffPage.data.items],
    ['visitor', visitorPage.data.items],
  ]) {
    const got = [pg.find((m) => m.id === vid)?.body, pg.find((m) => m.id === aid)?.body];
    const verbatim = got.every((b) => b === body);
    const bidiStripped = label === 'RTL override' && got.every((b) => b === body.replace('‮', ''));
    ok(verbatim || bidiStripped, `${label}: ${who} sees the exact text as a JSON string${bidiStripped ? ' (bidi override stripped)' : ''}`, got.map((b) => (b ?? 'missing').slice(0, 60)));
  }
}
ok(!staffPage.text.includes('&lt;script') && staffPage.text.includes('<script>alert(document.cookie)</script>'), 'no server-side HTML entity encoding: the API returns raw text and leaves escaping to the renderer');
const tooLong = await visitorA1.call('POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'y'.repeat(8001) });
const tooLongAgent = await ownerA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'y'.repeat(8001) });
ok(tooLong.status === 422 && tooLongAgent.status === 422, 'bodies over 8000 characters rejected by length (422)');
const snippet = (await ownerA.must('GET', `/chats/history?q=${encodeURIComponent('alert')}`)).find((c) => c.id === chatA1);
ok(snippet && typeof snippet.snippet === 'string' && Array.isArray(snippet.snippet_highlights) && !/<\/?(b|mark|em)>/.test(snippet.snippet.replace(/<b>bold<\/b>/g, '')), 'search snippets are plain text with offset highlights (no server-inserted markup)');
// Department scope (HIST01, AUD-71-25): candidates come from a tenant-wide index lookup, so the permission filter
// must still decide which chats — and which snippets — an agent gets. Agent A serves Support only; chat A3 is in
// a department agent A neither serves nor monitors, and both chats carry MARK.
const ownerMarked = await ownerA.must('GET', `/chats/history?q=${encodeURIComponent(MARK)}`);
const agentMarked = await agentA.call('GET', `/chats/history?q=${encodeURIComponent(MARK)}`);
ok(ownerMarked.some((c) => c.id === chatA1) && ownerMarked.some((c) => c.id === chatA3), 'owner (tenant-wide) history search finds the marked chats in every department');
ok(agentMarked.status === 200 && agentMarked.data.some((c) => c.id === chatA1), "department-scoped agent history search finds the chat in the agent's department");
ok(!agentMarked.data.some((c) => c.id === chatA3) && !agentMarked.text.includes('Assigned routing please'), "department-scoped agent history search omits the chat outside the agent's departments and its snippet text");

console.log('6b. Transcript exports neutralise spreadsheet formulas; downloads are attachments');
const FORMULAS = ['=HYPERLINK("http://evil.example","x")', '+1+cmd|\' /C calc\'!A0', '-2+3+cmd|\' /C calc\'!A0', '@SUM(1+1)*cmd|\' /C calc\'!A0'];
for (const f of FORMULAS) await ownerA.must('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: f });
async function staffExport(format) {
  const e = await ownerA.must('POST', '/exports', { chat_ids: [chatA1], format, timezone: 'UTC' });
  const done = await waitFor(async () => {
    const s = await ownerA.must('GET', `/exports/${e.id}`);
    return ['ready', 'failed'].includes(s.state) ? s : null;
  }, 25000, `export ${format}`);
  ok(done.state === 'ready', `${format.toUpperCase()} export ready`);
  const g = await ownerA.must('GET', `/exports/${e.id}/download`);
  const res = await fetch(g.url);
  return { res, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
}
const csvx = await staffExport('csv');
ok(/text\/csv/.test(csvx.res.headers.get('content-type') ?? '') && /^attachment/.test(csvx.res.headers.get('content-disposition') ?? '') && csvx.res.headers.get('x-content-type-options') === 'nosniff', 'CSV served as text/csv attachment with nosniff');
const unquoted = csvx.text.replace(/"(?:[^"]|"")*"/g, '""');
ok(!/(^|,)[=+\-@]/m.test(unquoted), 'no unquoted CSV cell starts with = + - @');
const cells = [...csvx.text.matchAll(/"((?:[^"]|"")*)"|([^,\r\n]+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/""/g, '"'));
for (const f of FORMULAS) known(cells.includes(`'${f}`) && !cells.includes(f), `CSV cell for ${f.slice(0, 12)}… is prefixed with ' (neutralised)`);
ok(csvx.text.includes('<script>alert(document.cookie)</script>'), 'CSV keeps hostile HTML as inert text');
const txtx = await staffExport('txt');
ok(/^text\/plain/.test(txtx.res.headers.get('content-type') ?? '') && /^attachment/.test(txtx.res.headers.get('content-disposition') ?? '') && txtx.res.headers.get('x-content-type-options') === 'nosniff', 'TXT served as text/plain attachment with nosniff (never text/html)');
ok(txtx.text.includes('<img src=x onerror=alert(1)>') && !txtx.text.includes(`NOTE ${MARK}`), 'TXT transcript carries the text verbatim and excludes internal notes by default');
note('TXT transcripts carry formula-like lines verbatim — CSV is the only spreadsheet-parsed format, and it is neutralised');

console.log('6c. Upload filenames with markup are sanitised');
for (const [who, client, path] of [
  ['agent', ownerA, '/attachments/uploads'],
  ['visitor', visitorA1, '/widget/v1/uploads'],
]) {
  for (const name of ['<script>alert(1)</script>.png', '<img src=x onerror=alert(1)>.png', '..\\..\\"evil"‮gnp.png']) {
    const init = await client.call('POST', path, { chat_id: chatA1, name, size_bytes: PNG.length, mime: 'image/png', sha256: sha(PNG) });
    if (init.status === 422) {
      ok(true, `${who} upload init with ${JSON.stringify(name)} rejected (422)`);
      continue;
    }
    ok(init.status === 201, `${who} upload init with ${JSON.stringify(name)} accepted`, init.status);
    const statePath = who === 'agent' ? `/attachments/${init.data.upload_id}` : `/widget/v1/uploads/${init.data.upload_id}`;
    const st = await client.must('GET', statePath);
    const stored = sql(`SELECT original_name FROM attachments WHERE id = '${init.data.upload_id}'`);
    ok(!/[<>"\\/‮]/.test(st.name) && !/[<>"\\/‮]/.test(stored), `${who} filename sanitised to ${JSON.stringify(st.name)} (no < > " / \\ or bidi)`);
    await client.call('DELETE', statePath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n7. SQL injection — search, filters, cursors and ids never reach SQL as code');
const SQLI = ["'; DROP TABLE messages; --", '%', '_', '\\', "' OR 1=1 --", '" OR ""="', 'refund OR 1=1', '"refund" -hello', 'refund:* & !x | (y', "1' UNION SELECT id, body FROM messages --", '%%%%', '\\\\%\\_', '$$; SELECT pg_sleep(5); $$'];
const aIds = [chatA1, chatA2];
for (const q of SQLI) {
  const t0 = Date.now();
  const rb = await ownerB.call('GET', `/chats/history?q=${encodeURIComponent(q)}`);
  const ra = await ownerA.call('GET', `/chats/history?q=${encodeURIComponent(q)}`);
  ok(rb.status === 200 && ra.status === 200 && Date.now() - t0 < 4000, `history q=${JSON.stringify(q)} → 200 (A and B)`, `${rb.status}/${ra.status}`);
  ok(!rb.data.some((c) => aIds.includes(c.id)) && !A_SECRETS.some((s) => rb.text.includes(s)), `history q=${JSON.stringify(q)}: no tenant A chats for tenant B`);
}
const vSearch = await ownerA.call('GET', `/visitors?q=${encodeURIComponent('%')}`);
const vSearch2 = await ownerA.call('GET', `/visitors?q=${encodeURIComponent('_')}`);
ok(vSearch.status === 200 && vSearch2.status === 200 && vSearch.data.length === 0 && vSearch2.data.length === 0, 'visitor search treats % and _ literally (escaped LIKE: no wildcard match-all)');
const garbage = [
  ['GET', `/visitors?q=${encodeURIComponent("' OR 1=1 --")}`],
  ['GET', `/visitors/live?q=${encodeURIComponent("'; DROP TABLE visitors; --")}`],
  ['GET', `/shortcuts?q=${encodeURIComponent("' OR 1=1 --")}`],
  ['GET', `/chats?view=${encodeURIComponent("all'; --")}`],
  ['GET', `/chats/history?cursor=${encodeURIComponent("eyJrIjp7fX0'; DROP TABLE chats; --")}`],
  ['GET', '/chats/history?cursor=%%%invalid'],
  ['GET', `/chats/history?site_id=${encodeURIComponent("1' OR '1'='1")}`],
  ['GET', '/chats/history?limit=-1'],
  ['GET', '/chats/history?limit=99999999999999999999'],
  ['GET', `/chats/history?from=${encodeURIComponent("2026-01-01'; --")}`],
  ['GET', `/chats/history?sort=${encodeURIComponent('id; DROP TABLE chats')}&order=${encodeURIComponent("desc'")}`],
  ['GET', `/chats/history?status=${encodeURIComponent("closed' OR 1=1")}`],
  ['GET', `/chats/${chatA1}/messages?after_seq=${encodeURIComponent('1 OR 1=1')}`],
  ['GET', `/chats/${chatA1}/messages?before_seq=-5`],
  ['GET', '/visitors?cursor=not-a-cursor'],
  ['GET', `/visitors/live?cursor=${encodeURIComponent("' OR 1=1")}&status=${encodeURIComponent("browsing'--")}`],
  ['GET', `/audit-events?action=${encodeURIComponent("x'; DROP TABLE audit_events; --")}`],
  ['GET', '/bans?active=maybe'],
  ['GET', `/offline-submissions?status=${encodeURIComponent("received' OR '1'='1")}`],
  ['GET', `/schedules?cursor=${encodeURIComponent("'; --")}`],
  ['GET', `/triggers?event=${encodeURIComponent("chat.requested' --")}`],
  ['GET', `/analytics/chats?from=${encodeURIComponent("2026-01-01'; --")}&to=2026-12-31`],
  ['GET', `/notifications?cursor=${encodeURIComponent("' OR 1=1")}`],
  ['GET', '/chats/not-a-uuid'],
  ['GET', `/chats/${encodeURIComponent("1' OR '1'='1")}/messages`],
  ['GET', `/visitors/${encodeURIComponent('1 OR 1=1')}`],
  ['GET', `/sites/${encodeURIComponent("'; DROP TABLE sites; --")}`],
  ['PATCH', `/departments/${encodeURIComponent("x' OR 1=1 --")}`, { name: 'x' }],
  ['DELETE', `/bans/${encodeURIComponent("1; DELETE FROM bans")}`],
  ['GET', '/exports/00000000-0000-0000-0000-00000000000g'],
  ['POST', `/chats/${chatA1}/messages`, { client_message_id: "'; DROP TABLE messages; --", body: "Robert'); DROP TABLE messages;--" }],
];
for (const [method, path, body] of garbage) {
  const r = await ownerA.call(method, path, body);
  ok([200, 201, 400, 404, 422].includes(r.status), `${method} ${path.slice(0, 70)} → ${r.status} (never 500)`, r.text.slice(0, 160));
}
const wGarbage = await visitorA1.call('GET', `/widget/v1/chats/${encodeURIComponent("1' OR 1=1")}/messages`);
const wGarbage2 = await visitorA1.call('GET', `/widget/v1/chats/${chatA1}/messages?after_seq=${encodeURIComponent("0' OR 1=1")}`);
ok([400, 404, 422].includes(wGarbage.status) && wGarbage2.status === 422, 'widget id/seq garbage → 4xx (never 500)');
console.log('7b. NUL bytes in text input');
for (const [label, run] of [
  ['history q with \\u0000', () => ownerA.call('GET', `/chats/history?q=${encodeURIComponent('ref\u0000und')}`)],
  ['visitor search with \\u0000', () => ownerA.call('GET', `/visitors?q=${encodeURIComponent('a\u0000b')}`)],
  ['agent message body with \\u0000', () => ownerA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'nul\u0000byte' })],
  ['visitor message body with \\u0000', () => visitorA1.call('POST', `/widget/v1/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'nul\u0000byte' })],
]) {
  const r = await run();
  known(r.status < 500, `${label} → 4xx/2xx, not 500`, `${r.status} ${r.error?.code ?? ''}`);
}
const tables = sql(`SELECT count(*) FROM unnest(ARRAY['messages','chats','tenants','visitors','users','sites','bans','audit_events','departments']) t WHERE to_regclass('public.' || t) IS NOT NULL`);
ok(tables === '9', 'messages, chats, tenants, visitors, users, sites, bans, audit_events and departments tables still exist');
ok(Number(a1Count()) > 10 && sql(`SELECT count(*) FROM bans WHERE id = '${fx.ban.id}'`) === '1', `chat A1 still has its messages (${a1Count()}) and the ban row survives`);

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n8. SSRF — webhook targets are validated at save time and again at dispatch');
const probe = await ownerA.call('POST', '/webhooks', { url: 'http://127.0.0.1:9/talkivio-ssrf-probe', event_types: ['privacy.erased'] });
const allowPrivate = probe.status === 201;
console.log(`  policy: TALKIVIO_WEBHOOK_ALLOW_PRIVATE ${allowPrivate ? 'IN EFFECT (test-only allowlist for loopback/private hosts)' : 'not set → every loopback/private/metadata target is blocked'} (repo .env: ${process.env.TALKIVIO_WEBHOOK_ALLOW_PRIVATE ?? 'unset'}; NODE_ENV=${process.env.NODE_ENV ?? 'unset'})`);
if (allowPrivate) await ownerA.call('DELETE', `/webhooks/${probe.data.id}`, undefined, ifm(probe.data.version));
const SSRF = [
  ['http://127.0.0.1/hook', 'loopback', true],
  ['http://127.1/hook', 'loopback (short form)', true],
  ['http://2130706433/hook', 'loopback (decimal)', true],
  ['http://0x7f.0.0.1/hook', 'loopback (hex)', true],
  ['http://[::1]/hook', 'IPv6 loopback', true],
  ['http://[::ffff:127.0.0.1]/hook', 'IPv4-mapped loopback', true],
  ['http://localhost/hook', 'localhost', true],
  ['http://0.0.0.0/hook', 'unspecified', false],
  ['http://169.254.169.254/latest/meta-data/', 'cloud metadata', false],
  ['http://[::ffff:169.254.169.254]/latest/meta-data/', 'IPv4-mapped metadata', false],
  ['http://[fd00:ec2::254]/latest/meta-data/', 'AWS IPv6 metadata', false],
  ['http://100.100.100.200/', 'Alibaba metadata', false],
  ['http://169.254.1.1/', 'link-local', false],
  ['http://10.0.0.1/hook', 'private 10/8', false],
  ['http://172.16.0.1/hook', 'private 172.16/12', false],
  ['http://192.168.1.1/hook', 'private 192.168/16', false],
  ['http://100.64.0.1/hook', 'CGNAT', false],
  ['http://[fc00::1]/hook', 'IPv6 unique-local', false],
  ['http://[fe80::1]/hook', 'IPv6 link-local', false],
  ['file:///etc/passwd', 'file://', false],
  ['gopher://127.0.0.1:6379/_INFO', 'gopher://', false],
  ['ftp://93.184.215.14/x', 'ftp://', false],
  ['javascript:alert(1)', 'javascript:', false],
  ['dict://127.0.0.1:11211/stat', 'dict://', false],
  ['https://user:pass@93.184.215.14/hook', 'credentials in URL', false],
];
for (const [url, label, loopbackClass] of SSRF) {
  const r = await ownerA.call('POST', '/webhooks', { url, event_types: ['privacy.erased'] });
  const allowedByPolicy = allowPrivate && loopbackClass;
  if (allowedByPolicy) {
    ok(r.status === 201 || r.status === 422, `${label}: ${url} → ${r.status} (test-only private allowlist in effect)`);
    if (r.status === 201) await ownerA.call('DELETE', `/webhooks/${r.data.id}`, undefined, ifm(r.data.version));
  } else {
    known(r.status === 422 && r.error.code === 'VALIDATION_FAILED' && r.error.field_errors?.url, `${label}: ${url} rejected at save (422${r.error?.details?.reason ? ` ${r.error.details.reason}` : ''})`, `${r.status} ${r.text.slice(0, 120)}`);
  }
}
for (const host of ['localtest.me', '127.0.0.1.nip.io']) {
  let addrs = null;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    addrs = null;
  }
  if (!addrs || !addrs.some((a) => a.address === '127.0.0.1' || a.address === '::1')) {
    note(`${host} does not resolve to loopback here (offline or filtered DNS); DNS-to-loopback case skipped`);
    continue;
  }
  const r = await ownerA.call('POST', '/webhooks', { url: `http://${host}/hook`, event_types: ['privacy.erased'] });
  known(r.status === 422 && r.error?.details?.reason === 'blocked_address', `DNS name ${host} → ${addrs.map((a) => a.address).join(',')} rejected as blocked_address`, `${r.status} ${r.error?.details?.reason}`);
}
const hookBefore = sql(`SELECT url FROM webhook_endpoints WHERE id = '${fx.webhook.id}'`);
const patchBad = await ownerA.call('PATCH', `/webhooks/${fx.webhook.id}`, { url: 'http://169.254.169.254/latest/meta-data/' }, ifm(fx.webhook.version));
ok(patchBad.status === 422 && sql(`SELECT url FROM webhook_endpoints WHERE id = '${fx.webhook.id}'`) === hookBefore, 'PATCH to a metadata URL rejected (422) and the stored URL is unchanged');
ok(sql(`SELECT count(*) FROM webhook_endpoints WHERE tenant_id = '${ownerA.tenantId}'`) === '1', 'no rejected target was stored');
// Dispatch-time re-validation (DNS rebinding / legacy rows): plant a loopback URL directly in the row,
// then request a test delivery. The worker must refuse to connect.
sql(`UPDATE webhook_endpoints SET url = 'http://127.0.0.1:9/talkivio-rebind' WHERE id = '${fx.webhook.id}'`);
const testDelivery = await ownerA.call('POST', `/webhooks/${fx.webhook.id}/test`, undefined, idem());
ok(testDelivery.status === 202, 'test delivery queued for the planted loopback target');
const blocked = await waitFor(async () => {
  const d = (await ownerA.must('GET', `/webhooks/${fx.webhook.id}/deliveries`)).find((x) => x.id === testDelivery.data.id);
  return d && !['pending', 'sending'].includes(d.status) ? d : null;
}, 20000, 'test delivery to settle');
known(/^ssrf_blocked/.test(blocked.last_error ?? '') && blocked.response_status === null && blocked.status !== 'delivered', `dispatch re-validates the target and blocks it (status ${blocked.status}, ${blocked.last_error?.slice(0, 60)})`, blocked);
fx.delivery = testDelivery.data.id;
sql(`UPDATE webhook_endpoints SET url = '${hookBefore}', enabled = false WHERE id = '${fx.webhook.id}'`);
await expect404(ownerB, 'POST', `/webhook-deliveries/${fx.delivery}/retry`, undefined, idem());

console.log('8b. Widget image URLs (launcher_icon_url, logo_url)');
let cfgEtag = aCfg.draft?.etag ?? null;
const baseCfg = aCfg.published?.config ?? aCfg.draft?.config;
const withImg = (k, u) => ({ ...baseCfg, appearance: { ...baseCfg.appearance, ...(k === 'launcher_icon_url' ? { launcher_icon: 'custom' } : {}), [k]: u } });
for (const k of ['launcher_icon_url', 'logo_url']) {
  const good = await ownerA.call('PUT', `/sites/${siteA.id}/widget-config`, { config: withImg(k, 'https://cdn.example.com/icon.png'), base_etag: cfgEtag });
  if (good.status === 200) cfgEtag = good.data.etag;
  ok(good.status === 200, `${k} = https://… accepted`, `${good.status} ${good.text.slice(0, 160)}`);
  const accepted = [];
  for (const u of ['javascript:alert(document.domain)', 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
    const r = await ownerA.call('PUT', `/sites/${siteA.id}/widget-config`, { config: withImg(k, u), base_etag: cfgEtag });
    if (r.status === 200) {
      cfgEtag = r.data.etag;
      accepted.push(u.split(':')[0] + ':');
    }
  }
  known(accepted.length === 0, `${k}: server rejects non-http(s) schemes (javascript:, data:, vbscript:, file:) — the dashboard only offers http(s)`, `accepted with 200: ${accepted.join(' ')}`);
  const plainHttp = await ownerA.call('PUT', `/sites/${siteA.id}/widget-config`, { config: withImg(k, 'http://cdn.example.com/icon.png'), base_etag: cfgEtag });
  if (plainHttp.status === 200) cfgEtag = plainHttp.data.etag;
  note(`${k} = http:// (non-TLS) → ${plainHttp.status}: the dashboard allows http(s); the frame CSP allows http: images only outside production`);
}
const discard = await ownerA.call('DELETE', `/sites/${siteA.id}/widget-config/draft${cfgEtag ? `?etag=${cfgEtag}` : ''}`);
ok(discard.status === 200, 'probe draft discarded (nothing published)');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n9. Socket boundaries');
const t1 = await agentTicket(ownerA);
const s1 = await socket('/agent', t1);
ok(s1.connected, 'agent socket authenticates with a fresh ticket');
ok(/AUTH_REQUIRED/.test((await connectError('/agent', t1)) ?? ''), 'reusing a ticket fails (single-use)');
ok(/AUTH_REQUIRED/.test((await connectError('/agent', 'rdtk_garbage_garbage_garbage')) ?? ''), 'a garbage ticket fails');
ok(/AUTH_REQUIRED/.test((await connectError('/agent', undefined)) ?? ''), 'no ticket fails');
ok(/AUTH_REQUIRED/.test((await connectError('/agent', 'x'.repeat(5000))) ?? ''), 'an oversized ticket fails');
const waitExp = 31_000 - (Date.now() - expiringMintedAt);
if (waitExp > 0) {
  console.log(`  (waiting ${Math.ceil(waitExp / 1000)} s for the early ticket to pass its 30 s TTL)`);
  await sleep(waitExp);
}
ok(/AUTH_REQUIRED/.test((await connectError('/agent', expiringTicket)) ?? ''), `an expired ticket (${Math.round((Date.now() - expiringMintedAt) / 1000)} s old, TTL 30 s) fails`);
ok(/AUTH_REQUIRED/.test((await connectError('/agent', await visitorTicket(visitorA1))) ?? ''), 'a visitor ticket cannot open the /agent namespace');
ok(/AUTH_REQUIRED/.test((await connectError('/visitor', await agentTicket(ownerA))) ?? ''), 'an agent ticket cannot open the /visitor namespace');
ok(/ORIGIN_NOT_ALLOWED/.test((await connectError('/agent', await agentTicket(ownerA), { extraHeaders: { origin: 'https://evil.example' } })) ?? ''), 'agent socket from a foreign Origin is refused (ORIGIN_NOT_ALLOWED)');

console.log('9b. Agents cannot subscribe across tenants or outside their scope');
const bSub = await ack(ownerBSock, 'subscribe', {
  scopes: [
    { kind: 'chat', id: chatA1 },
    { kind: 'queue', id: supportA.id },
    { kind: 'team', id: ownerA.tenantId },
    { kind: 'agent', id: ownerA.membershipId },
    { kind: 'visitor', id: siteA.id },
    { kind: 'config', id: siteA.id },
    { kind: 'tenant', id: ownerA.tenantId },
  ],
});
ok(bSub.type === 'subscription.ok' && bSub.granted === 0 && bSub.denied.length === 7, 'tenant B agent denied tenant A chat, queue, team, agent, visitor, config and tenant scopes', bSub);
const badAgentScope = await ack(ownerBSock, 'subscribe', { scopes: [{ kind: 'chat', id: "not-a-uuid' OR '1'='1" }] }).catch((e) => ({ type: 'no-ack', message: e.message }));
known(badAgentScope.type === 'subscription.ok' && badAgentScope.granted === 0, 'agent subscribe with a non-UUID chat id is denied cleanly (not an INTERNAL error)', badAgentScope);
const agentSock = await socket('/agent', await agentTicket(agentA));
const aSub = await ack(agentSock, 'subscribe', { scopes: [{ kind: 'queue', id: fx.dept.id }, { kind: 'config', id: siteA.id }, { kind: 'agent', id: ownerA.membershipId }, { kind: 'tenant', id: ownerA.tenantId }] });
ok(aSub.granted === 0 && aSub.denied.length === 4, 'tenant A agent denied an unserved department queue, site config, another agent and the tenant scope', aSub);
const leakCheckStart = ownerBSock.frames.length + ownerBSock.ephemeral.length;
await ownerA.must('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: `socket leak probe ${MARK}` });
await sleep(800);
ok(![...ownerBSock.frames, ...ownerBSock.ephemeral].slice(0).some((f) => JSON.stringify(f).includes(MARK) || JSON.stringify(f).includes(chatA1)) && ownerBSock.frames.length + ownerBSock.ephemeral.length >= leakCheckStart, 'no tenant A frame reached the tenant B socket');

console.log('9c. Agent commands on a chat the agent is not a participant in are refused');
for (const [type, payload] of [
  ['message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'not a participant' }],
  ['message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'note', visibility: 'internal' }],
  ['typing.set', { chat_id: chatA1, is_typing: true }],
  ['chat.close', { chat_id: chatA1 }],
]) {
  const r = await cmd(agentSock, type, payload);
  ok(r.type === 'command.error' && r.code === 'PERMISSION_DENIED', `non-participant agent ${type}${payload.visibility ? ' (internal)' : ''} → command.error PERMISSION_DENIED`, r);
}
for (const [type, payload] of [
  ['message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'cross tenant' }],
  ['chat.close', { chat_id: chatA1 }],
  ['offer.accept', { chat_id: chatA2 }],
  ['message.read', { chat_id: chatA1, last_read_seq: 1 }],
]) {
  const r = await cmd(ownerBSock, type, payload);
  ok(r.type === 'command.error' && ['NOT_FOUND', 'PERMISSION_DENIED'].includes(r.code), `tenant B agent ${type} on a tenant A chat → command.error ${r.code}`, r);
}
ok(sql(`SELECT status FROM chats WHERE id = '${chatA1}'`) === 'active' && sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}' AND body IN ('not a participant', 'note', 'cross tenant')`) === '0', 'chat A1 still active with no foreign messages (psql)');

console.log('9d. Visitors cannot reach other visitors, staff scopes or agent commands');
const vSock2 = await socket('/visitor', await visitorTicket(visitorA2));
const vSub = await ack(vSock2, 'subscribe', {
  scopes: [
    { kind: 'chat', id: chatA2 },
    { kind: 'chat', id: chatA1 },
    { kind: 'chat', id: chatB1 },
    { kind: 'team', id: 'all' },
    { kind: 'queue', id: 'none' },
    { kind: 'queue', id: supportA.id },
    { kind: 'agent', id: ownerA.membershipId },
    { kind: 'visitor', id: visitorA1.session.session_id },
    { kind: 'config', id: siteB.id },
    { kind: 'tenant', id: ownerA.tenantId },
  ],
});
const vDenied = Array.isArray(vSub.denied) ? vSub.denied.length : vSub.denied; // count (older builds) or the denied scopes
ok(vSub.type === 'subscription.ok' && vSub.granted === 1 && vDenied === 9, 'visitor A2 granted only its own chat; another visitor’s chat, other tenant, team, queue, agent, visitor-session, config and tenant scopes denied', vSub);
for (const [type, payload, codes] of [
  ['offer.accept', { chat_id: chatA2 }, ['VALIDATION_FAILED']],
  ['offer.decline', { offer_id: randomUUID() }, ['VALIDATION_FAILED']],
  ['message.send', { chat_id: chatA1, client_message_id: randomUUID(), body: 'into another chat' }, ['NOT_FOUND']],
  ['chat.close', { chat_id: chatA1 }, ['NOT_FOUND']],
  ['message.read', { chat_id: chatA1, last_read_seq: 1 }, ['NOT_FOUND']],
  ['typing.set', { chat_id: chatA1, is_typing: true }, ['VALIDATION_FAILED', 'NOT_FOUND']],
  ['message.send', { chat_id: chatA2, client_message_id: randomUUID(), body: 'pretend note', visibility: 'internal' }, ['VALIDATION_FAILED']],
]) {
  const r = await cmd(vSock2, type, payload);
  ok(r.type === 'command.error' && codes.includes(r.code), `visitor socket ${type}${payload.visibility ? ' (internal)' : ''} → command.error ${r.code}`, r);
}
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA1}' AND body = 'into another chat'`) === '0' && sql(`SELECT status FROM chats WHERE id = '${chatA1}'`) === 'active', 'nothing written to chat A1 by visitor A2 (psql)');
const badVisitorScope = await ack(vSock2, 'subscribe', { scopes: [{ kind: 'chat', id: "not-a-uuid' OR '1'='1" }] }).catch((e) => ({ type: 'no-ack', message: e.message }));
known(badVisitorScope.type === 'subscription.ok' && badVisitorScope.granted === 0, 'visitor subscribe with a non-UUID chat id is denied cleanly (no INTERNAL error, no missing ack)', badVisitorScope);
const malformed = await ack(vSock2, 'command', { type: 42 });
ok(malformed.type === 'command.error' && malformed.code === 'VALIDATION_FAILED', 'malformed command frame → VALIDATION_FAILED');

console.log('9e. Oversized frames');
const bigText = await cmd(vSock2, 'message.send', { chat_id: chatA2, client_message_id: randomUUID(), body: 'z'.repeat(8001) });
ok(bigText.type === 'command.error' && bigText.code === 'VALIDATION_FAILED', 'message body over 8000 characters over the socket → VALIDATION_FAILED');
const fatSock = await socket('/visitor', await visitorTicket(visitorA2));
let disconnectReason = null;
fatSock.on('disconnect', (reason) => (disconnectReason = reason));
fatSock.emit('command', { v: 1, command_id: randomUUID(), type: 'message.send', payload: { chat_id: chatA2, client_message_id: randomUUID(), body: 'Q'.repeat(100 * 1024) } });
await waitFor(() => disconnectReason, 5000, 'oversized frame disconnect').catch(() => null);
ok(!!disconnectReason, `a 100 KB frame (> 64 KB maxHttpBufferSize) closes the connection (${disconnectReason})`);
const fatAgent = await socket('/agent', await agentTicket(agentA));
let agentReason = null;
fatAgent.on('disconnect', (reason) => (agentReason = reason));
fatAgent.emit('subscribe', { scopes: Array.from({ length: 3000 }, () => ({ kind: 'chat', id: randomUUID() })) });
await waitFor(() => agentReason, 5000, 'oversized agent frame disconnect').catch(() => null);
ok(!!agentReason, `an oversized agent subscribe frame closes the connection (${agentReason})`);
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatA2}' AND body LIKE 'QQQQ%'`) === '0', 'the oversized message was never stored');
const big = await ownerA.call('POST', `/chats/${chatA1}/messages`, { client_message_id: randomUUID(), body: 'B'.repeat(300 * 1024) });
known(big.status === 413, 'REST JSON body over the 256 KB limit → 413 (not a 500)', `${big.status} ${big.error?.code}`);
const after = await socket('/visitor', await visitorTicket(visitorA2));
ok(after.connected, 'the gateway keeps serving new connections afterwards');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n10. Security headers');
const hdrChecks = [
  ['JSON 200', await ownerA.call('GET', '/tenants/current')],
  ['JSON 401', await new Client('anon').call('GET', '/tenants/current')],
  ['JSON 404', await ownerA.call('GET', '/no-such-route')],
  ['JSON 422', await ownerA.call('POST', '/departments', { nope: true })],
  ['widget JSON', await visitorA1.call('GET', `/widget/v1/chats/${chatA1}`)],
];
for (const [label, r] of hdrChecks) {
  ok(r.headers.get('x-content-type-options') === 'nosniff' && /application\/json/.test(r.headers.get('content-type') ?? ''), `${label}: application/json with X-Content-Type-Options: nosniff`);
}
const jr = hdrChecks[0][1].headers;
ok(jr.get('referrer-policy') === 'no-referrer' && /max-age=\d+/.test(jr.get('strict-transport-security') ?? '') && !jr.get('x-powered-by'), 'API sends Referrer-Policy no-referrer and HSTS, and hides X-Powered-By');
if (!jr.get('content-security-policy') && !jr.get('x-frame-options')) note('JSON API responses carry no CSP / X-Frame-Options (helmet CSP + frameguard disabled globally; JSON is not a framing target, the widget frame sets its own CSP)');
const frame = await fetch(`${API}/widget/frame/${siteA.public_key}`);
const csp = frame.headers.get('content-security-policy') ?? '';
const fa = (csp.match(/frame-ancestors ([^;]+)/) ?? [])[1]?.trim();
ok(frame.status === 200 && /text\/html/.test(frame.headers.get('content-type') ?? ''), 'widget frame route serves HTML');
ok(fa === ORIGIN_A, `widget frame CSP frame-ancestors matches the site origins exactly (${fa})`);
ok(/default-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp), "frame CSP: default-src 'self', script-src 'self' (no inline), object-src/base-uri/form-action 'none'");
ok(frame.headers.get('x-content-type-options') === 'nosniff' && frame.headers.get('referrer-policy') === 'strict-origin-when-cross-origin', 'frame sends nosniff and Referrer-Policy');
const frameB = await fetch(`${API}/widget/frame/${siteB.public_key}`);
ok(((frameB.headers.get('content-security-policy') ?? '').match(/frame-ancestors ([^;]+)/) ?? [])[1]?.trim() === ORIGIN_B, 'tenant B frame lists only tenant B origins');
const preview = await fetch(`${API}/widget/frame/${siteA.public_key}?preview=1`);
ok(((preview.headers.get('content-security-policy') ?? '').match(/frame-ancestors ([^;]+)/) ?? [])[1]?.includes('http://localhost:3000'), 'preview frame may only be embedded by the dashboard (+ localhost in development)');
const unknownFrame = await fetch(`${API}/widget/frame/${encodeURIComponent('rds_<script>alert(1)</script>')}`);
const unknownBody = await unknownFrame.text();
ok(unknownFrame.status === 404 && /text\/plain/.test(unknownFrame.headers.get('content-type') ?? '') && !unknownBody.includes('<script>'), 'unknown site key → 404 text/plain without reflecting the key');
const loader = await fetch(`${API}/widget/loader.js`);
ok(loader.status !== 200 || loader.headers.get('x-content-type-options') === 'nosniff', `widget static assets carry nosniff (loader.js ${loader.status})`);
const health = await fetch(`${WORKER}/health/ready`);
ok(health.status === 200, 'worker healthy at the end of the run');

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n7b. Remaining id-bearing routes probed from tenant B (every staff route with an id is now covered)');
{
  const exportJob = sql(`SELECT job_id FROM exports WHERE id = '${fx.export.id}'`);
  await expect404(B, 'GET', `/jobs/${exportJob}`);
  if (fx.offer) await expect404(B, 'POST', `/offers/${fx.offer}/decline`, {});
  if (fx.delivery) await expect404(B, 'POST', `/webhook-deliveries/${fx.delivery}/retry`, {});
  await expect404(B, 'PUT', `/schedules/${fx.schedule.id}/exceptions/2031-01-02`, { intervals: [], reason: 'probe' });
  await expect404(B, 'DELETE', `/schedules/${fx.schedule.id}/exceptions/2031-01-02`);
  await expect404(B, 'GET', `/triggers/${fx.trigger.id}/revisions/1`);
  const reqA = (await ownerA.must('GET', '/tenants/current/deletion-requests/current').catch(() => null))?.id ?? randomUUID();
  await expect404(B, 'DELETE', `/tenants/current/deletion-requests/${reqA}`);
  ok(sql(`SELECT count(*) FROM schedule_exceptions WHERE schedule_id = '${fx.schedule.id}' AND local_date = '2031-01-02'`) === '0', 'no schedule exception was written into tenant A (psql)');
  // Signed content routes take no session: only a valid grant (bound to tenant, object and expiry) opens them.
  for (const [m, route] of [['GET', `/attachments/${fx.upload.upload_id}/content`], ['PUT', `/attachments/${fx.upload.upload_id}/content`], ['GET', `/exports/${fx.export.id}/content`]]) {
    const res = await fetch(`${API}/api/v1${route}`, { method: m, headers: { cookie: B.cookieHeader?.() ?? '', 'content-type': 'image/png', 'x-forwarded-for': '10.250.3.3' }, body: m === 'PUT' ? Buffer.from('x') : undefined });
    const r = { status: res.status, text: await res.text() };
    const leaked = A_SECRETS.filter((x) => x && r.text.includes(x));
    ok([401, 403, 404].includes(r.status) && leaked.length === 0, `tenant B ${m} ${route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')} without a grant signature → ${r.status}, no tenant A data`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
console.log('\n8. Database role matrix — RLS with absent / wrong tenant (TEN03), composite foreign keys (AUD-72-02), schema (AUD-72-01)');
{
  // Every statement runs inside a transaction that is rolled back: nothing here can change data even if a check fails.
  const APP_DB = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  const run = (url, script) => {
    const r = spawnSync('psql', [url, '-XAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: script, encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  };
  const A = ownerA.tenantId;
  const B = ownerB.tenantId;
  const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;
  const appRole = sql("SELECT current_setting('is_superuser')") && run(APP_DB, 'SELECT current_user').out;
  ok(appRole && appRole !== sql('SELECT current_user'), `checks run as the application role (${appRole}), not the owner`);
  const tables = sql(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    ORDER BY 1`).split('\n').filter(Boolean);
  const priv = (t, kind) => sql(`SELECT has_table_privilege(${lit(appRole)}, ${lit('public.' + t)}, ${lit(kind)})`) === 't';
  const leaks = [];
  let withRowsOfA = 0;
  for (const t of tables) {
    const rowsA = Number(sql(`SELECT count(*) FROM "${t}" WHERE tenant_id = ${lit(A)}`));
    if (rowsA > 0) withRowsOfA++;
    const canUpdate = priv(t, 'UPDATE');
    const canDelete = priv(t, 'DELETE');
    const lines = [
      `SELECT count(*) FROM "${t}";`,
      canUpdate ? `WITH u AS (UPDATE "${t}" SET tenant_id = tenant_id RETURNING 1) SELECT count(*) FROM u;` : 'SELECT 0;',
      canDelete ? `WITH d AS (DELETE FROM "${t}" RETURNING 1) SELECT count(*) FROM d;` : 'SELECT 0;',
      `SELECT set_config('app.tenant_id', ${lit(B)}, true) IS NOT NULL AND false;`,
      `SELECT count(*) FROM "${t}" WHERE tenant_id = ${lit(A)};`,
      canUpdate ? `WITH u AS (UPDATE "${t}" SET tenant_id = tenant_id WHERE tenant_id = ${lit(A)} RETURNING 1) SELECT count(*) FROM u;` : 'SELECT 0;',
      canDelete ? `WITH d AS (DELETE FROM "${t}" WHERE tenant_id = ${lit(A)} RETURNING 1) SELECT count(*) FROM d;` : 'SELECT 0;',
    ];
    const r = run(APP_DB, `BEGIN;\n${lines.join('\n')}\nROLLBACK;`);
    const counts = r.out.split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
    if (!r.ok || counts.length !== 6 || counts.some((n) => n !== 0)) leaks.push(`${t}: ${r.ok ? counts.join('/') : r.err.split('\n')[0]}`);
  }
  ok(tables.length >= 50 && leaks.length === 0, `app role sees, updates and deletes nothing without a tenant context, and nothing of tenant A from tenant B's context, in all ${tables.length} RLS tables (${withRowsOfA} hold tenant A rows)${leaks.length ? ': ' + leaks.join('; ') : ''}`);

  // INSERT … WITH CHECK: a real tenant A row (fresh id) inserted by the app role claiming tenant A from tenant B's context
  // and from no context must be refused by the policy itself.
  const insertLeaks = [];
  let insertChecked = 0;
  for (const t of tables) {
    if (!priv(t, 'INSERT') || sql(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public."${t}"'::regclass AND attname = 'id'`) !== '1') continue;
    const row = sql(`SELECT to_jsonb(r) FROM "${t}" r WHERE tenant_id = ${lit(A)} LIMIT 1`);
    if (!row) continue;
    const json = JSON.parse(row);
    json.id = typeof json.id === 'string' ? randomUUID() : json.id;
    for (const ctx of [B, null]) {
      const r = run(APP_DB, `BEGIN;\n${ctx ? `SELECT set_config('app.tenant_id', ${lit(ctx)}, true);\n` : ''}INSERT INTO "${t}" SELECT (jsonb_populate_record(NULL::"${t}", ${lit(JSON.stringify(json))}::jsonb)).*;\nROLLBACK;`);
      if (r.ok || !/row-level security/.test(r.err)) insertLeaks.push(`${t} (${ctx ? 'tenant B context' : 'no context'}): ${r.ok ? 'inserted' : r.err.split('\n')[0]}`);
    }
    insertChecked++;
  }
  ok(insertChecked >= 25 && insertLeaks.length === 0, `row-level security refuses inserting a tenant A row from tenant B's context and without context (${insertChecked} tables)${insertLeaks.length ? ': ' + insertLeaks.join('; ') : ''}`);

  // Composite foreign keys: every reference between tenant-owned tables carries tenant_id on both sides …
  const nonComposite = sql(`SELECT c.conname FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'tenant_id')
      AND c.confrelid <> 'public.tenants'::regclass
      AND NOT ((SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'tenant_id') = ANY(c.conkey)
           AND (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'tenant_id') = ANY(c.confkey))`).split('\n').filter(Boolean);
  ok(nonComposite.length === 0, `every foreign key between tenant-owned tables includes tenant_id on both sides${nonComposite.length ? ': ' + nonComposite.join(', ') : ''}`);
  // … so even the table owner (who bypasses RLS) cannot store a tenant B row that still points at tenant A's data:
  // for every composite foreign key, a tenant A row whose reference is filled in is relabelled to tenant B.
  const fks = sql(`SELECT c.conname, c.conrelid::regclass::text,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum WHERE a.attname <> 'tenant_id')
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.confrelid <> 'public.tenants'::regclass
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id')
      AND (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'tenant_id') = ANY(c.conkey)
    ORDER BY 1`).split('\n').filter(Boolean).map((l) => l.split('|'));
  const crossLeaks = [];
  const inconclusive = [];
  let crossChecked = 0;
  for (const [con, t, cols] of fks) {
    const notNull = cols.split(',').map((c) => `r."${c}" IS NOT NULL`).join(' AND ');
    const row = sql(`SELECT to_jsonb(r) FROM ${t} r WHERE r.tenant_id = ${lit(A)} AND ${notNull} LIMIT 1`);
    if (!row) continue;
    const json = JSON.parse(row);
    json.tenant_id = B;
    if (typeof json.id === 'string') json.id = randomUUID();
    const attempt = () => run(OWNER_DB, `BEGIN;\nINSERT INTO ${t} SELECT (jsonb_populate_record(NULL::${t}, ${lit(JSON.stringify(json))}::jsonb)).*;\nROLLBACK;`);
    let r = attempt();
    // A globally unique column (object key, token hash, …; Prisma makes these unique indexes) may stop the copy first:
    // give it a fresh value and retry once.
    const dup = /violates unique constraint "([^"]+)"/.exec(r.err);
    if (dup) {
      for (const c of sql(`SELECT a.attname FROM pg_class ic JOIN pg_index i ON i.indexrelid = ic.oid JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE ic.relname = ${lit(dup[1])}`).split('\n').filter(Boolean)) {
        if (typeof json[c] === 'string') json[c] = /^[0-9a-f-]{36}$/.test(json[c]) ? randomUUID() : `${json[c]}-${randomUUID()}`;
      }
      r = attempt();
    }
    if (r.ok) crossLeaks.push(`${con}: inserted`);
    else if (/violates foreign key constraint/.test(r.err)) crossChecked++;
    else inconclusive.push(`${con}: ${r.err.split('\n')[0]}`);
  }
  ok(
    crossChecked >= 30 && crossLeaks.length === 0,
    `a tenant A row relabelled to tenant B while still referencing tenant A's data is refused by a foreign key, even for the owner (${crossChecked} composite foreign keys with sample rows${inconclusive.length ? `; ${inconclusive.length} stopped earlier by another constraint` : ''})${crossLeaks.length ? ': ' + crossLeaks.join('; ') : ''}`,
  );
  if (inconclusive.length) notes.push(`composite FK checks stopped by another constraint first: ${inconclusive.join('; ')}`);

  // Schema hygiene: tenant_id is NOT NULL in tenant-owned tables (global tokens, signup mail and provider events may
  // precede a workspace), and every foreign key is backed by an index on its columns.
  const nullableTenant = sql(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' AND is_nullable = 'YES'
    AND table_name NOT IN ('auth_tokens', 'outbound_emails', 'billing_events')`).split('\n').filter(Boolean); // rows that may precede a workspace
  ok(nullableTenant.length === 0, `tenant_id is NOT NULL in every tenant-owned table${nullableTenant.length ? ': ' + nullableTenant.join(', ') : ''}`);
  const unindexed = sql(`SELECT c.conrelid::regclass || '.' || c.conname FROM pg_constraint c
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
        AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)`).split('\n').filter(Boolean);
  ok(unindexed.length === 0, `every foreign key is backed by an index on its columns (parent deletes never scan the child)${unindexed.length ? ': ' + unindexed.join(', ') : ''}`);
}

for (const s of [ownerASock, ownerBSock, vSock1, vSock2, s1, agentSock, fatSock, fatAgent, after]) s.close();
// Housekeeping in tenant A (test data stays; nothing left running): lift the emergency closure.
await ownerA.call('DELETE', `/emergency-closures/${fx.closure.id}`);

console.log(`\nKnown failures (${knownFails.length}):`);
for (const k of knownFails) console.log(`  - ${k}`);
if (notes.length) {
  console.log(`Notes (${notes.length}):`);
  for (const n of notes) console.log(`  - ${n}`);
}
console.log(`\nSECURITY E2E: ${passed} passed, ${knownFails.length} known failures`);
process.exit(knownFails.length ? 1 : 0);
