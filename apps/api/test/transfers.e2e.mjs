// Transfers (CHAT04, AUD-71-18) — end-to-end against a running api + worker (node test/transfers.e2e.mjs).
// Real HTTP, sockets, PostgreSQL, Redis.
//   * a transfer offer that is declined or expires (30 s) keeps the original owner; accept moves ownership
//   * transfer (offer or forced) to a full agent fails atomically — reservations count toward "full"
//   * a forced transfer needs a supervisor and a reason, applies at once and is audited
//   * a department transfer requeues the chat (owner released, pending offers withdrawn)
//   * close racing a transfer offer / transfer accept / forced transfer / department transfer always ends in
//     one consistent terminal state
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const OFFER_TTL_MS = 30_000; // features/chats/routing.service.ts (transfer offers share the TTL)
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
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
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
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookieHeader(), ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}), ...extra },
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
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) =>
  sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const command = (s, type, payload) => s.emitWithAck('command', { v: 1, command_id: randomUUID(), type, payload });
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const frameOf = (s, type, pred = () => true) => s.frames.find((f) => f.type === type && pred(f.payload));

const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:widget-session:*');
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `xfer-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Transfers ${stamp}`, timezone: 'UTC' });
const T = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
await owner.must('PUT', '/agents/me/presence', { status: 'away' });
const site = await owner.must('POST', '/sites', { name: 'Transfer store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const billing = await owner.must('POST', '/departments', { name: 'Billing', public_label: 'Billing', max_wait_seconds: 0 });
await owner.must('PATCH', `/departments/${support.id}`, { max_wait_seconds: 0 });

async function member(name, role, deptIds, capacity) {
  const email = `xfer-${name.toLowerCase()}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', { email, role, department_ids: deptIds, capacity });
  const c = new Client(name);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'), display_name: name, password: 'agent passphrase long' });
  const me = await c.must('GET', '/agents/me');
  const sock = await socket('/agent', (await c.must('POST', '/socket-ticket')).ticket);
  await c.must('PUT', '/agents/me/presence', { status: 'online' });
  return { name, c, id: me.agent.id, userId: sql(`SELECT id FROM users WHERE email = '${email}'`), sock };
}
const A = await member('Ana', 'agent', [support.id], 8);
const B = await member('Ben', 'agent', [support.id, billing.id], 4);
const C = await member('Cat', 'agent', [support.id], 1);
const S = await member('Sam', 'supervisor', [support.id], 3);
ok(support.routing_mode === 'broadcast', 'Support is broadcast (agents pick chats up); agents Ana (8), Ben (4), Cat (1) and supervisor Sam are online');

async function newVisitor() {
  const v = new Client('visitor');
  const s = await v.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
  v.auth = { authorization: `Bearer ${s.capability}` };
  return v;
}
/** A fresh visitor chat in Support, picked up by `agent`. */
async function chatOwnedBy(agent, label = 'help') {
  const v = await newVisitor();
  const id = (await v.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Hello, I need ${label}`, department_id: support.id }, v.auth)).chat.id;
  await agent.c.must('POST', `/chats/${id}/accept`, {});
  return { id, v };
}
const owner_ = (id) => sql(`SELECT status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${id}'`);
const transfer = (who, chatId, body) => who.c.call('POST', `/chats/${chatId}/transfers`, body);
const publicSystem = (chatId, kind) => Number(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND visibility = 'public' AND system_event->>'kind' = '${kind}'`));
const snapshot = (chatId) =>
  sql(`SELECT c.version || '|' || c.status || '|' || coalesce(c.owner_membership_id::text, '-') || '|' ||
        (SELECT count(*) FROM messages m WHERE m.chat_id = c.id) || '|' ||
        (SELECT count(*) FROM assignment_offers o WHERE o.chat_id = c.id) || '|' ||
        (SELECT count(*) FROM assignment_history h WHERE h.chat_id = c.id) || '|' ||
        (SELECT count(*) FROM audit_events a WHERE a.tenant_id = c.tenant_id AND a.object_id = c.id::text) || '|' ||
        (SELECT count(*) FROM chat_participants p WHERE p.chat_id = c.id AND p.left_at IS NULL)
      FROM chats c WHERE c.id = '${chatId}'`);

// ═══════════════════════════ Decline keeps the owner ═══════════════════════════
console.log('Declined transfer keeps the original owner (CHAT04, AUD-71-18)');
const chat1 = await chatOwnedBy(A, 'a refund');
ok(owner_(chat1.id) === `active|${A.id}`, 'chat1 is active and owned by Ana');
const t1 = await transfer(A, chat1.id, { target_agent_id: B.id, note: 'Refund question, can you take it?' });
ok(t1.status === 201 && t1.data.offer.mode === 'transfer' && t1.data.offer.target_membership_id === B.id && t1.data.offer.from_membership_id === A.id, 'Ana offers chat1 to Ben → 201 transfer offer');
const ttl = Number(sql(`SELECT round(extract(epoch FROM expires_at - created_at) * 1000) FROM assignment_offers WHERE id = '${t1.data.offer.id}'`));
ok(Math.abs(ttl - OFFER_TTL_MS) <= 5, `transfer offer lives 30 s (${ttl} ms)`);
ok(owner_(chat1.id) === `active|${A.id}`, 'while the offer is pending Ana still owns chat1');
await waitFor(() => frameOf(B.sock, 'assignment.offered', (p) => p.offer.id === t1.data.offer.id), 5000, 'Ben offered');
ok(frameOf(B.sock, 'assignment.offered', (p) => p.offer.id === t1.data.offer.id).payload.offer.note === 'Refund question, can you take it?', 'Ben receives assignment.offered (mode transfer) with the handoff note');
const dup = await transfer(A, chat1.id, { target_agent_id: C.id });
ok(dup.status === 409, 'a second transfer while one is pending → 409');
ok((await A.c.call('POST', `/chats/${chat1.id}/messages`, { client_message_id: `a-${stamp}-1`, body: 'Still with you while I find a colleague.' })).status === 201, 'Ana keeps replying while the offer is pending');
const benEarly = await B.c.call('POST', `/chats/${chat1.id}/messages`, { client_message_id: `b-${stamp}-1`, body: 'Hi from Ben' });
ok(benEarly.status === 403, 'Ben cannot reply before accepting (403)');
ok((await B.c.call('POST', `/offers/${t1.data.offer.id}/decline`, { reason: 'Not my area' })).status === 200, 'Ben declines');
ok(sql(`SELECT status || '|' || decision_reason FROM assignment_offers WHERE id = '${t1.data.offer.id}'`) === 'declined|Not my area', 'offer is declined with the reason');
ok(owner_(chat1.id) === `active|${A.id}`, 'after the decline Ana still owns chat1');
const declinedFrame = await waitFor(() => frameOf(A.sock, 'transfer.declined', (p) => p.offer_id === t1.data.offer.id), 5000, 'transfer.declined');
ok(declinedFrame.payload.chat_id === chat1.id, 'Ana is told (transfer.declined)');
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat1.id}' AND membership_id = '${B.id}'`) === '0' && publicSystem(chat1.id, 'chat.transferred') === 0, 'Ben never joined and the visitor saw no transfer notice');
const staleDecl = await B.c.call('POST', `/chats/${chat1.id}/accept`, { offer_id: t1.data.offer.id });
ok(staleDecl.status === 409 && staleDecl.error.code === 'OFFER_WITHDRAWN', 'Ben cannot accept the offer he declined (409 OFFER_WITHDRAWN)');

