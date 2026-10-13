// Tenant deletion (ch. 41 POST /tenants/current/deletion-requests) and job status (ch. 45 GET /jobs/{id}) —
// end-to-end against a running api + worker (node test/tenant-deletion.e2e.mjs). Real HTTP, sockets,
// PostgreSQL, Redis and local object storage. The API and worker must run with a short test-only window,
// e.g. TENANT_DELETION_GRACE_SECONDS=15 (refused in production), so the destruction run is observable.
// Env: API_URL, DATABASE_OWNER_URL, REDIS_URL and STORAGE_LOCAL_DIR of the api under test (cwd = apps/api).
//   * owner + recent auth + slug confirmation; admins/agents refused; 422 field error on a wrong slug
//   * 202 with destroy_after / cancel_before / transcript archive / policy; a second request → 409 (Idempotency-Key replays)
//   * GET current (banner), cancel (idempotent), re-request; audit + owner/admin emails for request and cancel
//   * the archive renders and downloads through the normal export grant
//   * GET /jobs/{id}: requester (membership or user id) or admin/owner; 404 for others and other tenants; no payload
//   * destruction: zero rows in every tenant_id table, empty object storage, no presence/vm keys or queued jobs,
//     sessions + sockets revoked, users kept, tombstone without personal data, another tenant untouched
//   * crash recovery: a claimed run whose worker died (lease expired, timer lost) is resumed by the sweep
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const STORAGE_DIR = resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR ?? './storage');
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-X', '-At', '-F', '|', '-c', q]).toString().trim();
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 3 });

class Client {
  constructor(name, bearer) {
    this.name = name;
    this.cookies = {};
    this.bearer = bearer;
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : { cookie: this.cookieHeader() }),
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
    return { status: res.status, json, data: json?.data, error: json?.error, text };
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  s.controls = [];
  s.on('control', (f) => s.controls.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
async function upload(client, chatId, name, bytes) {
  const init = await client.must('POST', '/attachments/uploads', { chat_id: chatId, name, size_bytes: bytes.length, mime: 'image/png', sha256: sha(bytes) });
  const put = await fetch(init.url, { method: init.method, headers: init.headers, body: bytes });
  if (put.status !== 200) throw new Error(`upload PUT → ${put.status}`);
  await client.must('POST', `/attachments/${init.upload_id}/finalize`, { sha256: sha(bytes) });
  return waitFor(async () => {
    const a = await client.must('GET', `/attachments/${init.upload_id}`);
    return a.state === 'clean' ? a : null;
  }, 20000, `attachment ${name} clean`);
}

/** Every table with a tenant_id column except the tombstone ledger (which is deliberately not tenant-owned). */
const TENANT_TABLES = sql(
  `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenant_tombstones' ORDER BY 1`,
).split('\n');
function rowCounts(tenantId) {
  const q = TENANT_TABLES.map((t) => `SELECT '${t}', count(*) FROM "${t}" WHERE tenant_id = '${tenantId}'`).join(' UNION ALL ');
  return Object.fromEntries(sql(q).split('\n').map((l) => l.split('|')).map(([t, n]) => [t, Number(n)]));
}
/** Stored objects naming the tenant, excluding the deliberate deletion ledger (checked separately). */
const LEDGER_DIR = join('exports', 'tenant-deletion-ledger');
function storedFiles(tenantId) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('._')) continue; // AppleDouble metadata macOS writes on non-APFS volumes, not objects
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!relative(STORAGE_DIR, full).startsWith(LEDGER_DIR)) out.push(relative(STORAGE_DIR, full));
    }
  };
  walk(STORAGE_DIR);
  return out.filter((p) => p.includes(tenantId));
}
const tenantDirs = (tenantId) => ['quarantine', 'clean', 'exports'].map((a) => join(STORAGE_DIR, a, 't', tenantId)).filter((d) => existsSync(d));
async function redisKeys(tenantId) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `*${tenantId}*`, 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}
/** Pending BullMQ jobs (wait/delayed/prioritized) of a queue whose data carries the tenant id. */
async function pendingJobsFor(queue, tenantId) {
  const ids = [...(await redis.lrange(`rd:${queue}:wait`, 0, -1)), ...(await redis.zrange(`rd:${queue}:delayed`, 0, -1)), ...(await redis.zrange(`rd:${queue}:prioritized`, 0, -1))];
  let n = 0;
  for (const id of ids) if (((await redis.hget(`rd:${queue}:${id}`, 'data')) ?? '').includes(tenantId)) n++;
  return n;
}

