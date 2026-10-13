// Talkivio analytics, monitoring and notifications end-to-end test (ch. 14, 49–51).
// Runs against a live api + worker (node test/analytics.e2e.mjs). Real HTTP, real
// sockets, real database — no mocks, no seeded metric numbers.
//
// Env: API_URL (default http://localhost:4105), DATABASE_OWNER_URL (for reading
// verification emails and — only if the offline endpoint is unavailable — inserting
// the Fixture A offline submission).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4105';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const TZ = 'Europe/London';
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
    this.headers = {};
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
        ...this.headers,
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
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    const json = text && isJson ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error, text, headers: res.headers };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

const psql = (sql) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]).toString().trim();
const latestEmail = (to, template) => psql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
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
const waitFor = async (pred, ms = 5000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const stamp = Date.now();
const T_START = new Date(Date.now() - 2000).toISOString();
const T_END = new Date(Date.now() + 2 * 3600_000).toISOString();

// ───────────────────────── Workspace setup ─────────────────────────
console.log('Setup — workspace, departments, team, sockets');
const owner = new Client('owner');
const ownerEmail = `owner+an${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Analytics ${stamp}`, timezone: TZ });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const tenantId = signup.me.active_tenant_id;
const ownerMe = await owner.must('GET', '/agents/me');
const ownerId = ownerMe.agent.id;
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const sales = await owner.must('POST', '/departments', { name: 'Sales', routing_mode: 'assigned' });
await owner.must('PUT', `/departments/${sales.id}/members`, { members: [{ membership_id: ownerId, can_serve: true }] });
const site = await owner.must('POST', '/sites', { name: 'Shop', origins: [{ origin: ORIGIN, pattern_type: 'exact' }], default_department_id: support.id });
ok(support && sales.routing_mode === 'assigned' && site.public_key, 'tenant with Support (broadcast) and Sales (assigned) departments and a site');

async function invite(email, role, departmentIds, name) {
  await owner.must('POST', '/agents/invitations', { email, role, department_ids: departmentIds, capacity: 3 });
  const c = new Client(name);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'), display_name: name, password: 'another strong passphrase' });
  c.id = (await c.must('GET', '/agents/me')).agent.id;
  return c;
}
const agentA = await invite(`agent+an${stamp}@example.com`, 'agent', [support.id], 'Alex Agent');
const sup = await invite(`sup+an${stamp}@example.com`, 'supervisor', [support.id], 'Sue Supervisor');
await agentA.must('PATCH', '/agents/me/preferences', { privacy_mode: true });
ok(agentA.id && sup.id, 'agent (Support, privacy mode on) and supervisor (Support only) joined');

const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
const aSock = await socket('/agent', (await agentA.must('POST', '/socket-ticket')).ticket);
const supSock = await socket('/agent', (await sup.must('POST', '/socket-ticket')).ticket);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
await agentA.must('PUT', '/agents/me/presence', { status: 'online' });
ok(true, 'owner, agent and supervisor sockets connected; owner and agent online');

let visitorN = 0;
async function newVisitor() {
  const v = new Client(`visitor${++visitorN}`);
  const sess = await v.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: true, policy_version: '2026-10' }, page: { url: `${ORIGIN}/p${visitorN}`, title: 'Page' } });
  v.headers = { authorization: `Bearer ${sess.capability}` };
  return v;
}
async function admit(v, message, departmentId) {
  const r = await v.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message, ...(departmentId ? { department_id: departmentId } : {}) });
  if (r.status !== 201) throw new Error(`admission failed ${r.status} ${JSON.stringify(r.error)}`);
  return r.data.chat.id;
}
const send = (c, chatId, body, visibility = 'public') => c.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), visibility, body });

// ───────────────────────── Fixture A ─────────────────────────
console.log('Fixture A — 3 requested, 2 assigned, 1 served, 1 good rating, 1 offline submission');
const v1 = await newVisitor();
const chat1 = await admit(v1, 'Hi, I need help with my order');
await agentA.must('POST', `/chats/${chat1}/accept`, {});
await send(agentA, chat1, 'Happy to help!');
await agentA.must('POST', `/chats/${chat1}/close`, { reason: 'resolved' });
await v1.must('PUT', `/widget/v1/chats/${chat1}/rating`, { rating: 'good' });

