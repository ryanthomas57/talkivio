// Slow consumer (WS04, ch. 47) — node test/backpressure.e2e.mjs against a running api + worker (repo .env sourced).
//   * Two agent sockets watch the same busy chat. One stops reading (its TCP socket is paused, so the server's
//     outbound queue for it grows); the other keeps reading.
//   * ~800 durable message frames (~6 MB) are written to the chat. The server closes the stalled socket once its
//     queue passes 1000 packets or 1 MiB (talkivio_socket_overloads_total counts it); the healthy socket receives
//     every frame, in order, without waiting for the stalled one.
//   * The close is resumable: the stalled client reconnects with a fresh ticket, subscribes with the cursor of the
//     last frame it processed and the replay delivers the rest — every message exactly once, nothing lost.
//   * Server memory does not grow with the abandoned queue: the pending outbound queue (talkivio_socket_outbound_*)
//     builds up while the reader is stalled and is released once it is cut off.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const N = Number(process.env.FLOOD_MESSAGES ?? 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
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
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
async function metric(name, labelMatch = '') {
  const text = await (await fetch(`${API}/health/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(name) && l.includes(labelMatch) && !l.startsWith('#'));
  return line ? Number(line.trim().split(/\s+/).pop()) : 0;
}
/** An agent socket that records durable message.created frames (id, cursor) for one chat. */
function agentSocket(ticket, chatId) {
  const s = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  s.messages = new Map(); // message id → { cursor, at }
  s.lastCursor = null;
  s.controls = [];
  s.on('event', (f) => {
    if (f.type !== 'message.created' || f.payload?.message?.chat_id !== chatId) return;
    if (!s.messages.has(f.payload.message.id)) s.messages.set(f.payload.message.id, { at: Date.now(), body: f.payload.message.body, seq: f.payload.message.seq });
    s.lastCursor = f.cursor;
  });
  s.on('control', (f) => s.controls.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
  });
}

// ═══════════════════════════ Setup ═══════════════════════════
const stamp = Date.now();
console.log('Setup: an owner with two sockets on one busy chat');
const owner = new Client('owner');
const email = `bp-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email, password: 'backpressure passphrase', tenant_name: `Backpressure ${stamp}`, timezone: 'UTC' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(email, 'verify_email'), 'token') });
const site = await owner.must('POST', '/sites', { name: 'BP store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const presenceSock = await agentSocket((await owner.must('POST', '/socket-ticket')).ticket, 'none');
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
const chatId = await waitFor(async () => (await visitor.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello there' }, { authorization: `Bearer ${sess.capability}` })).data?.chat?.id, 10000, 'chat admitted');
await waitFor(async () => (await owner.call('POST', `/chats/${chatId}/accept`, {})).status === 200, 8000, 'accept');
const healthy = await agentSocket((await owner.must('POST', '/socket-ticket')).ticket, chatId);
const stalled = await agentSocket((await owner.must('POST', '/socket-ticket')).ticket, chatId);
const subH = await healthy.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
const subS = await stalled.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
ok(subH.type === 'subscription.ok' && subS.type === 'subscription.ok', 'both sockets subscribed to the chat');
stalled.lastCursor = subS.snapshot_cursor;

// ═══════════════════════════ Stall one reader and flood ═══════════════════════════
console.log(`Flood: ${N} durable frames of ~7.6 kB while one reader is stalled`);
const raw = stalled.io.engine.transport.ws?._socket;
ok(raw && typeof raw.pause === 'function', 'the stalled client stops reading its TCP socket');
raw.pause();
const overloadsBefore = await metric('talkivio_socket_overloads_total', 'namespace="agent"');
const rssBefore = await metric('talkivio_process_resident_memory_bytes');
const filler = 'x'.repeat(7500); // ~7.6 kB frames: well past the 1 MiB budget plus the OS socket buffers (up to 4 MB each way)
const sent = new Map(); // body → sent at
let next = 0;
// Sample the server's pending outbound queue (bytes + packets of open agent sockets) while the reader is stalled.
const pressure = { maxBytes: 0, maxPackets: 0, stop: false };
const sampler = (async () => {
  while (!pressure.stop) {
    pressure.maxBytes = Math.max(pressure.maxBytes, await metric('talkivio_socket_outbound_buffered_bytes', 'namespace="agent"'));
    pressure.maxPackets = Math.max(pressure.maxPackets, await metric('talkivio_socket_outbound_queued_packets', 'namespace="agent"'));
    await sleep(250);
  }
})();
const t0 = Date.now();
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < N) {
      const i = next++;
      const body = `flood ${String(i).padStart(4, '0')} ${filler}`;
      sent.set(body, Date.now());
      await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body });
    }
  }),
);
const floodMs = Date.now() - t0;
ok(sent.size === N, `${N} messages committed in ${floodMs} ms (~${Math.round((N * 7.7) / 1024 * 10) / 10} MB of frames per subscriber)`);