async function workspace(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const owner = new Client(`${label}-owner`);
  const email = `tdel-${label}+${stamp}@example.com`;
  const signup = await owner.must('POST', '/auth/signup', { email, password: PASSWORD, tenant_name: `Deletion ${label} ${stamp}`, timezone: 'UTC' });
  await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(email, 'verify_email'), 'token') });
  const tenant = await owner.must('GET', '/tenants/current');
  const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
  const site = await owner.must('POST', '/sites', { name: `${label} store`, origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
  return { owner, email, tenantId: signup.tenant_id, userId: signup.user_id, tenant, support, site, stamp };
}
async function invite(ws, role, name) {
  const email = `tdel-${role}+${ws.stamp}@example.com`;
  await ws.owner.must('POST', '/agents/invitations', { email, role, department_ids: [ws.support.id], capacity: 3 });
  const c = new Client(role);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'), display_name: name, password: 'another strong passphrase' });
  const me = await c.must('GET', '/agents/me');
  return { client: c, email, membershipId: me.agent.id, userId: sql(`SELECT id FROM users WHERE email = '${email}'`) };
}
async function visitorChat(ws, text) {
  const anon = new Client('visitor');
  const sess = await anon.must('POST', '/widget/v1/sessions', { site_key: ws.site.public_key, host_origin: ORIGIN, consent: { analytics: true, policy_version: '2026-10' } });
  const visitor = new Client('visitor', sess.capability);
  const chat = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: text, department_id: ws.support.id })).chat;
  return { visitor, chat };
}

// ───────────────────────── setup ─────────────────────────
console.log('Setup: workspace A (owner, admin, agent, chat, note, file, live sockets) and workspace B');
const A = await workspace('a');
const admin = await invite(A, 'admin', 'Ada Admin');
const agent = await invite(A, 'agent', 'Abe Agent');
const ownerSock = await socket('/agent', (await A.owner.must('POST', '/socket-ticket')).ticket);
await A.owner.must('PUT', '/agents/me/presence', { status: 'online' });
// Letters touch the digits, so the canary can never look like a (Luhn-valid) card number and be masked.
const CANARY_A = `canary-a-x${A.stamp}z`;
const { visitor: visitorA, chat: chatA } = await visitorChat(A, `Hello, ${CANARY_A} here`);
const vSockA = await socket('/visitor', (await visitorA.must('POST', '/widget/v1/socket-ticket')).ticket);
await vSockA.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatA.id }] }).catch(() => undefined);
await waitFor(async () => (await A.owner.call('POST', `/chats/${chatA.id}/accept`, {})).status === 200, 8000, 'owner accept');
await A.owner.must('POST', `/chats/${chatA.id}/messages`, { client_message_id: randomUUID(), body: 'Happy to help.' });
await A.owner.must('POST', `/chats/${chatA.id}/messages`, { client_message_id: randomUUID(), visibility: 'internal', body: `Internal note ${CANARY_A}` });
const fileA = await upload(A.owner, chatA.id, 'receipt.png', PNG);
const agentExport = await agent.client.must('POST', '/exports', { chat_ids: [chatA.id], format: 'txt' });
const agentExportJob = sql(`SELECT job_id FROM exports WHERE id = '${agentExport.id}'`);
await waitFor(async () => (await agent.client.must('GET', `/exports/${agentExport.id}`)).state === 'ready', 15000, 'agent export ready');
ok(storedFiles(A.tenantId).length >= 2 && fileA.state === 'clean', `workspace A has stored objects (attachment in clean, export artifact)`);
await waitFor(async () => (await redisKeys(A.tenantId)).some((k) => k.startsWith('pv:') || k.startsWith('pa:')), 8000, 'presence keys for A');
ok(true, `workspace A has live presence keys in Redis (${(await redisKeys(A.tenantId)).filter((k) => !k.startsWith('rd:')).length} keys)`);

const B = await workspace('b');
const ownerSockB = await socket('/agent', (await B.owner.must('POST', '/socket-ticket')).ticket);
await B.owner.must('PUT', '/agents/me/presence', { status: 'online' });
const CANARY_B = `canary-b-${B.stamp}`;
const { chat: chatB } = await visitorChat(B, `Hello, ${CANARY_B} here`);
await waitFor(async () => (await B.owner.call('POST', `/chats/${chatB.id}/accept`, {})).status === 200, 8000, 'B owner accept');
await upload(B.owner, chatB.id, 'b.png', PNG);
ok(storedFiles(B.tenantId).length >= 1, 'workspace B has a stored attachment');