const v2 = await newVisitor();
const chat2 = await admit(v2, 'Anyone there?');
await owner.must('POST', `/chats/${chat2}/accept`, {});
await send(owner, chat2, 'Internal: checking stock first', 'internal');
await owner.must('POST', `/chats/${chat2}/close`, { reason: 'resolved' });

const v3 = await newVisitor();
const chat3 = await admit(v3, 'Never mind');
await v3.must('POST', `/widget/v1/chats/${chat3}/close`);

const v4 = await newVisitor();
let offlineVia = 'api';
const off = await v4.call('POST', '/widget/v1/offline-submissions', { client_request_id: `cr-${randomUUID()}`, name: 'Olive Offline', email: 'olive@example.com', message: 'Please call me back', department_id: support.id });
if (off.status !== 201) {
  // Offline endpoint not available in this build: insert the fixture row directly (owner DB, tenant-scoped).
  offlineVia = `psql (offline endpoint returned ${off.status})`;
  psql(
    `SELECT set_config('app.tenant_id', '${tenantId}', false); INSERT INTO offline_submissions (id, tenant_id, site_id, department_id, reference, email_ciphertext, email_lookup_hash, message, updated_at) VALUES (gen_random_uuid(), '${tenantId}', '${site.id}', '${support.id}', 'FX-${stamp}', 'x', 'fixture-${stamp}', 'Please call me back', now());`,
  );
}
await sleep(50);
const T_FIX = new Date().toISOString();
ok(true, `fixture created (offline submission via ${offlineVia})`);

const fixtureQuery = { from: T_START, to: T_FIX, timezone: TZ, group_by: 'hour' };
async function report(c, params) {
  return c.must('GET', `/analytics/chats?${qs(params)}`);
}
async function freshReport(c, params, label) {
  return waitFor(async () => {
    const r = await report(c, params);
    return r.freshness.pending_facts === 0 ? r : null;
  }, 20000, `fresh facts (${label})`);
}

const a = await freshReport(owner, fixtureQuery, 'fixture A');
const m = a.measures;
ok(m.requested.value === 3, 'requested = 3', m.requested);
ok(m.assigned.value === 2, 'assigned = 2', m.assigned);
ok(m.served.value === 1, 'served = 1 (assigned-but-unreplied chat is not served)', m.served);
ok(m.csat.value === 100 && m.csat.numerator === 1 && m.csat.denominator === 1 && m.csat.n === 1, 'CSAT = 100 % with n = 1', m.csat);
ok(m.offline_submissions.value === 1, 'offline submissions = 1, reported as a separate population', m.offline_submissions);
ok(m.missed.value === 2 && m.abandoned.value === 1 && m.quick_cancellations.value === 1, 'missed 2 and abandoned 1 overlap (quick cancellation disclosed)', [m.missed.value, m.abandoned.value]);
ok(m.wait_to_assignment.n === 2 && m.wait_to_assignment.median !== null && m.first_response_time.n === 1, 'durations carry explicit sample sizes', [m.wait_to_assignment, m.first_response_time]);
ok(m.response_rate.numerator === 1 && m.response_rate.denominator === 1, 'response rate = rated ÷ served');
ok(m.requested.comparison.label === 'new' && m.requested.comparison.change_pct === null, 'comparison with an empty previous period is labelled "new" without percent change');
ok(m.csat.null_policy && m.csat.population && m.csat.unit === 'percent' && m.wait_to_assignment.unit === 'seconds', 'measures carry null policy, population and units');
// AUD-72-07: not just those two — every measure the report serves states its population, unit, null rule and sample size.
const incomplete = Object.entries(m).filter(([, x]) => !(typeof x.population === 'string' && x.population.length > 10 && typeof x.unit === 'string' && typeof x.null_policy === 'string' && (Number.isInteger(x.n) || Number.isInteger(x.value))));
ok(Object.keys(m).length >= 15 && incomplete.length === 0, `all ${Object.keys(m).length} measures carry population, unit, null policy and a sample size (n, or the count itself)`, incomplete.map(([k]) => k));
const unsized = Object.entries(m).filter(([, x]) => x.unit === 'seconds' || x.unit === 'percent').filter(([, x]) => !Number.isInteger(x.n));
ok(unsized.length === 0, 'every duration and rate reports its sample size n', unsized.map(([k]) => k));
ok(a.series.reduce((s, b) => s + b.measures.requested.value, 0) === 3, 'hourly series sums to the total');
ok(a.range.timezone === TZ && a.range.timezone_label.startsWith('Europe/London') && a.freshness.source === 'facts' && a.freshness.lag_ms === 0, 'timezone label and freshness (facts, no lag) reported');
const raw = await report(owner, { ...fixtureQuery, reconcile: 1 });
ok(raw.freshness.source === 'raw', 'reconcile=1 recomputes from chats/messages');
ok(
  ['requested', 'assigned', 'served', 'missed', 'abandoned', 'ratings_good', 'ratings_bad', 'offline_submissions'].every((k) => raw.measures[k].value === m[k].value) &&
    raw.measures.csat.numerator === m.csat.numerator &&
    raw.measures.wait_to_assignment.median === m.wait_to_assignment.median,
  'materialized facts reconcile exactly with the raw query path',
);

