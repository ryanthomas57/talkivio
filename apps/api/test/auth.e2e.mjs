// Password reset, sessions and MFA (AUD-71-02, AUTH02) — end-to-end against a running api + worker
// (node test/auth.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis; TOTP computed here (RFC 6238).
//   * reset request is a generic 202 for known and unknown emails; the reset token is hashed, single use, 30 min
//   * reset revokes every session of the user (REST 401 + access.revoked on open sockets, < 60 s); a draft cannot be sent
//   * password change (authenticated) keeps the calling session and revokes the others
//   * MFA enroll → confirm with a real TOTP → recovery codes shown once; login then requires MFA_REQUIRED + code
//   * recovery codes are single use; MFA brute force is rate limited; trusted devices skip the challenge
//   * recent-auth gates sensitive routes until /auth/reauthenticate (password + TOTP when MFA is on)
//   * DELETE /auth/mfa {code} disables MFA, rotates the session cookie and audits security.mfa_disabled
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
/** A genuine finding: recorded and reported, never aborts the run. */
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
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Drop this run's own rate-limit buckets so the scripted attempts stay inside their windows. */
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
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
      else delete this.cookies[pair.slice(0, i)];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error, setCookies };
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
  s.controls = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('ephemeral', (f) => s.ephemeral.push(f));
  s.on('control', (f) => {
    s.controls.push({ ...f, at: Date.now() });
  });
  s.on('disconnect', () => {
    s.disconnectedAt = Date.now();
  });
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const agentSocket = async (c) => socket('/agent', (await c.must('POST', '/socket-ticket')).ticket);
const waitFor = async (pred, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** RFC 6238 TOTP: HMAC-SHA-1, 30 s step, 6 digits, base32 secret (otplib authenticator defaults). */
function totp(base32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...base32.replace(/=+$/, '').toUpperCase()].map((c) => {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error(`not base32: ${c}`);
    return i.toString(2).padStart(5, '0');
  }).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** A code that is never valid for the current ±1 step window. */
function wrongCode(base32) {
  const valid = new Set([-1, 0, 1].map((d) => totp(base32, Date.now() + d * 30_000)));
  for (let k = 7; ; k++) {
    const c = totp(base32, Date.now() + k * 30_000);
    if (!valid.has(c)) return c;
  }
}
/** Wait until at least `ms` remain in the current TOTP step, so a computed code cannot roll over mid-request. */
async function freshStep(ms = 5000) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < ms) await sleep(left + 200);
}
/**
 * TOTP codes are single use (RFC 6238 §5.2): the server accepts a step only if it is newer than the last
 * accepted one. Returns a code for the next unused step inside the ±1 window, waiting for the clock when the
 * window is spent. consume=false peeks (for requests refused before the code is checked).
 */
let lastStep = 0;
async function nextTotp(base32, { consume = true } = {}) {
  for (;;) {
    const now = Date.now();
    const current = Math.floor(now / 30_000);
    const step = Math.max(current, lastStep + 1);
    if (step <= current + 1) {
      if (consume) lastStep = step;
      return totp(base32, step * 30_000);
    }
    await sleep(30_000 - (now % 30_000) + 200);
  }
}

const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:login:*', 'rl:reset:*', 'rl:reauth:*');

