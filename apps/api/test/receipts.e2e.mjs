// Receipts, typing, sequence gaps and replay cursors (AUD-71-21, WS03) — end-to-end against a running api + worker
// (node test/receipts.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis.
//   * delivered (message.delivered command → ephemeral receipt) and read (read cursor → durable message.read)
//     are separate, monotonic and visible as different frames; unread counts follow read, not delivery
//   * typing frames carry expires_at (6 s), are never persisted, coalesce, and note-mode typing never reaches
//     the visitor socket
//   * public → internal note → public gets consecutive seqs; the visitor sees only the public ones and the
//     REST page's through_seq covers the hidden seq (no leak, no endless gap fetch)
//   * subscribing with a very old / expired last_cursor → snapshot.required; snapshot + resubscribe from the
//     snapshot cursor while messages keep arriving loses nothing and dedupes cleanly
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
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
  s.ephemeral = [];
  s.on('event', (f) => s.frames.push({ ...f, receivedAt: Date.now() }));
  s.on('ephemeral', (f) => s.ephemeral.push({ ...f, receivedAt: Date.now() }));
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
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const seqOfCursor = (c) => BigInt(parseInt(c.slice(3), 36)); // outbox cursor "c1.<base36 seq>"

const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:widget-session:*');
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `rcpt-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Receipts ${stamp}`, timezone: 'UTC' });
const T = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const ownerId = (await owner.must('GET', '/agents/me')).agent.id;
const site = await owner.must('POST', '/sites', { name: 'Receipts store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const agentTicket = async () => (await owner.must('POST', '/socket-ticket')).ticket;
const sockA = await socket('/agent', await agentTicket());
const sockB = await socket('/agent', await agentTicket()); // a second staff connection (e.g. a second tab)
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
const vauth = { authorization: `Bearer ${sess.capability}` };
const visitorSocket = async () => socket('/visitor', (await visitor.must('POST', '/widget/v1/socket-ticket', undefined, vauth)).ticket);
const vsock = await visitorSocket();
const chatId = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, is my parcel on the way?', department_id: support.id }, vauth)).chat.id;
await owner.must('POST', `/chats/${chatId}/accept`, {});
const vsub = await vsock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
await sockA.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
await sockB.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
ok(vsub.type === 'subscription.ok' && vsub.granted === 1, 'visitor chat accepted by the owner; visitor and two staff sockets subscribed to the chat');
const part = (who) => sql(`SELECT last_delivered_seq || '|' || last_read_seq FROM chat_participants WHERE chat_id = '${chatId}' AND left_at IS NULL AND ${who === 'agent' ? `membership_id = '${ownerId}'` : 'visitor_id IS NOT NULL'}`);
const inboxUnread = async () => (await owner.must('GET', '/chats?view=mine')).find((c) => c.id === chatId)?.unread_count;

// ═══════════════════════════ AUD-71-21: delivered vs read ═══════════════════════════
console.log('Delivered and read are distinct (AUD-71-21)');
const vm = await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: `v-${stamp}-1`, body: 'Order 4411, shipped Monday' }, vauth);
ok(vm.seq === 3, `visitor message got seq 3 (after the opening message and the join notice)`);
ok(part('agent') === '0|0' && (await inboxUnread()) === 2, 'before any receipt the agent has delivered 0 / read 0 and 2 unread visitor messages');
const del = await command(sockA, 'message.delivered', { chat_id: chatId, last_delivered_seq: vm.seq });
ok(del.type === 'command.ack' && del.result.last_delivered_seq === vm.seq, 'agent message.delivered command → ack {last_delivered_seq: 3}');
ok(part('agent') === '3|0', 'delivery cursor advanced to 3; read cursor untouched (0)');
const vDelivered = await waitFor(() => vsock.ephemeral.find((f) => f.type === 'message.delivered'), 5000, 'visitor delivered receipt');
ok(vDelivered.payload.actor_type === 'agent' && vDelivered.payload.through_seq === 3 && vDelivered.payload.participant_id === null && !!vDelivered.expires_at, 'visitor gets an ephemeral message.delivered {actor_type: agent, through_seq: 3} that does not identify the agent');
ok(!vsock.frames.some((f) => f.type === 'message.read'), 'no durable message.read is sent for a delivery');
ok((await inboxUnread()) === 2 && (await owner.must('GET', '/chats/counts')).unread_mine === 2, 'delivered messages still count as unread (inbox and counters)');
const regress = await command(sockA, 'message.delivered', { chat_id: chatId, last_delivered_seq: 1 });
const clamp = await command(sockA, 'message.delivered', { chat_id: chatId, last_delivered_seq: 999 });
await sleep(500);
ok(regress.type === 'command.ack' && clamp.type === 'command.ack' && part('agent') === '3|0', 'delivery cursor is monotonic (1 does not move it back) and clamped to the last seq (999 → 3)');
ok(vsock.ephemeral.filter((f) => f.type === 'message.delivered').length === 1, 'non-advancing delivery commands emit no further receipts');
const rd = await owner.call('PUT', `/chats/${chatId}/read-cursor`, { last_read_seq: 3 });
ok(rd.status === 200 && rd.data.last_read_seq === 3 && part('agent') === '3|3', 'agent read cursor → 3 (delivery stays ≥ read)');
const vRead = await waitFor(() => vsock.frames.find((f) => f.type === 'message.read'), 5000, 'visitor read receipt');
ok(vRead.payload.actor_type === 'agent' && vRead.payload.through_seq === 3 && !('participant_id' in vRead.payload) && !!vRead.cursor, 'visitor gets a durable message.read {actor_type: agent, through_seq: 3} with a replay cursor');
ok((await inboxUnread()) === 0 && (await owner.must('GET', '/chats/counts')).unread_mine === 0, 'read clears the unread count');
const beyond = await owner.call('PUT', `/chats/${chatId}/read-cursor`, { last_read_seq: 99 });
ok(beyond.status === 422, 'a read cursor beyond the last message → 422');
const back = await owner.call('PUT', `/chats/${chatId}/read-cursor`, { last_read_seq: 1 });
ok(back.data.last_read_seq === 3 && part('agent') === '3|3', 'a lower read cursor is ignored (monotonic)');

