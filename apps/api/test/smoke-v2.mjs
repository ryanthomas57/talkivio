// Talkivio v2 end-to-end smoke test against running api + worker (node test/smoke-v2.mjs).
// Real HTTP, real sockets, real database — no mocks.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') || path.startsWith('/health') ? '' : '/api/v1'}${path}`, {
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
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

function latestEmail(to, template) {
  const sql = `SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`;
  return execFileSync('psql', [OWNER_DB, '-At', '-c', sql]).toString();
}
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true });
  s.frames = [];
  s.ephemeral = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('ephemeral', (f) => s.ephemeral.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const waitFor = async (pred, ms = 4000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const stamp = Date.now();
const owner = new Client('owner');
const ownerEmail = `owner+${stamp}@example.com`;

console.log('Gate 1 — identity & tenancy');
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Alpha ${stamp}`, timezone: 'Europe/London' });
ok(signup.verification_required === true && signup.me.active_tenant_id, 'signup created tenant, owner membership and active context');
ok(!!owner.cookies.rd_session && !!owner.cookies.rd_csrf, 'session + CSRF cookies issued');
const noCsrf = await fetch(`${API}/api/v1/tenants/current`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: owner.cookieHeader() }, body: '{}' });
ok(noCsrf.status === 403, 'mutation without CSRF token rejected');
const invBlocked = await owner.call('POST', '/agents/invitations', { email: `agent+${stamp}@example.com`, role: 'agent' });
ok(invBlocked.status === 403 && invBlocked.error.code === 'EMAIL_NOT_VERIFIED', 'inviting requires a verified email');
const verifyText = latestEmail(ownerEmail, 'verify_email');
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(verifyText, 'token') });
const replay = await owner.call('POST', '/auth/verify-email', { token: tokenFrom(verifyText, 'token') });
ok(replay.status === 422 && replay.error.code === 'TOKEN_USED', 'verification token is single-use');
const weak = await owner.call('POST', '/auth/signup', { email: `weak+${stamp}@example.com`, password: 'short', tenant_name: 'X' });
ok(weak.status === 422 && weak.error.field_errors?.password, 'password policy enforced with field errors (snake_case envelope)');

const depts = await owner.must('GET', '/departments');
const support = depts.find((d) => d.name === 'Support');
ok(support, 'default Support department exists');
const site = await owner.must('POST', '/sites', { name: 'Demo store', origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }] });
ok(site.public_key.startsWith('rds_') && site.origins.length === 1, 'site created with public key and allowed origin');
const badOrigin = await owner.call('POST', '/sites', { name: 'Bad', origins: [{ origin: 'http://example.com', pattern_type: 'exact' }] });
ok(badOrigin.status === 422, 'plain-http non-local origin rejected');

const agentEmail = `agent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 2 });
const inviteText = latestEmail(agentEmail, 'agent_invitation');
const agentB = new Client('agentB');
const accepted = await agentB.must('POST', '/agents/invitations/accept', { token: tokenFrom(inviteText, 'invite'), display_name: 'Bea Agent', password: 'another strong passphrase' });
ok(accepted.active_tenant_id === signup.me.active_tenant_id, 'invited agent joined the tenant with active context');

console.log('Gate 2 — realtime chat vertical slice');
const ownerTicket = await owner.must('POST', '/socket-ticket');
const reused = ownerTicket.ticket;
const ownerSock = await socket('/agent', ownerTicket.ticket);
ok(true, 'owner agent socket authenticated with single-use ticket');
const reuseErr = await socket('/agent', reused).then(() => null, (e) => e);
ok(reuseErr && /AUTH_REQUIRED/.test(reuseErr.message), 'reusing a socket ticket is rejected');
const bSock = await socket('/agent', (await agentB.must('POST', '/socket-ticket')).ticket);
for (const s of [ownerSock, bSock]) {
  const sub = await s.emitWithAck('subscribe', { scopes: [{ kind: 'queue', id: 'none' }, { kind: 'queue', id: support.id }] });
  ok(sub.type === 'subscription.ok' && sub.snapshot_cursor, 'agent subscribed to queue scopes');
}
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
await agentB.must('PUT', '/agents/me/presence', { status: 'online' });