// ═══════════════════════════ Expiry keeps the owner ═══════════════════════════
console.log('Expired transfer keeps the original owner');
const t2 = await transfer(A, chat1.id, { target_agent_id: B.id });
ok(t2.status === 201, 'Ana offers chat1 to Ben again');
console.log('    … waiting for the 30 s transfer offer to expire');
const t2State = await waitFor(() => {
  const r = sql(`SELECT status || '|' || coalesce(decision_reason, '') FROM assignment_offers WHERE id = '${t2.data.offer.id}'`);
  return r.startsWith('pending') ? null : r;
}, 50_000, 'transfer expiry');
ok(t2State === 'expired|timeout', 'unanswered transfer offer → expired (timeout)');
ok(owner_(chat1.id) === `active|${A.id}`, 'after expiry Ana still owns chat1');
const expiredFrame = await waitFor(() => frameOf(A.sock, 'transfer.expired', (p) => p.offer_id === t2.data.offer.id), 5000, 'transfer.expired');
ok(expiredFrame.payload.chat_id === chat1.id, 'Ana is told (transfer.expired)');
const benWithdrawn = await waitFor(() => frameOf(B.sock, 'assignment.withdrawn', (p) => p.offer_id === t2.data.offer.id), 5000, 'Ben withdrawn');
ok(benWithdrawn.payload.reason === 'expired', 'Ben\'s offer card is withdrawn (assignment.withdrawn {reason: expired})');
const staleExp = await B.c.call('POST', `/chats/${chat1.id}/accept`, { offer_id: t2.data.offer.id });
ok(staleExp.status === 409 && staleExp.error.code === 'OFFER_EXPIRED' && owner_(chat1.id) === `active|${A.id}`, 'a late accept → 409 OFFER_EXPIRED and changes nothing');
ok(sql(`SELECT string_agg(reason, ',' ORDER BY occurred_at) FROM assignment_history WHERE chat_id = '${chat1.id}' AND reason LIKE 'transfer%'`) === 'transfer_offered,transfer_offered', 'history shows two offers and no transfer_accepted');