const am = await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: `a-${stamp}-1`, body: 'It is with the courier and arrives tomorrow.' });
const vdel = await command(vsock, 'message.delivered', { chat_id: chatId, last_delivered_seq: am.seq });
ok(vdel.type === 'command.ack' && part('visitor').startsWith(`${am.seq}|`) && part('visitor') !== `${am.seq}|${am.seq}`, 'visitor delivery cursor advances without marking anything read');
const aDelivered = await waitFor(() => sockA.ephemeral.find((f) => f.type === 'message.delivered' && f.payload.actor_type === 'visitor'), 5000, 'staff delivered receipt');
ok(aDelivered.payload.through_seq === am.seq, 'staff sees an ephemeral message.delivered {actor_type: visitor}');
await visitor.must('PUT', `/widget/v1/chats/${chatId}/read-cursor`, { last_read_seq: am.seq }, vauth);
const aRead = await waitFor(() => sockA.frames.find((f) => f.type === 'message.read' && f.payload.actor_type === 'visitor'), 5000, 'staff read receipt');
ok(aRead.payload.through_seq === am.seq && part('visitor') === `${am.seq}|${am.seq}`, 'staff sees a durable message.read {actor_type: visitor} once the visitor reads');
ok(sql(`SELECT count(*) FROM outbox_events WHERE tenant_id = '${T}' AND event_type = 'message.delivered'`) === '0' && sql(`SELECT count(DISTINCT event_id) FROM outbox_events WHERE tenant_id = '${T}' AND event_type = 'message.read'`) === '2', 'delivery receipts are ephemeral (never in the outbox); read receipts are durable events');