const boot = await fetch(`${API}/widget/v1/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_key: site.public_key, host_origin: 'http://localhost:5173' }) }).then((r) => r.json());
ok(boot.data.availability.state === 'available', `widget bootstrap: availability=${boot.data.availability.state}`);
const evil = await fetch(`${API}/widget/v1/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_key: site.public_key, host_origin: 'https://evil.example' }) }).then((r) => r.json());
ok(evil.error?.code === 'ORIGIN_NOT_ALLOWED' && !evil.data, 'unapproved origin receives no configuration');
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', {
  site_key: site.public_key,
  host_origin: 'http://localhost:5173',
  consent: { analytics: true, policy_version: '2026-10' },
  page: { url: 'http://localhost:5173/pricing?utm_source=x#top', title: 'Pricing', referrer: 'https://www.google.com/search?q=chat' },
});
ok(sess.capability.startsWith('rdv1.') && sess.anonymous_token.startsWith('rdvc_'), 'visitor session + capability + anonymous credential issued');
const vauth = { authorization: `Bearer ${sess.capability}` };
const vt = await visitor.must('POST', '/widget/v1/socket-ticket', undefined, vauth);
const vSock = await socket('/visitor', vt.ticket);
ok(true, 'visitor socket authenticated');

const req = randomUUID();
const created = await visitor.call('POST', '/widget/v1/chats', { client_request_id: req, message: 'Hi! Can you help with a refund? 4242 4242 4242 4242' }, vauth);
ok(created.status === 201 && created.data.initial_message.seq === 1, 'admission created chat + initial message seq 1 (201)');
ok(created.data.initial_message.body.includes('424242******4242'), 'card number redacted (first 6 / last 4)');
const chatId = created.data.chat.id;
const again = await visitor.call('POST', '/widget/v1/chats', { client_request_id: req, message: 'Hi! Can you help with a refund? 4242 4242 4242 4242' }, vauth);
ok(again.status === 201 && again.data.chat.id === chatId, 'same client_request_id replays the original admission');
await vSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
await waitFor(() => ownerSock.frames.find((f) => f.type === 'chat.requested' && f.payload.chat.id === chatId), 5000, 'chat.requested on owner socket');
ok(true, 'chat.requested delivered through the outbox to the queue scope');

// Two agents accept simultaneously → one owner, one conflict.
const [a1, a2] = await Promise.all([
  owner.call('POST', `/chats/${chatId}/accept`, {}),
  agentB.call('POST', `/chats/${chatId}/accept`, {}),
]);
const winners = [a1, a2].filter((r) => r.status === 200);
const losers = [a1, a2].filter((r) => r.status === 409);
ok(winners.length === 1 && losers.length === 1 && losers[0].error.code === 'CHAT_ALREADY_ASSIGNED', 'simultaneous accept → exactly one owner and one 409');
const ownerWon = a1.status === 200;
const winner = ownerWon ? owner : agentB;
const winnerSock = ownerWon ? ownerSock : bSock;
await winnerSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });

const cm = randomUUID();
const ack = await winnerSock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'message.send', payload: { chat_id: chatId, client_message_id: cm, body: 'I can help.\nWhat is your order number?' } });
ok(ack.type === 'command.ack' && ack.result.seq >= 2, `socket message.send acknowledged with seq ${ack.result.seq}`);
const ack2 = await winnerSock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'message.send', payload: { chat_id: chatId, client_message_id: cm, body: 'I can help.\nWhat is your order number?' } });
ok(ack2.result.id === ack.result.id, 'retry with same client_message_id returns the same message');
await waitFor(() => vSock.frames.find((f) => f.type === 'message.created' && f.payload.message.id === ack.result.id), 4000, 'agent reply on visitor socket');
ok(true, 'visitor received the agent reply');