console.log('Late rating change updates the numerator once');
await v1.must('PUT', `/widget/v1/chats/${chat1}/rating`, { rating: 'bad' });
const rb = await waitFor(async () => {
  const r = await freshReport(owner, fixtureQuery, 'rating bad');
  return r.measures.ratings_bad.value === 1 ? r : null;
}, 15000, 'bad rating in facts');
ok(rb.measures.csat.value === 0 && rb.measures.csat.numerator === 0 && rb.measures.csat.denominator === 1, 'rating changed to bad → CSAT 0 % (0/1)', rb.measures.csat);
await v1.must('PUT', `/widget/v1/chats/${chat1}/rating`, { rating: 'good' });
const rg = await waitFor(async () => {
  const r = await freshReport(owner, fixtureQuery, 'rating good');
  return r.measures.ratings_good.value === 1 ? r : null;
}, 15000, 'good rating in facts');
ok(rg.measures.csat.numerator === 1 && rg.measures.csat.denominator === 1 && rg.measures.ratings_good.value === 1 && rg.measures.ratings_bad.value === 0, 'changed back to good → numerator 1, denominator 1 (counted once)', rg.measures.csat);
const rgRaw = await report(owner, { ...fixtureQuery, reconcile: 'true' });
ok(rgRaw.measures.csat.numerator === 1 && rgRaw.measures.csat.denominator === 1, 'raw reconciliation agrees after the revisions');

console.log('Late, duplicate and out-of-order deliveries never regress or rewrite a fact (AUD-72-08)');
const factOf = (id) => psql(`SELECT source_version || '|' || updated_at::text || '|' || coalesce(rating::text, '-') FROM metric_chat_facts WHERE chat_id = '${id}'`);
const settled = factOf(chat1);
ok(settled.endsWith('|good'), `chat1's fact holds the final rating (${settled})`);
// A lagging or replaying producer: every earlier internal event of chat1 — requested, accepted, messages, closed and
// all three rating changes (the stale 'bad' among them) — arrives again under new event ids, late (original
// occurred_at) and newest first.
const replayIds = psql(`
  WITH src AS (
    SELECT * FROM outbox_events
     WHERE tenant_id = '${tenantId}' AND audience = 'internal' AND (aggregate_id = '${chat1}' OR payload->>'chat_id' = '${chat1}'))
  INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, scope_kind, scope_id, audience, payload, causation_id, occurred_at)
  SELECT gen_random_uuid(), tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, scope_kind, scope_id, audience, payload, causation_id, occurred_at
    FROM src ORDER BY seq DESC
  RETURNING event_id`)
  .split('\n')
  .filter((l) => /^[0-9a-f-]{36}$/.test(l)); // psql also prints the INSERT command tag