// ═══════════════════════════ AUD-71-21: typing ═══════════════════════════
console.log('Typing expires and note typing stays private (AUD-71-21)');
const t0 = Date.now();
const ty = await command(sockA, 'typing.set', { chat_id: chatId, is_typing: true, mode: 'reply' });
ok(ty.type === 'command.ack', 'agent typing.set (reply) acked');
const vTyping = await waitFor(() => vsock.ephemeral.find((f) => f.type === 'typing.changed' && f.payload.is_typing), 5000, 'visitor typing');
const exp = Date.parse(vTyping.expires_at);
ok(exp > t0 && exp <= t0 + 6500 && Math.abs(Date.parse(vTyping.payload.expires_at) - exp) < 200, `visitor typing.changed carries expires_at ${exp - t0} ms ahead (6 s TTL, in envelope and payload)`);
ok(vTyping.payload.actor.type === 'agent' && !('mode' in vTyping.payload) && !('id' in vTyping.payload.actor), 'the visitor copy names neither the mode nor the staff actor id');
const sTyping = await waitFor(() => sockB.ephemeral.find((f) => f.type === 'typing.changed' && f.payload.mode === 'reply'), 5000, 'staff typing');
ok(sTyping.payload.is_typing === true, 'other staff connections see reply typing too');
const co = await command(sockA, 'typing.set', { chat_id: chatId, is_typing: true, mode: 'reply' });
ok(co.type === 'command.ack' && co.result.coalesced === true, 'a repeat within 2 s is coalesced (no extra broadcast)');
ok(sql(`SELECT count(*) FROM outbox_events WHERE tenant_id = '${T}' AND event_type LIKE 'typing%'`) === '0', 'typing is never persisted');
await sleep(Math.max(0, exp - Date.now()) + 300);
const live = (frames, now) => {
  const last = [...frames].reverse().find((f) => f.type === 'typing.changed' && f.payload.actor.type === 'agent');
  return !!last && last.payload.is_typing && Date.parse(last.expires_at) > now;
};
ok(!live(vsock.ephemeral, Date.now()), 'with no refresh the indicator is expired at expires_at (no stuck typing)');
const vTypingBefore = vsock.ephemeral.filter((f) => f.type === 'typing.changed').length;
const note = await command(sockB, 'typing.set', { chat_id: chatId, is_typing: true, mode: 'note' });
ok(note.type === 'command.ack', 'note-mode typing acked');
const aNote = await waitFor(() => sockA.ephemeral.find((f) => f.type === 'typing.changed' && f.payload.mode === 'note'), 5000, 'staff note typing');
ok(aNote.payload.is_typing === true && !!aNote.expires_at, 'staff sockets see note-mode typing');
await sleep(1500);
ok(vsock.ephemeral.filter((f) => f.type === 'typing.changed').length === vTypingBefore && !vsock.ephemeral.some((f) => f.payload?.mode === 'note'), 'the visitor socket received nothing for note-mode typing');
await sleep(2100);
await command(sockA, 'typing.set', { chat_id: chatId, is_typing: false, mode: 'reply' });
const stop = await waitFor(() => vsock.ephemeral.find((f) => f.type === 'typing.changed' && f.payload.is_typing === false), 5000, 'typing stop');
ok(!!stop, 'typing stop reaches the visitor immediately');
const vt = await command(vsock, 'typing.set', { chat_id: chatId, is_typing: true });
const sVis = await waitFor(() => sockA.ephemeral.find((f) => f.type === 'typing.changed' && f.payload.actor.type === 'visitor'), 5000, 'visitor typing on staff');
ok(vt.type === 'command.ack' && Date.parse(sVis.expires_at) - Date.now() <= 6500, 'visitor typing reaches staff with expires_at');