// ───────────────────────── request validation and authority ─────────────────────────
console.log('Authority: owner + recent auth + exact slug');
const slug = A.tenant.slug;
const wrong = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: `${slug}-nope` });
ok(wrong.status === 422 && wrong.error.code === 'VALIDATION_FAILED' && wrong.error.field_errors?.confirm_slug?.length === 1, 'slug mismatch → 422 with a confirm_slug field error');
const unknownField = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug, force: true });
ok(unknownField.status === 422, 'unknown input fields are rejected (422)');
for (const [who, c] of [['admin', admin.client], ['agent', agent.client]]) {
  const r = await c.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug });
  ok(r.status === 403 && r.error.code === 'PERMISSION_DENIED', `${who} cannot request deletion (403)`);
}
ok(sql(`SELECT count(*) FROM jobs WHERE tenant_id = '${A.tenantId}' AND kind = 'tenant_deletion'`) === '0', 'refused requests created no job');
sql(`UPDATE auth_sessions SET recent_auth_at = now() - interval '1 hour' WHERE user_id = '${A.userId}'`);
const stale = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug });
ok(stale.status === 403 && stale.error.code === 'RECENT_AUTH_REQUIRED', 'owner without recent authentication → 403 RECENT_AUTH_REQUIRED');
const staleCancel = await A.owner.call('DELETE', `/tenants/current/deletion-requests/${randomUUID()}`);
ok(staleCancel.status === 403 && staleCancel.error.code === 'RECENT_AUTH_REQUIRED', 'cancel also requires recent authentication');
await A.owner.must('POST', '/auth/reauthenticate', { password: PASSWORD });

// ───────────────────────── request ─────────────────────────
console.log('Request: 202 staged destruction with window, archive and policy');
const idemKey = `tdel-${randomUUID()}`;
const t0 = Date.now();
const first = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug }, { 'idempotency-key': idemKey });
const req1 = first.data;
ok(first.status === 202 && req1.state === 'scheduled', `owner request accepted (202, state scheduled, id ${req1?.id})`);
const windowMs = Date.parse(req1.destroy_after) - Date.parse(req1.requested_at);
ok(req1.cancel_before === req1.destroy_after && windowMs > 0 && windowMs < 120_000, `destroy_after = cancel_before = requested_at + ${windowMs / 1000}s (short test window)`);
ok(req1.policy.window_seconds === Math.round(windowMs / 1000) && req1.policy.cancellable === true && req1.policy.retains.some((s) => s.startsWith('user accounts')), 'policy states the window, that it is cancellable and what is retained');
ok(req1.export && req1.export.format === 'json' && req1.export.chat_count === 1 && req1.export.total_chats === 1 && req1.export.truncated === false && req1.export.includes_internal_notes === true, 'transcript archive started (JSON, 1 of 1 chats, internal notes included, not truncated)');
ok(req1.export.chat_limit === 5000 && req1.export.excludes.includes('attachment file contents') && Date.parse(req1.export.expires_at) >= Date.parse(req1.destroy_after) - 1000, 'archive states its limit and exclusions and lasts until destroy_after');
const replay = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug }, { 'idempotency-key': idemKey });
ok(replay.status === 202 && replay.data.id === req1.id, 'same Idempotency-Key replays the original 202');
const dup = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug });
ok(dup.status === 409 && dup.error.code === 'CONFLICT' && dup.error.details.request_id === req1.id, 'a second request while one is scheduled → 409 CONFLICT naming the active request');
ok(sql(`SELECT count(*) FROM jobs WHERE tenant_id = '${A.tenantId}' AND kind = 'tenant_deletion'`) === '1', 'exactly one deletion job exists');
const cur = await A.owner.must('GET', '/tenants/current/deletion-requests');
ok(cur.id === req1.id && cur.state === 'scheduled' && cur.export?.id === req1.export.id, 'GET current returns the scheduled request with its archive');
const curAgent = await agent.client.must('GET', '/tenants/current/deletion-requests');
ok(curAgent.id === req1.id && curAgent.export === null, 'agents see the banner request without archive details');
ok(sql(`SELECT count(*) FROM audit_events WHERE tenant_id = '${A.tenantId}' AND action = 'tenant.deletion_requested' AND object_id = '${A.tenantId}'`) === '1', 'request audited (tenant.deletion_requested)');
const reqMails = sql(`SELECT recipient FROM outbound_emails WHERE tenant_id = '${A.tenantId}' AND template = 'tenant_deletion_scheduled' ORDER BY recipient`).split('\n');
ok(reqMails.length === 2 && reqMails.includes(A.email) && reqMails.includes(admin.email), 'owner and admin emailed (not the agent)');
ok((await A.owner.must('GET', '/tenants/current')).status === 'active', 'workspace stays active during the window');