console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `auth-owner+${stamp}@example.com`;
const P0 = 'correct horse battery';
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: P0, tenant_name: `Auth ${stamp}`, timezone: 'UTC' });
const tenantId = signup.me.active_tenant_id;
const ownerUserId = signup.user_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const ownerMember = (await owner.must('GET', '/agents/me')).agent.id;
const site = await owner.must('POST', '/sites', { name: 'Auth store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
ok(tenantId && ownerUserId && site && support, 'tenant with a verified owner, a site and the Support department');

// ═══════════════════════════ AUTH02: reset while several sessions and sockets are active ═══════════════════════════
console.log('Password reset with several live sessions and sockets (AUTH02)');
const sock0 = await agentSocket(owner);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
const vauth = { authorization: `Bearer ${sess.capability}` };
const chatId = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, I forgot something in my order', department_id: support.id }, vauth)).chat.id;
await owner.must('POST', `/chats/${chatId}/accept`, {});
ok(sql(`SELECT status || '|' || owner_membership_id FROM chats WHERE id = '${chatId}'`) === `active|${ownerMember}`, 'owner is serving a live chat (so a pending draft has somewhere to go)');

const b = new Client('owner-b');
const c = new Client('owner-c');
await b.must('POST', '/auth/login', { email: ownerEmail, password: P0 });
await c.must('POST', '/auth/login', { email: ownerEmail, password: P0 });
const sockB = await agentSocket(b);
const sockC = await agentSocket(c);
const listed = await b.must('GET', '/auth/sessions');
ok(listed.length === 3 && listed.filter((s) => s.current).length === 1, 'GET /auth/sessions lists the three live sessions, exactly one marked current');
ok(listed.every((s) => !('token' in s) && !('token_hash' in s) && !('ip_hash' in s) && !('csrf_token_hash' in s)), 'session list carries no tokens or raw network data');
const before = Number(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ownerUserId}' AND revoked_at IS NULL`));
ok(before === 3 && sock0.connected && sockB.connected && sockC.connected, 'three sessions and three agent sockets are live');

const unknownEmail = `nobody+${stamp}@example.com`;
const r1 = await b.call('POST', '/auth/password/reset-request', { email: ownerEmail });
const r2 = await new Client('anon').call('POST', '/auth/password/reset-request', { email: unknownEmail });
ok(r1.status === 202 && r2.status === 202, 'reset request → 202 for an existing account and for an unknown email');
ok(JSON.stringify(r1.data) === JSON.stringify(r2.data) && JSON.stringify(r1.data) === JSON.stringify({ accepted: true }), 'both responses are byte-identical {accepted: true} (no account enumeration)');
ok(sql(`SELECT count(*) FROM outbound_emails WHERE recipient = '${unknownEmail}'`) === '0', 'no email is generated for the unknown address');
const resetToken = tokenFrom(latestEmail(ownerEmail, 'password_reset'), 'token');
ok(resetToken.length >= 32, 'reset email for the real account carries a single-use link token');
const tokRow = sql(`SELECT token_hash || '|' || round(extract(epoch FROM expires_at - created_at)) FROM auth_tokens WHERE user_id = '${ownerUserId}' AND purpose = 'reset' ORDER BY created_at DESC LIMIT 1`).split('|');
ok(tokRow[0] === sha256(resetToken) && tokRow[0] !== resetToken, 'only the SHA-256 hash of the reset token is stored');
ok(Math.abs(Number(tokRow[1]) - 1800) <= 2, `reset token expires after 30 minutes (${tokRow[1]} s)`);

const shortPw = await new Client('anon').call('POST', '/auth/password/reset', { token: resetToken, new_password: 'short' });
ok(shortPw.status === 422 && shortPw.error.code === 'VALIDATION_FAILED', 'a too-short new password is refused (422 VALIDATION_FAILED) …');
ok(sql(`SELECT consumed_at IS NULL FROM auth_tokens WHERE token_hash = '${sha256(resetToken)}'`) === 't', '… without consuming the token');

const P1 = 'a brand new passphrase one';
const resetAt = Date.now();
const reset = await new Client('anon').call('POST', '/auth/password/reset', { token: resetToken, new_password: P1 });
ok(reset.status === 204, 'reset with the emailed token → 204');
const replay = await new Client('anon').call('POST', '/auth/password/reset', { token: resetToken, new_password: 'another passphrase two' });
ok(replay.status === 422 && replay.error.code === 'TOKEN_USED', 'replaying the consumed reset token → 422 TOKEN_USED');
ok(![...reset.setCookies, ...replay.setCookies].some((x) => x.startsWith('rd_session=')), 'neither the reset nor its replay signs the caller in (no session cookie issued)');

const revokedFrames = await waitFor(() => (sock0.controls.length && sockB.controls.length && sockC.controls.length ? [sock0, sockB, sockC].map((s) => s.controls[0]) : null), 60_000, 'access.revoked on all sockets');
ok(revokedFrames.every((f) => f.type === 'access.revoked' && f.payload.reason === 'session_revoked' && f.payload.relogin_required === true), 'every open socket receives access.revoked {reason: session_revoked, relogin_required: true}');
await waitFor(() => !sock0.connected && !sockB.connected && !sockC.connected, 10_000, 'sockets closed');
const latest = Math.max(...[sock0, sockB, sockC].map((s) => s.disconnectedAt)) - resetAt;
ok(latest < 60_000, `all three sockets were closed ${latest} ms after the reset (< 60 s)`);
const after = await Promise.all([owner, b, c].map((x) => x.call('GET', '/agents/me')));
ok(after.every((r) => r.status === 401), 'all three old sessions (including the one that requested the reset) now get 401');
ok(sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${ownerUserId}' AND revoked_at IS NULL`) === '0', 'every auth_sessions row of the user is revoked (reset revokes all sessions, as ch. 07 requires)');
const ticket = await b.call('POST', '/socket-ticket');
ok(ticket.status === 401, 'an old session cannot mint a socket ticket');
const draft = await owner.call('POST', `/chats/${chatId}/messages`, { client_message_id: `draft-${stamp}`, body: 'Draft written before the reset' });
ok(draft.status === 401, 'sending the composer draft with the old session → 401 …');
ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND body = 'Draft written before the reset'`) === '0', '… and the draft was not stored (remains unsent)');

const oldPw = await new Client('x').call('POST', '/auth/login', { email: ownerEmail, password: P0 });
ok(oldPw.status === 401 && oldPw.error.code === 'INVALID_CREDENTIALS', 'the old password no longer signs in');
const fresh = new Client('owner-fresh');
await fresh.must('POST', '/auth/login', { email: ownerEmail, password: P1 });
ok((await fresh.call('GET', '/agents/me')).status === 200, 'the new password signs in');
const sent = await fresh.call('POST', `/chats/${chatId}/messages`, { client_message_id: `draft-${stamp}`, body: 'Draft written before the reset' });
ok(sent.status === 201 && sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND body = 'Draft written before the reset'`) === '1', 'after signing in again the draft is sent exactly once');

console.log('Expired reset token');
clearRateLimits('rl:reset:*');
await new Client('anon').must('POST', '/auth/password/reset-request', { email: ownerEmail });
const t2 = tokenFrom(latestEmail(ownerEmail, 'password_reset'), 'token');
ok(t2 && t2 !== resetToken, 'a second reset link is issued');
sql(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = '${sha256(t2)}'`);
const expired = await new Client('anon').call('POST', '/auth/password/reset', { token: t2, new_password: 'yet another passphrase' });
ok(expired.status === 422 && expired.error.code === 'TOKEN_EXPIRED', 'a reset token past its 30-minute expiry → 422 TOKEN_EXPIRED');
ok((await fresh.call('GET', '/agents/me')).status === 200, 'a failed reset does not touch live sessions');

console.log('Password change keeps the calling session (the session that asked is not affected)');
const d = new Client('owner-d');
const e = new Client('owner-e');
await d.must('POST', '/auth/login', { email: ownerEmail, password: P1 });
await e.must('POST', '/auth/login', { email: ownerEmail, password: P1 });
const sockD = await agentSocket(d);
const sockE = await agentSocket(e);
const dSessionId = (await d.must('GET', '/auth/sessions')).find((s) => s.current).id;
const P2 = 'the third passphrase here';
const change = await d.call('POST', '/auth/password/change', { current_password: P1, new_password: P2 });
ok(change.status === 204, 'POST /auth/password/change from session D → 204');
ok((await d.call('GET', '/agents/me')).status === 200 && sockD.connected, 'session D (the requester) and its socket stay signed in');
const eFrame = await waitFor(() => sockE.controls.find((f) => f.type === 'access.revoked'), 10_000, 'E revoked');
ok(eFrame.payload.reason === 'session_revoked' && (await e.call('GET', '/agents/me')).status === 401 && (await fresh.call('GET', '/agents/me')).status === 401, 'every other session (E and the earlier one) is revoked, with access.revoked on E\'s socket');
ok(sql(`SELECT string_agg(id::text, ',') FROM auth_sessions WHERE user_id = '${ownerUserId}' AND revoked_at IS NULL`) === dSessionId, 'only the requesting session remains in auth_sessions');
await sleep(300);
ok(!sockD.controls.length, 'the requesting session\'s socket received no revocation frame');

console.log('Recent auth on sensitive routes');
sql(`UPDATE auth_sessions SET recent_auth_at = now() - interval '20 minutes' WHERE id = '${dSessionId}'`);
const gated = [
  ['POST', '/auth/password/change', { current_password: P2, new_password: 'yet another passphrase' }],
  ['POST', '/auth/mfa/enroll', {}],
  ['POST', '/tenants/current/ownership-transfer', { target_membership_id: randomUUID(), reason: 'audit' }],
  ['POST', '/integration-tokens', {}],
  ['POST', `/sites/${site.id}/key-rotation`, {}],
];
for (const [m, p, body] of gated) {
  const r = await d.call(m, p, body);
  ok(r.status === 403 && r.error.code === 'RECENT_AUTH_REQUIRED', `${m} ${p} with a 20-minute-old sign-in → 403 RECENT_AUTH_REQUIRED`);
}
const badReauth = await d.call('POST', '/auth/reauthenticate', { password: 'not my password at all' });
ok(badReauth.status === 401 && badReauth.error.code === 'INVALID_CREDENTIALS', 'reauthenticate with a wrong password → 401');
ok((await d.call('POST', '/auth/reauthenticate', { password: P2 })).status === 204, 'reauthenticate with the password → 204');
const opened = await d.call('POST', '/integration-tokens', {});
ok(opened.status !== 403 || opened.error.code !== 'RECENT_AUTH_REQUIRED', `after reauthentication the gate opens (POST /integration-tokens now reaches validation → ${opened.status} ${opened.error?.code})`);
for (const s of [sockD, sockE]) s.disconnect();

// ═══════════════════════════ AUD-71-02: MFA enrolment, login, recovery, disable ═══════════════════════════
console.log('MFA enrolment with a real TOTP');
const mEmail = `auth-mfa+${stamp}@example.com`;
const PM = 'mfa user passphrase one';
await d.must('POST', '/agents/invitations', { email: mEmail, role: 'agent', department_ids: [support.id], capacity: 3 });
const m0 = new Client('mfa-0');
await m0.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(mEmail, 'agent_invitation'), 'invite'), display_name: 'Mia Mfa', password: PM });
const mUserId = sql(`SELECT id FROM users WHERE email = '${mEmail}'`);
ok(!!mUserId && (await m0.call('GET', '/agents/me')).status === 200, 'second user (agent) joined the workspace and is signed in');
clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');

const enrol = await m0.must('POST', '/auth/mfa/enroll', {});
ok(typeof enrol.enrollment_id === 'string' && /^[A-Z2-7]{32}$/.test(enrol.secret), `enroll returns an enrollment id and a 160-bit base32 secret (${enrol.secret.length} chars)`);
const otp = new URL(enrol.otpauth_url);
ok(otp.protocol === 'otpauth:' && otp.searchParams.get('secret') === enrol.secret && (otp.searchParams.get('algorithm') ?? 'SHA1') === 'SHA1' && (otp.searchParams.get('digits') ?? '6') === '6' && (otp.searchParams.get('period') ?? '30') === '30', 'otpauth URL carries the same secret with SHA-1 / 6 digits / 30 s');
ok(enrol.qr_data_url.startsWith('data:image/png;base64,'), 'enroll returns a QR code for the manual key');
ok(sql(`SELECT mfa_enabled_at IS NULL FROM users WHERE id = '${mUserId}'`) === 't', 'MFA is not active before a valid code is confirmed');
const badConfirm = await m0.call('POST', '/auth/mfa/confirm', { enrollment_id: enrol.enrollment_id, code: wrongCode(enrol.secret) });
ok(badConfirm.status === 422 && badConfirm.error.code === 'VALIDATION_FAILED' && sql(`SELECT mfa_enabled_at IS NULL FROM users WHERE id = '${mUserId}'`) === 't', 'confirm with a wrong code → 422 and MFA stays off');
const confirmed = await m0.call('POST', '/auth/mfa/confirm', { enrollment_id: enrol.enrollment_id, code: await nextTotp(enrol.secret) });
ok(confirmed.status === 200, 'confirm with the TOTP computed from the secret → 200');
const codes = confirmed.data.recovery_codes;
ok(Array.isArray(codes) && codes.length === 10 && new Set(codes).size === 10 && codes.every((x) => /^[a-z0-9]{10}$/.test(x)), 'confirm returns 10 distinct recovery codes');
const again = await m0.call('POST', '/auth/mfa/confirm', { enrollment_id: enrol.enrollment_id, code: totp(enrol.secret) });
ok(again.status === 422 && again.error.code === 'TOKEN_EXPIRED' && !again.data, 'confirming the same enrollment again → 422, recovery codes are not shown a second time');
const reEnroll = await m0.call('POST', '/auth/mfa/enroll', {});
ok(reEnroll.status === 409, 'enrolling again while MFA is on → 409');
const urow = sql(`SELECT mfa_enabled_at IS NOT NULL, mfa_key_version, position('${enrol.secret}' in mfa_secret_ciphertext) = 0, cardinality(mfa_recovery_hashes) FROM users WHERE id = '${mUserId}'`).split('|');
ok(urow[0] === 't' && urow[1] === '1' && urow[2] === 't' && urow[3] === '10', 'users row: MFA enabled, key version 1, secret stored encrypted (not plaintext), 10 recovery hashes');
const hashes = sql(`SELECT array_to_string(mfa_recovery_hashes, ',') FROM users WHERE id = '${mUserId}'`).split(',');
ok(codes.every((x) => hashes.includes(sha256(x)) && !hashes.includes(x)), 'recovery codes are stored only as SHA-256 hashes');
ok((await m0.must('GET', '/auth/me')).user.mfa_enabled === true, 'GET /auth/me reports mfa_enabled');

console.log('Login now requires MFA');
const sessionsBefore = sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${mUserId}'`);
const m1 = new Client('mfa-1');
const challenge = await m1.call('POST', '/auth/login', { email: mEmail, password: PM });
ok(challenge.status === 401 && challenge.error.code === 'MFA_REQUIRED' && typeof challenge.error.details?.challenge === 'string', 'password-only login → 401 MFA_REQUIRED with a short-lived challenge nonce');
ok(!m1.cookies.rd_session && sql(`SELECT count(*) FROM auth_sessions WHERE user_id = '${mUserId}'`) === sessionsBefore, 'no session cookie and no auth_sessions row exist until the second factor verifies');
const nonceRow = sql(`SELECT round(extract(epoch FROM expires_at - created_at)) FROM auth_tokens WHERE token_hash = '${sha256(challenge.error.details.challenge)}' AND purpose = 'mfa_challenge'`);
ok(nonceRow === '300', `challenge nonce is stored hashed with a 5-minute lifetime (${nonceRow} s)`);
const wrong = await m1.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: wrongCode(enrol.secret) });
ok(wrong.status === 401 && wrong.error.code === 'MFA_REQUIRED' && !m1.cookies.rd_session, 'a wrong TOTP is refused (401 MFA_REQUIRED) without a session');
const reuseConfirm = await new Client('confirm-replay').call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: totp(enrol.secret, lastStep * 30_000) });
ok(reuseConfirm.status === 401 && reuseConfirm.error.code === 'MFA_REQUIRED', 'the code that confirmed enrollment cannot also complete a sign-in');
clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');
const code1 = await nextTotp(enrol.secret);
const good = await m1.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: code1 });
ok(good.status === 200 && !!m1.cookies.rd_session && (await m1.call('GET', '/agents/me')).status === 200, 'password + current TOTP → 200 with a working session');

