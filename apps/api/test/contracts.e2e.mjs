// Talkivio contract test: proves the generated OpenAPI / AsyncAPI contracts against the
// running stack (node apps/api/test/contracts.e2e.mjs; API_URL defaults to http://localhost:4000).
//
// Real HTTP, real Socket.IO, real PostgreSQL — no mocks. Every REST response body is
// validated (Ajv, JSON Schema 2020-12, *strict*: undeclared properties fail) against the
// response schema documented in contracts/openapi.yaml for that operation and status;
// every socket frame / acknowledgement against contracts/asyncapi.yaml; and every
// outbox_events row written for the test tenant against the per-audience payload schemas
// (`x-talkivio-outbox`). One tenant is created by signup and a second one through
// `POST /api/v1/tenants` (signup is rate limited to 10/hour per client address; the
// requests carry a private-range X-Forwarded-For unique to the run).
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const require = createRequire(resolve(HERE, '../package.json'));
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const { io } = require('socket.io-client');

const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const ORIGIN = 'http://localhost:5173';
const DEST_ORIGIN = 'http://localhost:5174';
const dotenv = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? dotenv.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
if (!OWNER_DB) throw new Error('DATABASE_OWNER_URL missing (env or repo .env)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const rnd = () => 1 + Math.floor(Math.random() * 253);
const XFF = `10.240.${rnd()}.${rnd()}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload, secret) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};
const now = () => Math.floor(Date.now() / 1000);
/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — matches otplib's authenticator defaults. */
function totp(base32, step = Math.floor(Date.now() / 30_000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...base32.replace(/=+$/, '').toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { maxBuffer: 256 * 1024 * 1024 }).toString().trim();
const waitFor = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
};

// ───────────────────────── contracts → validators ─────────────────────────
const openapi = YAML.parse(readFileSync(resolve(ROOT, 'contracts/openapi.yaml'), 'utf8'));
const asyncapi = YAML.parse(readFileSync(resolve(ROOT, 'contracts/asyncapi.yaml'), 'utf8'));

/** Strict mode: every object schema that declares properties rejects undeclared ones. */
function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictify(pv)])) : ['enum', 'const', 'required', 'example', 'examples', 'default'].includes(k) ? v : strictify(v);
  if (out.properties && out.additionalProperties === undefined && !out.patternProperties) out.additionalProperties = false;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
const deref = (doc, obj) => {
  if (obj?.$ref?.startsWith('#/components/responses/')) return doc.components.responses[obj.$ref.split('/').pop()];
  return obj;
};
const restSchemas = {};
const restIndex = {};
let n = 0;
for (const [path, item] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const key = `${method.toUpperCase()} ${path}`;
    restIndex[key] = { op, statuses: {} };
    for (const [status, resp0] of Object.entries(op.responses)) {
      const resp = deref(openapi, resp0);
      const media = Object.keys(resp.content ?? {});
      const json = resp.content?.['application/json']?.schema;
      const id = `s${n++}`;
      if (json) restSchemas[id] = json;
      restIndex[key].statuses[status] = { id: json ? id : null, media, untyped: !!op['x-talkivio-untyped'] };
    }
  }
}
ajv.addSchema(strictify({ $id: 'oas', components: { schemas: openapi.components.schemas }, ops: restSchemas }));
const restValidator = (id) => ajv.getSchema(`oas#/ops/${id}`);

const frameSchemas = {};
const frameIndex = {};
const ackIndex = {};
for (const [key, m] of Object.entries(asyncapi.components.messages)) frameSchemas[key] = m.payload;
for (const [chanKey, chan] of Object.entries(asyncapi.channels)) {
  for (const [msgKey, ref] of Object.entries(chan.messages)) {
    const key = ref.$ref.split('/').pop();
    const m = asyncapi.components.messages[key];
    const ev = m['x-socketio-event'];
    if (ev === 'event' || ev === 'ephemeral') frameIndex[`${chanKey}|${ev}|${m['x-talkivio-event-type']}`] = key;
    else if (ev === 'control') frameIndex[`${chanKey}|control|${m.title}`] = key;
    else if (ev === 'auth.ok') frameIndex[`${chanKey}|auth.ok`] = key;
    void msgKey;
  }
}
for (const op of Object.values(asyncapi.operations)) {
  if (!op.reply) continue;
  const chanKey = op.channel.$ref.split('/').pop();
  const reqKey = op.messages[0].$ref.split('/').pop();
  const m = asyncapi.components.messages[asyncapi.channels[chanKey].messages[reqKey].$ref.split('/').pop()];
  const replies = op.reply.messages.map((r) => asyncapi.channels[chanKey].messages[r.$ref.split('/').pop()].$ref.split('/').pop());
  ackIndex[`${chanKey}|${m['x-socketio-event']}${m['x-talkivio-command-type'] ? `|${m['x-talkivio-command-type']}` : ''}`] = replies;
}
const outboxSchemas = {};
for (const [type, o] of Object.entries(asyncapi['x-talkivio-outbox'])) {
  outboxSchemas[`${type}__payload`] = o.payload;
  if (o.public_payload) outboxSchemas[`${type}__public`] = o.public_payload;
}
ajv.addSchema(strictify({ $id: 'aas', components: { schemas: asyncapi.components.schemas }, msgs: frameSchemas, outbox: outboxSchemas }));
const frameValidator = (key) => ajv.getSchema(`aas#/msgs/${key}`);
const outboxValidator = (key) => ajv.getSchema(`aas#/outbox/${key}`);

// ───────────────────────── result bookkeeping ─────────────────────────
const R = {
  rest: { validated: 0, failures: [], typedOpsOk: new Set(), opsSeen: new Set(), errorsValidated: 0, media: 0, emptyLists: new Set(), filledLists: new Set() },
  frames: { validated: 0, failures: [], types: {} },
  acks: { validated: 0, failures: [] },
  outbox: { validated: 0, failures: [], types: {} },
};
const fmt = (errs) => (errs ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ');
function step(msg) {
  console.log(`  · ${msg}`);
}

function validateRest(key, status, ctype, json) {
  const entry = restIndex[key];
  if (!entry) return R.rest.failures.push(`${key}: operation not in openapi.yaml`);
  R.rest.opsSeen.add(key);
  const st = entry.statuses[String(status)] ?? entry.statuses.default;
  if (!st) return R.rest.failures.push(`${key}: undocumented status ${status}`);
  if (!st.id) {
    if (status === 204 || status === 302) return void R.rest.validated++;
    if (st.media.length && !st.media.some((m) => m === '*/*' || (ctype ?? '').startsWith(m))) return R.rest.failures.push(`${key} ${status}: content-type ${ctype} not in ${st.media}`);
    R.rest.media++;
    return void R.rest.validated++;
  }
  const v = restValidator(st.id);
  if (!v(json)) return R.rest.failures.push(`${key} ${status}: ${fmt(v.errors)}`);
  R.rest.validated++;
  if (status < 300) {
    R.rest.typedOpsOk.add(key);
    if (Array.isArray(json?.data)) (json.data.length ? R.rest.filledLists : R.rest.emptyLists).add(key);
  } else R.rest.errorsValidated++;
}

// ───────────────────────── HTTP client ─────────────────────────
class Principal {
  constructor(name, { xff = XFF, origin } = {}) {
    this.name = name;
    this.cookies = {};
    this.bearer = null;
    this.xff = xff;
    this.origin = origin;
  }
  async call(method, template, { params = {}, query, body, headers = {}, raw, noCsrf, expect } = {}) {
    const path = template.replace(/\{(\w+)\}/g, (_m, k) => encodeURIComponent(params[k]));
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : '';
    const h = { 'x-forwarded-for': this.xff, ...headers };
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (this.cookies.rd_csrf && !noCsrf && method !== 'GET') h['x-csrf-token'] = this.cookies.rd_csrf;
    if (this.bearer && !h.authorization) h.authorization = `Bearer ${this.bearer}`;
    if (this.origin && !h.origin) h.origin = this.origin;
    const res = await fetch(`${API}${path}${qs}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = decodeURIComponent(pair.slice(i + 1));
      if (v) this.cookies[pair.slice(0, i)] = v;
      else delete this.cookies[pair.slice(0, i)];
    }
    const ctype = res.headers.get('content-type');
    const text = await res.text();
    let json = null;
    if (ctype?.includes('application/json') && text) json = JSON.parse(text);
    validateRest(`${method} ${template}`, res.status, ctype, json);
    const out = { status: res.status, json, data: json?.data, error: json?.error, text, headers: res.headers };
    if (expect !== undefined && !(Array.isArray(expect) ? expect : [expect]).includes(res.status)) {
      throw new Error(`${this.name} ${method} ${path} → ${res.status} (expected ${expect}) ${text.slice(0, 400)}`);
    }
    return out;
  }
  async must(method, template, opts = {}) {
    const r = await this.call(method, template, opts);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${template} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

// ───────────────────────── sockets ─────────────────────────
const sockets = [];
function validateFrame(ns, kind, frame) {
  const type = kind === 'auth.ok' ? '' : frame?.type;
  const key = kind === 'auth.ok' ? frameIndex[`${ns}|auth.ok`] : frameIndex[`${ns}|${kind}|${type}`];
  const label = `${ns}/${kind}${type ? `/${type}` : ''}`;
  R.frames.types[label] = (R.frames.types[label] ?? 0) + 1;
  if (!key) return R.frames.failures.push(`${label}: frame type not in asyncapi.yaml`);
  const v = frameValidator(key);
  if (!v(frame)) return R.frames.failures.push(`${label}: ${fmt(v.errors)}`);
  const rescope = asyncapi.components.messages[key]['x-talkivio-rescope-reasons'];
  if (rescope && frame.payload.relogin_required !== !rescope.includes(frame.payload.reason)) return R.frames.failures.push(`${label}: relogin_required=${frame.payload.relogin_required} for reason ${frame.payload.reason}`);
  R.frames.validated++;
}
function validateAck(ns, op, commandType, ack) {
  const replies = ackIndex[`${ns}|${op}${commandType ? `|${commandType}` : ''}`];
  if (!replies) return R.acks.failures.push(`${ns}/${op}${commandType ? `/${commandType}` : ''}: no reply contract`);
  const errs = [];
  for (const key of replies) {
    const v = frameValidator(key);
    if (v(ack)) return void R.acks.validated++;
    errs.push(`${key}: ${fmt(v.errors)}`);
  }
  R.acks.failures.push(`${ns}/${op}${commandType ? `/${commandType}` : ''}: ${errs.join(' | ')}`);
}
function connect(ns, ticket) {
  const s = io(`${API}/${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, reconnection: false });
  s.ns = ns;
  s.events = [];
  s.ephemerals = [];
  s.controls = [];
  s.on('event', (f) => {
    s.events.push(f);
    validateFrame(ns, 'event', f);
  });
  s.on('ephemeral', (f) => {
    s.ephemerals.push(f);
    validateFrame(ns, 'ephemeral', f);
  });
  s.on('control', (f) => {
    s.controls.push(f);
    validateFrame(ns, 'control', f);
  });
  sockets.push(s);
  return new Promise((res, rej) => {
    s.on('auth.ok', (f) => {
      validateFrame(ns, 'auth.ok', f);
      res(s);
    });
    s.on('connect_error', (e) => rej(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
async function emitAck(s, op, payload, commandType) {
  const ack = await s.timeout(8000).emitWithAck(op, payload);
  validateAck(s.ns, op, commandType, ack);
  return ack;
}
const command = (s, type, payload, extra = {}) => emitAck(s, 'command', { v: 1, command_id: randomUUID(), type, payload, ...extra }, type);

// ═════════════════════════════════════ scenario ═════════════════════════════════════
const t0 = Date.now();
let tenantId = null;
let aborted = null;
try {
console.log(`Contract test against ${API} (X-Forwarded-For ${XFF})`);

console.log('Health & public auth');
const anon = new Principal('anonymous');
await anon.call('GET', '/health/live', { expect: 200 });
await anon.call('GET', '/health/ready', { expect: [200, 503] });
await anon.call('GET', '/api/v1/auth/providers', { expect: 200 });
await anon.call('GET', '/api/v1/tenants/current', { expect: 401 });

const owner = new Principal('owner');
const ownerEmail = `contracts-${stamp}@talkivio.test`;
const ownerPassword = `Ct-${randomBytes(12).toString('base64url')}!`;
const signup = await owner.must('POST', '/api/v1/auth/signup', { body: { email: ownerEmail, password: ownerPassword, tenant_name: `Contracts ${stamp}`, timezone: 'Europe/London' } });
tenantId = signup.tenant_id;
step(`tenant ${tenantId}`);
await anon.call('POST', '/api/v1/auth/signup', { body: { email: `x${stamp}@talkivio.test`, password: 'short', tenant_name: 'X' }, expect: 422 });
await owner.call('PATCH', '/api/v1/tenants/current', { body: {}, noCsrf: true, expect: 403 });
const verifyText = await waitFor(() => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${ownerEmail}' AND template = 'verify_email' ORDER BY created_at DESC LIMIT 1`), 8000, 'verification email');
await owner.call('POST', '/api/v1/auth/verify-email', { body: { token: decodeURIComponent((verifyText.match(/[?/]token[=/]([^\s&]+)/) ?? [])[1] ?? '') }, expect: 204 });
await owner.call('POST', '/api/v1/auth/login', { body: { email: ownerEmail, password: ownerPassword }, expect: 200 });
await owner.call('GET', '/api/v1/auth/me', { expect: 200 });
await owner.call('PATCH', '/api/v1/auth/profile', { body: { display_name: 'Contract Owner' }, expect: 200 });
await owner.call('GET', '/api/v1/auth/sessions', { expect: 200 });
await anon.call('POST', '/api/v1/auth/password/reset-request', { body: { email: `nobody-${stamp}@talkivio.test` }, expect: 202 });
const enrol = await owner.must('POST', '/api/v1/auth/mfa/enroll');
// TOTP steps are single use: confirm with the current step, regenerate with the next one, disable with a recovery code.
const enrolStep = Math.floor(Date.now() / 30_000);
await owner.call('POST', '/api/v1/auth/mfa/confirm', { body: { enrollment_id: enrol.enrollment_id, code: totp(enrol.secret, enrolStep) }, expect: 200 });
const regenerated = await owner.call('POST', '/api/v1/auth/mfa/recovery-codes', { body: { code: totp(enrol.secret, enrolStep + 1) }, expect: [200, 201] });
await owner.call('POST', '/api/v1/auth/mfa/disable', { body: { code: regenerated.data.recovery_codes[0] }, expect: 204 });
await owner.call('POST', '/api/v1/auth/verify-email/resend', { expect: [202, 409, 422, 429] });

console.log('Tenant, team, departments, tags, custom fields');
await owner.call('GET', '/api/v1/tenants/current', { expect: 200 });
await owner.call('PATCH', '/api/v1/tenants/current', { body: { name: `Contracts ${stamp} Ltd` }, expect: 200 });
await owner.call('PATCH', '/api/v1/tenants/current/onboarding', { body: { step: 'contracts' }, expect: 200 });
const meAgent = await owner.must('GET', '/api/v1/agents/me');
await owner.call('PATCH', '/api/v1/agents/me/preferences', { body: { sound: false }, expect: 200 });
await owner.call('PUT', '/api/v1/agents/me/presence', { body: { status: 'online' }, expect: 200 });
await owner.call('GET', '/api/v1/agents', { expect: 200 });
const depts = await owner.must('GET', '/api/v1/departments');
const support = depts.find((d) => d.name === 'Support') ?? depts[0];
const sales = await owner.must('POST', '/api/v1/departments', { body: { name: 'Sales', public_label: 'Sales team', routing_mode: 'broadcast' } });
if (restIndex['GET /api/v1/departments/{id}']) await owner.call('GET', '/api/v1/departments/{id}', { params: { id: sales.id }, expect: 200 });
await owner.call('PATCH', '/api/v1/departments/{id}', { params: { id: sales.id }, body: { description: 'Contract test department', routing_mode: 'assigned' }, expect: 200 });
await owner.call('PUT', '/api/v1/departments/{id}/members', { params: { id: sales.id }, body: { members: [{ membership_id: meAgent.agent.id, can_serve: true }] }, expect: 200 });
const tag = await owner.must('POST', '/api/v1/tags', { body: { label: 'VIP customer' } });
await owner.call('POST', '/api/v1/tags', { body: { label: 'VIP customer' }, expect: 409 });
await owner.call('GET', '/api/v1/tags', { query: { q: 'vip' }, expect: 200 });
const cf = await owner.must('POST', '/api/v1/custom-fields', { body: { key: 'plan', label: 'Plan', data_type: 'string', validation: {}, public_writable: true, visible_to_visitor: true } });
await owner.call('GET', '/api/v1/custom-fields', { expect: 200 });
await owner.call('PATCH', '/api/v1/custom-fields/{id}', { params: { id: cf.id }, body: { label: 'Subscription plan' }, expect: 428 });
await owner.call('PATCH', '/api/v1/custom-fields/{id}', { params: { id: cf.id }, body: { label: 'Subscription plan' }, headers: { 'if-match': `"${cf.version}"` }, expect: 200 });

console.log('Invite a second agent');
const agentEmail = `contracts-agent-${stamp}@talkivio.test`;
await owner.call('POST', '/api/v1/agents/invitations', { body: { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 3 }, expect: 201 });
await owner.call('GET', '/api/v1/agents/invitations', { expect: 200 });
const inviteText = await waitFor(() => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${agentEmail}' AND template = 'agent_invitation' ORDER BY created_at DESC LIMIT 1`), 8000, 'invitation email');
const inviteToken = decodeURIComponent((inviteText.match(/[?/]invite[=/]([^\s&]+)/) ?? [])[1] ?? '');
await anon.call('GET', '/api/v1/agents/invitations/lookup', { query: { token: inviteToken }, expect: 200 });
const agentB = new Principal('agentB');
await agentB.call('POST', '/api/v1/agents/invitations/accept', { body: { token: inviteToken, display_name: 'Bea Contract', password: `Bb-${randomBytes(12).toString('base64url')}` }, expect: [200, 201] });
const bMe = await agentB.must('GET', '/api/v1/agents/me');
const bPatched = await owner.must('PATCH', '/api/v1/agents/{id}', { params: { id: bMe.agent.id }, body: { title: 'Specialist' } });
await owner.call('PATCH', '/api/v1/agents/{id}', { params: { id: bMe.agent.id }, body: { title: 'Stale', expected_version: bPatched.version - 1 }, expect: 409 });
await owner.call('PUT', '/api/v1/departments/{id}/members', { params: { id: sales.id }, body: { members: [{ membership_id: meAgent.agent.id, can_serve: true }, { membership_id: bMe.agent.id, can_serve: true }] }, expect: 200 });
await owner.call('PUT', '/api/v1/agents/{id}/departments', { params: { id: bMe.agent.id }, body: { departments: [{ department_id: support.id, can_serve: true }] }, expect: 200 });
await agentB.call('PUT', '/api/v1/agents/me/presence', { body: { status: 'online' }, expect: 200 });

console.log('Agent sockets');
const ownerTicket = await owner.must('POST', '/api/v1/socket-ticket');
const oSock = await connect('agent', ownerTicket.ticket);
const bSock = await connect('agent', (await agentB.must('POST', '/api/v1/socket-ticket')).ticket);
for (const s of [oSock, bSock]) {
  await emitAck(s, 'subscribe', { scopes: [{ kind: 'queue', id: 'none' }, { kind: 'queue', id: support.id }, { kind: 'queue', id: sales.id }, { kind: 'team', id: 'all' }, { kind: 'visitor', id: 'all' }] }, null);
}
await emitAck(oSock, 'heartbeat', {}, null);

console.log('Sites, widget configuration, schedules, closures');
const site = await owner.must('POST', '/api/v1/sites', { body: { name: 'Contract store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] } });
const dest = await owner.must('POST', '/api/v1/sites', { body: { name: 'Contract docs', origins: [{ origin: DEST_ORIGIN, pattern_type: 'exact' }] } });
await emitAck(oSock, 'subscribe', { scopes: [{ kind: 'config', id: site.id }] }, null);
await owner.call('POST', '/api/v1/sites', { body: { name: 'Bad', origins: [{ origin: 'not a url', pattern_type: 'exact' }] }, expect: 422 });
await owner.call('GET', '/api/v1/sites', { expect: 200 });
await owner.call('GET', '/api/v1/sites/{id}', { params: { id: site.id }, expect: 200 });
await owner.call('PATCH', '/api/v1/sites/{id}', { params: { id: dest.id }, body: { name: 'Contract docs site' }, expect: 200 });
const cfg = await owner.must('GET', '/api/v1/sites/{id}/widget-config', { params: { id: site.id } });
const draftCfg = await owner.must('PUT', '/api/v1/sites/{id}/widget-config', { params: { id: site.id }, body: { config: (cfg.draft ?? cfg.published).config } });
await owner.call('POST', '/api/v1/sites/{id}/widget-config/publish', { params: { id: site.id }, body: { revision: draftCfg.revision }, expect: 200 });
if (restIndex['DELETE /api/v1/sites/{id}/widget-config/draft']) {
  await owner.call('PUT', '/api/v1/sites/{id}/widget-config', { params: { id: site.id }, body: { config: draftCfg.config, base_etag: null }, expect: 200 });
  await owner.call('PUT', '/api/v1/sites/{id}/widget-config', { params: { id: site.id }, body: { config: draftCfg.config, base_etag: 'stale-etag' }, expect: 409 });
  await owner.call('DELETE', '/api/v1/sites/{id}/widget-config/draft', { params: { id: site.id }, query: { etag: 'stale-etag' }, expect: 409 });
  await owner.call('DELETE', '/api/v1/sites/{id}/widget-config/draft', { params: { id: site.id }, expect: 200 });
}
await owner.call('GET', '/api/v1/sites/{id}/installation-status', { params: { id: site.id }, expect: 200 });
const { secret: identitySecret } = await owner.must('POST', '/api/v1/sites/{id}/identity-secret', { params: { id: site.id } });

const schedule = await owner.must('POST', '/api/v1/schedules', { body: { name: 'Contract hours', timezone: 'America/New_York', weekly_intervals: { mon: [{ start: '09:00', end: '17:00' }] } }, headers: { 'idempotency-key': `contract-sched-${stamp}` } });
await owner.call('GET', '/api/v1/schedules', { expect: 200 });
await owner.call('GET', '/api/v1/schedules/{id}', { params: { id: schedule.id }, expect: 200 });
const schedPatched = await owner.must('PATCH', '/api/v1/schedules/{id}', { params: { id: schedule.id }, body: { name: 'Contract hours (NY)' }, headers: { 'if-match': `"${schedule.version}"` } });
const exDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const exRes = await owner.must('PUT', '/api/v1/schedules/{id}/exceptions/{date}', { params: { id: schedule.id, date: exDate }, body: { intervals: [], reason: 'Holiday' }, headers: { 'if-match': `"${schedPatched.schedule.version}"` } });
await owner.call('GET', '/api/v1/schedules/{id}/preview', { params: { id: schedule.id }, query: { days: 7 }, expect: 200 });
await owner.call('DELETE', '/api/v1/schedules/{id}/exceptions/{date}', { params: { id: schedule.id, date: exDate }, headers: { 'if-match': `"${exRes.schedule_version}"` }, expect: 204 });
const closure = await owner.must('POST', '/api/v1/emergency-closures', { body: { department_id: sales.id, reason: 'Contract test closure' } });
await owner.call('GET', '/api/v1/emergency-closures', { expect: 200 });
await owner.call('DELETE', '/api/v1/emergency-closures/{id}', { params: { id: closure.id }, expect: 204 });
const schedNow = await owner.must('GET', '/api/v1/schedules/{id}', { params: { id: schedule.id } });
await owner.call('POST', '/api/v1/schedules/{id}/archive', { params: { id: schedule.id }, body: {}, headers: { 'if-match': `"${schedNow.version}"` }, expect: 200 });

console.log('Shortcuts & triggers');
const sc = await owner.must('POST', '/api/v1/shortcuts', { body: { slug: 'thanks', title: 'Thanks', body: 'Thanks {{visitor.name}}!', scope_type: 'tenant' } });
await owner.call('GET', '/api/v1/shortcuts', { expect: 200 });
await owner.call('GET', '/api/v1/shortcuts/{id}', { params: { id: sc.id }, expect: 200 });
await owner.call('PATCH', '/api/v1/shortcuts/{id}', { params: { id: sc.id }, body: { title: 'Thanks!' }, expect: 428 });
const scV2 = await owner.must('PATCH', '/api/v1/shortcuts/{id}', { params: { id: sc.id }, body: { title: 'Thanks!' }, headers: { 'if-match': `"${sc.version}"` } });
await owner.call('POST', '/api/v1/shortcuts/{id}/render', { params: { id: sc.id }, body: { sample: { 'visitor.name': 'Ada' } }, expect: 200 });
await owner.call('POST', '/api/v1/shortcuts/render-preview', { body: { body: 'Hi {{visitor.name}}, anything else?', sample: { 'visitor.name': 'Ada' } }, expect: 200 });
const preview = await owner.must('POST', '/api/v1/shortcuts/import-preview', { body: { csv_text: 'slug,title,body,scope_type\nhello,Hello,Hello there,tenant\n' } });
if (preview.preview_token) await owner.call('POST', '/api/v1/shortcuts/import-commit', { body: { preview_token: preview.preview_token }, expect: 201 });
await owner.call('GET', '/api/v1/shortcuts/export.csv', { expect: 200 });
await owner.call('POST', '/api/v1/shortcuts/{id}/archive', { params: { id: sc.id }, body: {}, headers: { 'if-match': `"${scV2.version}"` }, expect: 200 });

const def = { dsl_version: 1, event: 'chat.requested', priority: 100, all: [{ field: 'page.path', op: 'starts_with', value: '/never-matches-contract' }], any: [], actions: [{ type: 'add_tag', tag: 'contract', target: 'chat' }], stop_processing: false, cooldown_seconds: 0 };
const trig = await owner.must('POST', '/api/v1/triggers', { body: { name: 'Contract trigger', definition: def } });
await owner.call('GET', '/api/v1/triggers', { expect: 200 });
await owner.call('GET', '/api/v1/triggers/{id}', { params: { id: trig.id }, expect: 200 });
const draft = await owner.must('PUT', '/api/v1/triggers/{id}/draft', { params: { id: trig.id }, body: { definition: { ...def, priority: 120 } }, headers: { 'if-match': `"${trig.version}"` } });
await owner.call('POST', '/api/v1/triggers/{id}/simulate', { params: { id: trig.id }, body: { event: 'chat.requested', snapshot: { 'page.path': '/pricing' } }, expect: 200 });
const pub = await owner.must('POST', '/api/v1/triggers/{id}/publish', { params: { id: trig.id }, body: { revision: draft.draft.revision, enabled: false } });
await owner.call('GET', '/api/v1/triggers/{id}/revisions/{revision}', { params: { id: trig.id, revision: draft.draft.revision }, expect: 200 });
await owner.call('PATCH', '/api/v1/triggers/{id}', { params: { id: trig.id }, body: { description: 'contract' }, headers: { 'if-match': `"${pub.version}"` }, expect: 200 });
const restored = await owner.must('POST', '/api/v1/triggers/{id}/restore', { params: { id: trig.id }, body: { revision: 1 } });
await owner.call('GET', '/api/v1/triggers/{id}/runs', { params: { id: trig.id }, expect: 200 });
await owner.call('GET', '/api/v1/triggers/{id}/funnel', { params: { id: trig.id }, expect: 200 });
await owner.call('DELETE', '/api/v1/triggers/{id}', { params: { id: trig.id }, headers: { 'if-match': `"${restored.version}"` }, expect: 204 });


console.log('Widget: bootstrap, session, identity, consent, events');
const visitor = new Principal('visitor', { xff: `10.241.${rnd()}.${rnd()}`, origin: ORIGIN });
await visitor.call('POST', '/widget/v1/bootstrap', { body: { site_key: site.public_key, host_origin: ORIGIN, client_instance_id: `ci-${stamp}`, locale: 'en' }, expect: 200 });
await visitor.call('POST', '/widget/v1/bootstrap', { body: { site_key: site.public_key, host_origin: 'https://evil.example' }, expect: 403 });
const idTok = jwt({ iss: site.id, aud: 'talkivio visitor', sub: `cust-${stamp}`, email: `cust-${stamp}@talkivio.test`, name: 'Ada Visitor', iat: now(), exp: now() + 120, jti: randomUUID() }, identitySecret);
const sess = await visitor.must('POST', '/widget/v1/sessions', {
  body: { site_key: site.public_key, host_origin: ORIGIN, identity_token: idTok, consent: { analytics: true, policy_version: '2026-10' }, page: { url: `${ORIGIN}/pricing`, title: 'Pricing' }, locale: 'en', timezone: 'Europe/London' },
});
visitor.bearer = sess.capability;
await visitor.call('GET', '/widget/v1/availability', { expect: 200 });
await visitor.call('PUT', '/widget/v1/consent', { body: { purpose: 'analytics', state: 'granted', policy_version: '2026-10' }, expect: 200 });
await visitor.call('POST', '/widget/v1/events', { body: { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}/pricing`, title: 'Pricing', client_at: new Date().toISOString() }] }, expect: 202 });
await visitor.call('POST', '/widget/v1/identity', { body: { name: 'Ada Visitor' }, expect: 200 });
await visitor.call('PUT', '/widget/v1/visitor/custom-fields', { body: { custom_fields: { plan: 'pro' } }, expect: 200 });
await visitor.call('PUT', '/widget/v1/visitor/tags', { body: { tags: [tag.slug] }, expect: 200 });

console.log('Cross-domain handoff');
const handoffBody = { site_key: site.public_key, destination_site_id: dest.id, destination_origin: DEST_ORIGIN, visitor_subject: `cust-${stamp}` };
const hand = await anon.must('POST', '/widget/v1/identity/handoff', { body: handoffBody, headers: { authorization: `Bearer ${jwt({ iss: site.id, aud: 'talkivio handoff', sub: `cust-${stamp}`, iat: now(), exp: now() + 45, jti: randomUUID() }, identitySecret)}` } });
const destVisitor = new Principal('destVisitor', { xff: visitor.xff, origin: DEST_ORIGIN });
await destVisitor.call('POST', '/widget/v1/identity/redeem', { body: { handoff_code: hand.handoff_code, site_key: dest.public_key, host_origin: DEST_ORIGIN }, expect: 200 });
await destVisitor.call('POST', '/widget/v1/identity/redeem', { body: { handoff_code: hand.handoff_code, site_key: dest.public_key, host_origin: DEST_ORIGIN }, expect: 401 });

console.log('Visitor socket + chat admission');
const vSock = await connect('visitor', (await visitor.must('POST', '/widget/v1/socket-ticket')).ticket);
await emitAck(vSock, 'heartbeat', { visible: true, focused: true }, null);
const admission = await visitor.call('POST', '/widget/v1/chats', { body: { client_request_id: randomUUID(), message: 'Hello, I need help with my order', department_id: support.id }, expect: 201 });
const chatId = admission.data.chat.id;
await emitAck(vSock, 'subscribe', { scopes: [{ kind: 'chat', id: chatId }] }, null);
await waitFor(() => oSock.events.some((f) => f.type === 'chat.requested' && f.payload.chat.id === chatId), 8000, 'chat.requested on the agent socket');
await visitor.call('GET', '/widget/v1/chats/{id}', { params: { id: chatId }, expect: 200 });
await visitor.call('POST', '/widget/v1/chats', { body: { client_request_id: randomUUID(), message: 'Second tab' }, expect: 200 });

console.log('Agent accepts, messages both ways, typing, receipts');
await owner.call('GET', '/api/v1/chats/offers', { expect: 200 });
await owner.call('GET', '/api/v1/chats/queue', { expect: 200 });
await owner.call('POST', '/api/v1/chats/{id}/accept', { params: { id: chatId }, body: {}, expect: 200 });
await emitAck(oSock, 'subscribe', { scopes: [{ kind: 'chat', id: chatId }] }, null);
await emitAck(bSock, 'subscribe', { scopes: [{ kind: 'chat', id: chatId }] }, null);
const m1 = await owner.must('POST', '/api/v1/chats/{id}/messages', { params: { id: chatId }, body: { client_message_id: randomUUID(), body: 'Hi Ada, happy to help.' } });
await owner.must('POST', '/api/v1/chats/{id}/messages', { params: { id: chatId }, body: { client_message_id: randomUUID(), visibility: 'internal', body: 'Internal: VIP' } });
const sockMsg = await command(oSock, 'message.send', { chat_id: chatId, client_message_id: randomUUID(), body: 'Could you share the order number?' });
await command(oSock, 'typing.set', { chat_id: chatId, is_typing: true });
await command(vSock, 'typing.set', { chat_id: chatId, is_typing: true });
const vm = await visitor.must('POST', '/widget/v1/chats/{id}/messages', { params: { id: chatId }, body: { client_message_id: randomUUID(), body: 'Order #1001' } });
await command(vSock, 'message.send', { chat_id: chatId, client_message_id: randomUUID(), body: 'Thanks!' });
await command(vSock, 'message.delivered', { chat_id: chatId, last_delivered_seq: sockMsg.result.seq });
await command(vSock, 'message.read', { chat_id: chatId, last_read_seq: sockMsg.result.seq });
await command(oSock, 'message.delivered', { chat_id: chatId, last_delivered_seq: vm.seq });
await command(oSock, 'message.read', { chat_id: chatId, last_read_seq: vm.seq });
await command(oSock, 'message.send', { chat_id: chatId }).catch(() => null);
await owner.call('PUT', '/api/v1/chats/{id}/read-cursor', { params: { id: chatId }, body: { last_read_seq: vm.seq }, expect: 200 });
await visitor.call('PUT', '/widget/v1/chats/{id}/read-cursor', { params: { id: chatId }, body: { last_read_seq: m1.seq }, expect: 200 });
await owner.call('GET', '/api/v1/chats/{id}/messages', { params: { id: chatId }, query: { limit: 100 }, expect: 200 });
await visitor.call('GET', '/widget/v1/chats/{id}/messages', { params: { id: chatId }, query: { after_seq: 0 }, expect: 200 });
await owner.call('GET', '/api/v1/chats/{id}', { params: { id: chatId }, expect: 200 });
await owner.call('GET', '/api/v1/chats/{id}', { params: { id: randomUUID() }, expect: 404 });
await owner.call('GET', '/api/v1/chats/{id}', { params: { id: 'not-a-uuid' }, expect: 400 });
await owner.call('GET', '/api/v1/chats', { query: { view: 'all' }, expect: 200 });
await owner.call('GET', '/api/v1/chats/counts', { expect: 200 });
await owner.call('PUT', '/api/v1/chats/{id}/tags', { params: { id: chatId }, body: { tag_ids: [tag.id] }, expect: 200 });
await owner.call('POST', '/api/v1/chats/{id}/request-rating', { params: { id: chatId }, expect: 204 });

console.log('Attachments (agent + visitor)');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
async function upload(p, initPath, contentPath, finalizePath) {
  const init = await p.must('POST', initPath, { body: { chat_id: chatId, name: 'pixel.png', size_bytes: PNG.length, mime: 'image/png', sha256: sha(PNG) } });
  const u = new URL(init.url);
  await p.call('PUT', contentPath, { params: { id: init.upload_id }, query: Object.fromEntries(u.searchParams), raw: PNG, headers: init.headers, expect: 200 });
  await p.call('POST', finalizePath, { params: { id: init.upload_id }, body: { sha256: sha(PNG) }, expect: 202 });
  return init.upload_id;
}
const agentUpload = await upload(owner, '/api/v1/attachments/uploads', '/api/v1/attachments/{id}/content', '/api/v1/attachments/{id}/finalize');
const visitorUpload = await upload(visitor, '/widget/v1/uploads', '/widget/v1/uploads/{id}/content', '/widget/v1/uploads/{id}/finalize');
const settled = async (p, path, id) => waitFor(async () => (await p.must('GET', path, { params: { id } })).state === 'clean', 20000, `upload ${id} clean`);
await settled(owner, '/api/v1/attachments/{id}', agentUpload);
await settled(visitor, '/widget/v1/uploads/{id}', visitorUpload);
const aGrant = await owner.must('GET', '/api/v1/attachments/{id}/download', { params: { id: agentUpload } });
await anon.call('GET', '/api/v1/attachments/{id}/content', { params: { id: agentUpload }, query: Object.fromEntries(new URL(aGrant.url).searchParams), expect: 200 });
const vGrant = await visitor.must('GET', '/widget/v1/attachments/{id}/download', { params: { id: visitorUpload } });
await anon.call('GET', '/widget/v1/attachments/{id}/content', { params: { id: visitorUpload }, query: Object.fromEntries(new URL(vGrant.url).searchParams), expect: 200 });
await owner.call('POST', '/api/v1/chats/{id}/messages', { params: { id: chatId }, body: { client_message_id: randomUUID(), type: 'attachment', attachment_ids: [agentUpload] }, expect: 201 });
const spare = await owner.must('POST', '/api/v1/attachments/uploads', { body: { chat_id: chatId, name: 'draft.png', size_bytes: PNG.length, mime: 'image/png' } });
await owner.call('DELETE', '/api/v1/attachments/{id}', { params: { id: spare.upload_id }, expect: 204 });
const vSpare = await visitor.must('POST', '/widget/v1/uploads', { body: { chat_id: chatId, name: 'draft.png', size_bytes: PNG.length, mime: 'image/png' } });
await visitor.call('DELETE', '/widget/v1/uploads/{id}', { params: { id: vSpare.upload_id }, expect: 204 });

console.log('Collaboration, transfer, close, rating');
await owner.call('POST', '/api/v1/chats/{id}/collaborators', { params: { id: chatId }, body: { membership_id: bMe.agent.id }, expect: 201 });
await owner.call('DELETE', '/api/v1/chats/{id}/collaborators/{membershipId}', { params: { id: chatId, membershipId: bMe.agent.id }, expect: 204 });
const transfer = await owner.must('POST', '/api/v1/chats/{id}/transfers', { params: { id: chatId }, body: { target_agent_id: bMe.agent.id, note: 'Handing over' }, headers: { 'idempotency-key': `contract-transfer-${stamp}` } });
await waitFor(() => bSock.events.some((f) => f.type === 'assignment.offered'), 8000, 'transfer offer on agent B socket');
await agentB.call('GET', '/api/v1/chats/offers', { expect: 200 });
await agentB.call('POST', '/api/v1/chats/{id}/accept', { params: { id: chatId }, body: { offer_id: transfer.offer.id }, expect: 200 });
await command(bSock, 'chat.close', { chat_id: chatId, reason: 'resolved' });
await visitor.call('POST', '/widget/v1/chats/{id}/messages', { params: { id: chatId }, body: { client_message_id: randomUUID(), body: 'still there?' }, expect: 409 });
await visitor.call('PUT', '/widget/v1/chats/{id}/rating', { params: { id: chatId }, body: { rating: 'good', comment: 'Great help' }, expect: 200 });
await agentB.call('POST', '/api/v1/chats/{id}/close', { params: { id: chatId }, body: { reason: 'resolved' }, expect: 200 });

console.log('Second chat: offer decline via socket, visitor close');
const adm2 = await visitor.call('POST', '/widget/v1/chats', { body: { client_request_id: randomUUID(), message: 'One more question', department_id: sales.id }, expect: 201 });
const chat2 = adm2.data.chat.id;
await emitAck(vSock, 'subscribe', { scopes: [{ kind: 'chat', id: chat2 }] }, null);
const offersFor = () => [[owner, oSock], [agentB, bSock]].flatMap(([p, s]) => s.events.filter((f) => f.type === 'assignment.offered' && f.payload.offer.chat_id === chat2).map((f) => ({ p, s, f })));
await waitFor(() => offersFor().length, 8000, 'routing offer for chat 2').catch(() => null);
await sleep(500);
const [firstOffer, secondOffer] = offersFor();
if (firstOffer) await firstOffer.p.call('POST', '/api/v1/offers/{id}/decline', { params: { id: firstOffer.f.payload.offer.id }, body: { reason: 'busy' }, expect: 200 });
if (secondOffer) await command(secondOffer.s, 'offer.decline', { offer_id: secondOffer.f.payload.offer.id, reason: 'busy' });
else if (firstOffer) await command(firstOffer.s, 'offer.decline', { offer_id: firstOffer.f.payload.offer.id });
await visitor.call('POST', '/widget/v1/chats/{id}/close', { params: { id: chat2 }, expect: 200 });
await command(vSock, 'chat.close', { chat_id: chat2 });

console.log('Invitation campaign (trigger → invitation.offered → displayed → accept)');
const invDef = { dsl_version: 1, event: 'visitor.page.changed', priority: 100, all: [{ field: 'page.path', op: 'starts_with', value: '/contract-invite' }], any: [], actions: [{ type: 'display_invitation', message: 'Need a hand with your order?', attribution: 'Contract team' }], stop_processing: false, cooldown_seconds: 0 };
const invTrig = await owner.must('POST', '/api/v1/triggers', { body: { name: 'Contract invitation', definition: invDef } });
await owner.call('POST', '/api/v1/triggers/{id}/publish', { params: { id: invTrig.id }, body: { revision: 1, enabled: true }, expect: 200 });
await visitor.call('POST', '/widget/v1/events', { body: { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}/contract-invite`, title: 'Invite me' }] }, expect: 202 });
const invFrame = await waitFor(() => vSock.events.find((f) => f.type === 'invitation.offered'), 15000, 'invitation.offered on the visitor socket').catch(() => null);
if (invFrame) {
  await visitor.call('POST', '/widget/v1/invitations/{id}/displayed', { params: { id: invFrame.payload.invitation_id }, body: {}, expect: 200 });
  const invChat = await visitor.call('POST', '/widget/v1/invitations/{id}/accept', { params: { id: invFrame.payload.invitation_id }, body: { client_request_id: randomUUID() }, expect: [200, 201] });
  await visitor.call('POST', '/widget/v1/chats/{id}/close', { params: { id: invChat.data.chat.id }, expect: 200 });
} else step('no invitation.offered frame within 15 s — invitation endpoints not exercised');
await owner.call('GET', '/api/v1/triggers/{id}/runs', { params: { id: invTrig.id }, expect: 200 });
const invNow = await owner.must('GET', '/api/v1/triggers/{id}', { params: { id: invTrig.id } });
await owner.call('DELETE', '/api/v1/triggers/{id}', { params: { id: invTrig.id }, headers: { 'if-match': `"${invNow.version}"` }, expect: 204 });

console.log('Exports & transcripts');
const pubExport = await visitor.must('POST', '/widget/v1/chats/{id}/exports', { params: { id: chatId }, body: { format: 'txt' } });
await waitFor(async () => (await visitor.must('GET', '/widget/v1/exports/{id}', { params: { id: pubExport.id } })).state === 'ready', 30000, 'public export ready');
const pubGrant = await visitor.must('GET', '/widget/v1/exports/{id}/download', { params: { id: pubExport.id } });
await anon.call('GET', '/widget/v1/exports/{id}/content', { params: { id: pubExport.id }, query: Object.fromEntries(new URL(pubGrant.url).searchParams), expect: 200 });
await visitor.call('POST', '/widget/v1/chats/{id}/transcript-email', { params: { id: chatId }, body: { email: `cust-${stamp}@talkivio.test`, format: 'txt' }, expect: 202 });
await owner.call('POST', '/api/v1/exports/preview', { body: { chat_ids: [chatId], format: 'txt' }, expect: 200 });
const staffExport = await owner.must('POST', '/api/v1/exports', { body: { chat_ids: [chatId], format: 'txt', timezone: 'UTC' }, headers: { 'idempotency-key': `contract-export-${stamp}` } });
await owner.call('GET', '/api/v1/exports', { expect: 200 });
await waitFor(async () => (await owner.must('GET', '/api/v1/exports/{id}', { params: { id: staffExport.id } })).state === 'ready', 30000, 'staff export ready');
const staffGrant = await owner.must('GET', '/api/v1/exports/{id}/download', { params: { id: staffExport.id } });
await anon.call('GET', '/api/v1/exports/{id}/content', { params: { id: staffExport.id }, query: Object.fromEntries(new URL(staffGrant.url).searchParams), expect: 200 });
const mail = await owner.must('POST', '/api/v1/chats/{id}/transcript-email', { params: { id: chatId }, body: { recipient: ownerEmail, format: 'txt' }, headers: { 'idempotency-key': `contract-mail-${stamp}` } });
await owner.call('GET', '/api/v1/chats/{id}/transcript-emails/{jobId}', { params: { id: chatId, jobId: mail.id }, expect: 200 });

console.log('Offline submissions');
const offline = await visitor.must('POST', '/widget/v1/offline-submissions', { body: { client_request_id: `offline-${stamp}`, name: 'Ada Visitor', email: `cust-${stamp}@talkivio.test`, message: 'Please call me back', department_id: support.id } });
await command(vSock, 'offline.submit', { client_request_id: `offline-sock-${stamp}`, email: `cust-${stamp}@talkivio.test`, message: 'Socket offline form' });
await owner.call('GET', '/api/v1/offline-submissions', { expect: 200 });
const offDetail = await owner.must('GET', '/api/v1/offline-submissions/{id}', { params: { id: offline.id } });
await owner.call('POST', '/api/v1/offline-submissions/{id}/reply', { params: { id: offline.id }, body: { body: 'We will call you tomorrow.' }, headers: { 'idempotency-key': `contract-reply-${stamp}` }, expect: 200 });
await owner.call('PATCH', '/api/v1/offline-submissions/{id}', { params: { id: offline.id }, body: { status: 'handled', expected_version: (await owner.must('GET', '/api/v1/offline-submissions/{id}', { params: { id: offline.id } })).version }, expect: [200, 409] });
void offDetail;

console.log('Visitors, bans, history');
await owner.call('GET', '/api/v1/visitors', { expect: 200 });
await owner.call('GET', '/api/v1/visitors/live', { expect: 200 });
const vis = await owner.must('GET', '/api/v1/visitors/{id}', { params: { id: sess.visitor.id } });
await owner.call('PATCH', '/api/v1/visitors/{id}', { params: { id: vis.id }, body: { custom_fields: { plan: 'enterprise' } }, headers: { 'if-match': `"${vis.version}"` }, expect: 200 });
await owner.call('GET', '/api/v1/visitors/{id}/sessions', { params: { id: vis.id }, expect: 200 });
await owner.call('GET', '/api/v1/visitors/{id}/chats', { params: { id: vis.id }, expect: 200 });
await owner.call('PUT', '/api/v1/visitors/{id}/tags', { params: { id: vis.id }, body: { tag_ids: [tag.id] }, expect: 200 });
const ban = await owner.must('POST', '/api/v1/bans', { body: { ip_or_cidr: '203.0.113.77', reason: 'Contract test ban' } });
await owner.call('GET', '/api/v1/bans', { expect: 200 });
await owner.call('DELETE', '/api/v1/bans/{id}', { params: { id: ban.id }, expect: 204 });
await owner.call('GET', '/api/v1/chats/history', { query: { limit: 20 }, expect: 200 });

console.log('Analytics, monitor, notifications');
const from = new Date(Date.now() - 86_400_000).toISOString();
const to = new Date(Date.now() + 3_600_000).toISOString();
await owner.call('GET', '/api/v1/analytics/chats', { query: { from, to, timezone: 'UTC' }, expect: 200 });
await owner.call('GET', '/api/v1/analytics/agents', { query: { from, to, timezone: 'UTC' }, expect: 200 });
await owner.call('GET', '/api/v1/analytics/invitations', { query: { from, to, timezone: 'UTC' }, expect: 200 });
const aExp = await owner.must('POST', '/api/v1/analytics/exports', { body: { report: 'chats', filters: { from, to, timezone: 'UTC' }, format: 'csv' }, headers: { 'idempotency-key': `contract-analytics-${stamp}` } });
const aDone = await waitFor(async () => {
  const e = await owner.must('GET', '/api/v1/analytics/exports/{id}', { params: { id: aExp.id } });
  return ['succeeded', 'ready', 'failed'].includes(e.state) ? e : null;
}, 30000, 'analytics export');
if (aDone.download_path) await owner.call('GET', '/api/v1/analytics/exports/{id}/download', { params: { id: aExp.id }, expect: 200 });
await owner.call('GET', '/api/v1/monitor', { expect: 200 });
await owner.call('GET', '/api/v1/notifications', { expect: 200 });
const notes = await owner.must('GET', '/api/v1/notifications');
if (notes.items[0]) await owner.call('POST', '/api/v1/notifications/{id}/read', { params: { id: notes.items[0].id }, expect: 200 });
await owner.call('POST', '/api/v1/notifications/read-all', { expect: 200 });

console.log('Integrations: tokens, webhooks (SSRF), connectors');
await owner.call('GET', '/api/v1/integration-tokens', { expect: 200 });
await owner.call('GET', '/api/v1/integration-tokens/scopes', { expect: 200 });
const tok = await owner.must('POST', '/api/v1/integration-tokens', { body: { name: 'Contract reader', scopes: ['chats:read'] }, headers: { 'idempotency-key': `contract-token-${stamp}` } });
await owner.call('GET', '/api/v1/integration-tokens', { expect: 200 });
const integ = new Principal('integration');
integ.bearer = tok.token;
await integ.call('GET', '/api/v1/chats/history', { query: { limit: 5 }, expect: 200 });
await integ.call('GET', '/api/v1/chats/{id}', { params: { id: chatId }, expect: 200 });
await integ.call('GET', '/api/v1/agents/me', { expect: 403 });
const rotated = await owner.must('POST', '/api/v1/integration-tokens/{id}/rotate', { params: { id: tok.id }, headers: { 'idempotency-key': `contract-rotate-${stamp}` } });
await owner.call('DELETE', '/api/v1/integration-tokens/{id}', { params: { id: rotated.id }, expect: 204 });
await owner.call('GET', '/api/v1/webhooks/event-types', { expect: 200 });
for (const url of ['http://127.0.0.1:9/hook', 'http://10.0.0.5/hook', 'http://localhost/hook', 'http://169.254.169.254/latest']) {
  await owner.call('POST', '/api/v1/webhooks', { body: { url, event_types: ['privacy.erased'] }, expect: 422 });
}
const hook = await owner.call('POST', '/api/v1/webhooks', { body: { url: 'https://example.com/talkivio-contract-hook', event_types: ['privacy.erased'] }, expect: [201, 422] });
if (hook.status === 201) {
  const h = hook.data;
  await owner.call('GET', '/api/v1/webhooks', { expect: 200 });
  const hv = await owner.call('GET', '/api/v1/webhooks/{id}', { params: { id: h.id }, expect: 200 });
  const upd = await owner.must('PATCH', '/api/v1/webhooks/{id}', { params: { id: h.id }, body: { description: 'contract' }, headers: { 'if-match': hv.headers.get('etag') } });
  await owner.call('GET', '/api/v1/webhooks/{id}/deliveries', { params: { id: h.id }, expect: 200 });
  const rot = await owner.must('POST', '/api/v1/webhooks/{id}/rotate-secret', { params: { id: h.id }, body: {}, headers: { 'idempotency-key': `contract-hook-rotate-${stamp}` } });
  await owner.call('DELETE', '/api/v1/webhooks/{id}', { params: { id: h.id }, headers: { 'if-match': `"${rot.version ?? upd.version}"` }, expect: 204 });
} else step(`public webhook host not resolvable here (${hook.error?.message}); create/update/delete not exercised`);
const connectors = await owner.must('GET', '/api/v1/integrations/connectors');
if (connectors[0]) await owner.call('POST', '/api/v1/integrations/connectors/{key}/health-check', { params: { key: connectors[0].key }, body: {}, expect: [200, 409] });

console.log('Audit & privacy');
await owner.call('GET', '/api/v1/audit-events', { query: { limit: 20 }, expect: 200 });
await owner.call('GET', '/api/v1/audit-events/export.csv', { expect: 200 });
await owner.call('GET', '/api/v1/privacy/retention/preview', { expect: 200 });
const priv = await owner.must('POST', '/api/v1/privacy/requests', { body: { kind: 'access', visitor_id: sess.visitor.id, proof_reference: `TICKET-${stamp}` }, headers: { 'idempotency-key': `contract-privacy-${stamp}` } });
await owner.call('GET', '/api/v1/privacy/requests', { expect: 200 });
await owner.call('POST', '/api/v1/privacy/requests/{id}/verify', { params: { id: priv.id }, body: { method: 'email_confirmation' }, expect: 202 });
await waitFor(async () => (await owner.must('GET', '/api/v1/privacy/requests/{id}', { params: { id: priv.id } })).state === 'completed', 30000, 'privacy access export');
await owner.call('GET', '/api/v1/privacy/requests/{id}/export', { params: { id: priv.id }, expect: 200 });
await owner.call('POST', '/api/v1/privacy/requests/{id}/resume', { params: { id: priv.id }, expect: [202, 409] });
await owner.call('POST', '/api/v1/privacy/retention/run', { expect: 200 });

console.log('Key rotation, widget reset, archives');
await owner.call('POST', '/api/v1/sites/{id}/key-rotation', { params: { id: dest.id }, body: { overlap_seconds: 60 }, expect: 201 });
await owner.call('DELETE', '/api/v1/sites/{id}/identity-secret', { params: { id: site.id }, expect: 200 });
const reset = await visitor.must('POST', '/widget/v1/identity/reset', { body: {} });
await owner.call('POST', '/api/v1/visitors/merge-requests', { body: { source_id: reset.visitor.id, target_id: sess.visitor.id, proof_reference: `ticket-${stamp} verified by phone`, reason: 'Contract test merge' }, expect: [202, 409, 422] });
await waitFor(() => vSock.controls.length > 0 || vSock.disconnected, 4000, 'visitor socket revoked after reset').catch(() => null);
await owner.call('POST', '/api/v1/departments/{id}/archive', { params: { id: sales.id }, expect: 200 });
await owner.call('POST', '/api/v1/tags/{id}/archive', { params: { id: tag.id }, expect: 200 });
await owner.call('POST', '/api/v1/custom-fields/{id}/archive', { params: { id: cf.id }, expect: 200 });
await owner.call('POST', '/api/v1/sites/{id}/archive', { params: { id: dest.id }, expect: 200 });

console.log('Workspace deletion request (scheduled, then cancelled) + GET /jobs/{id}');
const tenantNow = await owner.must('GET', '/api/v1/tenants/current');
const delReq = await owner.must('POST', '/api/v1/tenants/current/deletion-requests', { body: { confirm_slug: tenantNow.slug }, headers: { 'idempotency-key': `contract-tenant-delete-${stamp}` } });
await owner.call('GET', '/api/v1/tenants/current/deletion-requests', { expect: 200 });
await owner.call('GET', '/api/v1/jobs/{id}', { params: { id: delReq.id }, expect: 200 }); // the deletion request is itself a job
await owner.call('DELETE', '/api/v1/tenants/current/deletion-requests/{id}', { params: { id: delReq.id }, expect: 200 });

console.log('Second tenant + switch (revokes the agent socket)');
await owner.call('POST', '/api/v1/tenants', { body: { tenant_name: `Contracts B ${stamp}`, timezone: 'UTC' }, expect: [200, 201] });
await owner.call('POST', '/api/v1/tenants/switch', { body: { tenant_id: tenantId }, expect: 200 });
await waitFor(() => oSock.controls.length > 0, 4000, 'access.revoked control frame').catch(() => null);
await owner.call('POST', '/api/v1/tenants/current/ownership-transfer', { body: { target_membership_id: bMe.agent.id, reason: 'Contract test hand-over' }, expect: [200, 409, 422] });
await owner.call('POST', '/api/v1/auth/sessions/revoke-others', { expect: 200 });
console.log('Typed client (@talkivio/client dist) against the live API');
const clientDist = resolve(ROOT, 'packages/client/dist/index.js');
let clientMod = null;
try {
  clientMod = await import(clientDist);
} catch {
  step('packages/client/dist not built — run `pnpm --filter @talkivio/client build`; typed client check skipped');
}
if (clientMod) {
  const cookieFetch = (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-forwarded-for': XFF, cookie: Object.entries(owner.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') } });
  const api = clientMod.createClient({ baseUrl: API, fetch: cookieFetch, csrf: () => owner.cookies.rd_csrf });
  const typedChat = await api.get('/api/v1/chats/{id}', { params: { id: chatId } });
  if (typedChat.data.id !== chatId || typedChat.data.owner_membership_id !== undefined || typeof typedChat.data.lastSeq !== 'number') R.rest.failures.push('typed client: GET /api/v1/chats/{id} did not return a camelCased StaffChat');
  const typedHistory = await api.get('/api/v1/chats/history', { query: { limit: 5, siteId: site.id } });
  if (!Array.isArray(typedHistory.data) || typeof typedHistory.page?.hasMore !== 'boolean') R.rest.failures.push('typed client: paged history envelope not mapped');
  const typedTag = await api.post('/api/v1/tags', { body: { label: `Client ${stamp}` } });
  if (typedTag.status !== 201 || !typedTag.data.slug) R.rest.failures.push('typed client: POST /api/v1/tags failed');
  const typedErr = await api.get('/api/v1/chats/{id}', { params: { id: randomUUID() } }).then(() => null, (e) => e);
  if (!(typedErr instanceof clientMod.TalkivioError) || typedErr.code !== 'NOT_FOUND' || typedErr.status !== 404) R.rest.failures.push('typed client: 404 not surfaced as TalkivioError NOT_FOUND');
  else step('typed client: camelCase data, paging, CSRF POST and TalkivioError verified');
}
await owner.call('POST', '/api/v1/auth/logout', { expect: 204 });
await owner.call('GET', '/api/v1/auth/me', { expect: 401 });

} catch (err) {
  aborted = err;
  console.log(`  ✗ scenario aborted: ${err.message}`);
}

// ───────────────────────── outbox rows ─────────────────────────
await sleep(1500);
for (const s of sockets) s.disconnect();
console.log('Outbox rows for the test tenant');
const rows = tenantId ? JSON.parse(sql(`SELECT coalesce(json_agg(json_build_object('type', event_type, 'audience', audience, 'kind', scope_kind, 'payload', payload) ORDER BY seq), '[]') FROM outbox_events WHERE tenant_id = '${tenantId}'`) || '[]') : [];
const outboxMeta = asyncapi['x-talkivio-outbox'];
for (const r of rows) {
  const label = `${r.type}/${r.audience}`;
  R.outbox.types[label] = (R.outbox.types[label] ?? 0) + 1;
  const meta = outboxMeta[r.type];
  if (!meta) {
    R.outbox.failures.push(`${label}: event type not in asyncapi.yaml`);
    continue;
  }
  const allowed = r.audience === 'staff' ? meta.staff_scopes : r.audience === 'public' ? meta.public_scopes : ['tenant'];
  if (!allowed.includes(r.kind)) R.outbox.failures.push(`${label}: scope kind ${r.kind} not in ${allowed}`);
  const v = outboxValidator(r.audience === 'public' && meta.public_payload ? `${r.type}__public` : `${r.type}__payload`);
  if (!v(r.payload)) R.outbox.failures.push(`${label}: ${fmt(v.errors)}`);
  else R.outbox.validated++;
}

// ───────────────────────── expectations & report ─────────────────────────
const mustSee = {
  'agent/event': ['chat.requested', 'chat.updated', 'message.created', 'message.read', 'assignment.offered', 'assignment.accepted', 'participant.joined', 'participant.left', 'chat.transferred', 'chat.closed', 'rating.updated', 'attachment.updated', 'config.published', 'schedule.updated', 'emergency_closure.created', 'shortcut.changed', 'export.ready', 'offline.submitted'],
  'visitor/event': ['chat.requested', 'chat.updated', 'message.created', 'message.read', 'participant.joined', 'chat.transferred', 'chat.closed', 'rating.updated', 'attachment.updated', 'export.ready', 'offline.submitted'],
  'agent/ephemeral': ['typing.changed', 'message.delivered', 'presence.updated', 'visitor.updated'],
  'visitor/ephemeral': ['typing.changed', 'message.delivered'],
};
const missing = [];
for (const [prefix, types] of Object.entries(mustSee)) for (const t of types) if (!R.frames.types[`${prefix}/${t}`]) missing.push(`${prefix}/${t}`);

const typedOps = Object.entries(restIndex).filter(([, e]) => Object.entries(e.statuses).some(([s, st]) => Number(s) < 300 && st.id)).map(([k]) => k);
const fmtTypes = (o) => Object.entries(o).sort().map(([k, v]) => `${k}×${v}`).join(', ');
console.log('\n════════ Contract test report ════════');
console.log(`REST: ${R.rest.validated} responses validated (${R.rest.errorsValidated} error envelopes, ${R.rest.media} non-JSON media) across ${R.rest.opsSeen.size} operations; ${R.rest.typedOpsOk.size}/${typedOps.length} typed success contracts proven; ${Object.keys(restIndex).length} operations in openapi.yaml`);
console.log(`Frames: ${R.frames.validated} validated — ${fmtTypes(R.frames.types)}`);
console.log(`Acks: ${R.acks.validated} validated`);
console.log(`Outbox: ${R.outbox.validated}/${rows.length} rows validated — ${fmtTypes(R.outbox.types)}`);
const unproven = typedOps.filter((k) => !R.rest.typedOpsOk.has(k));
const onlyEmpty = [...R.rest.emptyLists].filter((k) => !R.rest.filledLists.has(k));
console.log(`List operations only ever seen empty (envelope proven, item schema not exercised) (${onlyEmpty.length}): ${onlyEmpty.join(', ') || '—'}`);
console.log(`Typed operations not exercised (${unproven.length}): ${unproven.join(', ')}`);
const failures = [...(aborted ? [`ABORTED ${aborted.message}`] : []), ...R.rest.failures.map((f) => `REST ${f}`), ...R.frames.failures.map((f) => `FRAME ${f}`), ...R.acks.failures.map((f) => `ACK ${f}`), ...R.outbox.failures.map((f) => `OUTBOX ${f}`), ...missing.map((m) => `MISSING frame ${m}`)];
if (failures.length) {
  console.log(`\n✗ ${failures.length} contract failure(s):`);
  for (const f of [...new Set(failures)]) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ all contracts hold (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(0);