const note = await winner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), visibility: 'internal', body: 'VIP — handle gently' });
await sleep(600);
ok(!vSock.frames.some((f) => JSON.stringify(f).includes('VIP — handle gently')), 'internal note never reaches the visitor socket');
const publicPage = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?limit=100`, undefined, vauth);
ok(!publicPage.items.some((m) => m.id === note.id) && publicPage.through_seq >= note.seq, 'visitor history skips the note seq without leaking it (through_seq covers gap)');

const vmsg = await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'Order #1001 — مرحبا 👋' }, vauth);
ok(vmsg.seq > note.seq, 'visitor message ordered after note (Unicode preserved)');
const staffPage = await winner.must('GET', `/chats/${chatId}/messages?limit=100`);
const seqs = staffPage.items.map((m) => m.seq);
ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]) && staffPage.items.some((m) => m.id === note.id), 'staff transcript ordered by seq and includes the note');
await winner.must('PUT', `/chats/${chatId}/read-cursor`, { last_read_seq: vmsg.seq });
const beyond = await winner.call('PUT', `/chats/${chatId}/read-cursor`, { last_read_seq: vmsg.seq + 100 });
ok(beyond.status === 422, 'read cursor beyond last seq rejected');

const close1 = winner.call('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
const close2 = winner.call('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
const [c1, c2] = await Promise.all([close1, close2]);
ok(c1.status === 200 && c2.status === 200 && c1.data.status === 'closed', 'double close → one terminal transition, idempotent acks');
const afterClose = await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'still there?' }, vauth);
ok(afterClose.status === 409 && afterClose.error.code === 'CHAT_CLOSED', 'sending to a closed chat → CHAT_CLOSED');
const r1 = await visitor.must('PUT', `/widget/v1/chats/${chatId}/rating`, { rating: 'bad' }, vauth);
const r2 = await visitor.must('PUT', `/widget/v1/chats/${chatId}/rating`, { rating: 'good', comment: 'Great help' }, vauth);
ok(r1.rating === 'bad' && r2.rating === 'good' && r2.revision_count === 1, 'rating can be changed; one current record');

const hist = await winner.must('GET', `/chats/history?q=refund`);
const hit = hist.find((c) => c.id === chatId);
ok(hit && hit.snippet, 'history full-text search finds the chat with a snippet');
ok(!/[\u0002\u0003«»]/.test(hit.snippet) && hit.snippet_highlights.some(([s, e]) => Array.from(hit.snippet).slice(s, e).join('').toLowerCase() === 'refund'), 'snippet is plain text with code-point highlight offsets for the match');

console.log('Tenant isolation');
const beta = new Client('beta');
await beta.must('POST', '/auth/signup', { email: `beta+${stamp}@example.com`, password: 'yet another passphrase', tenant_name: `Beta ${stamp}` });
const peek = await beta.call('GET', `/chats/${chatId}`);
ok(peek.status === 404, 'other tenant gets 404 for a guessed chat id');
const peekMsgs = await beta.call('GET', `/chats/${chatId}/messages`);
ok(peekMsgs.status === 404, 'other tenant cannot read messages');
const betaHist = await beta.must('GET', '/chats/history?q=refund');
ok(betaHist.length === 0, 'search returns nothing across tenants');
const betaSock = await socket('/agent', (await beta.must('POST', '/socket-ticket')).ticket);
const subOther = await betaSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
ok(subOther.granted === 0 && subOther.denied.length === 1, 'socket subscription to another tenant chat is denied');

for (const s of [ownerSock, bSock, vSock, betaSock]) s.close();
console.log(`\nSMOKE V2 PASSED (${passed} checks)`);
process.exit(0);