console.log('Cancel and re-request');
const agentCancel = await agent.client.call('DELETE', `/tenants/current/deletion-requests/${req1.id}`);
ok(agentCancel.status === 403, 'agent cannot cancel (403)');
const cancelled = await A.owner.must('DELETE', `/tenants/current/deletion-requests/${req1.id}`);
ok(cancelled.state === 'cancelled' && cancelled.cancelled_at && cancelled.policy.cancellable === false, `owner cancelled after ${(Date.now() - t0) / 1000}s (state cancelled)`);
const again = await A.owner.call('DELETE', `/tenants/current/deletion-requests/${req1.id}`);
ok(again.status === 200 && again.data.state === 'cancelled', 'cancelling again is idempotent (200 cancelled)');
ok((await A.owner.call('DELETE', `/tenants/current/deletion-requests/${randomUUID()}`)).status === 404, 'unknown request id → 404');
ok((await A.owner.call('GET', '/tenants/current/deletion-requests')).data === null, 'GET current → null after cancel');
ok((await redis.exists(`rd:timers:tenant-deletion-${req1.id}-0`)) === 0, 'the delayed destruction timer was removed');
ok(sql(`SELECT count(*) FROM audit_events WHERE tenant_id = '${A.tenantId}' AND action = 'tenant.deletion_cancelled'`) === '1', 'cancel audited once (tenant.deletion_cancelled)');
ok(sql(`SELECT count(*) FROM outbound_emails WHERE tenant_id = '${A.tenantId}' AND template = 'tenant_deletion_cancelled'`) === '2', 'owner and admin emailed about the cancellation');
const second = await A.owner.call('POST', '/tenants/current/deletion-requests', { confirm_slug: slug });
const req2 = second.data;
ok(second.status === 202 && req2.id !== req1.id && req2.state === 'scheduled', 're-request after cancel → 202 with a new request');
const ownerJob = sql(`SELECT state || '|' || dedupe_key FROM jobs WHERE id = '${req1.id}'`);
ok(ownerJob === `cancelled|cancelled:${req1.id}`, 'the cancelled request released the active dedupe key');

// ───────────────────────── GET /jobs/{id} ─────────────────────────
console.log('GET /jobs/{id}: requester or admin/owner, 404 otherwise, never the payload');
const FIELDS = ['attempts', 'completed_at', 'created_at', 'id', 'kind', 'last_error_code', 'progress', 'run_after', 'state'];
const j1 = await A.owner.call('GET', `/jobs/${req2.id}`);
ok(j1.status === 200 && j1.data.kind === 'tenant_deletion' && j1.data.state === 'queued' && Date.parse(j1.data.run_after) === Date.parse(req2.destroy_after), 'owner reads the deletion job (kind, state queued, run_after = destroy_after)');
ok(JSON.stringify(Object.keys(j1.data).sort()) === JSON.stringify(FIELDS) && !j1.text.includes('export_job_id'), 'job status has exactly the public fields (no payload/result)');
ok((await admin.client.call('GET', `/jobs/${req2.id}`)).status === 200, 'admin reads any job of the workspace');
const notMine = await agent.client.call('GET', `/jobs/${req2.id}`);
ok(notMine.status === 404 && notMine.error.code === 'NOT_FOUND', "agent → 404 for someone else's job");
const own = await agent.client.call('GET', `/jobs/${agentExportJob}`);
ok(own.status === 200 && own.data.kind === 'export' && own.data.state === 'succeeded' && own.data.progress === 100, 'agent reads their own export job (requested_by = membership id)');
ok((await A.owner.call('GET', `/jobs/${agentExportJob}`)).status === 200, "owner reads the agent's job");
const mergeMine = sql(`INSERT INTO jobs (id, tenant_id, kind, dedupe_key, state, payload, requested_by) VALUES (gen_random_uuid(), '${A.tenantId}', 'visitor_merge', 'e2e-${randomUUID()}', 'succeeded', '{"secret_proof":"x"}', '${agent.userId}') RETURNING id`).split('\n')[0];
const mergeOther = sql(`INSERT INTO jobs (id, tenant_id, kind, dedupe_key, state, payload, requested_by) VALUES (gen_random_uuid(), '${A.tenantId}', 'visitor_merge', 'e2e-${randomUUID()}', 'succeeded', '{}', '${A.userId}') RETURNING id`).split('\n')[0];
const mm = await agent.client.call('GET', `/jobs/${mergeMine}`);
ok(mm.status === 200 && mm.data.kind === 'visitor_merge' && !mm.text.includes('secret_proof'), 'requested_by holding the user id (visitor_merge) also counts as the requester; payload not exposed');
ok((await agent.client.call('GET', `/jobs/${mergeOther}`)).status === 404, "agent → 404 for the owner's user-id job");
ok((await B.owner.call('GET', `/jobs/${req2.id}`)).status === 404 && (await B.owner.call('GET', `/jobs/${agentExportJob}`)).status === 404, 'another tenant’s owner → 404 (existence not leaked)');
ok((await A.owner.call('GET', `/jobs/${randomUUID()}`)).status === 404, 'unknown job → 404');

