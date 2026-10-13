// Audit coverage of direct API writes (AUD-72-16, ch. 54) — node test/audit.e2e.mjs against a running api + worker
// (repo .env sourced: the checks read audit_events with psql).
//   * Every audited category of ch. 54 is invoked straight through the REST API (no UI): login failures, invite and
//     role changes, suspensions, ownership transfer, tenant settings, site origins, widget publish, department
//     membership, schedule changes, routing overrides (forced transfer), trigger publish, bans, exports, token
//     creation/revocation, webhook configuration, privacy actions — plus the account security events (password
//     change/reset, MFA, sessions, failed re-authentication). Billing is OPTIONAL DISABLED (no billing module).
//   * Each request carries its own X-Request-Id; the audit row must carry the same request id, the right actor,
//     action, object and outcome, and a server timestamp from this run.
//   * A denied write records safe security telemetry (authorization.denied) without object details.
//   * Secrets stay masked: no password, token, signing secret, identity secret, MFA secret, recovery code, emailed
//     link token, visitor capability or email address appears anywhere in this tenant's audit rows.
//   * Export and token creation are visible to the audit role through GET /audit-events; an agent gets 403.
// The static half of this item is scripts/audit-coverage.mjs (every write route audits or is exempt with a reason).
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
function clearRateLimits(...patterns) {
  for (const p of patterns) {
    const keys = execFileSync('redis-cli', ['--scan', '--pattern', p]).toString().split('\n').filter(Boolean);
    if (keys.length) execFileSync('redis-cli', ['del', ...keys]);
  }
}

const stamp = Date.now();
let seq = 0;
const nextRid = () => `aud-${stamp}-${String(++seq).padStart(3, '0')}`;

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  /** Every call carries a fresh X-Request-Id (returned as `rid`) unless one is passed in `extra`. */
  async call(method, path, body, extra = {}) {
    const rid = extra['x-request-id'] ?? nextRid();
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...extra,
        'x-request-id': rid,
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
    return { status: res.status, json, data: json?.data, error: json?.error, rid, echoed: res.headers.get('x-request-id') };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r;
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

function totp(base32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...base32.replace(/=+$/, '').toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
let lastStep = 0;
/** A TOTP code for a time step not used yet (codes are single use per step). */
async function nextTotp(base32) {
  for (;;) {
    const now = Date.now();
    const current = Math.floor(now / 30_000);
    const step = Math.max(current, lastStep + 1);
    if (step <= current + 1) {
      lastStep = step;
      return totp(base32, step * 30_000);
    }
    await sleep(30_000 - (now % 30_000) + 200);
  }
}

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}

let tenantId = '';
const runStart = sql('SELECT now()');
/** The audit rows written by one request (matched on the request id it sent). */
const rowsFor = (rid) =>
  JSON.parse(
    sql(
      `SELECT coalesce(json_agg(json_build_object('action', action, 'actor_type', actor_type, 'actor_id', actor_id, 'object_type', object_type, 'object_id', object_id, 'outcome', outcome, 'safe_diff', safe_diff, 'fresh', occurred_at >= '${runStart}'::timestamptz AND occurred_at <= now()) ORDER BY occurred_at), '[]') FROM audit_events WHERE tenant_id = '${tenantId}' AND request_id = '${rid}'`,
    ),
  );
/**
 * Asserts that request `r` (its X-Request-Id) left an audit row with this action, actor, object and outcome.
 * Waits briefly: failed sign-ins are recorded off the response path.
 */
async function audited(label, r, want) {
  const row = await waitFor(() => rowsFor(r.rid).find((x) => x.action === want.action), 5000, `${want.action} for ${r.rid}`).catch(() => null);
  ok(!!row, `${label}: ${want.action} recorded under its request id`, { rid: r.rid, status: r.status, rows: rowsFor(r.rid) });
  const expect = { outcome: 'success', actor_type: 'user', ...want };
  for (const k of ['actor_type', 'actor_id', 'object_type', 'object_id', 'outcome']) {
    if (expect[k] !== undefined) ok(row[k] === expect[k], `${label}: ${k} = ${expect[k]}`, row);
  }
  ok(row.fresh, `${label}: server time from this run`);
  return row;
}

// ═══════════════════════════ Setup ═══════════════════════════
console.log('Setup: a workspace with an owner and an invited agent');
clearRateLimits('rl:login:*', 'rl:reset:*', 'rl:reauth:*', 'rl:signup:*', 'rl:mfa:*');
const P1 = `audit owner passphrase ${stamp}`;
const PA = `audit agent passphrase ${stamp}`;
const ownerEmail = `audit-owner+${stamp}@example.com`;
const agentEmail = `audit-agent+${stamp}@example.com`;
const owner = new Client('owner');
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: P1, tenant_name: `Audit ${stamp}`, timezone: 'UTC', display_name: 'Olive Owner' });
tenantId = signup.data.me.active_tenant_id;
const verifyToken = tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token');
await owner.must('POST', '/auth/verify-email', { token: verifyToken });
const ownerUserId = (await owner.must('GET', '/auth/me')).data.user.id;
const ownerMembership = (await owner.must('GET', '/agents/me')).data.agent.id;
const support = (await owner.must('GET', '/departments')).data.find((d) => d.name === 'Support');
ok(!!support, 'tenant created with its Support department');

