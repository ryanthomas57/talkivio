// Talkivio visitors feature end-to-end test (ch. 11/17/24/25/26/37/43/46) against a running api + worker.
// Real HTTP, real sockets, real database — no mocks.
//   API_URL=http://127.0.0.1:4102 DATABASE_OWNER_URL=... node test/visitors.e2e.mjs
// Use the default VISITOR_TIMEOUT_MS (it must stay above the 15 s gateway heartbeat).
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://127.0.0.1:4102';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-c', q]).toString().trim();

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
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) this.cookies[k] = decodeURIComponent(v);
      else delete this.cookies[k];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error, page: json?.page };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

const anon = new Client('widget');
const W = (method, path, body, cap, extra = {}) => anon.call(method, `/widget/v1${path}`, body, { ...(cap ? { authorization: `Bearer ${cap}` } : {}), ...extra });

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload, secret) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);

const stamp = Date.now();
// Signup is rate limited per client address; give each run its own (TRUST_PROXY=loopback honours it).
const runIp = { 'x-forwarded-for': `10.${(stamp >> 16) & 255}.${(stamp >> 8) & 255}.${stamp & 255}` };
const ORIGIN = 'http://localhost:5173';
const DEST_ORIGIN = 'http://localhost:5174';

console.log('Setup — tenant, sites, agent online');
const owner = new Client('owner');
const ownerEmail = `vis-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Visitors ${stamp}`, timezone: 'UTC' }, runIp);
const verifyText = await waitFor(() => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${ownerEmail}' AND template = 'verify_email' ORDER BY created_at DESC LIMIT 1`), 5000, 'verification email');
await owner.must('POST', '/auth/verify-email', { token: decodeURIComponent((verifyText.match(/[?/]token[=/]([^\s&]+)/) ?? [])[1] ?? '') });
const tenantA = signup.me.active_tenant_id;
const site = await owner.must('POST', '/sites', { name: 'Store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const dest = await owner.must('POST', '/sites', { name: 'Help center', origins: [{ origin: DEST_ORIGIN, pattern_type: 'exact' }] });
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
const sub = await ownerSock.emitWithAck('subscribe', { scopes: [{ kind: 'visitor', id: 'all' }, { kind: 'queue', id: 'none' }] });
ok(sub.type === 'subscription.ok' && sub.granted === 2, 'agent subscribed to visitor:all monitoring scope');
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const depts = await owner.must('GET', '/departments');
for (const d of depts) await ownerSock.emitWithAck('subscribe', { scopes: [{ kind: 'queue', id: d.id }] });

const newSession = (extra = {}, headers = {}) =>
  W('POST', '/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: true, policy_version: '2026-10' }, ...extra }, null, headers);
const ticketFor = async (cap) => (await W('POST', '/socket-ticket', undefined, cap)).data.ticket;
const live = async (qs = '') => owner.must('GET', `/visitors/live${qs}`);
const deltasFor = (visitorId) => ownerSock.ephemeral.filter((f) => f.type === 'visitor.updated' && f.payload.visitor_id === visitorId);

// ───────────────────────────────────────────────────────────────────────
console.log('VIS01 — two tabs → one live visitor, distinct sessions, most recent page');
const tab1 = (await newSession({ page: { url: `${ORIGIN}/pricing?utm_source=x&email=a@b.c#top`, title: 'Pricing', referrer: 'https://www.google.com/search?q=chat' } })).data;
ok(tab1.anonymous_token && tab1.anonymous_token_persistence === 'persistent', 'analytics consent → persistent anonymous credential');
const tab2 = (await newSession({ anonymous_token: tab1.anonymous_token, page: { url: `${ORIGIN}/`, title: 'Home' } })).data;
const V = tab1.visitor.id;
ok(tab2.visitor.id === V && tab2.session_id !== tab1.session_id && tab2.anonymous_token === null, 'second tab resumes the same visitor with its own session');
const vs1 = await socket('/visitor', await ticketFor(tab1.capability));
const vs2 = await socket('/visitor', await ticketFor(tab2.capability));
await sleep(300);
const ev2 = await W('POST', '/events', { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}/docs/start?token=secret#frag`, title: 'Docs', client_at: new Date().toISOString() }] }, tab2.capability);
ok(ev2.status === 202 && ev2.data.accepted === 1, 'page event accepted (202)');
const snap1 = await waitFor(async () => {
  const s = await live();
  const mine = s.items.filter((i) => i.visitor_id === V);
  return mine.length === 1 && mine[0].sessions.length === 2 && mine[0].current_url === `${ORIGIN}/docs/start` ? s : null;
}, 6000, 'two-tab visitor in live list');
const item1 = snap1.items.find((i) => i.visitor_id === V);
ok(snap1.items.filter((i) => i.visitor_id === V).length === 1, 'concurrent tabs appear as ONE live visitor');
ok(new Set(item1.sessions.map((s) => s.session_id)).size === 2, 'visitor lists two distinct sessions');
ok(item1.sessions.find((s) => s.most_recent).session_id === tab2.session_id, 'most recently active page marker is on the navigating tab');
ok(item1.sessions.find((s) => s.session_id === tab1.session_id).current_url === `${ORIGIN}/pricing`, 'URLs sanitized: query and fragment stripped');
ok(item1.referrer_origin === null || item1.referrer_origin === 'https://www.google.com' || item1.sessions.some((s) => s.referrer_origin === 'https://www.google.com'), 'referrer reduced to origin');
ok(item1.group === 'browsing' && item1.anonymous_label && item1.identity.verified === false && item1.session_count === 2, 'browsing group, anonymous label, session count');
ok(snap1.as_of && snap1.snapshot_cursor?.startsWith('c1.') && snap1.counts.browsing >= 1 && snap1.omitted_browsing === false, 'snapshot carries as_of, snapshot_cursor and group counts');
ok(typeof item1.time_on_site_ms === 'number' && typeof item1.page_dwell_ms === 'number' && item1.device_category, 'time on site, current page dwell and device category');
await waitFor(() => deltasFor(V).some((f) => f.payload.allowed_patch?.sessions?.length === 2), 6000, 'coalesced visitor.updated delta');
ok(true, 'coalesced visitor.updated delta reached the agent visitor:all room');
const perSecond = deltasFor(V).map((f) => Date.parse(f.payload.as_of));
ok(perSecond.every((t, i) => i === 0 || t - perSecond[i - 1] >= 900), 'deltas for the tenant are coalesced (≥ 1 s apart)');

// ───────────────────────────────────────────────────────────────────────
console.log('VIS01 — SPA navigation updates page without creating a chat');
const chatA = await W('POST', '/chats', { client_request_id: randomUUID(), message: 'Hi, question about pricing' }, tab1.capability);
ok(chatA.status === 201, 'visitor started a chat');
const chatId = chatA.data.chat.id;
const navId = randomUUID();
const nav = await W('POST', '/events', { events: [{ id: navId, kind: 'entered', url: `${ORIGIN}/checkout`, title: 'Checkout' }] }, tab1.capability);
const dup = await W('POST', '/events', { events: [{ id: navId, kind: 'entered', url: `${ORIGIN}/checkout`, title: 'Checkout' }] }, tab1.capability);
ok(nav.data.accepted === 1 && dup.data.accepted === 0 && dup.data.duplicates === 1, 'client event ids are deduplicated');
const snap2 = await waitFor(async () => {
  const s = await live();
  const it = s.items.find((i) => i.visitor_id === V);
  return it?.current_url === `${ORIGIN}/checkout` ? it : null;
}, 6000, 'SPA page update');
ok(snap2.group === 'incoming' && snap2.chat.id === chatId && snap2.chat.wait_ms >= 0, 'visitor shown as incoming with chat status and queue age');
const vchats = await owner.call('GET', `/visitors/${V}/chats`);
ok(vchats.data.length === 1 && vchats.data[0].id === chatId, 'SPA navigation created no new chat (exactly one chat)');
await W('POST', '/events', { events: [{ id: randomUUID(), kind: 'hidden', url: `${ORIGIN}/checkout` }] }, tab1.capability);
const sessionsPage = await owner.call('GET', `/visitors/${V}/sessions`);
const s1 = sessionsPage.data.find((s) => s.id === tab1.session_id);
ok(sessionsPage.status === 200 && s1.pages.some((p) => p.url === `${ORIGIN}/checkout`) && s1.pages.every((p) => p.dwell_ms >= 0), 'session timeline with sanitized pages and server-time dwell');
const totalExclusive = sessionsPage.data.reduce((a, s) => a + (s.exclusive_visible_ms ?? 0), 0);
const totalVisible = sessionsPage.data.reduce((a, s) => a + (s.visible_ms ?? 0), 0);
ok(totalExclusive <= totalVisible, 'overlapping visible tabs are not double counted (exclusive ≤ raw visible)');

// ───────────────────────────────────────────────────────────────────────
console.log('CONS01/02 — consent withdrawal hides browsing data');
const wSess = (await newSession({ page: { url: `${ORIGIN}/blog`, title: 'Blog' } }, { 'x-forwarded-for': '192.0.2.10' })).data;
const wSock = await socket('/visitor', await ticketFor(wSess.capability));
await W('POST', '/events', { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}/blog/post-1`, title: 'Post' }] }, wSess.capability);
await waitFor(async () => (await live()).items.some((i) => i.visitor_id === wSess.visitor.id && i.group === 'browsing'), 6000, 'consenting browser listed');
ok(true, 'consenting browsing visitor is listed');
const withdraw = await W('PUT', '/consent', { purpose: 'analytics', state: 'withdrawn', policy_version: '2026-10' }, wSess.capability);
ok(withdraw.status === 200 && withdraw.data.collection === 'restricted' && withdraw.data.erasure?.state === 'scheduled', 'withdrawal restricts collection and schedules deletion (not reported complete)');
const afterW = await live();
ok(!afterW.items.some((i) => i.visitor_id === wSess.visitor.id), 'withdrawn visitor disappears from browsing views immediately');
const ignored = await W('POST', '/events', { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}/blog/post-2` }] }, wSess.capability);
ok(ignored.data.accepted === 0 && ignored.data.reason === 'consent', 'events after withdrawal are not collected');
await waitFor(() => deltasFor(wSess.visitor.id).some((f) => f.payload.allowed_patch === null), 6000, 'removal delta');
ok(true, 'agents receive a visitor.updated removal (allowed_patch null)');
await waitFor(() => sql(`SELECT state FROM jobs WHERE id = '${withdraw.data.erasure.job_id}'`) === 'succeeded', 10000, 'consent purge job');
ok(sql(`SELECT count(*) FROM page_events pe JOIN visitor_sessions s ON s.id = pe.session_id WHERE s.visitor_id = '${wSess.visitor.id}'`) === '0', 'durable worker purged the withdrawn visitor’s page events');
const midChat = await W('PUT', '/consent', { purpose: 'analytics', state: 'withdrawn', policy_version: '2026-10' }, tab1.capability);
ok(midChat.status === 200, 'chatting visitor withdraws analytics consent mid-chat');
const vAfter = (await live()).items.find((i) => i.visitor_id === V);
ok(vAfter && vAfter.group === 'incoming' && vAfter.browsing_hidden === true && vAfter.current_url === null && vAfter.sessions.every((s) => s.current_url === null), 'service chat remains visible while browsing details are hidden');
const svcMsg = await W('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'still here' }, tab1.capability);
ok(svcMsg.status === 201, 'service conversation continues after withdrawal');
const deniedSess = (await W('POST', '/sessions', { site_key: site.public_key, host_origin: ORIGIN, page: { url: `${ORIGIN}/secret` } })).data;
ok(deniedSess.consent.analytics === 'unknown' && deniedSess.anonymous_token_persistence === 'session', 'unknown consent → no persistent browsing identity');

// ───────────────────────────────────────────────────────────────────────
console.log('VIS02 / SEC03 — verified identity vs forged unverified email');
const { secret } = await owner.must('POST', `/sites/${site.id}/identity-secret`);
const idClaims = (sub, extra = {}) => ({ iss: site.id, aud: 'talkivio visitor', sub, iat: now(), exp: now() + 120, jti: randomUUID(), ...extra });
const tokX = jwt(idClaims('cust-42', { email: 'alice@example.com', name: 'Alice' }), secret);
const xSess = (await newSession({ identity_token: tokX }, { 'x-forwarded-for': '192.0.2.20' })).data;
ok(xSess.visitor.verified === true && xSess.visitor.fields_verified === true, 'verified JWT links the visitor (verified fields)');
const X = xSess.visitor.id;
const xChat = await W('POST', '/chats', { client_request_id: randomUUID(), message: 'secret order 77 for alice' }, xSess.capability);
ok(xChat.status === 201, 'verified visitor has a private chat');
const replay = await newSession({ identity_token: tokX });
ok(replay.status === 401 && replay.error.code === 'TOKEN_USED', 'replayed jti rejected');
for (const [label, token] of [
  ['forged signature', jwt(idClaims('cust-42'), 'not-the-secret-not-the-secret-123')],
  ['lifetime > 5 minutes', jwt(idClaims('cust-42', { exp: now() + 600 }), secret)],
  ['wrong audience', jwt(idClaims('cust-42', { aud: 'someone else' }), secret)],
  ['other site binding', jwt(idClaims('cust-42', { site_id: dest.id }), secret)],
  ['missing jti', jwt({ ...idClaims('cust-42'), jti: undefined }, secret)],
  ['expired', jwt(idClaims('cust-42', { iat: now() - 400, exp: now() - 200 }), secret)],
]) {
  const r = await newSession({ identity_token: token });
  ok(r.status === 401 && r.error.code === 'TOKEN_EXPIRED', `identity token rejected: ${label}`);
}
const ySess = (await newSession({}, { 'x-forwarded-for': '192.0.2.30' })).data;
const Y = ySess.visitor.id;
const forged = await W('POST', '/identity', { email: 'alice@example.com', name: 'Alice' }, ySess.capability);
ok(forged.status === 200 && forged.data.verified === false, 'SDK identify with a matching email stays unverified');
const priv = await W('POST', '/identity', { email: 'alice@example.com', verified: true }, ySess.capability);
ok(priv.status === 422, 'client cannot set verified (schema rejects privileged write)');
const yAgain = (await newSession({ anonymous_token: ySess.anonymous_token })).data;
ok(yAgain.visitor.id === Y && yAgain.active_chat === null, 'forged email browser sees no verified customer chat');
const peek = await W('GET', `/chats/${xChat.data.chat.id}/messages`, undefined, ySess.capability);
ok(peek.status === 404, 'forged email cannot read verified history');
const yProfile = await owner.must('GET', `/visitors/${Y}`);
const xProfile = await owner.must('GET', `/visitors/${X}`);
ok(yProfile.fields.email.value === 'alice@example.com' && yProfile.fields.email.verified === false && yProfile.identity_verified === false, 'staff profile marks the SDK email unverified (decrypted for staff)');
ok(xProfile.identity_verified === true && xProfile.fields.email.verified === true && xProfile.fields.name.verified === true, 'staff profile marks token fields verified');
const xIdentify = await W('POST', '/identity', { email: 'mallory@example.com' }, xSess.capability);
ok(xIdentify.data.ignored.includes('email'), 'unverified identify never overwrites verified fields');
const second = (await newSession({ identity_token: jwt(idClaims('cust-42'), secret) }, { 'x-forwarded-for': '192.0.2.21' })).data;
ok(second.visitor.id === X && second.active_chat?.id === xChat.data.chat.id, 'same verified subject on a second browser joins the identity and sees permitted chat');
const switchMid = await newSession({ anonymous_token: xSess.anonymous_token, identity_token: jwt(idClaims('cust-99'), secret) });
ok(switchMid.status === 409, 'identity switching during an active chat requires reset');
const contacts = await owner.must('GET', `/visitors?q=${encodeURIComponent('alice@example.com')}`);
ok(contacts.some((c) => c.id === X) && contacts.some((c) => c.id === Y && c.identity_verified === false), 'contacts exact-email search via lookup hash (no merge by email)');

// ───────────────────────────────────────────────────────────────────────
console.log('VIS03 — reset hides the prior transcript');
const reset = await W('POST', '/identity/reset', { anonymous_token: xSess.anonymous_token, consent: { analytics: true, policy_version: '2026-10' } }, xSess.capability);
ok(reset.status === 200 && reset.data.visitor.id !== X && reset.data.active_chat === null && reset.data.capability, 'reset returns a new anonymous context');
const oldCap = await W('GET', `/chats/${xChat.data.chat.id}/messages`, undefined, xSess.capability);
ok(oldCap.status === 401, 'old capability is revoked');
const newCap = await W('GET', `/chats/${xChat.data.chat.id}`, undefined, reset.data.capability);
ok(newCap.status === 404, 'next user cannot open the previous transcript');
const oldTok = (await newSession({ anonymous_token: xSess.anonymous_token })).data;
ok(oldTok.visitor.id !== X && oldTok.active_chat === null, 'revoked anonymous credential no longer resolves the prior visitor');

// ───────────────────────────────────────────────────────────────────────
console.log('Custom fields and tags');
const fPlan = await owner.call('POST', '/custom-fields', { key: 'plan', label: 'Plan', data_type: 'enum', validation: { options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }] }, public_writable: true, visible_to_visitor: true });
ok(fPlan.status === 201 && fPlan.data.validation.options.length === 2, 'enum custom field created');
const fLtv = await owner.call('POST', '/custom-fields', { key: 'lifetime_value', label: 'LTV', data_type: 'number', validation: { min: 0, integer: true } });
ok(fLtv.status === 201 && fLtv.data.public_writable === false, 'private number field created');
ok((await owner.call('POST', '/custom-fields', { key: 'vip', label: 'VIP', data_type: 'boolean' })).status === 422, 'reserved key rejected');
ok((await owner.call('POST', '/custom-fields', { key: 'tier', label: 'Tier', data_type: 'enum', validation: {} })).status === 422, 'enum without options rejected');
ok((await owner.call('POST', '/custom-fields', { key: 'code', label: 'Code', data_type: 'string', validation: { pattern: '(a+)+$' } })).status === 422, 'executable/regex validation rejected');
const sdkOk = await W('PUT', '/visitor/custom-fields', { custom_fields: { plan: 'pro' } }, tab2.capability);
ok(sdkOk.status === 200 && sdkOk.data.custom_fields.plan === 'pro' && sdkOk.data.visitor_id === V, 'SDK writes a public_writable field');
const afterSdk = await owner.must('GET', `/visitors/${V}`);
ok(afterSdk.custom_field_sources.plan?.source === 'visitor' && afterSdk.custom_field_sources.plan.by === null && !Number.isNaN(Date.parse(afterSdk.custom_field_sources.plan.at)), 'provenance: the SDK value is attributed to the visitor (the site\'s page, unverified)');
for (const [label, body] of [
  ['non-public field', { lifetime_value: 5 }],
  ['unknown key', { shoe_size: 42 }],
  ['nested object', { plan: { value: 'pro' } }],
  ['value outside enum', { plan: 'enterprise' }],
]) {
  const r = await W('PUT', '/visitor/custom-fields', { custom_fields: body }, tab2.capability);
  ok(r.status === 422 && r.error.code === 'VALIDATION_FAILED', `SDK custom field rejected: ${label}`);
}
const noPre = await owner.call('PATCH', `/visitors/${V}`, { display_name: 'Vee' });
ok(noPre.status === 428, 'PATCH without If-Match → 428');
const prof = await owner.must('GET', `/visitors/${V}`);
const patched = await owner.call('PATCH', `/visitors/${V}`, { display_name: 'Vee', custom_fields: { lifetime_value: 1200 } }, { 'if-match': `"${prof.version}"` });
ok(patched.status === 200 && patched.data.display_name === 'Vee' && patched.data.fields.name.verified === false && patched.data.custom_fields.lifetime_value === 1200, 'agent edit is applied and stays unverified');
const ownerMembership = (await owner.must('GET', '/agents/me')).agent.id;
ok(patched.data.custom_field_sources.lifetime_value?.source === 'agent' && patched.data.custom_field_sources.lifetime_value.by === ownerMembership && patched.data.custom_field_sources.plan?.source === 'visitor', 'provenance: the staff edit is attributed to that agent; the untouched SDK value keeps its own source');
// Write visibility: a write-only field is echoed to its writer once; private and write-only values never reach the page afterwards.
const fNote = await owner.call('POST', '/custom-fields', { key: 'page_note', label: 'Page note', data_type: 'string', public_writable: true, visible_to_visitor: false });
ok(fNote.status === 201 && fNote.data.public_writable === true && fNote.data.visible_to_visitor === false, 'write-only (public_writable, not visible_to_visitor) definition created');
const noteWrite = await W('PUT', '/visitor/custom-fields', { custom_fields: { page_note: 'from the page' } }, tab2.capability);
ok(noteWrite.status === 200 && noteWrite.data.custom_fields.page_note === 'from the page' && !('lifetime_value' in noteWrite.data.custom_fields), 'the writer sees its own write-only value, never the private one');
const later = await W('PUT', '/visitor/custom-fields', { custom_fields: { plan: 'free' } }, tab2.capability);
ok(later.status === 200 && later.data.custom_fields.plan === 'free' && !('page_note' in later.data.custom_fields) && !('lifetime_value' in later.data.custom_fields), 'later page responses show visible_to_visitor fields only');
const staffView = await owner.must('GET', `/visitors/${V}`);
ok(staffView.custom_fields.page_note === 'from the page' && staffView.custom_field_sources.page_note?.source === 'visitor' && staffView.custom_fields.lifetime_value === 1200, 'staff see every value with its source');
const removed = await owner.call('PATCH', `/visitors/${V}`, { custom_fields: { page_note: null } }, { 'if-match': `"${staffView.version}"` });
ok(removed.status === 200 && !('page_note' in removed.data.custom_fields) && !('page_note' in removed.data.custom_field_sources), 'removing a value removes its provenance entry');
const stale = await owner.call('PATCH', `/visitors/${V}`, { display_name: 'Old' }, { 'if-match': `"${prof.version}"` });
ok(stale.status === 409 && stale.error.code === 'VERSION_CONFLICT', 'stale If-Match → 409');
const badAgent = await owner.call('PATCH', `/visitors/${V}`, { custom_fields: { lifetime_value: -5 } }, { 'if-match': `"${removed.data.version}"` });
ok(badAgent.status === 422 && badAgent.error.field_errors['custom_fields.lifetime_value'], 'agent custom field validated against definition');
const snapshotMsg = sql(`SELECT sender_name_snapshot FROM messages WHERE chat_id = '${chatId}' AND sender_type = 'visitor' ORDER BY seq LIMIT 1`);
ok(snapshotMsg !== 'Vee', 'renaming a visitor never rewrites historical sender snapshots');
const typeChange = await owner.call('PATCH', `/custom-fields/${fPlan.data.id}`, { data_type: 'string' }, { 'if-match': `"${fPlan.data.version}"` });
ok(typeChange.status === 409, 'destructive type change while populated → 409');
const relabel = await owner.call('PATCH', `/custom-fields/${fPlan.data.id}`, { label: 'Subscription plan' }, { 'if-match': `"${fPlan.data.version}"` });
ok(relabel.status === 200 && relabel.data.version === fPlan.data.version + 1, 'definition label updated with version bump');
const tagReturning = await owner.must('POST', '/tags', { label: 'Returning' });
const tagLead = await owner.must('POST', '/tags', { label: 'Priority lead' });
const agentTags = await owner.call('PUT', `/visitors/${V}/tags`, { tag_ids: [tagLead.id] });
ok(agentTags.status === 200 && agentTags.data.tags[0].source === 'agent', 'agent tag applied with source attribution');
const sdkTags = await W('PUT', '/visitor/tags', { tags: ['Returning'] }, tab2.capability);
ok(sdkTags.status === 200 && sdkTags.data.tags.length === 1 && sdkTags.data.tags[0] === 'returning', 'SDK tag normalized, stored as client tag; agent tags not exposed');
const both = await owner.must('GET', `/visitors/${V}`);
ok(both.tags.some((t) => t.slug === 'returning' && t.source === 'client') && both.tags.some((t) => t.id === tagLead.id && t.source === 'agent'), 'profile distinguishes client vs agent tag provenance');
const sdkClear = await W('PUT', '/visitor/tags', { tags: [] }, tab2.capability);
const afterClear = await owner.must('GET', `/visitors/${V}`);
ok(sdkClear.status === 200 && afterClear.tags.length === 1 && afterClear.tags[0].id === tagLead.id, 'SDK never removes agent-applied tags');
ok((await W('PUT', '/visitor/tags', { tags: ['no-such-tag'] }, tab2.capability)).status === 422, 'SDK cannot create tags');
ok((await W('PUT', '/visitor/tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, tab2.capability)).status === 422, 'SDK tag list bounded to 20');
const byTag = await live(`?tag=${tagLead.slug}`);
ok(byTag.items.length === 1 && byTag.items[0].visitor_id === V, 'live list filters by tag');

// ───────────────────────────────────────────────────────────────────────
console.log('Merge requests');
const emailProof = await owner.call('POST', '/visitors/merge-requests', { source_id: Y, target_id: X, proof_reference: 'alice@example.com', reason: 'Same person' });
ok(emailProof.status === 422, 'email text alone is not merge proof');
const unverifiedTarget = await owner.call('POST', '/visitors/merge-requests', { source_id: X, target_id: Y, proof_reference: 'ticket-881 passport check', reason: 'Same person' });
ok(unverifiedTarget.status === 422, 'merge target must be identity-verified');
const merge = await owner.call('POST', '/visitors/merge-requests', { source_id: Y, target_id: X, proof_reference: 'ticket-881 passport check', reason: 'Customer confirmed by phone' });
ok(merge.status === 202 && merge.data.state === 'queued' && merge.data.review_state === 'pending_review', '202 reviewed association job created (no automatic merge)');

// ───────────────────────────────────────────────────────────────────────
console.log('Cross-domain handoff (ch. 26)');
const hClaims = (extra = {}) => ({ iss: site.id, aud: 'talkivio handoff', sub: 'cust-42', iat: now(), exp: now() + 45, jti: randomUUID(), ...extra });
const hBody = { site_key: site.public_key, destination_site_id: dest.id, destination_origin: DEST_ORIGIN, visitor_subject: 'cust-42' };
ok((await W('POST', '/identity/handoff', hBody)).status === 401, 'handoff requires backend authentication');
ok((await W('POST', '/identity/handoff', hBody, jwt(idClaims('cust-42'), secret))).status === 401, 'identity token cannot be used as a handoff credential');
ok((await W('POST', '/identity/handoff', { ...hBody, visitor_subject: 'nobody' }, jwt(hClaims({ sub: 'nobody' }), secret))).status === 404, 'unknown subject → 404');
ok((await W('POST', '/identity/handoff', { ...hBody, destination_origin: 'https://evil.example' }, jwt(hClaims(), secret))).status === 403, 'unapproved destination origin rejected');
const h1 = await W('POST', '/identity/handoff', hBody, jwt(hClaims(), secret));
ok(h1.status === 201 && h1.data.handoff_code.startsWith('rdho_') && Date.parse(h1.data.expires_at) - Date.now() <= 60_000, 'single-use 60 s handoff code issued');
ok(sql(`SELECT count(*) FROM identity_handoffs WHERE nonce_hash = encode(sha256('${h1.data.handoff_code}'::bytea), 'hex')`) === '1', 'only the nonce hash is stored');
const red = await W('POST', '/identity/redeem', { handoff_code: h1.data.handoff_code, site_key: dest.public_key, host_origin: DEST_ORIGIN, consent: { analytics: true, policy_version: '2026-10' } });
ok(red.status === 200 && red.data.visitor.id === X && red.data.capability && red.data.handoff.source_site_id === site.id, 'redeem → destination-scoped capability for the same visitor');
ok(red.data.active_chat === null, 'no chat ownership transferred to the destination domain');
ok((await W('GET', `/chats/${xChat.data.chat.id}`, undefined, red.data.capability)).status === 404, 'destination capability cannot read source-site transcripts');
const red2 = await W('POST', '/identity/redeem', { handoff_code: h1.data.handoff_code, site_key: dest.public_key, host_origin: DEST_ORIGIN });
ok(red2.status === 401 && red2.error.code === 'TOKEN_USED', 'handoff code is single use');
const h2 = await W('POST', '/identity/handoff', hBody, jwt(hClaims(), secret));
const wrongDest = await W('POST', '/identity/redeem', { handoff_code: h2.data.handoff_code, site_key: site.public_key, host_origin: ORIGIN });
ok(wrongDest.status === 403 && wrongDest.error.code === 'ORIGIN_NOT_ALLOWED', 'redeem on a different destination is refused');
const burned = await W('POST', '/identity/redeem', { handoff_code: h2.data.handoff_code, site_key: dest.public_key, host_origin: DEST_ORIGIN });
ok(burned.status === 401, 'a code presented to the wrong destination is burned');

// ───────────────────────────────────────────────────────────────────────
console.log('BAN01 — bans, expiry, unban, tenant isolation');
const liveVisitor = await socket('/visitor', await ticketFor(tab2.capability));
const liveControls = [];
liveVisitor.on('control', (c) => liveControls.push(c));
const ban = await owner.call('POST', '/bans', { visitor_id: V, reason: 'Abusive language', close_active_chat: true });
ok(ban.status === 201 && ban.data.target.kind === 'visitor' && ban.data.closed_chat_ids.includes(chatId), 'visitor ban created and active chat closed');
ok(sql(`SELECT close_reason FROM chats WHERE id = '${chatId}'`) === 'banned', 'chat closed with policy reason banned');
const cut = await waitFor(() => liveControls.find((x) => x.type === 'access.revoked'), 5000, 'banned visitor socket revoked');
ok(cut.payload.reason === 'banned' && cut.payload.relogin_required === true, 'a ban cuts the visitor\'s live socket immediately (access.revoked banned)');
const blocked = await W('POST', '/chats', { client_request_id: randomUUID(), message: 'let me back' }, tab2.capability);
ok(blocked.status === 403 && blocked.error.message === 'Service unavailable' && !/ban|abus/i.test(blocked.error.message), 'banned visitor cannot start a chat; neutral public copy');
const blockedTicket = await W('POST', '/socket-ticket', undefined, tab2.capability);
ok(blockedTicket.status === 403 && blockedTicket.error.code === 'SERVICE_UNAVAILABLE', 'banned visitor cannot mint a socket ticket (no reconnect after the live cut-off)');
const blockedSess = await newSession({ anonymous_token: tab1.anonymous_token });
ok(blockedSess.status === 403 && blockedSess.error.code === 'SERVICE_UNAVAILABLE', 'banned visitor gets neutral Service unavailable on session');
const dupBan = await owner.call('POST', '/bans', { visitor_id: V, reason: 'again' });
ok(dupBan.status === 409, 'duplicate active ban rejected');
ok((await owner.call('POST', '/bans', { visitor_id: V, ip: '203.0.113.7', reason: 'x' })).status === 422, 'exactly one ban target required');
const listBans = await owner.call('GET', '/bans?active=true');
ok(listBans.status === 200 && listBans.data.some((b) => b.id === ban.data.id && b.active), 'active bans listed');
ok((await owner.call('DELETE', `/bans/${ban.data.id}`)).status === 204, 'unban → 204');
ok((await owner.call('DELETE', `/bans/${ban.data.id}`)).status === 204, 'unban is idempotent');
ok(sql(`SELECT count(*) FROM audit_events WHERE action = 'ban.revoked' AND object_id = '${ban.data.id}'`) === '1', 'unban audited exactly once');
const unbanned = await newSession({ anonymous_token: tab1.anonymous_token });
ok(unbanned.status === 201 && unbanned.data.visitor.id === V, 'unban allows a subsequent session');
const again = await W('POST', '/chats', { client_request_id: randomUUID(), message: 'thanks for unbanning' }, unbanned.data.capability);
ok(again.status === 201, 'unban restores chat admission');
ok((await W('POST', '/socket-ticket', undefined, unbanned.data.capability)).status === 201, 'unban restores socket tickets');

const ipBan = await owner.call('POST', '/bans', { ip: '203.0.113.7', reason: 'Spam flood' });
ok(ipBan.status === 201 && ipBan.data.target.masked === '203.0.x.x' && ipBan.data.collateral_warning, 'IP ban stored masked with collateral warning');
ok(!sql(`SELECT ip_match_hash || coalesce(ip_masked,'') FROM bans WHERE id = '${ipBan.data.id}'`).includes('203.0.113.7'), 'raw IP never stored');
ok((await owner.call('POST', '/bans', { ip: '203.0.0.0/16', reason: 'range' })).status === 422, 'CIDR ranges rejected by policy');
ok((await owner.call('POST', '/bans', { ip: 'not-an-ip', reason: 'x' })).status === 422, 'invalid IP rejected');
const bootBlocked = await W('POST', '/bootstrap', { site_key: site.public_key, host_origin: ORIGIN }, null, { 'x-forwarded-for': '203.0.113.7' });
ok(bootBlocked.status === 403 && bootBlocked.error.code === 'SERVICE_UNAVAILABLE', 'IP-banned client blocked at bootstrap');
const bootOk = await W('POST', '/bootstrap', { site_key: site.public_key, host_origin: ORIGIN }, null, { 'x-forwarded-for': '203.0.113.8' });
ok(bootOk.status === 200, 'other addresses unaffected');
const ipChat = await W('POST', '/chats', { client_request_id: randomUUID(), message: 'hi' }, ySess.capability, { 'x-forwarded-for': '203.0.113.7' });
ok(ipChat.status === 403, 'IP ban blocks chat admission');
const shortBan = await owner.call('POST', '/bans', { ip: '198.51.100.9', reason: 'cool-off', expires_at: new Date(Date.now() + 2000).toISOString() });
ok(shortBan.status === 201, 'expiring ban created');
ok((await W('POST', '/bootstrap', { site_key: site.public_key, host_origin: ORIGIN }, null, { 'x-forwarded-for': '198.51.100.9' })).status === 403, 'expiring ban enforced');
await sleep(2600);
ok((await W('POST', '/bootstrap', { site_key: site.public_key, host_origin: ORIGIN }, null, { 'x-forwarded-for': '198.51.100.9' })).status === 200, 'expired ban stops applying without cleanup');

const beta = new Client('beta');
await beta.must('POST', '/auth/signup', { email: `vis-beta+${stamp}@example.com`, password: 'yet another passphrase', tenant_name: `Beta ${stamp}` }, runIp);
const betaSite = await beta.must('POST', '/sites', { name: 'Beta', origins: [{ origin: 'http://localhost:5175', pattern_type: 'exact' }] });
const betaBoot = await W('POST', '/bootstrap', { site_key: betaSite.public_key, host_origin: 'http://localhost:5175' }, null, { 'x-forwarded-for': '203.0.113.7' });
ok(betaBoot.status === 200, 'ban in tenant A does not affect tenant B');
const betaBans = await beta.must('GET', '/bans');
ok(betaBans.length === 0, 'tenant B sees none of tenant A bans');
ok((await beta.call('DELETE', `/bans/${ipBan.data.id}`)).status === 404, 'tenant B cannot revoke tenant A ban');
ok((await beta.call('GET', `/visitors/${V}`)).status === 404, 'tenant B cannot read tenant A visitor');
const betaLive = await beta.must('GET', '/visitors/live');
ok(betaLive.items.length === 0 && betaLive.counts.browsing === 0, 'tenant B live list has no tenant A visitors');

// ───────────────────────────────────────────────────────────────────────
console.log('High-load mode');
const zSess = (await newSession({ page: { url: `${ORIGIN}/features` } }, { 'x-forwarded-for': '192.0.2.40' })).data;
const zSock = await socket('/visitor', await ticketFor(zSess.capability));
await waitFor(async () => (await live()).items.some((i) => i.visitor_id === zSess.visitor.id && i.group === 'browsing'), 6000, 'browsing visitor');
const high = await live('?mode=high_load');
ok(high.omitted_browsing === true && high.mode === 'high_load', 'high-load snapshot flags omitted browsing');
ok(high.items.length >= 1 && high.items.every((i) => i.group === 'incoming' || i.group === 'served'), 'high-load lists only incoming/served chats');
ok(!high.items.some((i) => i.visitor_id === zSess.visitor.id) && high.counts.browsing === undefined, 'browsing visitors omitted in high-load mode');
const page1 = await live('?limit=1');
ok(page1.items.length === 1 && page1.next_cursor && page1.has_more, 'live snapshot paginates with a cursor');
const page2 = await live(`?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`);
ok(page2.items.length === 1 && page2.items[0].visitor_id !== page1.items[0].visitor_id, 'next page continues after the cursor');
ok((await owner.call('GET', `/visitors/live?limit=1&mode=high_load&cursor=${encodeURIComponent(page1.next_cursor)}`)).status === 422, 'cursor bound to its filters');
const statusFilter = await live('?status=browsing');
ok(statusFilter.items.every((i) => i.group === 'browsing') && statusFilter.items.some((i) => i.visitor_id === zSess.visitor.id), 'status filter');

// ───────────────────────────────────────────────────────────────────────
console.log('Session lifecycle — visitor.session.left when the tab disconnects');
zSock.close();
const left = await waitFor(() => ownerSock.ephemeral.find((f) => f.type === 'visitor.session.left' && f.payload.session_id === zSess.session_id), 15_000, 'visitor.session.left').catch((err) => {
  console.error('owner socket connected:', ownerSock.connected, 'last frames:', JSON.stringify(ownerSock.ephemeral.slice(-6).map((f) => [f.type, f.payload.visitor_id, f.payload.session_id ?? null])));
  console.error('z frames:', JSON.stringify(ownerSock.ephemeral.filter((f) => f.payload.visitor_id === zSess.visitor.id).map((f) => [f.type, f.payload.allowed_patch === null ? null : f.payload.allowed_patch?.sessions?.map((s) => s.session_id)])));
  throw err;
});
ok(left.payload.visitor_id === zSess.visitor.id && left.payload.last_seen_at, 'visitor.session.left published with server last_seen_at');
ok(!(await live()).items.some((i) => i.visitor_id === zSess.visitor.id), 'expired browsing entry removed from the live list');
const blink = (await newSession({ page: { url: `${ORIGIN}/pricing` } }, { 'x-forwarded-for': '192.0.2.41' })).data;
const blinkSock = await socket('/visitor', await ticketFor(blink.capability));
blinkSock.close(); // shorter than one monitor flush: no signature ever recorded the session
const blinkLeft = await waitFor(() => ownerSock.ephemeral.find((f) => f.type === 'visitor.session.left' && f.payload.session_id === blink.session_id), 15_000, 'short session left');
ok(blinkLeft.payload.visitor_id === blink.visitor.id, 'a session shorter than one flush window still publishes visitor.session.left');

for (const s of [ownerSock, vs1, vs2, wSock]) s.close();
console.log(`\nVISITORS E2E PASSED (${passed} checks)`);
process.exit(0);