// ═══════════════════════════ public → note → public ═══════════════════════════
console.log('Public, private note, public: consecutive seqs, no leak, gap covered');
const p1 = await command(sockA, 'message.send', { chat_id: chatId, client_message_id: `p1-${stamp}`, body: 'Public one' });
const nt = await command(sockA, 'message.send', { chat_id: chatId, client_message_id: `n1-${stamp}`, body: 'NOTE: customer sounded annoyed', visibility: 'internal' });
const n = p1.result.seq;
ok(nt.result.seq === n + 1, `public then note: seqs ${n}, ${n + 1}`);
const gap = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?after_seq=${n}`, undefined, vauth);
ok(gap.items.length === 0 && gap.through_seq === n + 1 && gap.last_seq === n + 1 && gap.has_more === false, `visitor page after ${n}: no items, through_seq ${n + 1} covers the hidden note (a client stops fetching)`);
const p2 = await command(sockA, 'message.send', { chat_id: chatId, client_message_id: `p2-${stamp}`, body: 'Public two' });
ok(p2.result.seq === n + 2, `then public: seq ${n + 2} (consecutive)`);
await waitFor(() => vsock.frames.find((f) => f.type === 'message.created' && f.payload.message.seq === n + 2), 5000, 'visitor sees p2');
const vSeqs = vsock.frames.filter((f) => f.type === 'message.created').map((f) => f.payload.message.seq);
ok(vSeqs.includes(n) && vSeqs.includes(n + 2) && !vSeqs.includes(n + 1), `visitor socket received seqs ${n} and ${n + 2}, not ${n + 1}`);
ok(!JSON.stringify(vsock.frames).includes('customer sounded annoyed') && !JSON.stringify(vsock.ephemeral).includes('customer sounded annoyed'), 'no visitor frame contains the note text');
const page = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?after_seq=${n - 1}`, undefined, vauth);
ok(JSON.stringify(page.items.map((m) => m.seq)) === JSON.stringify([n, n + 2]) && page.through_seq === n + 2 && page.last_seq === n + 2 && page.has_more === false, `visitor REST page after ${n - 1}: items [${n}, ${n + 2}], through_seq ${n + 2}`);
const step = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?after_seq=${n}&limit=1`, undefined, vauth);
ok(step.items.length === 0 && step.through_seq === n + 1 && step.has_more === true, 'limit-1 paging over the note returns no item but advances through_seq past it');
const step2 = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?after_seq=${step.through_seq}&limit=1`, undefined, vauth);
ok(step2.items.length === 1 && step2.items[0].seq === n + 2, '… so the next page continues with the following public message (no endless gap fetch)');
const latest = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages`, undefined, vauth);
ok(!latest.items.some((m) => m.visibility !== 'public' || m.seq === n + 1), 'the visitor\'s latest page never includes the note');
const staffPage = await owner.must('GET', `/chats/${chatId}/messages?after_seq=${n - 1}`);
ok(JSON.stringify(staffPage.items.map((m) => m.seq)) === JSON.stringify([n, n + 1, n + 2]) && staffPage.items[1].visibility === 'internal', 'staff page has all three seqs including the internal note');
ok(sql(`SELECT count(*) FROM outbox_events WHERE tenant_id = '${T}' AND audience = 'public' AND payload::text LIKE '%${nt.result.id}%'`) === '0', 'no public outbox row references the note');

// ═══════════════════════════ WS03: replay cursors ═══════════════════════════
console.log('Replay cursors: very old, valid, and expired by time (WS03)');
const v2 = await visitorSocket();
const old = await v2.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: 'c1.1' });
const minSeq = BigInt(sql(`SELECT min(seq) FROM outbox_events WHERE tenant_id = '${T}'`));
ok(old.type === 'snapshot.required' && typeof old.snapshot_cursor === 'string' && minSeq > 2n, `visitor subscribe with a cursor older than the tenant's retained outbox (c1.1 < min seq ${minSeq}) → snapshot.required`);
const a2 = await socket('/agent', await agentTicket());
const oldA = await a2.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: 'c1.1' });
ok(oldA.type === 'snapshot.required', 'agent subscribe with the same cursor → snapshot.required');
const edge = await a2.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: `c1.${(minSeq - 1n).toString(36)}` });
ok(edge.type === 'subscription.ok', 'a cursor just before the oldest retained event is still replayable (subscription.ok)');
const p1Frame = vsock.frames.find((f) => f.type === 'message.created' && f.payload.message.seq === n);
const v3 = await visitorSocket();
const okSub = await v3.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: p1Frame.cursor });
await sleep(300);
const replayed = v3.frames.filter((f) => f.type === 'message.created').map((f) => f.payload.message.seq);
ok(okSub.type === 'subscription.ok' && replayed.includes(n + 2) && !replayed.includes(n) && !replayed.includes(n + 1), `resubscribe from the cursor of seq ${n} replays seq ${n + 2} only (not ${n}, never the note)`);
ok(v3.frames.every((f) => seqOfCursor(f.cursor) > seqOfCursor(p1Frame.cursor)), 'every replayed frame is strictly after the given cursor');