const invite = await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 3 });
await audited('invite', invite, { action: 'agent.invited', actor_id: ownerUserId });
const inviteToken = tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite');
const agent = new Client('agent');
const accepted = await agent.must('POST', '/agents/invitations/accept', { token: inviteToken, display_name: 'Ada Agent', password: PA });
const agentMe = (await agent.must('GET', '/agents/me')).data;
const agentMembership = agentMe.agent.id;
const agentUserId = (await agent.must('GET', '/auth/me')).data.user.id;
await audited('invitation accepted', accepted, { action: 'agent.joined' });

// ═══════════════════════════ Login failures ═══════════════════════════
console.log('Login failures');
const wrongPassword = `not the passphrase ${stamp}`;
const failed = await new Client('stranger').call('POST', '/auth/login', { email: ownerEmail, password: wrongPassword });
ok(failed.status === 401 && failed.error.code === 'INVALID_CREDENTIALS', 'wrong password → 401 INVALID_CREDENTIALS');
ok(failed.echoed === failed.rid, 'the response echoes the request id');
const lf = await audited('failed sign-in', failed, { action: 'security.login_failed', outcome: 'failure', actor_type: 'anonymous', actor_id: null, object_type: 'user', object_id: ownerUserId });
ok(lf.safe_diff?.reason === 'invalid_credentials' && Object.keys(lf.safe_diff).length === 1, 'failed sign-in: safe diff holds only the reason', lf.safe_diff);
const unknown = await new Client('stranger').call('POST', '/auth/login', { email: `nobody+${stamp}@example.com`, password: wrongPassword });
ok(unknown.status === 401 && unknown.error.code === 'INVALID_CREDENTIALS', 'unknown email → the same 401 (no account enumeration)');
await sleep(500);
ok(sql(`SELECT count(*) FROM audit_events WHERE request_id = '${unknown.rid}'`) === '0', 'unknown email: no workspace receives an audit row');

// ═══════════════════════════ Team ═══════════════════════════
console.log('Role changes and suspensions');
const role = await owner.must('PATCH', `/agents/${agentMembership}`, { role: 'supervisor' });
const rc = await audited('role change', role, { action: 'agent.role_changed', actor_id: ownerUserId, object_id: agentMembership });
ok(JSON.stringify(rc.safe_diff).includes('supervisor'), 'role change: safe diff names the new role', rc.safe_diff);
await owner.must('PATCH', `/agents/${agentMembership}`, { role: 'agent' });
const suspend = await owner.must('PATCH', `/agents/${agentMembership}`, { enabled: false });
await audited('suspension', suspend, { action: 'agent.suspended', actor_id: ownerUserId, object_id: agentMembership });
const reinstate = await owner.must('PATCH', `/agents/${agentMembership}`, { enabled: true });
await audited('reinstatement', reinstate, { action: 'agent.updated', object_id: agentMembership });