console.log('Accepted transfer moves ownership');
const t3 = await transfer(A, chat1.id, { target_agent_id: B.id });
const acc = await command(B.sock, 'offer.accept', { chat_id: chat1.id, offer_id: t3.data.offer.id });
ok(acc.type === 'command.ack' && owner_(chat1.id) === `active|${B.id}`, 'Ben accepts over the socket → Ben owns chat1');
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat1.id}' AND membership_id = '${A.id}' AND left_at IS NULL`) === '0' && publicSystem(chat1.id, 'chat.transferred') === 1, 'Ana left the chat; the visitor sees one "now chatting with" notice');

// ═══════════════════════════ Full agent ═══════════════════════════
console.log('Transfer to a full agent fails atomically');
const chat2 = await chatOwnedBy(C, 'shipping');
const chat3 = await chatOwnedBy(A, 'an invoice');
ok(owner_(chat2.id) === `active|${C.id}`, 'Cat (capacity 1) is full with chat2');
const before3 = snapshot(chat3.id);
const toFull = await transfer(A, chat3.id, { target_agent_id: C.id });
ok(toFull.status === 409 && toFull.error.code === 'CAPACITY_EXCEEDED', 'transfer offer to the full agent → 409 CAPACITY_EXCEEDED');
const forceFull = await transfer(S, chat3.id, { target_agent_id: C.id, force: true, reason: 'Cat knows this customer' });
ok(forceFull.status === 409 && forceFull.error.code === 'CAPACITY_EXCEEDED', 'forced transfer to the full agent → 409 CAPACITY_EXCEEDED');
ok(snapshot(chat3.id) === before3, `chat3 unchanged (version, owner, messages, offers, history, audit, participants: ${before3})`);
const fill = await transfer(A, chat3.id, { target_agent_id: B.id });
ok(fill.status === 201, 'Ben (1 of 4 active) gets a transfer offer for chat3 …');
const chat4 = await chatOwnedBy(A, 'a password reset');
const chat4b = await chatOwnedBy(A, 'a delivery date');
ok((await transfer(A, chat4.id, { target_agent_id: B.id })).status === 201, '… and one for chat4 (Ben: 1 active + 2 reserved)');
const before4b = snapshot(chat4b.id);
await B.c.must('PUT', '/agents/me/presence', { status: 'online' });
await owner.must('PATCH', `/agents/${B.id}`, { capacity: 3 });
const resFull = await transfer(A, chat4b.id, { target_agent_id: B.id });
ok(resFull.status === 409 && resFull.error.code === 'CAPACITY_EXCEEDED' && snapshot(chat4b.id) === before4b, 'with capacity 3 and 1 active + 2 reservations Ben counts as full: the next transfer → 409, nothing written');
await owner.must('PATCH', `/agents/${B.id}`, { capacity: 4 });
await B.c.must('POST', `/offers/${fill.data.offer.id}/decline`, {});
const p4 = sql(`SELECT id FROM assignment_offers WHERE chat_id = '${chat4.id}' AND status = 'pending'`);
await B.c.must('POST', `/offers/${p4}/decline`, {});

