// Lifecycle edges of sites, visitors, chats and agents — end-to-end against a running api + worker
// (node test/lifecycle.e2e.mjs). Covers:
//   * AUD-71-05  site key rotation: the old key keeps working only during the overlap, then is refused;
//   * ROUTE04    department fallback graph: cycles (and self-fallback) are rejected;
//   * CONS01     without analytics consent no browsing data is kept and the service credential is short-lived
//                (24 h, vs 180 days with consent); an expired credential is not honoured; service chat still works;
//   * VIS02      anonymous credentials are site-bound: the same browser token on another site's origin is a
//                different visitor and cannot read the first site's chat;
//   * NOTE01     internal notes never reach the visitor (messages, socket frames, visitor transcript export) and
//                appear in staff exports only with include_internal;
//   * AUD-71-19  collaborators: only the owner (or a supervisor) invites, capacity is enforced, active chats only,
//                a removed collaborator loses access;
//   * RATE01 / AUD-71-24  one current rating per chat (revisions counted), the rating window closes 24 h after the
//                chat ends, CSAT counts rated chats only (unrated chats stay out of the denominator);
//   * AUD-71-23  reconnect grace: a visitor who returns before the grace timer keeps the chat; one who doesn't has it
//                closed as visitor_disconnected (the delayed timer job is promoted instead of waiting minutes);
//   * AUD-71-14  an agent whose connection goes silent (network gone, no FIN) drops out of the roster and routing once
//                the socket.io ping times out, and comes back with a fresh connection.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const stamp = Date.now().toString(36);
const PASSWORD = 'lifecycle passphrase long';
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
}
const latestEmail = (to, template) => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