// ═══════════════════════════ Tenant settings, sites, widget ═══════════════════════════
console.log('Tenant settings, site origins, widget publish, identity secret');
const rename = await owner.must('PATCH', '/tenants/current', { name: `Audit ${stamp} renamed` });
await audited('tenant settings', rename, { action: 'tenant.settings_updated', object_type: 'tenant', object_id: tenantId });
const security = await owner.must('PATCH', '/tenants/current', { settings: { security: { require_mfa: false } } });
await audited('tenant security settings', security, { action: 'tenant.security_updated', object_id: tenantId });
const siteRes = await owner.must('POST', '/sites', { name: 'Audit store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const site = siteRes.data;
await audited('site created', siteRes, { action: 'site.created', object_type: 'site', object_id: site.id });
const origins = await owner.must('PATCH', `/sites/${site.id}`, { origins: [{ origin: ORIGIN, pattern_type: 'exact' }, { origin: 'https://shop.example.com', pattern_type: 'exact' }] });
await audited('site origins', origins, { action: 'site.origins_updated', object_id: site.id });
const cfg = (await owner.must('GET', `/sites/${site.id}/widget-config`)).data;
const baseCfg = cfg.published?.config ?? cfg.draft?.config;
const draft = (await owner.must('PUT', `/sites/${site.id}/widget-config`, { config: { ...baseCfg, appearance: { ...baseCfg.appearance, title: 'Audited title' } }, base_etag: cfg.draft?.etag ?? null })).data;
const publish = await owner.must('POST', `/sites/${site.id}/widget-config/publish`, { revision: draft.revision, etag: draft.etag });
await audited('widget publish', publish, { action: 'widget.published', object_id: site.id });
const idSecret = await owner.must('POST', `/sites/${site.id}/identity-secret`);
ok(typeof idSecret.data.secret === 'string' && idSecret.data.secret.length >= 16, 'identity secret shown once');
await audited('identity secret', idSecret, { action: 'site.identity_secret_rotated', object_id: site.id });

// ═══════════════════════════ Departments, schedules, triggers ═══════════════════════════
console.log('Department membership, schedule changes, trigger publish');
const members = await owner.must('PUT', `/departments/${support.id}/members`, { members: [{ membership_id: ownerMembership, can_serve: true }, { membership_id: agentMembership, can_serve: true }] });
await audited('department membership', members, { action: 'department.members_set', object_id: support.id });
const sched = await owner.must('POST', '/schedules', { name: 'Audit hours', timezone: 'UTC', weekly_intervals: { mon: [{ start: '09:00', end: '17:00' }] } });
await audited('schedule created', sched, { action: 'schedule.created', object_type: 'schedule', object_id: sched.data.id });
const schedPatch = await owner.must('PATCH', `/schedules/${sched.data.id}`, { name: 'Audit hours (late)', weekly_intervals: { mon: [{ start: '10:00', end: '18:00' }] } }, { 'if-match': `"${sched.data.version}"` });
await audited('schedule changed', schedPatch, { action: 'schedule.updated', object_id: sched.data.id });
const definition = { dsl_version: 1, event: 'chat.requested', priority: 100, all: [], any: [], actions: [{ type: 'add_tag', tag: 'audited' }], stop_processing: false, cooldown_seconds: 0 };
const trig = await owner.must('POST', '/triggers', { name: 'Audit trigger', definition });
await audited('trigger created', trig, { action: 'trigger.created', object_type: 'trigger', object_id: trig.data.id });
const trigPub = await owner.must('POST', `/triggers/${trig.data.id}/publish`, { revision: 1, enabled: true });
await audited('trigger publish', trigPub, { action: 'trigger.published', object_id: trig.data.id });

// ═══════════════════════════ Routing override, bans, exports ═══════════════════════════
console.log('Routing override (forced transfer), bans, exports');
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).data.ticket);
const agentSock = await socket('/agent', (await agent.must('POST', '/socket-ticket')).data.ticket);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
await agent.must('PUT', '/agents/me/presence', { status: 'online' });
const sess = (await new Client('visitor').must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } })).data;
const vauth = { authorization: `Bearer ${sess.capability}` };
const visitorId = sess.visitor?.id ?? sess.visitor_id;
const chatId = await waitFor(async () => (await new Client('visitor').call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Audit me please', department_id: support.id }, vauth)).data?.chat?.id, 10000, 'chat admitted');
await waitFor(async () => (await agent.call('POST', `/chats/${chatId}/accept`, {})).status === 200, 8000, 'agent accept');
const forced = await owner.call('POST', `/chats/${chatId}/transfers`, { target_agent_id: ownerMembership, force: true, reason: 'Audit handover' }, { 'idempotency-key': `ft-${randomUUID()}` });
ok(forced.status === 201, 'forced transfer → 201', forced.error);
const ft = await audited('routing override', forced, { action: 'chat.force_transferred', object_type: 'chat', object_id: chatId });
ok(ft.safe_diff?.reason === 'Audit handover' && ft.safe_diff?.from === agentMembership && ft.safe_diff?.to === ownerMembership, 'routing override: from, to and reason recorded', ft.safe_diff);
const ban = await owner.must('POST', '/bans', { visitor_id: visitorId, reason: 'Audit ban' });
await audited('ban', ban, { action: 'ban.created', object_type: 'ban', object_id: ban.data.id });
const unban = await owner.must('DELETE', `/bans/${ban.data.id}`);
await audited('unban', unban, { action: 'ban.revoked', object_id: ban.data.id });
const exp = await owner.must('POST', '/exports', { chat_ids: [chatId], format: 'json' });
const expId = exp.data.id ?? exp.data.job_id;
await audited('export', exp, { action: 'export.created', object_id: expId });

// ═══════════════════════════ Tokens, webhooks, privacy ═══════════════════════════
console.log('Token creation/revocation, webhook configuration, privacy actions');
await owner.must('POST', '/auth/reauthenticate', { password: P1 });
const tok = await owner.must('POST', '/integration-tokens', { name: 'Audit reader', scopes: ['chats:read'] }, { 'idempotency-key': `tok-${stamp}` });
const tokenPlain = tok.data.token;
ok(/^rdt_/.test(tokenPlain ?? ''), 'integration token shown once');
await audited('token creation', tok, { action: 'integration_token.created', object_type: 'integration_token', object_id: tok.data.id });
const tokRevoke = await owner.must('DELETE', `/integration-tokens/${tok.data.id}`);
await audited('token revocation', tokRevoke, { action: 'integration_token.revoked', object_id: tok.data.id });
const hook = await owner.must('POST', '/webhooks', { url: 'https://example.com/talkivio-audit-hook', event_types: ['chat.closed'], description: 'audit' });
const hookSecret = hook.data.secret;
ok(/^whsec_/.test(hookSecret ?? ''), 'webhook signing secret shown once');
await audited('webhook created', hook, { action: 'webhook.created', object_id: hook.data.id });
const hookVersion = (await owner.must('GET', `/webhooks/${hook.data.id}`)).data.version;
const hookPatch = await owner.must('PATCH', `/webhooks/${hook.data.id}`, { description: 'audit (edited)' }, { 'if-match': `"${hookVersion}"` });
await audited('webhook updated', hookPatch, { action: 'webhook.updated', object_id: hook.data.id });
const hookRotate = await owner.must('POST', `/webhooks/${hook.data.id}/rotate-secret`, { overlap_minutes: 5 });
const hookSecret2 = hookRotate.data.secret;
await audited('webhook secret rotated', hookRotate, { action: 'webhook.secret_rotated', object_id: hook.data.id });
const hookVersion2 = (await owner.must('GET', `/webhooks/${hook.data.id}`)).data.version;
const hookDelete = await owner.must('DELETE', `/webhooks/${hook.data.id}`, undefined, { 'if-match': `"${hookVersion2}"` });
await audited('webhook deleted', hookDelete, { action: 'webhook.deleted', object_id: hook.data.id });
const privacy = await owner.must('POST', '/privacy/requests', { kind: 'access', visitor_id: visitorId, proof_reference: `AUDIT-${stamp}` });
await audited('privacy request', privacy, { action: 'privacy.request_created', object_id: privacy.data.id });

// ═══════════════════════════ Denied writes ═══════════════════════════
console.log('A denied write records safe security telemetry');
const denied = await agent.call('POST', '/webhooks', { url: 'https://example.com/agent-hook', event_types: ['chat.closed'] });
ok(denied.status === 403 && denied.error.code === 'PERMISSION_DENIED', 'agent creating a webhook → 403 PERMISSION_DENIED');
const dn = await audited('denied write', denied, { action: 'authorization.denied', outcome: 'denied', actor_id: agentUserId });
ok(!JSON.stringify(dn).includes('agent-hook'), 'denied write: the attempted payload is not copied into the audit row', dn);
ok(sql(`SELECT count(*) FROM webhook_endpoints WHERE tenant_id = '${tenantId}' AND url LIKE '%agent-hook%'`) === '0', 'denied write changed nothing');

// ═══════════════════════════ Visibility to the audit role ═══════════════════════════
console.log('Export and token creation are visible to the audit role');
const listed = (await owner.must('GET', `/audit-events?action=${encodeURIComponent('integration_token.*')}`)).data;
const items = listed.items ?? listed;
ok(items.some((e) => e.action === 'integration_token.created' && e.object_id === tok.data.id && e.request_id === tok.rid), 'GET /audit-events lists the token creation with its request id');
const exports_ = (await owner.must('GET', `/audit-events?action=${encodeURIComponent('export.*')}`)).data;
ok((exports_.items ?? exports_).some((e) => e.action === 'export.created'), 'GET /audit-events lists the export');
const agentList = await agent.call('GET', '/audit-events');
ok(agentList.status === 403, 'an agent cannot read the audit log (403)');

// ═══════════════════════════ Account security events ═══════════════════════════
console.log('Account security events');
const badReauth = await owner.call('POST', '/auth/reauthenticate', { password: wrongPassword });
ok(badReauth.status === 401, 'failed re-authentication → 401');
await audited('failed re-authentication', badReauth, { action: 'security.reauth_failed', outcome: 'failure', actor_id: ownerUserId, object_id: ownerUserId });
const second = new Client('owner-2');
await second.must('POST', '/auth/login', { email: ownerEmail, password: P1 });
const secondSession = (await second.must('GET', '/auth/sessions')).data.find((s) => s.current).id;
const revoke = await owner.must('DELETE', `/auth/sessions/${secondSession}`);
await audited('session revoked', revoke, { action: 'security.session_revoked', actor_id: ownerUserId });
const third = new Client('owner-3');
await third.must('POST', '/auth/login', { email: ownerEmail, password: P1 });
const others = await owner.must('POST', '/auth/sessions/revoke-others');
const ro = await audited('other sessions revoked', others, { action: 'security.other_sessions_revoked', actor_id: ownerUserId });
ok(ro.safe_diff?.revoked >= 1, 'other sessions revoked: count recorded', ro.safe_diff);
const P2 = `audit owner second passphrase ${stamp}`;
const change = await owner.must('POST', '/auth/password/change', { current_password: P1, new_password: P2 });
await audited('password change', change, { action: 'security.password_changed', actor_id: ownerUserId, object_id: ownerUserId });
await owner.must('POST', '/auth/reauthenticate', { password: P2 });
const enrol = (await owner.must('POST', '/auth/mfa/enroll', {})).data;
const confirm = await owner.must('POST', '/auth/mfa/confirm', { enrollment_id: enrol.enrollment_id, code: await nextTotp(enrol.secret) });
const recoveryCodes = confirm.data.recovery_codes;
ok(Array.isArray(recoveryCodes) && recoveryCodes.length === 10, 'MFA enabled; recovery codes shown once');
await audited('MFA enabled', confirm, { action: 'security.mfa_enabled', actor_id: ownerUserId, object_id: ownerUserId });
const regen = await owner.must('POST', '/auth/mfa/recovery-codes', { code: await nextTotp(enrol.secret) });
const recoveryCodes2 = regen.data.recovery_codes;
await audited('recovery codes regenerated', regen, { action: 'security.mfa_recovery_codes_regenerated', actor_id: ownerUserId });
const mfaOff = await owner.must('DELETE', '/auth/mfa', { code: await nextTotp(enrol.secret) });
await audited('MFA disabled', mfaOff, { action: 'security.mfa_disabled', actor_id: ownerUserId, object_id: ownerUserId });
const resetReq = await new Client('stranger').must('POST', '/auth/password/reset-request', { email: ownerEmail });
await audited('reset requested', resetReq, { action: 'security.password_reset_requested', actor_type: 'anonymous', actor_id: null, object_id: ownerUserId });
const resetToken = tokenFrom(await waitFor(() => latestEmail(ownerEmail, 'password_reset'), 5000, 'reset email'), 'token');
const P3 = `audit owner third passphrase ${stamp}`;
const reset = await new Client('stranger').must('POST', '/auth/password/reset', { token: resetToken, new_password: P3 });
await audited('password reset', reset, { action: 'security.password_reset', actor_id: ownerUserId, object_id: ownerUserId });

// ═══════════════════════════ Ownership transfer ═══════════════════════════
console.log('Ownership transfer');
const back = new Client('owner-again');
await back.must('POST', '/auth/login', { email: ownerEmail, password: P3 });
const transfer = await back.must('POST', '/tenants/current/ownership-transfer', { target_membership_id: agentMembership, reason: 'Audit hand-over' });
await audited('ownership transfer', transfer, { action: 'tenant.ownership_transferred', actor_id: ownerUserId });

// ═══════════════════════════ Secrets stay masked ═══════════════════════════
console.log('No secret or address reaches the audit trail');
const dump = sql(`SELECT coalesce(json_agg(a)::text, '') FROM audit_events a WHERE tenant_id = '${tenantId}'`);
const secrets = {
  'owner password (1)': P1,
  'owner password (2)': P2,
  'owner password (3)': P3,
  'wrong password': wrongPassword,
  'agent password': PA,
  'integration token': tokenPlain,
  'webhook secret': hookSecret,
  'rotated webhook secret': hookSecret2,
  'identity secret': idSecret.data.secret,
  'MFA secret': enrol.secret,
  'verification link token': verifyToken,
  'invitation link token': inviteToken,
  'reset link token': resetToken,
  'visitor capability': sess.capability,
  'owner email': ownerEmail,
  'agent email': agentEmail,
};
for (const [i, c] of [...recoveryCodes, ...recoveryCodes2].entries()) secrets[`recovery code ${i + 1}`] = c;
const leaked = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v.length >= 8 && dump.includes(v)).map(([k]) => k);
ok(Object.values(secrets).every((v) => typeof v === 'string' && v.length >= 8), `all ${Object.keys(secrets).length} secrets were captured for the check`);
ok(leaked.length === 0, `none of ${Object.keys(secrets).length} secrets appears in ${sql(`SELECT count(*) FROM audit_events WHERE tenant_id = '${tenantId}'`)} audit rows`, leaked);
const httpRows = sql(`SELECT count(*) || '|' || count(*) FILTER (WHERE request_id IS NULL OR request_id = '') FROM audit_events WHERE tenant_id = '${tenantId}' AND actor_type <> 'system'`).split('|');
ok(httpRows[1] === '0', `every request-driven audit row carries a request id (${httpRows[0]} rows)`);

ownerSock.disconnect();
agentSock.disconnect();
await new Client('cleanup').call('GET', '/health/ready');
await agent.call('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
await back.call('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
console.log(`\nAUDIT E2E PASSED (${passed} checks)`);
process.exit(0);