console.log('Recovery codes are single use');
const m2 = new Client('mfa-2');
const rec = await m2.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: codes[0] });
ok(rec.status === 200 && (await m2.call('GET', '/agents/me')).status === 200, 'a recovery code signs in once');
const m3 = new Client('mfa-3');
const reuse = await m3.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: codes[0] });
ok(reuse.status === 401 && reuse.error.code === 'MFA_REQUIRED' && !m3.cookies.rd_session, 'the same recovery code is refused the second time');
ok(sql(`SELECT cardinality(mfa_recovery_hashes) FROM users WHERE id = '${mUserId}'`) === '9', 'the used code\'s hash was removed (9 left)');

// Race: each round spends one fresh recovery code from 4 concurrent logins.
const rounds = [];
for (const code of [codes[1], codes[2], codes[3]]) {
  clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');
  const racers = await Promise.all([0, 1, 2, 3].map((i) => new Client(`race-${i}`).call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: code })));
  rounds.push(racers.filter((r) => r.status === 200).length);
}
ok(rounds.every((w) => w === 1), `a recovery code used by 4 concurrent logins signs in exactly once (successful sign-ins per round: [${rounds.join(', ')}])`);

console.log('TOTP code reuse and MFA brute force');
clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');
const replayed = await new Client('replay').call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: code1 });
ok(replayed.status === 401, `a TOTP code already used for a sign-in is refused when replayed in its window (RFC 6238 §5.2; got ${replayed.status})`);
clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');
const bf = new Client('brute');
const bad = wrongCode(enrol.secret);
const tries = [];
for (let i = 0; i < 5; i++) tries.push((await bf.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: bad })).status);
ok(tries.every((s) => s === 401), 'five wrong codes → 401 each');
const sixth = await bf.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: await nextTotp(enrol.secret, { consume: false }) });
ok(sixth.status === 429 && sixth.error.code === 'RATE_LIMITED' && !bf.cookies.rd_session, 'the sixth attempt inside 5 minutes is rate limited (429) even with a valid code — MFA brute force is capped');