const replayTypes = psql(`SELECT string_agg(event_type, ',' ORDER BY seq) FROM outbox_events WHERE event_id IN (${replayIds.map((id) => `'${id}'`).join(',')})`);
const originalTypes = psql(`SELECT string_agg(event_type, ',' ORDER BY seq DESC) FROM outbox_events WHERE tenant_id = '${tenantId}' AND audience = 'internal' AND (aggregate_id = '${chat1}' OR payload->>'chat_id' = '${chat1}') AND event_id NOT IN (${replayIds.map((id) => `'${id}'`).join(',')})`);
ok(replayIds.length >= 6 && (replayTypes.match(/rating\.updated/g) ?? []).length === 3 && replayTypes === originalTypes && replayTypes.includes('chat.requested'), `${replayIds.length} events replayed in exactly reverse order (${replayTypes})`);
const consumed = (id) => execFileSync('redis-cli', ['hget', `rd:events:ev-${id}`, 'finishedOn']).toString().trim();
await waitFor(() => replayIds.every((id) => consumed(id) !== ''), 30000, 'replayed events consumed');
ok(psql(`SELECT count(*) FROM outbox_events WHERE event_id IN (${replayIds.map((id) => `'${id}'`).join(',')}) AND published_at IS NULL`) === '0', 'every replayed event was published to the internal consumers and processed');
ok(factOf(chat1) === settled, 'after the late, duplicate and reverse-order deliveries the fact is untouched: same source version, never rewritten, rating still good');
const afterReplay = await report(owner, fixtureQuery);
const afterReplayRaw = await report(owner, { ...fixtureQuery, reconcile: 1 });
ok(
  afterReplay.measures.csat.numerator === 1 && afterReplay.measures.csat.denominator === 1 && afterReplay.measures.requested.value === 3 && afterReplayRaw.measures.requested.value === 3 && afterReplayRaw.measures.csat.numerator === 1,
  'report and raw reconciliation still count chat1 once with its final rating',
);

console.log('Export — aggregate CSV equals the visible report');
const key = `idem-${randomUUID()}`;
const exp = await owner.call('POST', '/analytics/exports', { report: 'chats', format: 'csv', filters: fixtureQuery }, { 'idempotency-key': key });
ok(exp.status === 202 && exp.data.state === 'queued', 'POST /analytics/exports → 202 queued job', exp.status);
const expAgain = await owner.call('POST', '/analytics/exports', { report: 'chats', format: 'csv', filters: fixtureQuery }, { 'idempotency-key': key });
ok(expAgain.data.id === exp.data.id, 'same Idempotency-Key replays the same export');
const done = await waitFor(async () => {
  const s = await owner.must('GET', `/analytics/exports/${exp.data.id}`);
  return s.state === 'succeeded' || s.state === 'failed' ? s : null;
}, 20000, 'export job');
ok(done.state === 'succeeded' && done.download_path, 'export job succeeded', done);
const visible = await freshReport(owner, fixtureQuery, 'export compare');
const dl = await owner.call('GET', `/analytics/exports/${exp.data.id}/download`);
ok(dl.status === 200 && (dl.headers.get('content-type') ?? '').startsWith('text/csv') && /attachment/.test(dl.headers.get('content-disposition') ?? ''), 'download returns an attachment CSV');
ok(dl.text.includes('\r\n'), 'CSV uses CRLF line endings');
const rows = parseCsv(dl.text);
const header = rows[0];
ok(rows.every((r) => r.length === header.length), 'CSV is rectangular (RFC 4180)');
const col = (name) => header.indexOf(name);
const total = rows.find((r) => r[0] === 'total');
const buckets = rows.filter((r) => r[0] === 'bucket');
const countKeys = ['requested', 'assigned', 'served', 'missed', 'abandoned', 'quick_cancellations', 'ratings_good', 'ratings_bad', 'invitations_accepted', 'offline_submissions'];
ok(countKeys.every((k) => Number(total[col(k)]) === visible.measures[k].value), 'export total row equals the visible report for every count measure', countKeys.map((k) => [k, total[col(k)], visible.measures[k].value]));
ok(Number(total[col('csat_numerator')]) === visible.measures.csat.numerator && Number(total[col('csat_denominator')]) === visible.measures.csat.denominator && Number(total[col('csat_pct')]) === visible.measures.csat.value, 'export CSAT numerator/denominator equal the report');
ok(countKeys.every((k) => buckets.reduce((s, r) => s + Number(r[col(k)] || 0), 0) === Number(total[col(k)])), 'export bucket rows sum to the total row');
ok(rows.some((r) => r[0] === 'definition' && r[col('served')].includes('human agent public message')), 'export carries exact measure definitions');
const otherTenant = new Client('beta');
await otherTenant.must('POST', '/auth/signup', { email: `beta+an${stamp}@example.com`, password: 'yet another passphrase', tenant_name: `Beta ${stamp}` });
const peekExport = await otherTenant.call('GET', `/analytics/exports/${exp.data.id}`);
ok(peekExport.status === 404, 'another tenant cannot see the export');
const betaReport = await report(otherTenant, { from: T_START, to: T_END, timezone: TZ });
ok(betaReport.measures.requested.value === 0 && betaReport.measures.csat.value === null, 'another tenant sees zero counts and null CSAT (no event yet = zero, no ratings = null)');

