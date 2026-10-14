// Schedules, emergency closures, offline forms and queue overflow — end-to-end against a
// running api + worker (node test/offline.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis.
// Run the worker with an unreachable SMTP server (e.g. EMAIL_PROVIDER=smtp SMTP_PORT=1) to
// exercise OFF01 (SMTP outage still saves the submission and keeps the email retriable).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const REDIS_DB = (process.env.REDIS_URL ?? '').match(/\/(\d+)$/)?.[1] ?? '0';
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
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
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
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
      else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error, page: json?.page };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

function latestEmail(to, template) {
  return sql(
    `SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
}
const tokenFrom = (text, param) =>
  decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket },
    forceNew: true,
  });
  s.frames = [];
  s.ephemeral = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('ephemeral', (f) => s.ephemeral.push({ ...f, receivedAt: Date.now() }));
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

async function newVisitor(siteKey, label) {
  const c = new Client(label);
  const sess = await c.must('POST', '/widget/v1/sessions', {
    site_key: siteKey,
    host_origin: ORIGIN,
    consent: { analytics: false, policy_version: '2026-10' },
  });
  c.auth = { authorization: `Bearer ${sess.capability}` };
  c.visitorId = sess.visitor?.id ?? sess.visitor_id;
  const t = await c.must('POST', '/widget/v1/socket-ticket', undefined, c.auth);
  c.sock = await socket('/visitor', t.ticket);
  return c;
}

// Isolated test environment only: reset offline rate-limit windows so reruns within the hour work.
try {
  const keys = execFileSync('redis-cli', ['-n', REDIS_DB, '--scan', '--pattern', 'rl:offline:*'])
    .toString()
    .split('\n')
    .filter(Boolean);
  if (keys.length) execFileSync('redis-cli', ['-n', REDIS_DB, 'del', ...keys]);
} catch {
  /* redis-cli unavailable: limits still apply */
}

const stamp = Date.now();
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `sched-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', {
  email: ownerEmail,
  password: 'correct horse battery',
  tenant_name: `Hours ${stamp}`,
  timezone: 'Europe/London',
});
const tenantId = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', {
  token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token'),
});
const site = await owner.must('POST', '/sites', {
  name: 'Hours store',
  origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
});
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const sales = await owner.must('POST', '/departments', {
  name: 'Sales',
  public_label: 'Sales',
  max_wait_seconds: 3,
});
const agentEmail = `sched-agent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', {
  email: agentEmail,
  role: 'agent',
  department_ids: [sales.id],
  capacity: 2,
});
const salesAgent = new Client('salesAgent');
await salesAgent.must('POST', '/agents/invitations/accept', {
  token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'),
  display_name: 'Sal Agent',
  password: 'another strong passphrase',
});
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
await ownerSock.emitWithAck('subscribe', {
  scopes: [
    { kind: 'queue', id: 'none' },
    { kind: 'queue', id: support.id },
    { kind: 'queue', id: sales.id },
    { kind: 'team', id: 'all' },
  ],
});
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
ok(true, 'tenant, site, Support/Sales departments, sales-only agent and connected owner ready');

console.log('Schedules (ch. 22/42)');
const bad = await owner.call('POST', '/schedules', {
  name: 'Bad',
  timezone: 'Mars/Olympus',
  weekly_intervals: {},
});
ok(bad.status === 422 && bad.error.field_errors.timezone, 'unknown IANA timezone rejected');
const offset = await owner.call('POST', '/schedules', {
  name: 'Bad',
  timezone: '+05:00',
  weekly_intervals: {},
});
ok(offset.status === 422, 'numeric offset rejected (timezone names only)');
const overlap = await owner.call('POST', '/schedules', {
  name: 'Overlap',
  timezone: 'UTC',
  weekly_intervals: { mon: [{ start: '22:00', end: '03:00' }], tue: [{ start: '02:00', end: '05:00' }] },
});
ok(
  overlap.status === 422 && overlap.error.field_errors['weekly_intervals.tue.0'],
  'overnight interval overlapping the next day rejected with a field error',
);
const ny = await owner.must(
  'POST',
  '/schedules',
  {
    name: 'New York',
    timezone: 'America/New_York',
    weekly_intervals: {
      sun: [{ start: '02:30', end: '12:00' }],
      mon: [{ start: '09:00', end: '17:00' }],
      fri: [{ start: '20:00', end: '02:00' }],
    },
  },
  { 'idempotency-key': `sched-${stamp}-create-ny` },
);
ok(
  ny.version === 1 && ny.weekly_intervals.sun.length === 1 && ny.weekly_intervals.tue.length === 0,
  'schedule created with all seven weekdays normalized',
);
const nyAgain = await owner.must(
  'POST',
  '/schedules',
  {
    name: 'New York',
    timezone: 'America/New_York',
    weekly_intervals: {
      sun: [{ start: '02:30', end: '12:00' }],
      mon: [{ start: '09:00', end: '17:00' }],
      fri: [{ start: '20:00', end: '02:00' }],
    },
  },
  { 'idempotency-key': `sched-${stamp}-create-ny` },
);
ok(nyAgain.id === ny.id, 'Idempotency-Key replays the original create');
const nyDetail = await owner.must('GET', `/schedules/${ny.id}`);
ok(
  nyDetail.usage.departments.length === 0 &&
    Array.isArray(nyDetail.exceptions) &&
    typeof nyDetail.state.open === 'boolean' &&
    nyDetail.state.next_boundary?.local_label,
  'schedule detail returns usage, exceptions and the next boundary with a local label',
);
ok(
  (await owner.call('GET', `/schedules/${ny.id}/preview?days=32`)).status === 422,
  'preview limited to 31 days',
);
const preview = await owner.must('GET', `/schedules/${ny.id}/preview?from=2026-03-07T00:00:00Z&days=7`);
const gapOpen = preview.boundaries.find((b) => b.local_date === '2026-03-08' && b.kind === 'open');
ok(
  gapOpen.at === '2026-03-08T07:00:00.000Z' &&
    gapOpen.local === '2026-03-08T03:00:00' &&
    /does not exist/.test(gapOpen.note),
  'preview: spring-forward 02:30 opening resolves to first valid instant 03:00 EDT with a DST note',
);
ok(
  preview.transitions.length === 1 && preview.transitions[0].kind === 'forward',
  'preview highlights the DST transition',
);
const fold = await owner.must('GET', `/schedules/${ny.id}/preview?from=2026-10-30T00:00:00Z&days=3`);
const friClose = fold.boundaries.find((b) => b.kind === 'close' && b.local_date === '2026-10-30');
ok(friClose.at === '2026-10-31T06:00:00.000Z', 'overnight Fri 20:00–02:00 closes Saturday 02:00 local');
const noPre = await owner.call('PATCH', `/schedules/${ny.id}`, { name: 'NYC' });
ok(
  noPre.status === 428 && noPre.error.code === 'PRECONDITION_REQUIRED',
  'PATCH without If-Match/expected_version → 428',
);
const patched = await owner.must(
  'PATCH',
  `/schedules/${ny.id}`,
  {
    name: 'NYC',
    weekly_intervals: {
      mon: [{ start: '09:00', end: '18:00' }],
      thu: [{ start: '09:00', end: '17:00' }],
      fri: [{ start: '09:00', end: '17:00' }],
    },
  },
  { 'if-match': '"1"' },
);
ok(
  patched.applied && patched.schedule.version === 2 && patched.schedule.weekly_intervals.sun.length === 0,
  'versioned PATCH with If-Match applied (version 2)',
);
const stale = await owner.call('PATCH', `/schedules/${ny.id}`, { name: 'Stale', expected_version: 1 });
ok(
  stale.status === 409 && stale.error.code === 'VERSION_CONFLICT',
  'stale expected_version → 409 VERSION_CONFLICT',
);
const holiday = await owner.must('PUT', `/schedules/${ny.id}/exceptions/2026-12-25`, {
  intervals: [],
  reason: 'Christmas',
});
ok(
  holiday.exception.closed === true && holiday.schedule_version === 3,
  'holiday exception (empty intervals = closed) bumps the schedule version',
);
const xmas = await owner.must('GET', `/schedules/${ny.id}/preview?from=2026-12-24T00:00:00Z&days=3`);
ok(
  !xmas.boundaries.some((b) => b.local_date === '2026-12-25') &&
    xmas.boundaries.some((b) => b.local_date === '2026-12-24'),
  'exception replaces the weekly hours for that local date only',
);
const badEx = await owner.call('PUT', `/schedules/${ny.id}/exceptions/2026-02-30`, { intervals: [] });
ok(badEx.status === 422, 'invalid calendar date rejected');
const special = await owner.must('PUT', `/schedules/${ny.id}/exceptions/2026-12-24`, {
  intervals: [{ start: '10:00', end: '13:00' }],
  reason: 'Christmas Eve',
});
ok(special.exception.intervals.length === 1, 'special hours exception stored');
const delEx = await owner.call('DELETE', `/schedules/${ny.id}/exceptions/2026-12-24`);
ok(delEx.status === 204, 'exception removed (204)');
await owner.must('PATCH', '/departments/' + sales.id, { schedule_id: ny.id });
const inUse = await owner.call('POST', `/schedules/${ny.id}/archive`, {});
ok(
  inUse.status === 409 && inUse.error.details.departments.some((d) => d.id === sales.id),
  'archiving a schedule still used by a department → 409 with usage',
);
await owner.must('PATCH', '/departments/' + sales.id, { schedule_id: null });
const archived = await owner.must('POST', `/schedules/${ny.id}/archive`, {});
ok(!!archived.archived_at, 'unused schedule archived');
const list = await owner.call('GET', '/schedules');
ok(
  list.status === 200 && !list.data.some((s) => s.id === ny.id) && list.page,
  'archived schedules hidden from the default list (cursor page)',
);
const agentSched = await salesAgent.call('POST', '/schedules', {
  name: 'Nope',
  timezone: 'UTC',
  weekly_intervals: {},
});
ok(agentSched.status === 403, 'agents cannot manage schedules');

console.log('Offline form (ch. 23, OFF01)');
const v1 = await newVisitor(site.public_key, 'visitor1');
const rid = randomUUID();
const form = {
  client_request_id: rid,
  name: 'Olive Offline',
  email: 'Olive@Example.com',
  phone: '+44 (20) 7946-0000',
  message: 'Please call me back about my order 👋',
  department_id: support.id,
};
const missing = await v1.call(
  'POST',
  '/widget/v1/offline-submissions',
  { ...form, client_request_id: randomUUID(), email: '' },
  v1.auth,
);
ok(
  missing.status === 422 && missing.error.field_errors.email,
  'email required by default (field error, visitor can retry)',
);
const badDept = await v1.call(
  'POST',
  '/widget/v1/offline-submissions',
  { ...form, client_request_id: randomUUID(), department_id: randomUUID() },
  v1.auth,
);
ok(
  badDept.status === 422 && badDept.error.details.departments.some((d) => d.id === support.id),
  'invalid department offers the current choices',
);
const badField = await v1.call(
  'POST',
  '/widget/v1/offline-submissions',
  { ...form, client_request_id: randomUUID(), fields: { secret_admin_flag: 'x' } },
  v1.auth,
);
ok(
  badField.status === 422 && Object.keys(badField.error.field_errors).some((k) => k.startsWith('fields.')),
  'undeclared custom fields rejected',
);
const badPhone = await v1.call(
  'POST',
  '/widget/v1/offline-submissions',
  { ...form, client_request_id: randomUUID(), phone: 'call me' },
  v1.auth,
);
ok(badPhone.status === 422 && badPhone.error.field_errors.phone, 'phone restricted to digits/space/+()-.');
const [s1, s2] = await Promise.all([
  v1.call('POST', '/widget/v1/offline-submissions', form, v1.auth),
  v1.call('POST', '/widget/v1/offline-submissions', form, v1.auth),
]);
const firstOk = [s1, s2].find((r) => r.status === 201);
ok(
  firstOk &&
    /^R-[0-9A-HJKMNP-TV-Z]{8}$/.test(firstOk.data.reference) &&
    firstOk.data.status === 'received' &&
    firstOk.data.id &&
    firstOk.data.created_at,
  `submission saved with reference ${firstOk?.data.reference} ({id, reference, status, created_at})`,
);
ok(
  s1.status === 201 && s2.status === 201 && s1.data.reference === s2.data.reference,
  'concurrent double submit → both 201 with the same reference',
);
const s3 = await v1.call('POST', '/widget/v1/offline-submissions', form, v1.auth);
ok(
  s3.status === 201 && s3.data.reference === firstOk.data.reference,
  'identical retry replays the same reference',
);
ok(
  sql(
    `SELECT count(*) FROM offline_submissions WHERE tenant_id = '${tenantId}' AND message LIKE 'Please call me back%'`,
  ) === '1',
  'double submit produced exactly one record',
);
const subId = firstOk.data.id;
const stored = sql(
  `SELECT email_ciphertext LIKE 'v1:%', email_lookup_hash <> '', custom_fields::text NOT LIKE '%7946%' FROM offline_submissions WHERE id = '${subId}'`,
);
ok(stored === 't|t|t', 'email encrypted with lookup hash; phone encrypted inside custom_fields');
const emails = await waitFor(
  () => {
    const rows = sql(
      `SELECT template || ':' || recipient FROM outbound_emails WHERE tenant_id = '${tenantId}' AND dedupe_key LIKE '%${subId}%' ORDER BY template`,
    )
      .split('\n')
      .filter(Boolean);
    return rows.length >= 2 ? rows : null;
  },
  10000,
  'offline notification emails',
);
ok(
  emails.includes('offline_confirmation:olive@example.com') &&
    emails.includes(`offline_team_notification:${ownerEmail}`),
  'confirmation + team notification rows created by the worker consumer',
);
ok(
  !sql(`SELECT text_body FROM outbound_emails WHERE dedupe_key LIKE '%${subId}%'`).includes('7946'),
  'phone number never appears in emails',
);
const smtp = await waitFor(
  () => {
    const r = sql(
      `SELECT status, attempts FROM outbound_emails WHERE template = 'offline_confirmation' AND dedupe_key LIKE '%${subId}%'`,
    );
    return r && r !== 'queued|0' ? r : null;
  },
  15000,
  'first SMTP attempt',
);
console.log(`    (confirmation email after first delivery attempt: ${smtp})`);
ok(
  sql(`SELECT count(*) FROM offline_submissions WHERE id = '${subId}'`) === '1',
  'submission remains saved regardless of SMTP outcome (retriable delivery)',
);
await waitFor(
  () => ownerSock.frames.find((f) => f.type === 'offline.submitted' && f.payload.submission.id === subId),
  5000,
  'offline.submitted on queue scope',
);
ok(
  !JSON.stringify(ownerSock.frames.find((f) => f.type === 'offline.submitted')).includes('olive@'),
  'offline.submitted delivered to the staff queue scope without the email address',
);

const v2 = await newVisitor(site.public_key, 'visitor2');
const salesSub = await v2.must(
  'POST',
  '/widget/v1/offline-submissions',
  {
    client_request_id: randomUUID(),
    email: 'sam@example.com',
    message: 'Pricing question',
    department_id: sales.id,
  },
  v2.auth,
);
const ownerList = await owner.call('GET', '/offline-submissions');
ok(
  ownerList.data.some((s) => s.id === subId) &&
    ownerList.data.some((s) => s.id === salesSub.id) &&
    ownerList.data[0].email_masked.includes('***'),
  'owner list sees all departments (masked email)',
);
const agentList = await salesAgent.call('GET', '/offline-submissions');
ok(
  agentList.data.some((s) => s.id === salesSub.id) && !agentList.data.some((s) => s.id === subId),
  'sales agent list is department scoped',
);
ok(
  (await salesAgent.call('GET', `/offline-submissions/${subId}`)).status === 404,
  'out-of-scope submission is 404 for the agent',
);
ok(
  (await salesAgent.call('GET', `/offline-submissions?department_id=${support.id}`)).status === 403,
  'filtering by an unserved department is denied',
);
const detail = await owner.must('GET', `/offline-submissions/${subId}`);
ok(
  detail.email === 'olive@example.com' &&
    detail.phone === '+44 (20) 7946-0000' &&
    detail.message.includes('👋'),
  'authorized staff see decrypted email and phone',
);
const replyKey = `reply-${stamp}-0000000001`;
const replied = await owner.must(
  'POST',
  `/offline-submissions/${subId}/reply`,
  { body: 'Thanks Olive, we will call you today.' },
  { 'idempotency-key': replyKey },
);
ok(
  replied.status === 'handled' && replied.handled_at && replied.handled_by && replied.replies.length === 1,
  'reply sends offline_reply and records handled_at/handled_by',
);
const replyAgain = await owner.must(
  'POST',
  `/offline-submissions/${subId}/reply`,
  { body: 'Thanks Olive, we will call you today.' },
  { 'idempotency-key': replyKey },
);
ok(
  replyAgain.replies.length === 1 &&
    sql(
      `SELECT count(*) FROM outbound_emails WHERE template = 'offline_reply' AND dedupe_key LIKE '%${subId}%'`,
    ) === '1',
  'retried reply (same key) sends no duplicate email',
);
ok(
  sql(
    `SELECT count(*) FROM audit_events WHERE tenant_id = '${tenantId}' AND action = 'offline_submission.replied' AND object_id = '${subId}'`,
  ) === '1',
  'reply audited once',
);
const reopenNoPre = await owner.call('PATCH', `/offline-submissions/${subId}`, { status: 'received' });
ok(reopenNoPre.status === 428, 'status PATCH requires a precondition');
const reopened = await owner.must('PATCH', `/offline-submissions/${subId}`, {
  status: 'received',
  expected_version: replied.version,
});
ok(
  reopened.status === 'received' && reopened.handled_at === null,
  'status PATCH back to received clears handled fields',
);

console.log('Queue overflow & conversion (ROUTE04)');
await owner.must('PATCH', `/departments/${support.id}`, {
  max_wait_seconds: 3,
  fallback_department_id: sales.id,
});
const cyc = await owner.call('PATCH', `/departments/${sales.id}`, { fallback_department_id: support.id });
ok(cyc.status === 409, 'fallback cycle Support→Sales→Support cannot be saved');
const v3 = await newVisitor(site.public_key, 'visitor3');
const chatReq = await v3.call(
  'POST',
  '/widget/v1/chats',
  { client_request_id: randomUUID(), message: 'Anyone there?', department_id: support.id },
  v3.auth,
);
ok(chatReq.status === 201, 'visitor queued in Support');
const chatId = chatReq.data.chat.id;
await v3.sock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
const requestedAt = sql(`SELECT requested_at FROM chats WHERE id = '${chatId}'`);
const exceeded = await waitFor(
  () => v3.sock.ephemeral.find((f) => f.type === 'queue.wait_exceeded' && f.payload.chat_id === chatId),
  10000,
  'queue.wait_exceeded',
);
ok(
  exceeded.payload.options.join(',') === 'continue,offline_form' && exceeded.payload.waited_seconds >= 3,
  'visitor offered continue/offline_form after max wait (ephemeral, public chat room)',
);
await waitFor(
  () => sql(`SELECT department_id FROM chats WHERE id = '${chatId}'`) === sales.id,
  5000,
  'fallback to Sales',
);
ok(
  sql(`SELECT status || '|' || requested_at FROM chats WHERE id = '${chatId}'`) === `queued|${requestedAt}`,
  'fallback applied: chat still queued in Sales, requested_at unchanged',
);
await sleep(4500);
ok(
  sql(
    `SELECT count(*) FROM assignment_history WHERE chat_id = '${chatId}' AND reason = 'max_wait_fallback'`,
  ) === '1',
  'fallback applied exactly once (no loop)',
);
ok(
  Number(
    sql(
      `SELECT count(*) FROM assignment_history WHERE chat_id = '${chatId}' AND reason = 'max_wait_exceeded'`,
    ),
  ) === 2 && v3.sock.ephemeral.filter((f) => f.type === 'queue.wait_exceeded').length >= 2,
  'Sales wait also exceeded → offered again, never closed silently',
);
ok(
  sql(`SELECT status FROM chats WHERE id = '${chatId}'`) === 'queued',
  'chat still waiting until the visitor chooses',
);
const conv = await v3.call(
  'POST',
  '/widget/v1/offline-submissions',
  {
    client_request_id: randomUUID(),
    email: 'queue@example.com',
    message: 'I will leave a message instead',
    source_chat_id: chatId,
  },
  v3.auth,
);
ok(
  conv.status === 201 &&
    conv.data.source_chat_id === chatId &&
    conv.data.conversion_reason === 'max_wait_exceeded',
  'queue → offline conversion returns the reference with conversion reason',
);
const atomic = sql(
  `SELECT c.status, c.close_reason, o.department_id, (c.xmin::text = o.xmin::text) FROM chats c JOIN offline_submissions o ON o.source_chat_id = c.id WHERE c.id = '${chatId}'`,
);
ok(
  atomic === `closed|converted_offline|${sales.id}|t`,
  'chat closed (converted_offline) and submission written by the SAME transaction (equal xmin)',
);
await waitFor(
  () =>
    v3.sock.frames.find((f) => f.type === 'chat.closed' && f.payload.public_reason === 'converted_offline'),
  5000,
  'chat.closed to visitor',
);
ok(true, 'visitor received chat.closed with public reason converted_offline');
const conv2 = await v3.call(
  'POST',
  '/widget/v1/offline-submissions',
  { client_request_id: randomUUID(), email: 'queue@example.com', message: 'again', source_chat_id: chatId },
  v3.auth,
);
ok(
  conv2.status === 409 && conv2.error.code === 'CHAT_CLOSED',
  'converting an already closed chat → 409 CHAT_CLOSED',
);
const v4 = await newVisitor(site.public_key, 'visitor4');
const chat4 = (
  await v4.must(
    'POST',
    '/widget/v1/chats',
    { client_request_id: randomUUID(), message: 'hi', department_id: support.id },
    v4.auth,
  )
).chat.id;
await owner.must('POST', `/chats/${chat4}/accept`, {});
const conv4 = await v4.call(
  'POST',
  '/widget/v1/offline-submissions',
  { client_request_id: randomUUID(), email: 'v4@example.com', message: 'late', source_chat_id: chat4 },
  v4.auth,
);
ok(
  conv4.status === 409 &&
    sql(`SELECT status FROM chats WHERE id = '${chat4}'`) === 'active' &&
    sql(`SELECT count(*) FROM offline_submissions WHERE source_chat_id = '${chat4}'`) === '0',
  'conversion after an agent accepted is rejected atomically (chat active, no submission)',
);
const foreign = await v1.call(
  'POST',
  '/widget/v1/offline-submissions',
  { client_request_id: randomUUID(), email: 'x@example.com', message: 'steal', source_chat_id: chat4 },
  v1.auth,
);
ok(
  foreign.status === 422 && sql(`SELECT status FROM chats WHERE id = '${chat4}'`) === 'active',
  "another visitor's chat cannot be converted",
);
await owner.must('PATCH', `/departments/${support.id}`, {
  max_wait_seconds: 300,
  fallback_department_id: null,
});
await owner.must('POST', `/chats/${chat4}/close`, { reason: 'resolved' });

console.log('Rate limit');
const v5 = await newVisitor(site.public_key, 'visitor5');
const statuses = [];
for (let i = 0; i < 6; i++)
  statuses.push(
    (
      await v5.call(
        'POST',
        '/widget/v1/offline-submissions',
        { client_request_id: randomUUID(), email: 'r@example.com', message: `n${i}` },
        v5.auth,
      )
    ).status,
  );
ok(
  statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429,
  'sixth submission within an hour from one visitor → 429',
);

console.log('Emergency closures');
const avail = async (v) => (await v.must('GET', '/widget/v1/availability', undefined, v.auth)).state;
const v6 = await newVisitor(site.public_key, 'visitor6');
await v6.sock.emitWithAck('subscribe', { scopes: [{ kind: 'config', id: site.id }] });
ok((await avail(v6)) === 'available', 'site available with a connected online agent');
const both = await owner.call('POST', '/emergency-closures', {
  site_id: site.id,
  department_id: support.id,
  reason: 'x',
});
ok(both.status === 422, 'closure scope is a site OR a department');
const past = await owner.call('POST', '/emergency-closures', {
  reason: 'x',
  ends_at: new Date(Date.now() - 1000).toISOString(),
});
ok(past.status === 422, 'closure must end in the future');
const closure = await owner.call('POST', '/emergency-closures', { site_id: site.id, reason: 'Power outage' });
ok(
  closure.status === 201 && closure.data.state === 'active' && closure.data.scope === 'site',
  'site emergency closure created (201)',
);
ok((await avail(v6)) === 'offline', 'closure makes availability offline immediately');
const offlineFrame = await waitFor(
  () => v6.sock.ephemeral.find((f) => f.type === 'availability.changed' && f.payload.state === 'offline'),
  5000,
  'availability.changed offline',
);
ok(!!offlineFrame, 'widget pushed availability.changed → offline');
const blocked = await v6.call(
  'POST',
  '/widget/v1/chats',
  { client_request_id: randomUUID(), message: 'hello?' },
  v6.auth,
);
ok(
  blocked.status === 409 && blocked.error.code === 'DEPARTMENT_UNAVAILABLE',
  'new chat requests refused during the closure',
);
const activeList = await owner.must('GET', '/emergency-closures');
ok(
  activeList.some((c) => c.id === closure.data.id),
  'active closures listed',
);
ok(
  (await owner.call('DELETE', `/emergency-closures/${closure.data.id}`)).status === 204,
  'closure revoked (204)',
);
ok((await avail(v6)) === 'available', 'revoking restores availability');
ok(
  (await owner.call('DELETE', `/emergency-closures/${closure.data.id}`)).status === 204,
  'revoking twice is idempotent',
);
const expiring = await owner.must('POST', '/emergency-closures', {
  department_id: support.id,
  reason: 'Team meeting',
  ends_at: new Date(Date.now() + 4000).toISOString(),
});
const deptState = async () =>
  (await v6.must('GET', '/widget/v1/availability', undefined, v6.auth)).departments.find(
    (d) => d.id === support.id,
  );
ok(
  (await deptState()).state === 'offline' &&
    new Date((await deptState()).next_open_at).getTime() === new Date(expiring.ends_at).getTime(),
  'department closure: Support offline with next_open_at = ends_at',
);
const expiresAt = new Date(expiring.ends_at).getTime();
await waitFor(
  () =>
    v6.sock.ephemeral.find(
      (f) =>
        f.receivedAt >= expiresAt &&
        f.type === 'availability.changed' &&
        f.payload.departments.find((d) => d.id === support.id)?.state === 'available',
    ),
  10000,
  'availability.changed at closure expiry',
);
ok(
  (await deptState()).state === 'available',
  'closure expiry restores availability via the worker timer (no refresh)',
);
ok(
  sql(
    `SELECT count(*) FROM audit_events WHERE tenant_id = '${tenantId}' AND action LIKE 'emergency_closure.%'`,
  ) === '3',
  'closure create/revoke audited',
);
const history = await owner.must('GET', '/emergency-closures?state=all');
ok(
  history.find((c) => c.id === closure.data.id)?.state === 'revoked' &&
    history.find((c) => c.id === expiring.id)?.state === 'expired',
  'closure history shows revoked and expired closures',
);

console.log('Exact closing boundary (HOURS01)');
// UTC schedule for today that closes at the next whole minute (at least 12 s away).
let boundary = Math.ceil((Date.now() + 1) / 60000) * 60000;
if (boundary - Date.now() < 12000) boundary += 60000;
const bd = new Date(boundary);
const hm = `${String(bd.getUTCHours()).padStart(2, '0')}:${String(bd.getUTCMinutes()).padStart(2, '0')}`;
const openDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(boundary - 1).getUTCDay()];
const closing = await owner.must('POST', '/schedules', {
  name: 'Closing soon',
  timezone: 'UTC',
  weekly_intervals: { [openDay]: [{ start: '00:00', end: hm === '00:00' ? '24:00' : hm }] },
});
await owner.must('PATCH', '/tenants/current', {
  settings: { availability: { default_schedule_id: closing.id } },
});
ok((await avail(v6)) === 'available', `tenant default schedule open until ${bd.toISOString()}`);
const v7 = await newVisitor(site.public_key, 'visitor7');
const v8 = await newVisitor(site.public_key, 'visitor8');
const liveChat = (
  await v7.must(
    'POST',
    '/widget/v1/chats',
    { client_request_id: randomUUID(), message: 'Before closing' },
    v7.auth,
  )
).chat.id;
await owner.must('POST', `/chats/${liveChat}/accept`, {});
await sleep(Math.max(0, boundary - Date.now() - 1500));
ok((await avail(v6)) === 'available', 'still available 1.5 s before the closing instant');
await sleep(Math.max(0, boundary - Date.now() + 300));
const after = await v6.must('GET', '/widget/v1/availability', undefined, v6.auth);
ok(
  after.state === 'offline' && new Date(after.next_open_at).getTime() > boundary,
  `at the exact closing second the site is offline (next_open_at ${after.next_open_at})`,
);
const lateReq = await v8.call(
  'POST',
  '/widget/v1/chats',
  { client_request_id: randomUUID(), message: 'new request after closing' },
  v8.auth,
);
ok(
  lateReq.status === 409 && lateReq.error.code === 'DEPARTMENT_UNAVAILABLE',
  'a new request after closing is refused (offline)',
);
const cont = await owner.call('POST', `/chats/${liveChat}/messages`, {
  client_message_id: randomUUID(),
  body: 'We are closed now but I am still here.',
});
ok(
  cont.status === 201 && sql(`SELECT status FROM chats WHERE id = '${liveChat}'`) === 'active',
  'already active chat continues after closing time',
);
const pushed = await waitFor(
  () =>
    v6.sock.ephemeral.find(
      (f) => f.receivedAt >= boundary && f.type === 'availability.changed' && f.payload.state === 'offline',
    ),
  8000,
  'availability.changed at the schedule boundary',
);
ok(
  pushed.receivedAt - boundary < 5000,
  `boundary timer pushed availability.changed → offline ${pushed.receivedAt - boundary} ms after the boundary (no refresh)`,
);

for (const s of [ownerSock, v1.sock, v2.sock, v3.sock, v4.sock, v5.sock, v6.sock, v7.sock, v8.sock])
  s.close();
console.log(`\nOFFLINE/SCHEDULES E2E PASSED (${passed} checks)`);
process.exit(0);