console.log('Trusted device');
clearRateLimits(`rl:mfa:${mUserId}:*`, 'rl:login:*');
const dev = new Client('device');
const remembered = await dev.call('POST', '/auth/login', { email: mEmail, password: PM, totp_code: await nextTotp(enrol.secret), remember_device: true });
ok(remembered.status === 200 && !!dev.cookies.rd_device, 'login with remember_device sets an rd_device cookie');
ok(sql(`SELECT count(*) FROM trusted_devices WHERE user_id = '${mUserId}' AND token_hash = '${sha256(dev.cookies.rd_device)}'`) === '1', 'trusted device stored by token hash');
const deviceCookie = dev.cookies.rd_device;
dev.cookies = { rd_device: deviceCookie };
const skip = await dev.call('POST', '/auth/login', { email: mEmail, password: PM });
ok(skip.status === 200 && !!dev.cookies.rd_session, 'the trusted device signs in with the password alone');
const stranger = await new Client('stranger').call('POST', '/auth/login', { email: mEmail, password: PM });
ok(stranger.status === 401 && stranger.error.code === 'MFA_REQUIRED', 'a browser without the device cookie is still challenged');

console.log('Recent auth with MFA on, recovery regeneration and DELETE /auth/mfa');
const mSession = (await m1.must('GET', '/auth/sessions')).find((s) => s.current).id;
sql(`UPDATE auth_sessions SET recent_auth_at = now() - interval '20 minutes' WHERE id = '${mSession}'`);
const staleDisable = await m1.call('DELETE', '/auth/mfa', { code: await nextTotp(enrol.secret, { consume: false }) });
ok(staleDisable.status === 403 && staleDisable.error.code === 'RECENT_AUTH_REQUIRED', 'DELETE /auth/mfa on a stale sign-in → 403 RECENT_AUTH_REQUIRED');
const staleRegen = await m1.call('POST', '/auth/mfa/recovery-codes', { code: await nextTotp(enrol.secret, { consume: false }) });
ok(staleRegen.status === 403 && staleRegen.error.code === 'RECENT_AUTH_REQUIRED', 'POST /auth/mfa/recovery-codes on a stale sign-in → 403 RECENT_AUTH_REQUIRED');
ok(sql(`SELECT mfa_enabled_at IS NOT NULL FROM users WHERE id = '${mUserId}'`) === 't', 'MFA is still on after the refused attempts');
const pwOnly = await m1.call('POST', '/auth/reauthenticate', { password: PM });
ok(pwOnly.status === 401 && pwOnly.error.code === 'MFA_REQUIRED', 'reauthenticate with the password alone → 401 MFA_REQUIRED when MFA is on');
ok((await m1.call('POST', '/auth/reauthenticate', { password: PM, totp_code: await nextTotp(enrol.secret) })).status === 204, 'reauthenticate with password + TOTP → 204');
const regen = await m1.call('POST', '/auth/mfa/recovery-codes', { code: await nextTotp(enrol.secret) });
const newCodes = regen.data?.recovery_codes ?? [];
const newHashes = sql(`SELECT array_to_string(mfa_recovery_hashes, ',') FROM users WHERE id = '${mUserId}'`).split(',');
ok(regen.status === 201 && newCodes.length === 10 && newCodes.every((x) => newHashes.includes(sha256(x))) && codes.every((x) => !newHashes.includes(sha256(x))), 'regenerating recovery codes replaces the whole set (old codes invalid)');