// Retention: replay only covers 24 h. A cursor whose following events are older than that must not silently
// skip them (deterministic clock: the events after the cursor are aged by 25 h; the hourly purge has not run).
const p2Frame = vsock.frames.find((f) => f.type === 'message.created' && f.payload.message.seq === n + 2);
sql(`UPDATE outbox_events SET occurred_at = occurred_at - interval '25 hours' WHERE tenant_id = '${T}' AND seq > ${seqOfCursor(p1Frame.cursor)} AND seq <= ${seqOfCursor(p2Frame.cursor)}`);
const v4 = await visitorSocket();
const agedSub = await v4.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: p1Frame.cursor });
await sleep(300);
const agedReplay = v4.frames.filter((f) => f.type === 'message.created').map((f) => f.payload.message.seq);
ok(agedSub.type === 'snapshot.required' || agedReplay.includes(n + 2), `a cursor older than the 24 h replay window → snapshot.required instead of a silent gap (got ${agedSub.type}, replayed seqs [${agedReplay.join(',')}], seq ${n + 2} missing)`);

console.log('Snapshot barrier with messages arriving concurrently (WS03)');
clearRateLimits('rl:ws-*');
const v5 = await visitorSocket();
const N = 20;
const sender = (async () => {
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push(await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: `burst-${stamp}-${i}`, body: `Burst message ${i}` }));
    if (i % 4 === 1) await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: `burst-note-${stamp}-${i}`, body: `Burst note ${i}`, visibility: 'internal' });
    await sleep(40);
  }
  return out;
})();
await sleep(150);
const first = await v5.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: 'c1.1' });
ok(first.type === 'snapshot.required', 'mid-burst: subscribe with an expired cursor → snapshot.required (snapshot_cursor = barrier)');
await sleep(150);
const snap = await visitor.must('GET', `/widget/v1/chats/${chatId}/messages?limit=100`, undefined, vauth);
await sleep(150);
const resub = await v5.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: first.snapshot_cursor });
ok(resub.type === 'subscription.ok', 'resubscribe from the snapshot cursor → subscription.ok (replay of everything after the barrier)');
const sentMsgs = await sender;
await sleep(1500);
const merged = new Map();
const variants = new Map();
for (const m of snap.items) merged.set(m.id, m);
for (const f of v5.frames.filter((x) => x.type === 'message.created')) {
  const m = f.payload.message;
  const key = JSON.stringify([m.seq, m.body, m.visibility]);
  variants.set(m.id, new Set([...(variants.get(m.id) ?? []), key]));
  merged.set(m.id, m);
}
const expected = sql(`SELECT seq FROM messages WHERE chat_id = '${chatId}' AND visibility = 'public' AND (type <> 'system' OR system_event->>'kind' IN ('chat.agent_joined','chat.agent_left','chat.transferred','chat.closed','chat.rating_requested','chat.queued')) ORDER BY seq`).split('\n').map(Number);
const got = [...merged.values()].map((m) => m.seq).sort((x, y) => x - y);
const fromSnap = new Set(snap.items.map((m) => m.seq));
const missing = expected.filter((s) => !got.includes(s));
ok(sentMsgs.length === N && missing.length === 0 && got.length === expected.length, `snapshot ∪ replay ∪ live = every visitor-visible message (${expected.length} seqs; ${fromSnap.size} from the snapshot, the rest from frames; missing [${missing.join(',')}])`);
ok([...variants.values()].every((s) => s.size === 1) && new Set(got).size === got.length, 'messages delivered both in the snapshot/replay and live are identical (same id → same seq/body), so dedupe by id leaves no visible duplicate');
ok(![...merged.values()].some((m) => m.visibility !== 'public' || /Burst note/.test(m.body ?? '')), 'no internal burst note appears in the merged visitor view');

for (const s of [sockA, sockB, a2, vsock, v2, v3, v4, v5]) s.disconnect();
console.log(`\nRECEIPTS E2E PASSED (${passed} checks)`);
if (knownFails.length) {
  console.log(`KNOWN FAILS (${knownFails.length}):`);
  for (const k of knownFails) console.log(`  - ${k}`);
}
process.exit(0);