await waitFor(() => healthy.messages.size >= N, 60_000, 'healthy socket receives every frame');
const lags = [...healthy.messages.values()].map((m) => m.at - (sent.get(m.body) ?? m.at)).sort((a, b) => a - b);
const p95 = lags[Math.floor(lags.length * 0.95)];
ok(healthy.messages.size === N, `the healthy socket received all ${N} frames`);
ok(p95 < 2000, `…promptly while the other reader was stalled (delivery p95 ${p95} ms, max ${lags.at(-1)} ms)`);
const order = [...healthy.messages.values()].map((m) => Number(m.body.slice(6, 10)));
ok(order.length === new Set(order).size, '…each exactly once');

const overloadsAfter = await waitFor(async () => {
  const v = await metric('talkivio_socket_overloads_total', 'namespace="agent"');
  return v > overloadsBefore ? v : null;
}, 15_000, 'the slow-consumer guard to close the stalled socket');
ok(overloadsAfter === overloadsBefore + 1, `the server closed exactly the stalled socket (talkivio_socket_overloads_total ${overloadsBefore} → ${overloadsAfter})`);
ok(healthy.connected, 'the healthy socket stays connected');

// ═══════════════════════════ Resume ═══════════════════════════
console.log('Resume: the stalled client reconnects and replays from its cursor');
const disconnected = new Promise((r) => stalled.on('disconnect', (reason) => r(reason)));
raw.resume();
const reason = await Promise.race([disconnected, sleep(15_000).then(() => 'still connected')]);
ok(reason === 'transport close' || reason === 'transport error' || reason === 'io server disconnect', `the stalled client learns of the close once it reads again (${reason})`);
const before = stalled.messages.size;
ok(before < N, `it had processed only ${before} of ${N} frames when it was cut off`);
const resumed = await agentSocket((await owner.must('POST', '/socket-ticket')).ticket, chatId);
for (const [id, m] of stalled.messages) resumed.messages.set(id, m);
const sub = await resumed.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: stalled.lastCursor });
// Within the replay window (≤ 1000 events) the gap is replayed; beyond it the server asks for a snapshot: the client
// reads the messages after its last seq over REST and resubscribes from the snapshot cursor (ch. 47) — both resume.
if (sub.type === 'snapshot.required') {
  let after = Math.max(0, ...[...resumed.messages.values()].map((m) => m.seq ?? 0));
  for (;;) {
    const page = await owner.must('GET', `/chats/${chatId}/messages?after_seq=${after}&limit=100`);
    const items = page.items ?? page;
    if (!items.length) break;
    for (const m of items) if (m.body?.startsWith('flood ') && !resumed.messages.has(m.id)) resumed.messages.set(m.id, { at: Date.now(), body: m.body, seq: m.seq });
    after = items[items.length - 1].seq;
  }
  const again = await resumed.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }], last_cursor: sub.snapshot_cursor });
  ok(again.type === 'subscription.ok', `gap beyond the replay window → snapshot.required; REST catch-up after seq, then resubscribed from the snapshot cursor`, again);
} else {
  ok(sub.type === 'subscription.ok', `resubscribed from cursor ${stalled.lastCursor}: the gap is replayed`, sub);
}
await waitFor(() => resumed.messages.size >= N, 20_000, 'replay of the missed frames');
const ids = [...resumed.messages.keys()];
ok(resumed.messages.size === N && new Set(ids).size === N, `after the replay the client holds all ${N} messages exactly once — nothing lost`);
const stored = Number(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND body LIKE 'flood %'`));
ok(stored === N, `and they match the ${stored} stored rows`);

// ═══════════════════════════ Memory ═══════════════════════════
await sleep(2000);
pressure.stop = true;
await sampler;
ok(pressure.maxBytes > 256 * 1024 || pressure.maxPackets > 100, `the stalled reader built up a server-side queue (peak ${Math.round(pressure.maxBytes / 1024)} kB, ${pressure.maxPackets} packets pending)`);
const residual = { bytes: await metric('talkivio_socket_outbound_buffered_bytes', 'namespace="agent"'), packets: await metric('talkivio_socket_outbound_queued_packets', 'namespace="agent"') };
ok(residual.bytes < 64 * 1024 && residual.packets < 50, `after the cut-off the queue is released — nothing keeps growing (${residual.bytes} B, ${residual.packets} packets pending on open sockets)`);
const rssAfter = await metric('talkivio_process_resident_memory_bytes');
console.log(`  (API resident memory ${Math.round(rssBefore / 1048576)} → ${Math.round(rssAfter / 1048576)} MB across the run; V8 keeps heap it has grown, so this is reported, not asserted)`);

for (const s of [healthy, resumed, presenceSock]) s.disconnect();
await owner.call('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
console.log(`\nBACKPRESSURE E2E PASSED (${passed} checks)`);
process.exit(0);