// ───────────────────────── archive ─────────────────────────
console.log('Transcript archive downloads through the export grant');
const ready = await waitFor(async () => {
  const e = await A.owner.must('GET', `/exports/${req2.export.id}`);
  return e.state === 'ready' ? e : null;
}, 10000, 'archive ready');
ok(Date.parse(ready.expires_at) >= Date.parse(req2.destroy_after) - 1000, 'rendered archive is kept until destroy_after (not the usual 24 h)');
const grant = await A.owner.must('GET', `/exports/${req2.export.id}/download`);
const archive = await (await fetch(grant.url)).json();
ok(archive.format === 'talkivio.transcript' && archive.chats.length === 1 && archive.chats[0].id === chatA.id && archive.include_internal === true, 'archive is a JSON transcript of the workspace chat');
const bodies = archive.chats[0].messages.map((m) => m.body ?? '');
ok(bodies.includes(`Hello, ${CANARY_A} here`) && bodies.includes(`Internal note ${CANARY_A}`) && bodies.includes('Happy to help.'), `archive contains the visitor message, the reply and the internal note (${bodies.length} bodies: ${JSON.stringify(bodies.map((b) => b.slice(0, 40)))})`);
ok((await agent.client.call('GET', `/exports/${req2.export.id}/download`)).status === 404, 'only the requesting owner can download the archive');
const deletionStatus = (await A.owner.must('GET', '/tenants/current/deletion-requests')).export;
ok(deletionStatus.state === 'ready' && deletionStatus.size_bytes > 0 && /^[0-9a-f]{64}$/.test(deletionStatus.sha256), 'the request reports the archive as ready with size and checksum');

