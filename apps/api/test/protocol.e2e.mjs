// Realtime protocol conformance (ch. 47/48/77) — end-to-end against a running api + worker
// (node test/protocol.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis.
//   * auth.ok capability_expiry, command.ack {resource_id, seq?, version?}, presence.set
//   * subscribe denied lists and unsubscribe {scope_ids} on both namespaces
//   * queue.updated (coalesced, department scoped), visitor chat.started, participant.joined joined_at
//   * message.redacted after a privacy erasure (internal notes never announced publicly)
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

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  s.frames = [];
  s.ephemeral = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('ephemeral', (f) => s.ephemeral.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', (a) => {
      s.authOk = a;
      resolve(s);
    });
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const command = (s, type, payload, extra = {}) => s.emitWithAck('command', { v: 1, command_id: randomUUID(), type, payload, ...extra });
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const stamp = Date.now();
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `proto-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Protocol ${stamp}`, timezone: 'UTC' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const ownerId = (await owner.must('GET', '/agents/me')).agent.id;
const site = await owner.must('POST', '/sites', { name: 'Protocol store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
ok(!!support, 'tenant, site and Support department ready');

console.log('auth.ok and presence.set');
const agentSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
const agentExpiry = Date.parse(agentSock.authOk.capability_expiry);
ok(agentExpiry > Date.now() + 60_000, `agent auth.ok capability_expiry is the session expiry (${agentSock.authOk.capability_expiry})`);
const sub = await agentSock.emitWithAck('subscribe', { scopes: [{ kind: 'queue', id: support.id }, { kind: 'team', id: 'all' }, { kind: 'chat', id: randomUUID() }] });
ok(sub.type === 'subscription.ok' && sub.granted === 2 && Array.isArray(sub.denied) && sub.denied.length === 1, 'agent subscribe grants own scopes and lists the refused one');
const away = await command(agentSock, 'presence.set', { status: 'away' });
ok(away.type === 'command.ack' && away.result.desired_status === 'away' && away.result.resource_id === null, 'presence.set command acks {desired_status, resource_id: null}');
const badPresence = await command(agentSock, 'presence.set', { status: 'busy' });
ok(badPresence.type === 'command.error' && badPresence.code === 'VALIDATION_FAILED', 'presence.set validates the status');
ok((await owner.must('GET', '/agents/me')).agent.desired_status === 'away', 'presence.set used the same service as REST (desired status away)');

const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
const vauth = { authorization: `Bearer ${sess.capability}` };
const visitorId = sess.visitor?.id ?? sess.visitor_id;
const vsock = await socket('/visitor', (await visitor.must('POST', '/widget/v1/socket-ticket', undefined, vauth)).ticket);
const vExpiry = Date.parse(vsock.authOk.capability_expiry);
ok(vExpiry > Date.now() + 60_000 && vExpiry <= Date.now() + 3700_000, `visitor auth.ok capability_expiry is the capability expiry (${vsock.authOk.capability_expiry})`);

console.log('queue.updated');
await command(agentSock, 'presence.set', { status: 'online' }); // admission needs an available agent
const chatId = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, I would like to ask about delivery times', department_id: support.id }, vauth)).chat.id;
const queued = await waitFor(() => agentSock.ephemeral.find((f) => f.type === 'queue.updated' && f.payload.waiting_count === 1), 8000, 'queue.updated waiting_count 1');
ok(queued.scope.kind === 'queue' && queued.scope.id === support.id && queued.payload.department_id === support.id && !!queued.payload.oldest_requested_at && !!queued.payload.as_of, 'queue.updated {department_id, waiting_count: 1, oldest_requested_at, as_of} on the department queue scope');

console.log('Visitor subscribe / unsubscribe');
const vsub = await vsock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }, { kind: 'chat', id: randomUUID() }] });
ok(vsub.type === 'subscription.ok' && vsub.granted === 1 && Array.isArray(vsub.denied) && vsub.denied.length === 1, 'visitor subscribe lists denied scopes (another chat refused)');
const vbad = await vsock.emitWithAck('subscribe', { scopes: [{ kind: 'team', id: 'all' }] });
ok(vbad.type === 'subscription.ok' && vbad.granted === 0 && vbad.denied.length === 1, 'visitor cannot subscribe to staff scopes');