// ═══════════════════════════ Forced transfer ═══════════════════════════
console.log('Forced transfer needs a supervisor and a reason, and is audited');
const noReason = await transfer(S, chat3.id, { target_agent_id: B.id, force: true });
ok(noReason.status === 422 && noReason.error.code === 'VALIDATION_FAILED', 'forced transfer without a reason → 422');
const blank = await transfer(S, chat3.id, { target_agent_id: B.id, force: true, reason: '   ' });
ok(blank.status === 422, 'forced transfer with a blank reason → 422');
const byAgent = await transfer(A, chat3.id, { target_agent_id: B.id, force: true, reason: 'I want to' });
ok(byAgent.status === 403 && byAgent.error.code === 'PERMISSION_DENIED', 'the owning agent cannot force (403)');
ok(owner_(chat3.id) === `active|${A.id}`, 'refused forced transfers changed nothing');
const forced = await transfer(S, chat3.id, { target_agent_id: B.id, force: true, reason: 'Customer asked for Ben' });
ok(forced.status === 201 && !forced.data.offer && owner_(chat3.id) === `active|${B.id}`, 'supervisor force → 201, Ben owns chat3 immediately (no offer)');
const aud = sql(`SELECT actor_id || '|' || (safe_diff->>'from') || '|' || (safe_diff->>'to') || '|' || (safe_diff->>'reason') FROM audit_events WHERE tenant_id = '${T}' AND action = 'chat.force_transferred' AND object_id = '${chat3.id}'`);
ok(aud === `${S.userId}|${A.id}|${B.id}|Customer asked for Ben`, 'audit chat.force_transferred {actor: Sam, from: Ana, to: Ben, reason}');
ok(sql(`SELECT decision->>'reason' FROM assignment_history WHERE chat_id = '${chat3.id}' AND reason = 'forced_transfer'`) === 'Customer asked for Ben', 'assignment history records forced_transfer with the reason');
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat3.id}' AND left_at IS NULL AND role = 'primary'`) === '1' && sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat3.id}' AND membership_id = '${A.id}' AND left_at IS NULL`) === '0', 'exactly one primary (Ben); Ana left');
await waitFor(() => frameOf(A.sock, 'chat.transferred', (p) => p.chat_id === chat3.id), 5000, 'Ana informed');
ok(frameOf(A.sock, 'chat.transferred', (p) => p.chat_id === chat3.id).payload.forced === true, 'Ana\'s socket receives chat.transferred {forced: true}');

console.log('Forced transfer while a transfer offer is pending');
const chat5 = await chatOwnedBy(A, 'a warranty claim');
const pend5 = await transfer(A, chat5.id, { target_agent_id: S.id });
ok(pend5.status === 201, 'Ana offers chat5 to Sam (pending)');
const forced5 = await transfer({ c: owner }, chat5.id, { target_agent_id: B.id, force: true, reason: 'Escalation' });
ok(forced5.status === 201 && owner_(chat5.id) === `active|${B.id}`, 'owner forces chat5 to Ben');
const live5 = sql(`SELECT status FROM assignment_offers WHERE id = '${pend5.data.offer.id}'`);
ok(live5 !== 'pending', `the forced transfer withdraws the superseded pending offer (offer is '${live5}')`);
const stale5 = await S.c.call('POST', `/chats/${chat5.id}/accept`, { offer_id: pend5.data.offer.id });
ok(stale5.status === 409 && owner_(chat5.id) === `active|${B.id}`, `Sam's accept of the superseded offer is refused and the forced owner stays (got ${stale5.status}; owner ${owner_(chat5.id).split('|')[1] === B.id ? 'Ben' : owner_(chat5.id).split('|')[1] === S.id ? 'Sam' : owner_(chat5.id)})`);
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat5.id}' AND left_at IS NULL AND role = 'primary'`) === '1', 'chat5 still has exactly one primary participant');

