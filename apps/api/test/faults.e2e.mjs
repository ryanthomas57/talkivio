// Injected database faults during accept (ROUTE05, ch. 66) — end-to-end against a running api + worker
// (node test/faults.e2e.mjs). Real PostgreSQL errors are raised inside the accept transaction by a test-only trigger on
// chat_participants (the row an accept inserts): SQLSTATE 40001 (serialization failure) or 40P01 (deadlock), a set
// number of times per chat. A sequence counts the attempts — sequences survive the rollback that the error causes.
//   * one serialization failure / one deadlock: the transaction is retried and the accept succeeds exactly once;
//   * a fault while two agents race for the same chat: exactly one owner, the other gets a clean conflict;
//   * a fault that outlasts every retry: the accept is refused with nothing half-written, and succeeds once it clears.
// The trigger, function, table and sequences are removed afterwards (the schema drift gate would see them otherwise).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const stamp = Date.now().toString(36);
const PASSWORD = 'fault injection passphrase';
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
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
  async call(method, path, body) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(Object.keys(this.cookies).length ? { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, code: json?.error?.code ?? null, retryable: json?.error?.retryable ?? null, data: json?.data };
  }
  async must(method, path, body) {
    const r = await this.call(method, path, body);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${r.code}`);
    return r.data;
  }
}

// ───────────────────────── fault injection fixture ─────────────────────────
const FAULT_SQL = `
CREATE TABLE IF NOT EXISTS test_fault_injection (chat_id uuid PRIMARY KEY, sqlstate text NOT NULL, times int NOT NULL, seq text NOT NULL);
CREATE OR REPLACE FUNCTION test_fault_inject() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM test_fault_injection WHERE chat_id = NEW.chat_id;
  IF FOUND AND nextval(f.seq) <= f.times THEN
    IF f.sqlstate = '40P01' THEN
      RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
    END IF;
    RAISE EXCEPTION 'could not serialize access due to concurrent update' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_fault_inject ON chat_participants;
CREATE TRIGGER test_fault_inject BEFORE INSERT ON chat_participants FOR EACH ROW EXECUTE FUNCTION test_fault_inject();`;
let faultSeqs = [];
function cleanup() {
  sql(`DROP TRIGGER IF EXISTS test_fault_inject ON chat_participants; DROP FUNCTION IF EXISTS test_fault_inject(); DROP TABLE IF EXISTS test_fault_injection;`);
  for (const s of faultSeqs) sql(`DROP SEQUENCE IF EXISTS ${s}`);
  faultSeqs = [];
}
function injectFault(chatId, sqlstate, times) {
  const seq = `test_fault_seq_${chatId.replaceAll('-', '').slice(0, 20)}`;
  sql(`CREATE SEQUENCE IF NOT EXISTS ${seq}; INSERT INTO test_fault_injection (chat_id, sqlstate, times, seq) VALUES ('${chatId}', '${sqlstate}', ${times}, '${seq}')`);
  faultSeqs.push(seq);
  return () => Number(sql(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM ${seq}`));
}

// ───────────────────────── setup ─────────────────────────
console.log('Setup — a workspace with two online agents (owner, admin) and a site');
cleanup();
const owner = new Client('owner', '10.41.0.1');
const ownerEmail = `faults-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email: ownerEmail, password: PASSWORD, tenant_name: `Faults ${stamp}`, timezone: 'UTC' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(await waitFor(() => latestEmail(ownerEmail, 'verify_email'), 5000, 'verification email'), 'token') });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const adminEmail = `faults-admin+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: adminEmail, role: 'admin', department_ids: [support.id], capacity: 5 });
const admin = new Client('admin', '10.41.0.2');
await admin.must('POST', '/agents/invitations/accept', { token: tokenFrom(await waitFor(() => latestEmail(adminEmail, 'agent_invitation'), 5000, 'invitation'), 'invite'), display_name: 'Ada Admin', password: PASSWORD });
const sockets = [];
for (const c of [owner, admin]) {
  const s = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket: (await c.must('POST', '/socket-ticket')).ticket }, forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  sockets.push(s);
  await c.must('PUT', '/agents/me/presence', { status: 'online' });
  c.membershipId = (await c.must('GET', '/agents/me')).agent.id;
}
const site = await owner.must('POST', '/sites', { name: `Faults site ${stamp}`, origins: [{ origin: 'https://faults.example', pattern_type: 'exact' }] });
async function newChat(label) {
  const v = new Client(`visitor-${label}`, `10.41.1.${Math.floor(Math.random() * 200) + 1}`);
  const sess = (await fetch(`${API}/widget/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': v.ip }, body: JSON.stringify({ site_key: site.public_key, host_origin: 'https://faults.example', consent: { analytics: false, policy_version: '2026-10' } }) }).then((r) => r.json())).data;
  v.bearer = sess.capability;
  return (await v.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Fault case ${label}` })).chat.id;
}
const ownersOf = (chatId) => sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chatId}' AND role = 'primary' AND left_at IS NULL`);
const chatRow = (chatId) => sql(`SELECT status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${chatId}'`);