// ───────────────────────── destruction ─────────────────────────
const before = rowCounts(A.tenantId);
const bBefore = rowCounts(B.tenantId);
const bFiles = storedFiles(B.tenantId).sort();
ok(before.messages >= 3 && before.memberships === 3 && before.audit_events > 0, `workspace A has data before destruction (${Object.values(before).reduce((a, b) => a + b, 0)} rows in ${Object.values(before).filter(Boolean).length} tables)`);
const waitMs = Date.parse(req2.destroy_after) - Date.now();
console.log(`Destruction: waiting ${Math.max(0, Math.round(waitMs / 1000))}s for the window, then for the worker`);
await waitFor(() => sql(`SELECT count(*) FROM tenant_tombstones WHERE tenant_id = '${A.tenantId}' AND completed_at IS NOT NULL`) === '1', Math.max(0, waitMs) + 90_000, 'destruction to complete');
ok(Date.now() >= Date.parse(req2.destroy_after) - 2000, 'destruction did not start before destroy_after');
ok(sql(`SELECT count(*) FROM tenants WHERE id = '${A.tenantId}'`) === '0', 'tenant row deleted');
const after = rowCounts(A.tenantId);
const leftovers = Object.entries(after).filter(([, n]) => n > 0);
ok(leftovers.length === 0, `zero rows for the tenant in all ${TENANT_TABLES.length} tables with tenant_id (incl. outbound_emails, auth_tokens, billing_events)${leftovers.length ? `: ${JSON.stringify(leftovers)}` : ''}`);
ok(sql(`SELECT count(*) FROM jobs WHERE id IN ('${req1.id}', '${req2.id}', '${mergeMine}')`) === '0', 'its jobs (including the deletion request itself) are gone');
ok(sql(`SELECT count(*) FROM auth_sessions WHERE active_tenant_id = '${A.tenantId}'`) === '0', 'no session points at the deleted workspace');
ok(storedFiles(A.tenantId).length === 0 && tenantDirs(A.tenantId).length === 0, 'object storage: no file or directory for the tenant in quarantine, clean or exports');
const ledgerFile = join(STORAGE_DIR, LEDGER_DIR, `${A.tenantId}.json`);
const ledgerEntry = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null;
ok(
  ledgerEntry && JSON.stringify(Object.keys(ledgerEntry).sort()) === JSON.stringify(['deletion_job_id', 'kind', 'recorded_at', 'slug_hash', 'tenant_id', 'v']),
  'the external deletion ledger keeps one pseudonymous entry (ids, slug hash, time) for replay after a restore',
);
const keysLeft = (await redisKeys(A.tenantId)).filter((k) => !k.startsWith('rd:'));
ok(keysLeft.length === 0, `Redis: no tenant keys left (presence pa:/pv:, live monitor vm:)${keysLeft.length ? `: ${keysLeft.join(', ')}` : ''}`);
const registered = await Promise.all(['pa:tenants', 'pv:tenants', 'vm:dirty:tenants', 'vm:sig:tenants'].map((s) => redis.sismember(s, A.tenantId)));
ok(registered.every((x) => x === 0), 'tenant removed from the presence / monitor registry sets');
ok((await pendingJobsFor('timers', A.tenantId)) + (await pendingJobsFor('exports', A.tenantId)) + (await pendingJobsFor('events', A.tenantId)) === 0, 'no pending BullMQ jobs carry the tenant');
ok(ownerSock.controls.some((c) => c.type === 'access.revoked') && vSockA.controls.some((c) => c.type === 'access.revoked' && c.payload.reason === 'tenant_unavailable'), 'agent and visitor sockets received access.revoked (tenant_unavailable)');
ok((await A.owner.call('GET', '/auth/me')).status === 401 && (await admin.client.call('GET', '/auth/me')).status === 401 && (await agent.client.call('GET', '/auth/me')).status === 401, 'sessions active on the workspace were revoked (401)');
ok(sql(`SELECT count(*) FROM users WHERE id IN ('${A.userId}', '${admin.userId}', '${agent.userId}')`) === '3', 'global user accounts are kept (only memberships removed)');
const relogin = new Client('relogin');
const me = await relogin.must('POST', '/auth/login', { email: A.email, password: PASSWORD });
ok(!JSON.stringify(me).includes(A.tenantId), 'the owner can still sign in; the deleted workspace is no longer among their memberships');
const widget = await new Client('anon').call('POST', '/widget/v1/sessions', { site_key: A.site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
ok(widget.status >= 400, `the deleted workspace's widget key no longer works (${widget.status})`);

console.log('Tombstone');
const [tSlug, tJob, tDeleted, tCounts, tAll] = sql(`SELECT slug_hash, deletion_job_id, deleted_at IS NOT NULL, counts::text, row_to_json(t)::text FROM tenant_tombstones t WHERE tenant_id = '${A.tenantId}'`).split('|');
const counts = JSON.parse(tCounts);
ok(/^[0-9a-f]{64}$/.test(tSlug) && tSlug !== sha(slug) && tJob === req2.id && tDeleted === 't', 'tombstone: tenant id, keyed slug hash, deletion job id, deleted_at');
ok(counts.rows.messages === before.messages && counts.rows.chats === before.chats && counts.rows.memberships === 3, 'tombstone counts match the rows present when destruction started');
ok(counts.objects_deleted >= 3 && counts.sessions_revoked >= 3, `tombstone records ${counts.objects_deleted} objects deleted and ${counts.sessions_revoked} sessions revoked`);
ok(![slug, A.email, admin.email, A.tenant.name, CANARY_A, 'Abe Agent', A.userId].some((s) => tAll.includes(s)), 'tombstone holds no personal data (no slug, names, emails, user ids or content)');
ok(sql(`SELECT has_table_privilege('talkivio_app_role', 'tenant_tombstones', 'DELETE')`) === 'f', 'the application role cannot delete tombstones');

console.log('Workspace B untouched');
const bAfter = rowCounts(B.tenantId);
const changed = Object.keys(bBefore).filter((t) => bBefore[t] !== bAfter[t]);
ok(changed.length === 0, `workspace B row counts unchanged in every table${changed.length ? `: ${changed.join(', ')}` : ''}`);
ok(JSON.stringify(storedFiles(B.tenantId).sort()) === JSON.stringify(bFiles), "workspace B's stored files are untouched");
ok((await B.owner.must('GET', '/tenants/current')).status === 'active' && (await B.owner.must('GET', `/chats/${chatB.id}/messages`)).items.some((m) => (m.body ?? '').includes(CANARY_B)), "workspace B still serves its chats");
const bWidget = await new Client('anon-b').call('POST', '/widget/v1/sessions', { site_key: B.site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
ok(bWidget.status === 201 || bWidget.status === 200, "workspace B's widget still opens sessions");

// ───────────────────────── crash recovery ─────────────────────────
console.log('Crash recovery: a run that died after claiming (lease expired, timer lost) is resumed by the sweep');
const C = await workspace('c');
const ownerSockC = await socket('/agent', (await C.owner.must('POST', '/socket-ticket')).ticket);
await C.owner.must('PUT', '/agents/me/presence', { status: 'online' });
const { chat: chatC } = await visitorChat(C, 'Hello from workspace C');
await waitFor(async () => (await C.owner.call('POST', `/chats/${chatC.id}/accept`, {})).status === 200, 8000, 'C owner accept');
await upload(C.owner, chatC.id, 'c.png', PNG);
const reqC = await C.owner.must('POST', '/tenants/current/deletion-requests', { confirm_slug: C.tenant.slug });
// Simulate: the worker claimed the job (tenant disabled, tombstone opened), deleted the stored files, then
// crashed — and Redis lost the timer. Nothing but the durable rows is left to drive recovery.
const timers = new Queue('timers', { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }), prefix: 'rd' });
await (await timers.getJob(`tenant-deletion-${reqC.id}-0`))?.remove();
sql(`UPDATE jobs SET state = 'running', attempts = 1, run_after = now() - interval '1 minute', lease_until = now() - interval '1 second' WHERE id = '${reqC.id}'`);
sql(`UPDATE tenants SET status = 'deleting' WHERE id = '${C.tenantId}'`);
sql(`INSERT INTO tenant_tombstones (tenant_id, slug_hash, deletion_job_id) VALUES ('${C.tenantId}', '${'0'.repeat(64)}', '${reqC.id}')`);
rmSync(join(STORAGE_DIR, 'clean', 't', C.tenantId), { recursive: true, force: true });
ok((await timers.getJob(`tenant-deletion-${reqC.id}-0`)) === undefined && (await C.owner.call('GET', '/tenants/current')).status === 403, 'crash state: timer gone, workspace disabled (403), tombstone open, files partly deleted');
await waitFor(() => sql(`SELECT count(*) FROM tenant_tombstones WHERE tenant_id = '${C.tenantId}' AND completed_at IS NOT NULL`) === '1', 150_000, 'sweep to resume the destruction');
const cLeft = Object.entries(rowCounts(C.tenantId)).filter(([, n]) => n > 0);
ok(cLeft.length === 0 && sql(`SELECT count(*) FROM tenants WHERE id = '${C.tenantId}'`) === '0', 'resumed run removed every row of workspace C');
ok(storedFiles(C.tenantId).length === 0 && (await redisKeys(C.tenantId)).filter((k) => !k.startsWith('rd:')).length === 0, 'resumed run cleared the remaining objects and Redis keys (already-deleted files were not an error)');
const cCounts = JSON.parse(sql(`SELECT counts::text FROM tenant_tombstones WHERE tenant_id = '${C.tenantId}'`));
ok(cCounts.rows.chats === 1 && cCounts.rows.memberships === 1, 'resumed run still recorded the inventory');
await timers.close();

for (const s of [ownerSock, vSockA, ownerSockB, ownerSockC]) s.disconnect();
await redis.quit();
console.log(`\ntenant-deletion.e2e: ${passed} assertions passed`);
process.exit(0);