// ═══════════════════════════ Department transfer ═══════════════════════════
console.log('Department transfer requeues the chat');
const chat6 = await chatOwnedBy(A, 'billing help');
const pend6 = await transfer(A, chat6.id, { target_agent_id: S.id });
ok(pend6.status === 201, 'a transfer offer to Sam is pending on chat6');
const dept = await transfer(A, chat6.id, { target_department_id: billing.id, note: 'Needs billing' });
ok(dept.status === 201 && dept.data.chat.status === 'queued', 'Ana transfers chat6 to Billing → 201, chat queued');
ok(sql(`SELECT status || '|' || coalesce(owner_membership_id::text, '-') || '|' || department_id FROM chats WHERE id = '${chat6.id}'`) === `queued|-|${billing.id}`, 'owner released, department Billing, status queued');
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chat6.id}' AND membership_id = '${A.id}' AND left_at IS NULL`) === '0', 'Ana left the chat');
ok(sql(`SELECT status || '|' || decision_reason FROM assignment_offers WHERE id = '${pend6.data.offer.id}'`) === 'withdrawn|department_transfer', 'the pending agent offer is withdrawn (department_transfer)');
await sleep(800);
ok(!!frameOf(S.sock, 'assignment.withdrawn', (p) => p.offer_id === pend6.data.offer.id), 'Sam is told his pending offer was withdrawn by the department transfer (assignment.withdrawn)');
ok(sql(`SELECT (previous_owner_id::text = '${A.id}')::text || '|' || next_department_id FROM assignment_history WHERE chat_id = '${chat6.id}' AND reason = 'department_transfer'`) === `true|${billing.id}`, 'history: department_transfer from Ana to Billing');
ok(publicSystem(chat6.id, 'chat.transferred') === 1 && sql(`SELECT body FROM messages WHERE chat_id = '${chat6.id}' AND system_event->>'kind' = 'chat.transferred'`) === "You're being transferred to Billing", 'the visitor sees "You\'re being transferred to Billing"');
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chat6.id}' AND visibility = 'internal' AND body LIKE 'Handoff note:%'`) === '1', 'the handoff note is an internal note');
ok((await B.c.must('GET', '/chats/queue')).some((c) => c.id === chat6.id), 'chat6 is in the Billing queue for Ben');
ok((await A.c.call('POST', `/chats/${chat6.id}/accept`, {})).status === 403, 'Ana (not in Billing) cannot pick it up');
await B.c.must('POST', `/chats/${chat6.id}/accept`, {});
ok(owner_(chat6.id) === `active|${B.id}`, 'Ben (Billing) picks it up');

