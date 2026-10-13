// Trigger DSL v1 + proactive invitations end-to-end (ch. 21/32/33; TRIG01–03, INV01–02).
// Real HTTP, sockets, PostgreSQL, Redis/BullMQ and the worker — no mocks.
// Run against an isolated api + worker:  node test/triggers.e2e.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4103';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3';
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg, extra) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}${extra !== undefined ? `\n  ${JSON.stringify(extra, null, 2).slice(0, 2000)}` : ''}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = {};
    this.auth = null;
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...(this.auth ? { authorization: `Bearer ${this.auth}` } : {}),
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
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, data: json?.data, error: json?.error, headers: res.headers };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-c', q]).toString().trim();
const latestEmail = (to, template) => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
async function waitFor(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

const stamp = Date.now();

async function signupOwner(label) {
  const c = new Client(label);
  const email = `${label}+${stamp}@example.com`;
  await c.must('POST', '/auth/signup', { email, password: 'correct horse battery staple', tenant_name: `${label} ${stamp}`, timezone: 'UTC' });
  await c.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(email, 'verify_email'), 'token') });
  return c;
}

async function newVisitor(site, label, page = '/pricing') {
  const v = new Client(label);
  const sess = await v.must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: ORIGIN,
    consent: { analytics: true, policy_version: '2026-10' },
    page: { url: `${ORIGIN}${page}`, title: 'Page', referrer: 'https://www.google.com/' },
  });
  v.auth = sess.capability;
  v.session = sess;
  v.sock = await socket('/visitor', (await v.must('POST', '/widget/v1/socket-ticket')).ticket);
  return v;
}
const enter = (v, path) => v.must('POST', '/widget/v1/events', { events: [{ id: randomUUID(), kind: 'entered', url: `${ORIGIN}${path}`, title: path }] });
const offers = (v) => v.sock.frames.filter((f) => f.type === 'invitation.offered');