class Client {
  constructor(name, ip) {
    this.name = name;
    this.ip = ip;
    this.cookies = {};
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(Object.keys(this.cookies).length ? { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, code: json?.error?.code ?? null, data: json?.data, text };
  }
  async must(method, path, body, headers) {
    const r = await this.call(method, path, body, headers);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${r.code}`);
    return r.data;
  }
}

const sockets = [];
async function agentSocket(client, { heartbeat = true } = {}) {
  const s = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket: (await client.must('POST', '/socket-ticket')).ticket }, forceNew: true, reconnection: false });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  await new Promise((resolve, reject) => {
    s.once('auth.ok', resolve);
    s.once('connect_error', reject);
  });
  if (heartbeat) s.beat = setInterval(() => s.emit('heartbeat'), 10_000);
  sockets.push(s);
  return s;
}
async function visitorSocket(visitor, chatId) {
  const s = io(`${API}/visitor`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket: (await visitor.must('POST', '/widget/v1/socket-ticket')).ticket }, forceNew: true, reconnection: false });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  await new Promise((resolve, reject) => {
    s.once('auth.ok', resolve);
    s.once('connect_error', reject);
  });
  if (chatId) await s.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
  sockets.push(s);
  return s;
}
async function session(siteKey, origin, { analytics = false, anonymousToken = null, ip = `10.52.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200) + 1}` } = {}) {
  const v = new Client(`visitor@${origin}`, ip);
  const r = await v.call('POST', '/widget/v1/sessions', { site_key: siteKey, host_origin: origin, anonymous_token: anonymousToken, consent: { analytics, policy_version: '2026-10' }, page: { url: `${origin}/pricing?utm_source=newsletter`, title: 'Pricing', referrer: 'https://search.example/?q=chat' } });
  if (r.status >= 400) return { status: r.status, code: r.code };
  v.bearer = r.data.capability;
  return { status: r.status, visitor: v, data: r.data };
}
async function newChat(visitor, message) {
  return (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message })).chat.id;
}

// ───────────────────────── setup ─────────────────────────
console.log('Setup — owner, two agents, two sites');
const owner = new Client('owner', '10.51.0.1');
const ownerEmail = `life-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email: ownerEmail, password: PASSWORD, tenant_name: `Lifecycle ${stamp}`, timezone: 'UTC' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(await waitFor(async () => latestEmail(ownerEmail, 'verify_email'), 20000, 'verification'), 'token') });
const tenantId = sql(`SELECT tenant_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = '${ownerEmail}'`);
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
async function invite(role, capacity, label, departmentIds = [support.id]) {
  const email = `life-${label.toLowerCase()}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', { email, role, department_ids: departmentIds, capacity });
  const c = new Client(label, `10.51.0.${10 + capacity + label.length}`);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(await waitFor(async () => latestEmail(email, 'agent_invitation'), 20000, `${label} invitation`), 'invite'), display_name: label, password: PASSWORD });
  c.membershipId = (await c.must('GET', '/agents/me')).agent.id;
  return c;
}
const bea = await invite('agent', 3, 'Bea');
const cal = await invite('agent', 1, 'Cal');
for (const c of [owner, bea, cal]) {
  await agentSocket(c);
  await c.must('PUT', '/agents/me/presence', { status: 'online' });
}
owner.membershipId = (await owner.must('GET', '/agents/me')).agent.id;
const siteA = await owner.must('POST', '/sites', { name: `Shop A ${stamp}`, origins: [{ origin: 'https://a.example', pattern_type: 'exact' }] });
const siteB = await owner.must('POST', '/sites', { name: `Shop B ${stamp}`, origins: [{ origin: 'https://b.example', pattern_type: 'exact' }] });

// ───────────────────────── ROUTE04 ─────────────────────────
console.log('ROUTE04 — department fallback cycles are refused');
{
  const d1 = await owner.must('POST', '/departments', { name: `North ${stamp}` });
  const d2 = await owner.must('POST', '/departments', { name: `South ${stamp}` });
  const l1 = await owner.call('PATCH', `/departments/${d1.id}`, { fallback_department_id: d2.id, expected_version: d1.version });
  ok(l1.status === 200 && l1.data.fallback_department_id === d2.id, 'North falls back to South');
  const cycle = await owner.call('PATCH', `/departments/${d2.id}`, { fallback_department_id: d1.id, expected_version: d2.version });
  ok(cycle.status === 409 && cycle.code === 'CONFLICT', `South → North would loop: refused (${cycle.status} ${cycle.code})`);
  const self = await owner.call('PATCH', `/departments/${d2.id}`, { fallback_department_id: d2.id, expected_version: d2.version });
  ok(self.status === 409, 'a department cannot fall back to itself');
}

// ───────────────────────── AUD-71-05 ─────────────────────────
console.log('AUD-71-05 — key rotation keeps the old key only during the overlap');
{
  const oldKey = siteA.public_key;
  const rotated = await owner.must('POST', `/sites/${siteA.id}/key-rotation`, { overlap_seconds: 3 });
  ok(rotated.public_key !== oldKey && Date.parse(rotated.previous_key_expires_at) - Date.now() <= 3_500, 'a new key is issued; the old one expires in ~3 s');
  ok((await session(oldKey, 'https://a.example')).status === 201, 'during the overlap the old key still opens visitor sessions');
  ok((await session(rotated.public_key, 'https://a.example')).status === 201, 'the new key works');
  await sleep(3_500);
  const late = await session(oldKey, 'https://a.example');
  ok(late.status >= 400 && late.status < 500, `after the overlap the old key is refused (${late.status} ${late.code})`);
  ok((await session(rotated.public_key, 'https://a.example')).status === 201, 'the new key keeps working');
  siteA.public_key = rotated.public_key;
}

// ───────────────────────── CONS01 + VIS02 ─────────────────────────
console.log('CONS01 — denied analytics: no browsing data, short-lived service credential');
const denied = await session(siteA.public_key, 'https://a.example', { analytics: false });
const granted = await session(siteA.public_key, 'https://a.example', { analytics: true });
const days = (iso) => (Date.parse(iso) - Date.now()) / 86_400_000;
ok(denied.data.anonymous_token && days(denied.data.anonymous_token_expires_at) <= 1.01 && days(denied.data.anonymous_token_expires_at) > 0.9, `without consent the credential lasts 24 h (${days(denied.data.anonymous_token_expires_at).toFixed(2)} d)`);
ok(days(granted.data.anonymous_token_expires_at) > 170, `with consent it lasts ~180 days (${days(granted.data.anonymous_token_expires_at).toFixed(0)} d)`);
ok(denied.data.anonymous_token_persistence === 'session' && granted.data.anonymous_token_persistence === 'persistent', 'the page is told to keep the denied credential for the session only');
const deniedVisitor = denied.data.visitor.id;
const kept = sql(`SELECT coalesce(current_url, '') || '|' || coalesce(landing_url, '') || '|' || coalesce(referrer_origin, '') || '|' || coalesce(utm::text, '') FROM visitor_sessions WHERE visitor_id = '${deniedVisitor}'`);
ok(kept === '|||', 'no page, landing page, referrer or UTM stored for the denied session', kept);
const grantedVisitor = granted.data.visitor.id;
ok(sql(`SELECT current_url IS NOT NULL FROM visitor_sessions WHERE visitor_id = '${grantedVisitor}'`) === 't', 'the consented session keeps its page (contrast)');
const serviceChat = await newChat(denied.visitor, 'Service only, please');
ok(/^[0-9a-f-]{36}$/.test(serviceChat), 'a chat works without analytics consent (service purpose)');
{
  const again = await session(siteA.public_key, 'https://a.example', { anonymousToken: denied.data.anonymous_token });
  ok(again.data.visitor.id === deniedVisitor, 'within its lifetime the credential resumes the same visitor');
  sql(`UPDATE visitor_credentials SET expires_at = now() - interval '1 second' WHERE token_hash = '${sha256(denied.data.anonymous_token)}'`);
  const expired = await session(siteA.public_key, 'https://a.example', { anonymousToken: denied.data.anonymous_token });
  ok(expired.data.anonymous_token && expired.data.visitor.id !== deniedVisitor, 'once expired, the short-lived credential is not honoured: a new anonymous visitor');
}

console.log('VIS02 — anonymous credentials are bound to their site');
{
  const onA = await session(siteA.public_key, 'https://a.example', { analytics: true });
  const visitorA = onA.data.visitor.id;
  const chatA = await newChat(onA.visitor, 'Order question on shop A');
  const onB = await session(siteB.public_key, 'https://b.example', { analytics: true, anonymousToken: onA.data.anonymous_token });
  ok(onB.status === 201 && onB.data.visitor.id !== visitorA, 'the same browser token on site B starts a separate visitor');
  ok((await onB.visitor.call('GET', `/widget/v1/chats/${chatA}`)).status === 404, "site B's session cannot read site A's chat");
  ok((await onB.visitor.call('GET', `/widget/v1/chats/${chatA}/messages`)).status === 404, "…nor its messages");
  const backOnA = await session(siteA.public_key, 'https://a.example', { analytics: true, anonymousToken: onA.data.anonymous_token });
  ok(backOnA.data.visitor.id === visitorA && (await backOnA.visitor.call('GET', `/widget/v1/chats/${chatA}`)).status === 200, 'back on site A, the token resumes the same visitor and chat');
}

// ───────────────────────── NOTE01 ─────────────────────────
console.log('NOTE01 — internal notes never reach the visitor');
const noteVisit = await session(siteA.public_key, 'https://a.example');
const noteChat = await newChat(noteVisit.visitor, 'Can you check my order?');
await owner.must('POST', `/chats/${noteChat}/accept`, {});
const vSock = await visitorSocket(noteVisit.visitor, noteChat);
const NOTE = `NoteCanary${stamp}`;
await owner.must('POST', `/chats/${noteChat}/messages`, { client_message_id: randomUUID(), body: 'Checking now.' });
await owner.must('POST', `/chats/${noteChat}/messages`, { client_message_id: randomUUID(), visibility: 'internal', body: `${NOTE} VIP, refund approved` });
await waitFor(async () => vSock.frames.some((f) => f.type === 'message.created' && f.payload.message?.body === 'Checking now.'), 8000, 'public reply frame');
await sleep(800);
ok(!JSON.stringify(vSock.frames).includes(NOTE), 'no socket frame to the visitor carries the note');
ok(!JSON.stringify((await noteVisit.visitor.must('GET', `/widget/v1/chats/${noteChat}/messages`)).items).includes(NOTE), "the visitor's message list has no note");
{
  const exp = await noteVisit.visitor.must('POST', `/widget/v1/chats/${noteChat}/exports`, { format: 'txt' });
  const ready = await waitFor(async () => ((await noteVisit.visitor.must('GET', `/widget/v1/exports/${exp.id}`)).state === 'ready' ? true : null), 15000, 'visitor transcript');
  const grant = await noteVisit.visitor.must('GET', `/widget/v1/exports/${exp.id}/download`);
  const txt = await (await fetch(grant.url)).text();
  ok(ready && txt.includes('Checking now.') && !txt.includes(NOTE), 'the visitor transcript export has the reply and no note');
}
async function staffExport(includeInternal) {
  const e = await owner.must('POST', '/exports', { chat_ids: [noteChat], format: 'json', include_internal: includeInternal });
  await waitFor(async () => ((await owner.must('GET', `/exports/${e.id}`)).state === 'ready' ? true : null), 15000, 'staff export');
  return (await fetch((await owner.must('GET', `/exports/${e.id}/download`)).url)).text();
}
ok(!(await staffExport(false)).includes(NOTE), 'a staff export without include_internal has no note');
ok((await staffExport(true)).includes(NOTE), 'with include_internal the note is in the staff export');

// ───────────────────────── AUD-71-19 ─────────────────────────
console.log('AUD-71-19 — collaborators: who may invite, capacity, access');
{
  const visit = await session(siteA.public_key, 'https://a.example');
  const chat = await newChat(visit.visitor, 'Complex billing issue');
  await owner.must('POST', `/chats/${chat}/accept`, {});
  ok((await bea.call('POST', `/chats/${chat}/collaborators`, { membership_id: cal.membershipId })).status === 403, 'an agent who does not own the chat cannot invite collaborators');
  // Cal's capacity is 1: give Cal a chat of their own, then try to add Cal as a collaborator.
  const calVisit = await session(siteA.public_key, 'https://a.example');
  const calChat = await newChat(calVisit.visitor, 'For Cal');
  ok((await cal.call('POST', `/chats/${calChat}/accept`, {})).status === 200, 'Cal takes a chat (capacity 1 now full)');
  const full = await owner.call('POST', `/chats/${chat}/collaborators`, { membership_id: cal.membershipId });
  ok(full.status === 409 && full.code === 'CAPACITY_EXCEEDED', `a collaborator without free capacity is refused (${full.code})`);
  const add = await owner.call('POST', `/chats/${chat}/collaborators`, { membership_id: bea.membershipId });
  ok(add.status === 201, 'the owner invites Bea');
  ok((await bea.call('POST', `/chats/${chat}/messages`, { client_message_id: randomUUID(), body: 'Bea here, I can help with billing.' })).status === 201, 'the collaborator can reply');
  ok((await bea.call('GET', `/chats/${chat}/messages`)).status === 200, 'and read the transcript');
  ok((await owner.call('DELETE', `/chats/${chat}/collaborators/${bea.membershipId}`)).status === 204, 'the owner removes Bea');
  const after = await bea.call('POST', `/chats/${chat}/messages`, { client_message_id: randomUUID(), body: 'still here?' });
  ok(after.status === 403 || after.status === 404, `a removed collaborator can no longer reply (${after.status})`);
  await owner.must('POST', `/chats/${chat}/close`, { reason: 'resolved' });
  ok((await owner.call('POST', `/chats/${chat}/collaborators`, { membership_id: bea.membershipId })).status === 409, 'closed chats take no collaborators');
  await cal.must('POST', `/chats/${calChat}/close`, { reason: 'resolved' });
}

// ───────────────────────── RATE01 / AUD-71-24 ─────────────────────────
console.log('RATE01 — one current rating, a 24 h window, CSAT over rated chats only');
const T0 = new Date(Date.now() - 60_000).toISOString();
const rated = [];
for (const [label, rating] of [['good', 'good'], ['bad', 'bad'], ['unrated', null]]) {
  const visit = await session(siteA.public_key, 'https://a.example');
  const chat = await newChat(visit.visitor, `Rate me (${label})`);
  await owner.must('POST', `/chats/${chat}/accept`, {});
  await owner.must('POST', `/chats/${chat}/messages`, { client_message_id: randomUUID(), body: 'Here you go.' });
  await owner.must('POST', `/chats/${chat}/close`, { reason: 'resolved' });
  if (rating) ok((await visit.visitor.call('PUT', `/widget/v1/chats/${chat}/rating`, { rating })).status === 200, `the visitor rates ${rating}`);
  rated.push({ chat, visit, rating });
}
{
  const [g] = rated;
  const revised = await g.visit.visitor.must('PUT', `/widget/v1/chats/${g.chat}/rating`, { rating: 'bad', comment: 'second thoughts' });
  const back = await g.visit.visitor.must('PUT', `/widget/v1/chats/${g.chat}/rating`, { rating: 'good' });
  ok(revised.revision_count === 1 && back.revision_count === 2 && sql(`SELECT count(*) FROM chat_ratings WHERE chat_id = '${g.chat}'`) === '1', 'changes revise the one current rating (revision count 2, one row)');
}
{
  const qs = new URLSearchParams({ from: T0, to: new Date(Date.now() + 60_000).toISOString(), timezone: 'UTC', group_by: 'hour' });
  const report = await waitFor(async () => {
    const r = await owner.must('GET', `/analytics/chats?${qs}`);
    return r.freshness.pending_facts === 0 && r.measures.csat.denominator >= 2 ? r : null;
  }, 30000, 'fresh analytics');
  const m = report.measures;
  ok(m.csat.numerator === 1 && m.csat.denominator === 2 && m.csat.value === 50, `CSAT = good ÷ rated = 1/2 (the unrated chat is not in the denominator) → ${m.csat.value} %`, m.csat);
  ok(m.response_rate.numerator === 2 && m.response_rate.denominator >= 3, `response rate = rated ÷ served = ${m.response_rate.numerator}/${m.response_rate.denominator}`, m.response_rate);
}
{
  const [, b] = rated;
  sql(`UPDATE chats SET closed_at = now() - interval '25 hours' WHERE id = '${b.chat}'`);
  const late = await b.visit.visitor.call('PUT', `/widget/v1/chats/${b.chat}/rating`, { rating: 'good' });
  ok(late.status === 409 && late.code === 'TOKEN_EXPIRED', `24 h after the chat ended the rating can no longer change (${late.status} ${late.code})`);
  ok(sql(`SELECT rating FROM chat_ratings WHERE chat_id = '${b.chat}'`) === 'bad', 'the stored rating is unchanged');
}

// ───────────────────────── AUD-71-23 ─────────────────────────
console.log('AUD-71-23 — reconnect grace');
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const timers = new Queue('timers', { connection: redis, prefix: 'rd' });
async function promoteGrace(chatId) {
  const job = await waitFor(async () => (await timers.getDelayed(0, 5000)).find((j) => j.id?.startsWith(`grace-${chatId}-`)) ?? null, 8000, 'grace timer job');
  await job.promote();
  return job;
}
const chatRow = (id) => sql(`SELECT status || '|' || coalesce(close_reason, '') || '|' || (visitor_disconnected_at IS NOT NULL) FROM chats WHERE id = '${id}'`);
{
  const visit = await session(siteA.public_key, 'https://a.example');
  const chat = await newChat(visit.visitor, 'I might reload the page');
  await owner.must('POST', `/chats/${chat}/accept`, {});
  let vs = await visitorSocket(visit.visitor, chat);
  vs.disconnect();
  await waitFor(async () => chatRow(chat).endsWith('|true'), 8000, 'disconnect recorded');
  ok(chatRow(chat) === 'active||true', 'when the visitor drops, the chat stays active and the disconnect is recorded');
  vs = await visitorSocket(visit.visitor, chat);
  await waitFor(async () => chatRow(chat).endsWith('|false'), 8000, 'reconnect recorded');
  await promoteGrace(chat);
  await sleep(1500);
  ok(chatRow(chat) === 'active||false', 'back within the grace window: the timer fires and the chat stays open');
  vs.disconnect();
  await waitFor(async () => chatRow(chat).endsWith('|true'), 8000, 'second disconnect');
  sql(`UPDATE chats SET visitor_disconnected_at = now() - interval '2 hours' WHERE id = '${chat}'`);
  await promoteGrace(chat);
  const closed = await waitFor(async () => (chatRow(chat).startsWith('closed') ? chatRow(chat) : null), 10000, 'grace close');
  ok(closed.startsWith('closed|visitor_disconnected'), `the visitor never came back: closed as visitor_disconnected (${closed})`);
}
await timers.close();
await redis.quit();

// ───────────────────────── AUD-71-14 ─────────────────────────
// Liveness is transport-based: the gateway refreshes every connected socket's presence itself, so an agent stays
// eligible while the connection is alive. Heartbeat loss is a connection that goes silent (network gone, no FIN):
// Dan's socket runs through a TCP proxy that is frozen; socket.io's ping/pong times out (15 s interval + 30 s
// timeout), the server drops the connection and Dan stops counting — then a fresh connection brings Dan back.
console.log('AUD-71-14 — a silent connection (heartbeat loss) drops the agent out of the roster and routing');
{
  const apiUrl = new URL(API);
  let frozen = false;
  const proxy = createServer((client) => {
    const up = connect(Number(apiUrl.port || 80), apiUrl.hostname === 'localhost' ? '127.0.0.1' : apiUrl.hostname);
    client.on('data', (d) => !frozen && up.write(d));
    up.on('data', (d) => !frozen && client.write(d));
    const close = () => {
      client.destroy();
      up.destroy();
    };
    client.on('error', close).on('close', close);
    up.on('error', close).on('close', close);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const quietDept = await owner.must('POST', '/departments', { name: `Night ${stamp}` });
  const dan = await invite('agent', 2, 'Dan', [quietDept.id]);
  const viaProxy = io(`http://127.0.0.1:${proxy.address().port}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket: (await dan.must('POST', '/socket-ticket')).ticket }, forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    viaProxy.once('auth.ok', resolve);
    viaProxy.once('connect_error', reject);
  });
  await dan.must('PUT', '/agents/me/presence', { status: 'online' });
  const rosterOf = async () => (await owner.must('GET', '/agents')).find((a) => a.id === dan.membershipId);
  ok((await rosterOf()).connected === true, 'Dan is connected and online');
  const siteN = await owner.must('POST', '/sites', { name: `Night shop ${stamp}`, origins: [{ origin: 'https://night.example', pattern_type: 'exact' }], default_department_id: quietDept.id });
  const v = await session(siteN.public_key, 'https://night.example');
  frozen = true;
  const t0 = Date.now();
  await waitFor(async () => ((await rosterOf()).connected === false ? true : null), 70_000, 'silent connection to be dropped');
  const r = await rosterOf();
  ok(r.connected === false, `the connection went silent: after ${Math.round((Date.now() - t0) / 1000)} s Dan is no longer counted as connected (${r.effective_status})`);
  const req = await v.visitor.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Anyone at night?' });
  ok(req.status === 409 && req.code === 'DEPARTMENT_UNAVAILABLE', `routing does not count a silent agent (${req.status} ${req.code})`);
  viaProxy.close();
  proxy.close();
  await agentSocket(dan);
  await waitFor(async () => ((await rosterOf()).connected === true ? true : null), 10_000, 'reconnect');
  ok(true, 'a fresh connection makes Dan eligible again');
  const again = await v.visitor.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Anyone at night?' });
  ok(again.status === 201, 'and the chat request is accepted');
}

for (const s of sockets) {
  clearInterval(s.beat);
  s.close();
}
console.log(`\nLIFECYCLE E2E PASSED (${passed} checks)`);
process.exit(0);