try {
  sql(FAULT_SQL);
  for (const [label, sqlstate] of [['serialization failure (40001)', '40001'], ['deadlock (40P01)', '40P01']]) {
    console.log(`One ${label} inside the accept transaction`);
    const chatId = await newChat(sqlstate);
    const attempts = injectFault(chatId, sqlstate, 1);
    const r = await owner.call('POST', `/chats/${chatId}/accept`, {});
    ok(r.status === 200, `accept succeeds after the injected ${label} (${r.status} ${r.code ?? ''})`);
    ok(attempts() === 2, `the transaction ran twice: the failed attempt was rolled back and retried (${attempts()} attempts)`);
    ok(ownersOf(chatId) === '1' && chatRow(chatId) === `active|${owner.membershipId}`, 'exactly one primary participant; the chat is active and owned by the accepting agent');
  }

  console.log('A fault while two agents race for the same chat');
  {
    const chatId = await newChat('race');
    const attempts = injectFault(chatId, '40001', 1);
    const [a, b] = await Promise.all([owner.call('POST', `/chats/${chatId}/accept`, {}), admin.call('POST', `/chats/${chatId}/accept`, {})]);
    const wins = [a, b].filter((r) => r.status === 200);
    const loser = [a, b].find((r) => r.status !== 200);
    ok(wins.length === 1, `exactly one accept wins (${a.status} / ${b.status})`);
    ok(loser && loser.status === 409 && ['CHAT_ALREADY_ASSIGNED', 'CAPACITY_EXCEEDED', 'VERSION_CONFLICT'].includes(loser.code), `the other gets a clean conflict (${loser?.status} ${loser?.code})`);
    ok(ownersOf(chatId) === '1' && attempts() >= 2, `one owner participant after the race (${attempts()} insert attempts)`);
  }

  console.log('A fault that outlasts every retry');
  {
    // The owner may hold three chats by now (one per case above, the race when it won): free its capacity so the
    // accept reaches the faulted insert instead of stopping at CAPACITY_EXCEEDED.
    for (const id of sql(`SELECT id FROM chats WHERE owner_membership_id = '${owner.membershipId}' AND status = 'active'`).split('\n').filter(Boolean)) {
      await owner.call('POST', `/chats/${id}/close`, { reason: 'resolved' });
    }
    const chatId = await newChat('persistent');
    const before = chatRow(chatId);
    const attempts = injectFault(chatId, '40001', 50);
    const r = await owner.call('POST', `/chats/${chatId}/accept`, {});
    ok(r.status >= 409 && r.status !== 200, `accept is refused once retries are exhausted (${r.status} ${r.code}, retryable ${r.retryable})`);
    ok(attempts() > 1, `it was retried before giving up (${attempts()} attempts)`);
    ok(chatRow(chatId) === before && ownersOf(chatId) === '0', `nothing half-written: the chat is still ${before.split('|')[0]} with no owner`);
    sql(`DELETE FROM test_fault_injection WHERE chat_id = '${chatId}'`);
    const again = await owner.call('POST', `/chats/${chatId}/accept`, {});
    ok(again.status === 200 && ownersOf(chatId) === '1', 'once the fault clears, the same accept succeeds');
  }
} finally {
  cleanup();
  for (const s of sockets) s.close();
}
ok(sql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'test_fault_inject'`) === '0' && sql(`SELECT to_regclass('public.test_fault_injection') IS NULL`) === 't', 'fault fixture removed');

console.log(`\nFAULTS E2E PASSED (${passed} checks)`);
process.exit(0);