// ───────────────────────── Setup ─────────────────────────
console.log('Setup — tenant, departments, site, agents');
const owner = await signupOwner('trigowner');
const me = await owner.must('GET', '/agents/me');
const ownerMid = me.agent.id;
const depts = await owner.must('GET', '/departments');
const support = depts.find((d) => d.name === 'Support');
const billing = await owner.must('POST', '/departments', { name: 'Billing' });
await owner.must('PUT', `/departments/${billing.id}/members`, { members: [{ membership_id: ownerMid, can_serve: true }] });
const site = await owner.must('POST', '/sites', { name: 'Trigger demo', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const agentEmail = `trigagent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 2 });
const agentB = new Client('agentB');
await agentB.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'), display_name: 'Bea Agent', password: 'another strong passphrase' });
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
ok(!!ownerSock, 'owner online with a live agent socket');

// ───────────────────────── Templates & permissions ─────────────────────────
console.log('Templates, permissions and validation');
const [l1, l2, l3] = await Promise.all([owner.must('GET', '/triggers'), owner.must('GET', '/triggers'), owner.must('GET', '/triggers')]);
const again = await owner.must('GET', '/triggers');
ok(l1.length === 4 && l2.length === 4 && l3.length === 4 && again.length === 4, 'starter templates seeded exactly once under concurrent first GETs');
ok(again.every((t) => t.enabled === false && t.published_revision === 1), 'templates are disabled and published (revision 1)');
const names = again.map((t) => t.name).sort();
ok(JSON.stringify(names) === JSON.stringify(['First-visit greeting', 'Pricing page invitation', 'Queue apology', 'Tag returning visitors']), 'pricing invitation, queue apology, first-visit greeting, returning-visitor tag');
ok((await agentB.call('GET', '/triggers')).status === 403, 'agents cannot read triggers (triggers.view)');

const beta = await signupOwner('trigbeta');
const betaDept = (await beta.must('GET', '/departments'))[0];
const baseDef = (over) => ({ dsl_version: 1, event: 'chat.requested', priority: 100, all: [], any: [], actions: [{ type: 'add_tag', tag: 'x' }], stop_processing: false, cooldown_seconds: 0, ...over });
const cross = await owner.call('POST', '/triggers', { name: 'Cross tenant', definition: baseDef({ actions: [{ type: 'set_department', department_id: betaDept.id }] }) });
ok(cross.status === 422 && cross.error.field_errors['definition.actions.0.department_id'], 'cross-tenant department reference rejected (422)', cross.error);
const badOp = await owner.call('POST', '/triggers', { name: 'Bad', definition: baseDef({ all: [{ field: 'page.path', op: 'regex', value: '.*' }], color: 'red' }) });
ok(badOp.status === 422 && badOp.error.field_errors['definition.all.0.op'] && badOp.error.field_errors['definition.color'], 'unknown operator and unknown key rejected', badOp.error);
const badType = await owner.call('POST', '/triggers', { name: 'Bad', definition: baseDef({ all: [{ field: 'eligible_agent_count', op: 'gt', value: 'many' }] }) });
ok(badType.status === 422, 'numeric operator with a text operand rejected');

// ───────────────────────── Trigger configuration ─────────────────────────
console.log('Publishing chat triggers');
async function createPublished(name, definition) {
  const t = await owner.must('POST', '/triggers', { name, definition });
  ok(t.enabled === false && t.current_revision === 1 && t.published_revision === null, `${name}: created as a disabled draft`);
  const p = await owner.must('POST', `/triggers/${t.id}/publish`, { revision: 1, enabled: true });
  ok(p.enabled && p.published_revision === 1, `${name}: published revision 1 and enabled`);
  return p;
}
// A visitor field the routing trigger sets (its provenance must name the trigger).
await owner.must('POST', '/custom-fields', { key: 'support_topic', label: 'Support topic', data_type: 'string' });
const route = await createPublished('Billing routing', {
  dsl_version: 1,
  event: 'chat.requested',
  priority: 300,
  all: [{ field: 'message.text', op: 'contains', value: 'billing', ignore_case: true }],
  any: [],
  actions: [
    { type: 'send_public_message', text: 'We will escalate this to our Billing team right away.', attribution: 'Billing bot' },
    { type: 'set_department', department_id: billing.id },
    { type: 'add_tag', tag: 'billing' },
    { type: 'set_visitor_field', key: 'support_topic', value: 'billing' },
  ],
  stop_processing: false,
  cooldown_seconds: 0,
});
const escalate = await createPublished('Escalation', {
  dsl_version: 1,
  event: 'message.created',
  priority: 200,
  all: [{ field: 'message.text', op: 'contains', value: 'escalate', ignore_case: true }],
  any: [],
  actions: [
    { type: 'set_department', department_id: support.id },
    { type: 'add_tag', tag: 'escalation' },
  ],
  stop_processing: false,
  cooldown_seconds: 0,
});

// Versioned drafts, publish version check, restore.
const draft = await owner.must('PUT', `/triggers/${escalate.id}/draft`, { definition: { ...baseDef({ event: 'message.created', priority: 150 }), actions: [{ type: 'add_tag', tag: 'v2' }] } });
ok(draft.draft.revision === 2 && draft.trigger.published_revision === 1, 'saving a draft after publish starts revision 2 (published revision unchanged)');
const stale = await owner.call('POST', `/triggers/${escalate.id}/publish`, { revision: 1, enabled: true });
ok(stale.status === 409 && stale.error.code === 'VERSION_CONFLICT', 'publishing a stale revision → 409 VERSION_CONFLICT');
const restored = await owner.must('POST', `/triggers/${escalate.id}/restore`, { revision: 1 });
ok(restored.current_revision === 3 && restored.draft.definition.priority === 200 && restored.published_revision === 1, 'restore creates revision 3 from revision 1 (history kept)');
const [p1, p2] = await Promise.all([
  owner.call('POST', `/triggers/${escalate.id}/publish`, { revision: 3, enabled: true }),
  owner.call('POST', `/triggers/${escalate.id}/publish`, { revision: 3, enabled: true }),
]);
ok(p1.status === 200 && p2.status === 200 && p1.data.published_revision === 3 && p2.data.published_revision === 3, 'concurrent publish of the same revision is serialized and idempotent');
const noIfMatch = await owner.call('PATCH', `/triggers/${escalate.id}`, { name: 'Escalation v3' });
ok(noIfMatch.status === 428, 'PATCH metadata without If-Match → 428');
const renamed = await owner.must('PATCH', `/triggers/${escalate.id}`, { name: 'Escalation' }, { 'if-match': `"${p1.data.version > p2.data.version ? p1.data.version : p2.data.version}"` });
ok(renamed.name === 'Escalation', 'PATCH metadata with If-Match');
const audit = sql(`SELECT count(*) FROM audit_events WHERE object_id = '${escalate.id}' AND action IN ('trigger.published','trigger.enabled')`);
ok(Number(audit) >= 2, 'publish and enable are audited');

// Invitation campaigns: enable the pricing template + a generic greeting on the same timer event.
const pricing = again.find((t) => t.name === 'Pricing page invitation');
await owner.must('PATCH', `/triggers/${pricing.id}`, { enabled: true }, { 'if-match': String(pricing.version) });
const generic = await createPublished('Generic greeting', {
  dsl_version: 1,
  event: 'visitor.timer.elapsed',
  priority: 100,
  all: [{ field: 'page.visible_dwell_seconds', op: 'gte', value: 30 }],
  any: [],
  actions: [{ type: 'display_invitation', message: 'Hi! Need a hand?', attribution: 'Team' }],
  stop_processing: false,
  cooldown_seconds: 0,
});

// ───────────────────────── Invitations: pricing dwell 30 s ─────────────────────────
console.log('INV01/INV02 — pricing page dwell (server timers; ~70 s)');
const v1 = await newVisitor(site, 'v1');
const v3 = await newVisitor(site, 'v3');
const v4 = await newVisitor(site, 'v4');
const t0 = Date.now();
await Promise.all([enter(v1, '/pricing'), enter(v3, '/pricing/teams'), enter(v4, '/pricing')]);

// While the 30 s timers run: chat triggers (TRIG01/TRIG03).
console.log('TRIG — chat triggers while the dwell timers run');
const v2 = await newVisitor(site, 'v2', '/help');
const created = await v2.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hi, I have a BILLING question' });
ok(created.status === 201, 'visitor requested a chat');
const chatId = created.data.chat.id;
const routeRuns = await waitFor(async () => {
  const r = await owner.must('GET', `/triggers/${route.id}/runs`);
  return r.length && r[0].effects.every((e) => e.status !== 'pending') ? r : null;
}, 15000, 'billing routing run');
ok(routeRuns.length === 1 && routeRuns[0].matched === true, 'chat.requested produced one trigger run');
ok(routeRuns[0].effects.map((e) => `${e.action_type}:${e.status}`).join(',') === 'send_public_message:applied,set_department:applied,add_tag:applied,set_visitor_field:applied', 'before assignment: greeting, set_department, tag and visitor field applied', routeRuns[0].effects);
const chat1 = await owner.must('GET', `/chats/${chatId}`);
ok(chat1.department_id === billing.id && chat1.tags.some((t) => t.slug === 'billing'), 'chat routed to Billing and tagged');
const v2Profile = await owner.must('GET', `/visitors/${chat1.visitor_id ?? chat1.visitor?.id}`);
ok(v2Profile.custom_fields.support_topic === 'billing' && v2Profile.custom_field_sources.support_topic?.source === 'trigger' && v2Profile.custom_field_sources.support_topic.by === route.id, 'provenance: the field set by the trigger is attributed to that trigger');
const botMessages = async () => (await owner.must('GET', `/chats/${chatId}/messages?limit=100`)).items.filter((m) => m.sender.display_name === 'Billing bot' && m.automated);
ok((await botMessages()).length === 1, 'exactly one automated greeting (plain text, team attribution)');
await sleep(1500);
ok((await owner.must('GET', `/triggers/${escalate.id}/runs`)).length === 0, 'automated message containing "escalate" did not emit a visitor message event (no loop)');

// TRIG03: redeliver the same committed event → same effect once.
const ev = JSON.parse(sql(`SELECT row_to_json(x) FROM (SELECT event_id, tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, causation_id, occurred_at FROM outbox_events WHERE event_type = 'chat.requested' AND aggregate_id = '${chatId}' AND scope_kind = 'tenant' LIMIT 1) x`));
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const events = new Queue('events', { connection: redis, prefix: 'rd' });
const internal = { eventId: ev.event_id, tenantId: ev.tenant_id, eventType: ev.event_type, aggregateType: ev.aggregate_type, aggregateId: ev.aggregate_id, aggregateVersion: ev.aggregate_version, payload: ev.payload, causationId: ev.causation_id, occurredAt: ev.occurred_at };
await events.add('chat.requested', internal, { jobId: `retry-${ev.event_id}-1`, attempts: 1 });
await events.add('chat.requested', internal, { jobId: `retry-${ev.event_id}-2`, attempts: 1 });
await sleep(2500);
const routeRuns2 = await owner.must('GET', `/triggers/${route.id}/runs`);
ok(routeRuns2.length === 1 && routeRuns2[0].id === routeRuns[0].id, 'redelivered event (x2) reused the same trigger run');
ok((await botMessages()).length === 1, 'retry of the same event did not duplicate the greeting');

// After assignment: set_department is skipped with a reason.
const accepted = await owner.call('POST', `/chats/${chatId}/accept`, {});
ok(accepted.status === 200 && accepted.data.status === 'active', 'agent accepted the chat');
await v2.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'Please escalate this' });
const escRuns = await waitFor(async () => {
  const r = await owner.must('GET', `/triggers/${escalate.id}/runs`);
  return r.length && r[0].effects.every((e) => e.status !== 'pending') ? r : null;
}, 15000, 'escalation run');
const deptEffect = escRuns[0].effects.find((e) => e.action_type === 'set_department');
ok(escRuns.length === 1 && escRuns[0].trigger_revision === 3, 'visitor message evaluated against the published revision 3');
ok(deptEffect.status === 'skipped' && deptEffect.reason === 'chat_assigned', 'after assignment: set_department recorded as skipped (chat_assigned)', escRuns[0].effects);
ok((await owner.must('GET', `/chats/${chatId}`)).department_id === billing.id, 'active chat was not rerouted');
const queueApology = again.find((t) => t.name === 'Queue apology');
ok((await owner.must('GET', `/triggers/${queueApology.id}/runs`)).length === 0, 'disabled template never runs');

// ───────────────────────── Invitations arrive ─────────────────────────
await waitFor(() => offers(v1).length && offers(v3).length && offers(v4).length, 50_000, 'invitations after 30 s dwell');
const elapsed = (Date.now() - t0) / 1000;
ok(elapsed >= 29, `invitations arrived from server timers after ${elapsed.toFixed(1)} s (not before 30 s of dwell)`);
await sleep(1000);
ok(offers(v1).length === 1 && offers(v3).length === 1 && offers(v4).length === 1, 'pricing + generic campaigns matching the same event → exactly one invitation per visitor');
const inv1 = offers(v1)[0].payload;
ok(inv1.message.startsWith('Questions about plans') && inv1.attribution === 'Sales team' && inv1.expires_at && inv1.invitation_id, 'higher-priority pricing invitation won (message, attribution, expiry)');
ok(Number(sql(`SELECT count(*) FROM chats WHERE visitor_id IN ('${v1.session.visitor.id}','${v3.session.visitor.id}','${v4.session.visitor.id}')`)) === 0, 'offering/displaying an invitation never creates a chat');

const shown = await v1.must('POST', `/widget/v1/invitations/${inv1.invitation_id}/displayed`, {});
ok(shown.state === 'displayed' && shown.displayed_at, 'display acknowledged with server receipt time');
ok((await v3.call('POST', `/widget/v1/invitations/${inv1.invitation_id}/displayed`, {})).status === 404, "another visitor cannot touch someone else's invitation");
const dismissed = await v1.call('POST', `/widget/v1/invitations/${inv1.invitation_id}/dismiss`, {});
ok(dismissed.status === 204, 'dismissal recorded (204)');
const lateAccept = await v1.call('POST', `/widget/v1/invitations/${inv1.invitation_id}/accept`, { client_request_id: randomUUID() });
ok(lateAccept.status === 409 && lateAccept.error.code === 'OFFER_EXPIRED', 'dismissed invitation cannot be accepted (409)');

// Double-click accept → one chat.
const inv3 = offers(v3)[0].payload.invitation_id;
const [a1, a2] = await Promise.all([
  v3.call('POST', `/widget/v1/invitations/${inv3}/accept`, { client_request_id: randomUUID() }),
  v3.call('POST', `/widget/v1/invitations/${inv3}/accept`, { client_request_id: randomUUID() }),
]);
ok([a1, a2].every((r) => r.status === 201 || r.status === 200) && a1.data.chat.id === a2.data.chat.id && a1.data.initial_message === null, 'double-click accept → same chat, initial_message null', [a1.json, a2.json]);
ok(Number(sql(`SELECT count(*) FROM chats WHERE visitor_id = '${v3.session.visitor.id}'`)) === 1, 'exactly one chat row for the double click');
const invMsgs = await owner.must('GET', `/chats/${a1.data.chat.id}/messages?limit=20`);
ok(invMsgs.items.filter((m) => m.automated && m.body?.startsWith('Questions about plans')).length === 1, 'accepted chat starts with the automated invitation message (system attribution)');
const a3 = await v3.call('POST', `/widget/v1/invitations/${inv3}/accept`, { client_request_id: randomUUID() });
ok(a3.data.chat.id === a1.data.chat.id, 'a later retry returns the same chat');

// INV02: department went offline before accept → recoverable 409.
await owner.must('PUT', '/agents/me/presence', { status: 'away' });
const inv4 = offers(v4)[0].payload.invitation_id;
const offline = await v4.call('POST', `/widget/v1/invitations/${inv4}/accept`, { client_request_id: randomUUID() });
ok(offline.status === 409 && offline.error.code === 'DEPARTMENT_UNAVAILABLE', 'accept while nobody is available → 409 DEPARTMENT_UNAVAILABLE', offline.error);
ok(Number(sql(`SELECT count(*) FROM chats WHERE visitor_id = '${v4.session.visitor.id}'`)) === 0, 'no chat created for the unavailable accept');
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
// Socket parity (ch. 77): invitation.ack / invitation.dismiss reuse the REST service.
const ack = await v4.sock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'invitation.ack', payload: { invitation_id: inv4, displayed_at_client: new Date().toISOString() } });
ok(ack.type === 'command.ack' && ack.result.state === 'displayed', 'socket invitation.ack marks the invitation displayed', ack);
const sockDismiss = await v4.sock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'invitation.dismiss', payload: { invitation_id: inv4 } });
ok(sockDismiss.type === 'command.ack' && sql(`SELECT state FROM invitations WHERE id = '${inv4}'`) === 'dismissed', 'socket invitation.dismiss records the dismissal', sockDismiss);

// Dismiss + navigate → no repeat within the cap.
const t1 = Date.now();
await enter(v1, '/pricing');
const pricingRunsBefore = (await owner.must('GET', `/triggers/${pricing.id}/runs?limit=100`)).length;
const secondRun = await waitFor(async () => {
  const r = await owner.must('GET', `/triggers/${pricing.id}/runs?limit=100`);
  const mine = r.filter((x) => x.visitor_session_id === v1.session.session_id);
  return mine.length >= 2 && mine[0].effects.every((e) => e.status !== 'pending') ? mine[0] : null;
}, 50_000, 'second pricing timer run for v1');
ok((Date.now() - t1) / 1000 >= 29, 'second timer fired only after another 30 s on the page');
const capEffect = secondRun.effects.find((e) => e.action_type === 'display_invitation');
ok(capEffect.status === 'skipped' && ['dismissed_recently', 'session_cap'].includes(capEffect.reason), `navigation after dismissal: invitation suppressed (${capEffect.reason})`, secondRun.effects);
await sleep(500);
ok(offers(v1).length === 1, 'visitor still received exactly one invitation');
ok(pricingRunsBefore >= 3, 'one pricing run per visitor timer event');

// Funnel by invitation id.
const funnel = await owner.must('GET', `/triggers/${pricing.id}/funnel`);
ok(funnel.eligible === 3 && funnel.displayed === 3 && funnel.accepted === 1 && funnel.served === 0 && funnel.dismissed === 2,'funnel counts eligible/displayed/accepted/dismissed by distinct invitation id', funnel);

// ───────────────────────── Simulator parity ─────────────────────────
console.log('Simulator parity');
const firstRun = (await owner.must('GET', `/triggers/${pricing.id}/runs?limit=100`)).find((r) => r.visitor_session_id === v3.session.session_id);
const sim = await owner.must('POST', `/triggers/${pricing.id}/simulate`, { event: 'visitor.timer.elapsed', snapshot: firstRun.result.snapshot, include_published: true });
const simTrace = sim.triggers.find((t) => t.trigger_id === pricing.id);
ok(sim.writes === false && simTrace.reason === firstRun.result.reason && simTrace.reason === 'fired', 'simulator reproduces the production decision (fired)');
ok(JSON.stringify(simTrace.all.map((c) => [c.field, c.result])) === JSON.stringify(firstRun.result.all.map((c) => [c.field, c.result])), 'condition truth trace identical to production', { sim: simTrace.all, prod: firstRun.result.all });
ok(JSON.stringify(sim.effects.filter((e) => e.trigger_id === pricing.id).map((e) => e.action.type)) === JSON.stringify(firstRun.result.effects.map((e) => e.type)), 'collected effects identical to production');
ok(sim.triggers.find((t) => t.trigger_id === generic.id)?.reason === 'after_stop', 'simulator shows the generic greeting stopped by stop_processing');
const simMissing = await owner.must('POST', `/triggers/${pricing.id}/simulate`, { event: 'visitor.timer.elapsed', snapshot: { 'page.path': '/pricing' } });
ok(simMissing.triggers.find((t) => t.trigger_id === pricing.id).reason === 'conditions_false' && simMissing.effects.length === 0, 'missing dwell field never matches (explicit missing semantics)');
const simBad = await owner.call('POST', `/triggers/${pricing.id}/simulate`, { event: 'visitor.timer.elapsed', snapshot: { 'visitor.email': 'a@b.c' } });
ok(simBad.status === 422, 'simulator rejects non-allowlisted snapshot fields');
const pricingDetail = await owner.must('GET', `/triggers/${pricing.id}`);
const simUnsaved = await owner.must('POST', `/triggers/${pricing.id}/simulate`, { event: 'visitor.timer.elapsed', snapshot: firstRun.result.snapshot, definition: pricingDetail.published.definition });
ok(simUnsaved.revision === null && simUnsaved.triggers.find((t) => t.trigger_id === pricing.id).reason === 'fired', 'simulator runs an unsaved editor definition (revision null) with the production interpreter');
const simUnsavedBad = await owner.call('POST', `/triggers/${pricing.id}/simulate`, { event: 'visitor.timer.elapsed', snapshot: firstRun.result.snapshot, definition: { dsl_version: 1 } });
ok(simUnsavedBad.status === 422 && Object.keys(simUnsavedBad.error.field_errors).some((k) => k.startsWith('definition')), 'an invalid unsaved definition gets the same field errors as a draft save');
const rev = await owner.must('GET', `/triggers/${pricing.id}/revisions/${pricingDetail.published.revision}`);
ok(JSON.stringify(rev.definition) === JSON.stringify(pricingDetail.published.definition), 'a past revision can be read with its full definition');
ok((await owner.call('GET', `/triggers/${pricing.id}/revisions/9999`)).status === 404, 'unknown revision → 404');

// ───────────────────────── Cooldown (TRIG03) ─────────────────────────
console.log('Cooldown: a matching trigger stays quiet for the same session until it expires (TRIG03)');
const cdPath = `/cooldown-${stamp}`;
const cooled = await owner.must('POST', '/triggers', {
  name: 'Cooldown probe',
  definition: baseDef({ event: 'visitor.page.changed', all: [{ field: 'page.path', op: 'contains', value: cdPath }], actions: [{ type: 'set_visitor_field', key: 'support_topic', value: 'cooldown' }], cooldown_seconds: 3600 }),
});
await owner.must('POST', `/triggers/${cooled.id}/publish`, { revision: 1, enabled: true });
const cdRuns = async (v) => (await owner.must('GET', `/triggers/${cooled.id}/runs?limit=100`)).filter((r) => r.visitor_session_id === v.session.session_id).sort((a, b) => a.executed_at.localeCompare(b.executed_at));
const v5 = await newVisitor(site, 'v5', '/start');
await enter(v5, cdPath);
await waitFor(async () => (await cdRuns(v5)).length === 1, 10000, 'first cooldown run');
await enter(v5, '/elsewhere');
await enter(v5, `${cdPath}?again=1`);
const v5Runs = await waitFor(async () => {
  const r = await cdRuns(v5);
  return r.length === 2 ? r : null;
}, 10000, 'second cooldown run');
ok(v5Runs[0].matched === true && v5Runs[0].result.reason === 'fired' && v5Runs[0].effects.map((e) => `${e.action_type}:${e.status}`).join(',') === 'set_visitor_field:applied', 'first matching page view fires the trigger');
ok(v5Runs[1].matched === false && v5Runs[1].result.reason === 'cooldown' && v5Runs[1].effects.length === 0, 'the next matching page view in the same session is recorded as cooldown, with no effects');
await sleep(1500);
ok((await cdRuns(v5)).length === 2, 'the page view in between (/elsewhere) is evaluated on its own page, even when processed after the next one: no run');
const v6 = await newVisitor(site, 'v6', '/start');
await enter(v6, cdPath);
const v6Runs = await waitFor(async () => {
  const r = await cdRuns(v6);
  return r.length === 1 ? r : null;
}, 10000, 'other session run');
ok(v6Runs[0].matched === true && v6Runs[0].result.reason === 'fired', 'a different visitor session is not affected by that cooldown (scoped to trigger + session)');

await events.close();
await redis.quit();
for (const s of [ownerSock, v1.sock, v2.sock, v3.sock, v4.sock, v5.sock, v6.sock]) s.close();
console.log(`\nTRIGGERS E2E PASSED (${passed} checks)`);
process.exit(0);