console.log('command.ack shape, chat.started, participant.joined');
const accepted = await command(agentSock, 'offer.accept', { chat_id: chatId });
ok(accepted.type === 'command.ack' && accepted.result.resource_id === chatId && Number.isInteger(accepted.result.version) && accepted.result.status === 'active', 'offer.accept ack carries resource_id (chat), version and the full chat');
const started = await waitFor(() => vsock.frames.find((f) => f.type === 'chat.started'), 8000, 'visitor chat.started');
ok(
  started.payload.chat_id === chatId && !!started.payload.started_at && Object.keys(started.payload.owner_public_profile).sort().join(',') === 'avatar_url,display_name,id,title' && !JSON.stringify(started.payload).includes(ownerEmail),
  'visitor receives chat.started with only the owner public profile (no email, role or routing trace)',
);
const joined = await waitFor(() => vsock.frames.find((f) => f.type === 'participant.joined'), 5000, 'public participant.joined');
ok(!!joined.payload.joined_at && joined.payload.role === 'primary', 'public participant.joined carries joined_at');
const drained = await waitFor(() => agentSock.ephemeral.find((f) => f.type === 'queue.updated' && f.payload.waiting_count === 0), 8000, 'queue.updated waiting_count 0');
ok(drained.payload.oldest_requested_at === null, 'queue.updated reports the department queue emptied after accept');
await agentSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
const sent = await command(agentSock, 'message.send', { chat_id: chatId, client_message_id: `p-${stamp}`, body: 'Delivery takes two days.' });
ok(sent.type === 'command.ack' && sent.result.resource_id === sent.result.id && Number.isInteger(sent.result.seq), 'message.send ack carries resource_id = message id and seq');
const note = await command(agentSock, 'message.send', { chat_id: chatId, client_message_id: `n-${stamp}`, body: 'Internal: check the courier', visibility: 'internal' });
ok(note.type === 'command.ack' && note.result.visibility === 'internal', 'internal note sent');
const vmsg = await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: `v-${stamp}`, body: 'My address is 1 Test Street' }, vauth);

const unsub = await agentSock.emitWithAck('unsubscribe', { scope_ids: ['team:all', `agent:${ownerId}`] });
ok(unsub.type === 'unsubscribe.ok' && unsub.scope_ids.includes('team:all'), 'agent unsubscribe {scope_ids} acks the scopes');
const vunsub = await vsock.emitWithAck('unsubscribe', { scope_ids: [`chat:${chatId}`] });
ok(vunsub.type === 'unsubscribe.ok' && vunsub.scope_ids[0] === `chat:${chatId}`, 'visitor unsubscribe {scope_ids} acks');

console.log('message.redacted after erasure');
const er = await owner.call('POST', '/privacy/requests', { kind: 'erase', visitor_id: visitorId, proof_reference: `PROTO-${stamp}` });
ok(er.status === 202, 'erasure requested');
await owner.must('POST', `/privacy/requests/${er.data.id}/verify`, { method: 'verified_identity' });
await waitFor(
  async () => {
    const r = await owner.must('GET', `/privacy/requests/${er.data.id}`);
    if (r.state === 'failed') throw new Error(`erasure failed: ${JSON.stringify(r.report)}`);
    return r.state === 'completed';
  },
  60_000,
  'erasure',
);
const redacted = await waitFor(() => agentSock.frames.find((f) => f.type === 'message.redacted' && f.payload.message_id === vmsg.id), 8000, 'staff message.redacted');
ok(redacted.payload.chat_id === chatId && redacted.payload.reason === 'redacted' && Number.isInteger(redacted.payload.seq), 'staff receives message.redacted {chat_id, message_id, seq, reason}');
const publicRows = sql(`SELECT count(*) FROM outbox_events WHERE event_type = 'message.redacted' AND audience = 'public' AND payload->>'message_id' = '${vmsg.id}'`);
ok(publicRows === '1', 'the redaction of a public message is announced on the public chat scope (payload kept, not scrubbed)');
const noteRows = sql(`SELECT count(*) FROM outbox_events WHERE event_type = 'message.redacted' AND audience = 'public' AND payload->>'message_id' = '${note.result.id}'`);
ok(noteRows === '0', 'an internal note redaction is never announced on public scopes');
ok(sql(`SELECT count(*) FROM outbox_events WHERE event_type = 'message.redacted' AND payload::text LIKE '%Test Street%'`) === '0', 'message.redacted payloads carry no content');

for (const s of [agentSock, vsock]) s.disconnect();
console.log(`\nPROTOCOL E2E PASSED (${passed} checks)`);
process.exit(0);