// ═══════════════════════════ Close racing transfers ═══════════════════════════
console.log('Concurrent close and transfer end in one consistent terminal state');
await owner.must('PATCH', `/agents/${B.id}`, { capacity: 20 });
async function terminalInvariants(chatId, label) {
  const [status, closedAt, ownerId] = sql(`SELECT status, closed_at IS NOT NULL, coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${chatId}'`).split('|');
  const pending = sql(`SELECT count(*) FROM assignment_offers WHERE chat_id = '${chatId}' AND status = 'pending'`);
  const liveParts = sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chatId}' AND left_at IS NULL`);
  const primaries = sql(`SELECT coalesce(string_agg(membership_id::text, ','), '') FROM chat_participants WHERE chat_id = '${chatId}' AND left_at IS NULL AND role = 'primary'`);
  const closedEvents = sql(`SELECT count(DISTINCT event_id) FROM outbox_events WHERE aggregate_id = '${chatId}' AND event_type = 'chat.closed'`);
  const closedMsgs = sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND system_event->>'kind' = 'chat.closed'`);
  if (status === 'closed') {
    ok(closedAt === 't' && pending === '0' && liveParts === '0' && closedEvents === '1' && closedMsgs === '1', `${label}: closed once — no pending offer, no live participant, one chat.closed event and notice`);
  } else if (status === 'active') {
    ok(pending === '0' && primaries === ownerId && closedEvents === '0', `${label}: active with exactly one primary = owner, no stray offer`);
  } else {
    ok(status === 'queued' && ownerId === '-' && closedEvents === '0', `${label}: queued without owner`);
  }
  return status;
}
const outcomes = { offer: [], accept: [], force: [], department: [] };
for (let i = 0; i < 3; i++) {
  // close ‖ transfer offer
  let ch = await chatOwnedBy(A, `race offer ${i}`);
  let [cl, tr] = await Promise.all([A.c.call('POST', `/chats/${ch.id}/close`, { reason: 'resolved' }), transfer(A, ch.id, { target_agent_id: B.id })]);
  ok(cl.status === 200 && (tr.status === 201 || (tr.status === 409 && tr.error.code === 'CHAT_CLOSED')), `race ${i} close‖offer: close 200, transfer ${tr.status}${tr.error ? ` ${tr.error.code}` : ''}`);
  if (tr.status === 201) ok(sql(`SELECT status || '|' || decision_reason FROM assignment_offers WHERE id = '${tr.data.offer.id}'`) === 'withdrawn|chat_closed', `race ${i}: the offer created first was withdrawn by the close`);
  outcomes.offer.push(await terminalInvariants(ch.id, `race ${i} close‖offer`));
  if (tr.status === 201) {
    const late = await B.c.call('POST', `/chats/${ch.id}/accept`, { offer_id: tr.data.offer.id });
    ok(late.status === 409 && late.error.code === 'CHAT_CLOSED', `race ${i}: accepting the withdrawn offer of a closed chat → 409 CHAT_CLOSED`);
  }

  // close ‖ transfer accept
  ch = await chatOwnedBy(A, `race accept ${i}`);
  const off = (await transfer(A, ch.id, { target_agent_id: B.id })).data.offer;
  const [cl2, ac2] = await Promise.all([A.c.call('POST', `/chats/${ch.id}/close`, { reason: 'resolved' }), B.c.call('POST', `/chats/${ch.id}/accept`, { offer_id: off.id })]);
  const acceptWon = ac2.status === 200;
  ok(acceptWon ? cl2.status === 403 && owner_(ch.id) === `active|${B.id}` : cl2.status === 200 && ac2.status === 409 && ac2.error.code === 'CHAT_CLOSED', `race ${i} close‖accept: ${acceptWon ? 'accept won (Ben owns, Ana\'s close refused 403)' : 'close won (accept → 409 CHAT_CLOSED)'}`);
  outcomes.accept.push(await terminalInvariants(ch.id, `race ${i} close‖accept`));
  if (acceptWon) await B.c.must('POST', `/chats/${ch.id}/close`, { reason: 'resolved' });

  // close ‖ forced transfer
  ch = await chatOwnedBy(A, `race force ${i}`);
  const [cl3, fo3] = await Promise.all([A.c.call('POST', `/chats/${ch.id}/close`, { reason: 'resolved' }), transfer(S, ch.id, { target_agent_id: B.id, force: true, reason: 'race' })]);
  const forceWon = fo3.status === 201;
  ok(forceWon ? cl3.status === 403 && owner_(ch.id) === `active|${B.id}` : cl3.status === 200 && fo3.status === 409 && fo3.error.code === 'CHAT_CLOSED', `race ${i} close‖force: ${forceWon ? 'force won (Ben owns, Ana\'s close refused 403)' : 'close won (force → 409 CHAT_CLOSED)'}`);
  if (!forceWon) ok(sql(`SELECT count(*) FROM audit_events WHERE action = 'chat.force_transferred' AND object_id = '${ch.id}'`) === '0', `race ${i}: no forced-transfer audit row for a refused force`);
  outcomes.force.push(await terminalInvariants(ch.id, `race ${i} close‖force`));
  if (forceWon) await B.c.must('POST', `/chats/${ch.id}/close`, { reason: 'resolved' });

  // close ‖ department transfer
  ch = await chatOwnedBy(A, `race dept ${i}`);
  const [cl4, de4] = await Promise.all([A.c.call('POST', `/chats/${ch.id}/close`, { reason: 'resolved' }), transfer(A, ch.id, { target_department_id: billing.id })]);
  ok(cl4.status === 200 && (de4.status === 201 || (de4.status === 409 && de4.error.code === 'CHAT_CLOSED')), `race ${i} close‖department: close 200, department transfer ${de4.status}`);
  outcomes.department.push(await terminalInvariants(ch.id, `race ${i} close‖department`));
  ok(outcomes.department[i] === 'closed', `race ${i} close‖department: the chat ends closed either way`);
}
console.log(`    race outcomes: ${JSON.stringify(outcomes)}`);
ok(sql(`SELECT count(*) FROM chats c WHERE c.tenant_id = '${T}' AND c.status = 'closed' AND EXISTS (SELECT 1 FROM assignment_offers o WHERE o.chat_id = c.id AND o.status = 'pending')`) === '0', 'no closed chat in the tenant keeps a pending offer');
ok(sql(`SELECT count(*) FROM (SELECT chat_id FROM chat_participants WHERE tenant_id = '${T}' AND role = 'primary' AND left_at IS NULL GROUP BY chat_id HAVING count(*) > 1) x`) === '0', 'no chat in the tenant has two primary owners');

console.log('Close while a transfer offer is pending');
const chat7 = await chatOwnedBy(A, 'one last thing');
const pend7 = await transfer(A, chat7.id, { target_agent_id: S.id });
await A.c.must('POST', `/chats/${chat7.id}/close`, { reason: 'resolved' });
ok(sql(`SELECT status || '|' || decision_reason FROM assignment_offers WHERE id = '${pend7.data.offer.id}'`) === 'withdrawn|chat_closed', 'closing withdraws the pending transfer offer');
await sleep(800);
ok(!!frameOf(S.sock, 'assignment.withdrawn', (p) => p.offer_id === pend7.data.offer.id), 'Sam is told the offer for the closed chat was withdrawn (assignment.withdrawn)');
const late7 = await S.c.call('POST', `/chats/${chat7.id}/accept`, { offer_id: pend7.data.offer.id });
ok(late7.status === 409 && late7.error.code === 'CHAT_CLOSED', 'Sam\'s accept after the close → 409 CHAT_CLOSED');

for (const m of [A, B, C, S]) m.sock.disconnect();
console.log(`\nTRANSFERS E2E PASSED (${passed} checks)`);
if (knownFails.length) {
  console.log(`KNOWN FAILS (${knownFails.length}):`);
  for (const k of knownFails) console.log(`  - ${k}`);
}
process.exit(0);