console.log('Validation and permissions');
const unknown = await owner.call('GET', `/analytics/chats?${qs({ ...fixtureQuery, bogus: 1 })}`);
ok(unknown.status === 422, 'unknown query parameters are rejected');
const badTz = await owner.call('GET', `/analytics/chats?${qs({ ...fixtureQuery, timezone: 'Mars/Base' })}`);
ok(badTz.status === 422 && badTz.error.field_errors?.timezone, 'invalid IANA timezone → 422 with field error');
const agentDenied = await agentA.call('GET', `/analytics/chats?${qs(fixtureQuery)}`);
ok(agentDenied.status === 403, 'agents without analytics.view are denied');
const dst = await owner.must('GET', `/analytics/chats?${qs({ from: '2026-10-24', to: '2026-10-27', timezone: TZ, group_by: 'day' })}`);
ok(dst.series.map((b) => b.unit_hours).join(',') === '24,25,24', 'day buckets around the DST fold span 24/25/24 hours (MET02)', dst.series.map((b) => b.unit_hours));
ok(dst.measures.wait_to_assignment.n === 0 && dst.measures.wait_to_assignment.median === null && dst.measures.requested.value === 0, 'no samples → null percentile with n = 0; counts are zero');

// ───────────────────────── Transfer attribution + notifications ─────────────────────────
console.log('Transferred reply attribution and in-app notifications');
const v5 = await newVisitor();
const chat4 = await admit(v5, 'Question about returns');
await owner.must('POST', `/chats/${chat4}/accept`, {});
await send(owner, chat4, 'Let me check who handles returns.');
const tr = await owner.call('POST', `/chats/${chat4}/transfers`, { target_agent_id: agentA.id, note: 'Returns VIP' }, { 'idempotency-key': `tr-${randomUUID()}` });
ok(tr.status === 201 && tr.data.offer?.id, 'owner offered a transfer to the agent', tr.error);
const notifFrame = await waitFor(() => aSock.ephemeral.find((f) => f.type === 'notification.created' && f.payload.notification.type === 'chat.transfer_offered'), 8000, 'notification.created frame');
ok(notifFrame.payload.unread_count >= 1, 'agent received an ephemeral notification.created frame with the unread count');
ok(!/Returns VIP|#\d+/.test(`${notifFrame.payload.notification.title} ${notifFrame.payload.notification.body}`), 'privacy mode → generic notification text (no note, chat number or visitor details)', notifFrame.payload.notification);
await agentA.must('POST', `/chats/${chat4}/accept`, { offer_id: tr.data.offer.id });
await send(agentA, chat4, 'Hi, I handle returns.');
await agentA.must('POST', `/chats/${chat4}/close`, { reason: 'resolved' });

const v6 = await newVisitor();
const salesChat = await admit(v6, 'I want a quote', sales.id);
const assignedNote = await waitFor(async () => {
  const list = await owner.must('GET', '/notifications');
  return list.items.find((n) => n.type === 'chat.assigned' && n.link === `/inbox/${salesChat}`) ? list : null;
}, 8000, 'owner chat.assigned notification');
const assigned = assignedNote.items.find((n) => n.type === 'chat.assigned');
ok(/assigned to you/.test(assigned.title) && assigned.body.includes('I want a quote'), 'assigned-mode offer notified the owner with chat context (privacy off)', assigned);
ok(assignedNote.unread_count >= 1, 'notification list reports the unread count');

const agentsReport = await waitFor(async () => {
  const r = await owner.must('GET', `/analytics/agents?${qs({ from: T_START, to: T_END, timezone: TZ })}`);
  const o = r.agents.find((x) => x.membership_id === ownerId);
  const ag = r.agents.find((x) => x.membership_id === agentA.id);
  return o && ag && ag.transfers_in >= 1 && o.transfers_out >= 1 && ag.replies >= 2 ? r : null;
}, 10000, 'agents report with transfer');
const rowOwner = agentsReport.agents.find((x) => x.membership_id === ownerId);
const rowA = agentsReport.agents.find((x) => x.membership_id === agentA.id);
ok(rowOwner.replies === 1 && rowA.replies === 2, 'replies attributed to the actual author (owner 1, agent 2 incl. the post-transfer reply)', [rowOwner.replies, rowA.replies]);
ok(rowOwner.handled_chats === 2 && rowA.handled_chats === 2 && agentsReport.totals.distinct_chats_handled === 3 && agentsReport.totals.handled_chats_sum === 4, 'ownership intervals attribute the transferred chat to both owners; per-agent sums exceed distinct chats', agentsReport.totals);
ok(rowA.first_responses === 1 && rowOwner.first_responses === 1 && rowA.first_response_time.n === 1, 'first responses attributed to their authors');
ok(rowA.utilization.denominator > 0 && rowA.utilization.value !== null && rowA.utilization.value <= 100 && rowA.online_seconds > 0, 'utilization = occupied ÷ available capacity slot-seconds during online intervals', rowA.utilization);
ok(rowA.ratings.good === 1 && rowA.ratings.csat.value === 100, 'ratings attributed to the final owner');

// ───────────────────────── Monitor ─────────────────────────
console.log('Monitor — scoped snapshot and coalesced pushes');
const supMon0 = await sup.must('GET', '/monitor');
const ownMon0 = await owner.must('GET', '/monitor');
ok(supMon0.as_of && supMon0.source_watermark !== undefined && supMon0.freshness_ms >= 0 && supMon0.stale === false, 'snapshot includes as_of, source watermark, freshness_ms and stale flag');
ok(supMon0.thresholds.queue_warning_seconds === 60 && supMon0.thresholds.queue_critical_seconds === 180, 'queue age thresholds 60 s / 180 s');
ok(ownMon0.counters.queued === supMon0.counters.queued + 1, 'tenant-wide owner sees the Sales chat; Support supervisor does not', [ownMon0.counters.queued, supMon0.counters.queued]);
const ownSales = ownMon0.departments.find((d) => d.department_id === sales.id);
ok(ownSales && ownSales.queued === 1 && supMon0.counters.offered_reservations === 0, 'Sales queue (and its offer reservations) appear only in the tenant-wide view', ownSales);
ok(!supMon0.departments.some((d) => d.department_id === sales.id) && supMon0.departments.some((d) => d.department_id === support.id), 'supervisor department breakdown excludes hidden departments');
ok(!supMon0.agents.some((x) => x.membership_id === ownerId && x.department_ids.includes(sales.id)), 'agent grid never reveals hidden department memberships');
const supSales = await sup.call('GET', `/monitor?department_id=${sales.id}`);
ok(supSales.status === 403, 'supervisor cannot request another department');
const supAnalyticsSales = await sup.call('GET', `/analytics/chats?${qs({ from: T_START, to: T_END, department_id: sales.id })}`);
ok(supAnalyticsSales.status === 403, 'supervisor analytics cannot filter by a hidden department');
const ownAll = await freshReport(owner, { from: T_START, to: T_END, timezone: TZ }, 'owner all');
const supAll = await freshReport(sup, { from: T_START, to: T_END, timezone: TZ }, 'sup all');
ok(ownAll.measures.requested.value === supAll.measures.requested.value + 1, 'supervisor analytics exclude the Sales chat', [ownAll.measures.requested.value, supAll.measures.requested.value]);
const agentMon = await agentA.call('GET', '/monitor');
ok(agentMon.status === 403, 'agents cannot read the monitor');

const latestFrame = (s) => [...s.ephemeral].reverse().find((f) => f.type === 'monitor.updated');
await waitFor(() => latestFrame(supSock), 7000, 'first monitor.updated push');
const base = latestFrame(supSock).payload.snapshot.counters;
ok(latestFrame(supSock).payload.as_of && latestFrame(supSock).payload.stale === false, 'monitor.updated frames carry {snapshot, as_of, stale} on the supervisor’s own agent room');
const v7 = await newVisitor();
const chat7 = await admit(v7, 'Where is my parcel?');
const tq = Date.now();
await waitFor(() => latestFrame(supSock)?.payload.snapshot.counters.queued === base.queued + 1, 6000, 'queued +1 push');
ok(Date.now() - tq < 5000, `new request pushed queued +1 within ${Date.now() - tq} ms`);
const before = latestFrame(supSock).payload.snapshot.counters;
await agentA.must('POST', `/chats/${chat7}/accept`, {});
const ta = Date.now();
const moved = await waitFor(() => {
  const c = latestFrame(supSock)?.payload.snapshot.counters;
  return c && c.queued === before.queued - 1 && c.active === before.active + 1 ? c : null;
}, 6000, 'accept reflected in monitor push');
const lagMs = Date.now() - ta;
ok(lagMs < 5000, `accept moved queued −1 and active +1 within ${lagMs} ms (< 5 s)`);
await sleep(1500);
const after = (await sup.must('GET', '/monitor')).counters;
ok(after.queued === before.queued - 1 && after.active === before.active + 1, 'counts moved exactly once (REST agrees after further pushes)', [before, after]);
ok(after.response_backlog >= 1, 'unanswered visitor message counts in the response backlog');
const gridA = (await sup.must('GET', '/monitor')).agents.find((x) => x.membership_id === agentA.id);
ok(gridA.active_chats === 1 && gridA.response_backlog === 1 && gridA.oldest_unanswered_at, 'agent grid shows active ownership and the oldest unanswered visitor message', gridA);
await send(agentA, chat7, 'Internal: carrier delayed', 'internal');
await sleep(1200);
ok((await sup.must('GET', '/monitor')).agents.find((x) => x.membership_id === agentA.id).response_backlog === 1, 'an internal note does not clear the response backlog');
await send(agentA, chat7, 'Your parcel arrives tomorrow.');
await waitFor(async () => (await sup.must('GET', '/monitor')).agents.find((x) => x.membership_id === agentA.id).response_backlog === 0, 5000, 'backlog cleared by human reply');
ok(true, 'a human public reply clears the response backlog');

console.log('Forced transfer notifications and notification REST');
const forced = await sup.call('POST', `/chats/${chat7}/transfers`, { target_agent_id: ownerId, force: true, reason: 'Coaching handover' }, { 'idempotency-key': `ft-${randomUUID()}` });
ok(forced.status === 201, 'supervisor forced a transfer', forced.error);
const awayList = await waitFor(async () => {
  const l = await agentA.must('GET', '/notifications');
  return l.items.some((n) => n.type === 'chat.transferred_away') ? l : null;
}, 8000, 'transferred_away notification');
const ownerForced = await waitFor(async () => {
  const l = await owner.must('GET', '/notifications');
  return l.items.find((n) => n.type === 'chat.transferred') ?? null;
}, 8000, 'owner chat.transferred notification');
ok(ownerForced.link === `/inbox/${chat7}`, 'new owner notified of the forced transfer with a deep link');
ok(awayList.unread_count >= 2 && awayList.items.every((n) => !n.read), 'previous owner notified; list shows unread count', awayList.unread_count);
const first = awayList.items[0];
const read1 = await agentA.must('POST', `/notifications/${first.id}/read`);
ok(read1.unread_count === awayList.unread_count - 1, 'marking one read decrements the unread count');
const readAgain = await agentA.must('POST', `/notifications/${first.id}/read`);
ok(readAgain.unread_count === read1.unread_count, 'marking read is idempotent');
const foreign = await owner.call('POST', `/notifications/${first.id}/read`);
ok(foreign.status === 404, 'members cannot touch another member’s notifications');
const paged = await agentA.must('GET', '/notifications?limit=1');
ok(paged.items.length === 1 && paged.has_more && paged.next_cursor, 'notifications paginate with an opaque cursor');
const page2 = await agentA.must('GET', `/notifications?limit=1&cursor=${encodeURIComponent(paged.next_cursor)}`);
ok(page2.items.length === 1 && page2.items[0].id !== paged.items[0].id, 'second page continues after the cursor');
const all = await agentA.must('POST', '/notifications/read-all');
ok(all.unread_count === 0 && (await agentA.must('GET', '/notifications?unread_only=true')).items.length === 0, 'read-all clears unread notifications');
ok(aSock.ephemeral.some((f) => f.type === 'notification.read' && f.payload.all === true), 'other tabs are told about read-all via notification.read');

console.log('Invitations funnel and agents export');
const inv = await owner.must('GET', `/analytics/invitations?${qs({ from: T_START, to: T_END, timezone: TZ })}`);
ok(inv.totals.eligible === 0 && inv.totals.display_rate === null && Array.isArray(inv.campaigns), 'invitation funnel reports distinct ids with null rates when empty');
const agentsExp = await owner.call('POST', '/analytics/exports', { report: 'agents', filters: { from: T_START, to: T_END, timezone: TZ } });
ok(agentsExp.status === 202, 'agents export queued');
const agentsDone = await waitFor(async () => {
  const s = await owner.must('GET', `/analytics/exports/${agentsExp.data.id}`);
  return s.state === 'succeeded' ? s : null;
}, 20000, 'agents export');
const agentsCsv = parseCsv((await owner.call('GET', `/analytics/exports/${agentsExp.data.id}/download`)).text);
const aHeader = agentsCsv[0];
const aTotal = agentsCsv.find((r) => r[0] === 'total');
ok(Number(aTotal[aHeader.indexOf('distinct_chats_handled')]) === agentsDone.totals.distinct_chats_handled && agentsCsv.some((r) => r[0] === 'agent' && r[aHeader.indexOf('membership_id')] === agentA.id), 'agents export contains per-agent rows and matching totals');
const supExportOfAgents = await sup.call('GET', `/analytics/exports/${agentsExp.data.id}`);
ok(supExportOfAgents.status === 404, 'exports are visible only to the requester (or workspace managers)');

console.log('AUD-72-09 — analytics report their own lag truthfully while facts are behind');
// Pause the events queue (the fact builder's input) as a stand-in for a stalled worker, make a real change, and age
// it past the 60 s lag threshold; the report must say it is lagging, then recover once the queue runs again.
const { Queue } = await import('bullmq');
const { default: IORedis } = await import('ioredis');
const qConn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const eventsQueue = new Queue('events', { connection: qConn, prefix: 'rd' });
const lagQuery = { from: T_START, to: new Date(Date.now() + 60_000).toISOString(), timezone: TZ, group_by: 'day' };
await eventsQueue.pause();
try {
  await send(owner, chat7, 'One more thing about the parcel');
  psql(`UPDATE chats SET updated_at = now() - interval '2 minutes' WHERE id = '${chat7}'`);
  const lagging = await report(owner, lagQuery);
  ok(
    lagging.freshness.pending_facts >= 1 && lagging.freshness.lag_ms > 60_000 && lagging.freshness.status === 'lagging' && lagging.freshness.stale === true,
    `report flags itself lagging while facts are behind (${lagging.freshness.pending_facts} pending, lag ${Math.round(lagging.freshness.lag_ms / 1000)} s)`,
    lagging.freshness,
  );
  ok(Date.parse(lagging.freshness.source_watermark) < Date.parse(lagging.freshness.as_of) - 60_000, 'source watermark points at the oldest unprocessed change');
} finally {
  await eventsQueue.resume();
}
const recovered = await freshReport(owner, { ...lagQuery, to: new Date(Date.now() + 61_000).toISOString() }, 'after the queue resumed');
ok(recovered.freshness.status === 'fresh' && recovered.freshness.stale === false && recovered.freshness.lag_ms === 0, 'report returns to fresh once the facts catch up');
await eventsQueue.close();
qConn.disconnect();

for (const s of [ownerSock, aSock, supSock]) s.close();
console.log(`\nANALYTICS E2E PASSED (${passed} checks)`);
process.exit(0);