const badDisable = await m1.call('DELETE', '/auth/mfa', { code: wrongCode(enrol.secret) });
ok(badDisable.status === 422 && badDisable.error.code === 'VALIDATION_FAILED' && sql(`SELECT mfa_enabled_at IS NOT NULL FROM users WHERE id = '${mUserId}'`) === 't', 'DELETE /auth/mfa with a wrong code → 422, MFA stays on');
const oldCookies = { ...m1.cookies };
const disabled = await m1.call('DELETE', '/auth/mfa', { code: await nextTotp(enrol.secret) });
ok(disabled.status === 204, 'DELETE /auth/mfa {code} with the current TOTP → 204');
ok(disabled.setCookies.some((x) => x.startsWith('rd_session=')) && m1.cookies.rd_session !== oldCookies.rd_session && m1.cookies.rd_csrf !== oldCookies.rd_csrf, 'a new session cookie and CSRF token are issued');
const oldClient = new Client('old-cookie');
oldClient.cookies = oldCookies;
ok((await oldClient.call('GET', '/agents/me')).status === 401, 'the pre-rotation session cookie no longer works');
ok((await m1.call('GET', '/agents/me')).status === 200, 'the rotated cookie works');
ok((await m1.must('GET', '/auth/sessions')).find((s) => s.current).id === mSession, 'rotation keeps the session record (same session id, new token)');
const audit = sql(`SELECT count(*) || '|' || coalesce(max(actor_id::text), '') FROM audit_events WHERE tenant_id = '${tenantId}' AND action = 'security.mfa_disabled' AND object_id = '${mUserId}'`);
ok(audit === `1|${mUserId}`, 'audit_events has security.mfa_disabled for the user in the workspace');
const afterRow = sql(`SELECT (mfa_enabled_at IS NULL)::text || (mfa_secret_ciphertext IS NULL)::text || cardinality(mfa_recovery_hashes) FROM users WHERE id = '${mUserId}'`);
ok(afterRow === 'truetrue0', 'secret and recovery hashes are erased');
ok(sql(`SELECT count(*) FROM trusted_devices WHERE user_id = '${mUserId}'`) === '0', 'trusted devices are forgotten when MFA is disabled');
const plain = await new Client('plain').call('POST', '/auth/login', { email: mEmail, password: PM });
ok(plain.status === 200, 'login no longer asks for a second factor');
ok(!JSON.stringify(sql(`SELECT coalesce(json_agg(safe_diff)::text, '') FROM audit_events WHERE tenant_id = '${tenantId}' AND action LIKE 'security.%'`)).includes(enrol.secret), 'audit rows carry no MFA secret');

for (const s of [sock0, sockB, sockC]) s.disconnect();
console.log(`\nAUTH E2E PASSED (${passed} checks)`);
if (knownFails.length) {
  console.log(`KNOWN FAILS (${knownFails.length}):`);
  for (const k of knownFails) console.log(`  - ${k}`);
}
process.exit(0);
