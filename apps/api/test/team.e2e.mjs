// Team administration and widget drafts — end-to-end against a running api + worker
// (node test/team.e2e.mjs). Real HTTP, sockets, PostgreSQL, Redis.
//   * roster presence carries active-chat counts after assignment changes (presence.updated)
//   * agent edits / department changes are guarded by expected_version
//   * role or department changes re-scope live sockets without signing anyone out
//   * suspending an agent returns their active chats to the queue and re-routes them
//   * widget drafts are guarded by etags; drafts can be discarded
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
    return { status: res.status, json, data: json?.data, error: json?.error };
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
  s.on('control', (f) => s.controls.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
const agentSocket = async (c, scopes) => {
  const s = await socket('/agent', (await c.must('POST', '/socket-ticket')).ticket);
  if (scopes) await s.emitWithAck('subscribe', { scopes });
  return s;
};
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
const ownerEmail = `team-owner+${stamp}@example.com`;
const signup = await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Team ${stamp}`, timezone: 'UTC' });
const tenantId = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const ownerMe = await owner.must('GET', '/agents/me');
const site = await owner.must('POST', '/sites', { name: 'Team store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const sales = await owner.must('POST', '/departments', { name: 'Sales', public_label: 'Sales' });
const agentEmail = `team-agent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 3 });
const agent = new Client('agent');
const joined = await agent.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'), display_name: 'Ana Agent', password: 'another strong passphrase' });
const agentId = (await agent.must('GET', '/agents/me')).agent.id;
ok(joined && agentId, 'tenant with Support/Sales, an owner and a Support agent');

const ownerSock = await agentSocket(owner, [{ kind: 'team', id: 'all' }, { kind: 'queue', id: support.id }]);
await owner.must('PUT', '/agents/me/presence', { status: 'away' });
let agentSock = await agentSocket(agent);
await agent.must('PUT', '/agents/me/presence', { status: 'online' });

console.log('Roster presence follows assignment (presence.updated with active_count)');
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
const vauth = { authorization: `Bearer ${sess.capability}` };
const vsock = await socket('/visitor', (await visitor.must('POST', '/widget/v1/socket-ticket', undefined, vauth)).ticket);
const chatId = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, I need help with my order', department_id: support.id }, vauth)).chat.id;
await vsock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] }).catch(() => undefined);
await waitFor(async () => (await agent.call('POST', `/chats/${chatId}/accept`, {})).status === 200, 8000, 'agent accept');
ok(sql(`SELECT owner_membership_id || '|' || status FROM chats WHERE id = '${chatId}'`) === `${agentId}|active`, 'agent accepted the chat (owner, active)');
const loadFrame = await waitFor(
  () => ownerSock.ephemeral.find((f) => f.type === 'presence.updated' && f.payload.membership_id === agentId && f.payload.active_count === 1),
  10000,
  'presence.updated with active_count 1',
);
ok(loadFrame.payload.capacity === 3, 'team scope receives presence.updated for the agent with active_count 1 after accept');

console.log('Agent edits guarded by expected_version');
const roster = await owner.must('GET', '/agents');
const v0 = roster.find((a) => a.id === agentId).version;
ok(Number.isInteger(v0), `agent resource exposes version (${v0})`);
const edited = await owner.must('PATCH', `/agents/${agentId}`, { capacity: 4, expected_version: v0 });
ok(edited.capacity === 4 && edited.version === v0 + 1, 'PATCH with the current expected_version applies and bumps the version');
const stale = await owner.call('PATCH', `/agents/${agentId}`, { capacity: 5, expected_version: v0 });
ok(stale.status === 409 && stale.error.code === 'VERSION_CONFLICT' && stale.error.details.current_version === v0 + 1, 'stale expected_version → 409 VERSION_CONFLICT with current_version');
const staleDepts = await owner.call('PUT', `/agents/${agentId}/departments`, { departments: [{ department_id: support.id }], expected_version: v0 });
ok(staleDepts.status === 409 && staleDepts.error.code === 'VERSION_CONFLICT', 'stale expected_version on PUT departments → 409');

console.log('Department and role changes re-scope sockets without signing out');
const depts = await owner.must('PUT', `/agents/${agentId}/departments`, { departments: [{ department_id: support.id }, { department_id: sales.id }], expected_version: v0 + 1 });
ok(depts.department_ids.length === 2 && depts.version === v0 + 2, 'departments replaced with the current expected_version (version bumped)');
const rescope = await waitFor(() => agentSock.controls.find((c) => c.type === 'access.revoked'), 5000, 'agent control frame');
ok(rescope.payload.reason === 'scope_changed' && rescope.payload.relogin_required === false, 'agent socket gets access.revoked {reason: scope_changed, relogin_required: false}');
await waitFor(() => agentSock.disconnected, 3000, 'agent socket disconnect');
ok((await agent.call('GET', '/agents/me')).status === 200, 'agent session still valid after the department change');
agentSock = await agentSocket(agent);
ok(agentSock.connected, 'agent reconnects with a fresh ticket');
await owner.must('PUT', `/agents/${ownerMe.agent.id}/departments`, { departments: [{ department_id: sales.id }] });
const selfRescope = await waitFor(() => ownerSock.controls.find((c) => c.type === 'access.revoked'), 5000, 'owner control frame');
ok(selfRescope.payload.relogin_required === false && (await owner.call('GET', '/agents/me')).status === 200, 'changing your own departments keeps your session (relogin_required false)');
const ownerSock2 = await agentSocket(owner, [{ kind: 'team', id: 'all' }, { kind: 'queue', id: support.id }]);
const roleChange = await owner.must('PATCH', `/agents/${agentId}`, { role: 'supervisor' });
ok(roleChange.role === 'supervisor', 'role changed to supervisor');
const roleFrame = await waitFor(() => agentSock.controls.find((c) => c.type === 'access.revoked'), 5000, 'role control frame');
ok(roleFrame.payload.reason === 'role_changed' && roleFrame.payload.relogin_required === false, 'role change re-scopes (relogin_required false)');
const me = await agent.must('GET', '/agents/me');
ok(me.permissions.includes('chats.force_transfer'), 'agent session now carries the supervisor permissions');
await owner.must('PATCH', `/agents/${agentId}`, { role: 'agent' });
await waitFor(() => agentSock.disconnected, 3000, 'agent disconnect after role change');
agentSock = await agentSocket(agent);
await agent.must('PUT', '/agents/me/presence', { status: 'online' });

console.log('Suspending an agent requeues their chats');
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const suspended = await owner.must('PATCH', `/agents/${agentId}`, { enabled: false });
ok(suspended.enabled === false, 'agent suspended');
const kick = await waitFor(() => agentSock.controls.find((c) => c.type === 'access.revoked' && c.payload.reason === 'membership_suspended'), 5000, 'suspension control frame');
ok(kick.payload.relogin_required === true, 'suspended agent socket revoked with relogin_required true');
const history = sql(`SELECT reason || ':' || coalesce(previous_owner_id::text, '') FROM assignment_history WHERE chat_id = '${chatId}' AND reason = 'agent_suspended'`);
ok(history === `agent_suspended:${agentId}`, 'assignment history records agent_suspended from the agent');
ok(sql(`SELECT count(*) FROM chat_participants WHERE chat_id = '${chatId}' AND membership_id = '${agentId}' AND left_at IS NULL`) === '0', 'suspended agent left the chat');
const state = sql(`SELECT status || '|' || coalesce(owner_membership_id::text, '-') FROM chats WHERE id = '${chatId}'`);
ok(state === 'queued|-' || state === 'offered|-', `chat is back in the queue (${state})`);
const notice = await waitFor(() => vsock.frames.find((f) => JSON.stringify(f).includes('connected to another agent')), 5000, 'visitor system message');
ok(!!notice, 'visitor sees "You\'re being connected to another agent"');
await waitFor(async () => (await owner.call('POST', `/chats/${chatId}/accept`, {})).status === 200, 8000, 'owner accept');
ok(sql(`SELECT owner_membership_id || '|' || status FROM chats WHERE id = '${chatId}'`) === `${ownerMe.agent.id}|active`, 'the requeued chat was re-routed to and accepted by an available agent');
ok((await agent.call('GET', '/agents/me')).status >= 400, 'suspended agent can no longer use the workspace');

console.log('Widget drafts are guarded by etags');
const cfg = await owner.must('GET', `/sites/${site.id}/widget-config`);
const base = cfg.published?.config ?? cfg.draft?.config;
ok(!!base, `site has a widget config (published revision ${cfg.published?.revision ?? 'none'})`);
const withTitle = (t) => ({ ...base, appearance: { ...base.appearance, title: t } });
const d1 = await owner.must('PUT', `/sites/${site.id}/widget-config`, { config: withTitle('Draft one'), base_etag: cfg.draft?.etag ?? null });
ok(typeof d1.etag === 'string' && d1.etag.length > 8, `draft saved with an etag (revision ${d1.revision})`);
const lost = await owner.call('PUT', `/sites/${site.id}/widget-config`, { config: withTitle('Teammate edit'), base_etag: null });
ok(lost.status === 409 && lost.error.code === 'VERSION_CONFLICT' && lost.error.details.current_etag === d1.etag, 'saving on top of an unseen draft → 409 with the current etag');
const d2 = await owner.must('PUT', `/sites/${site.id}/widget-config`, { config: withTitle('Draft two'), base_etag: d1.etag });
ok(d2.revision === d1.revision && d2.etag !== d1.etag, 'saving with the current etag updates the same draft revision');
const stalePublish = await owner.call('POST', `/sites/${site.id}/widget-config/publish`, { revision: d2.revision, etag: d1.etag });
ok(stalePublish.status === 409 && stalePublish.error.code === 'VERSION_CONFLICT', 'publishing a draft that changed since it was loaded → 409');
const pub = await owner.must('POST', `/sites/${site.id}/widget-config/publish`, { revision: d2.revision, etag: d2.etag });
ok(pub.revision === d2.revision && pub.already_published === false, 'publishing with the current etag succeeds');
const d3 = await owner.must('PUT', `/sites/${site.id}/widget-config`, { config: withTitle('Draft three'), base_etag: null });
const wrongDiscard = await owner.call('DELETE', `/sites/${site.id}/widget-config/draft?etag=${d1.etag}`);
ok(wrongDiscard.status === 409, 'discarding with a stale etag → 409');
const discarded = await owner.must('DELETE', `/sites/${site.id}/widget-config/draft?etag=${d3.etag}`);
ok(discarded.discarded === true && discarded.revision === d3.revision, 'draft discarded');
const after = await owner.must('GET', `/sites/${site.id}/widget-config`);
ok(after.draft === null && after.published.revision === pub.revision && after.published.config.appearance.title === 'Draft two', 'editor falls back to the published config');
const again = await owner.must('DELETE', `/sites/${site.id}/widget-config/draft`);
ok(again.discarded === false, 'discarding when no draft exists is a no-op');
ok(sql(`SELECT count(*) FROM audit_events WHERE tenant_id = '${tenantId}' AND action = 'widget.draft_discarded'`) === '1', 'discard is audited');

for (const s of [ownerSock, ownerSock2, agentSock, vsock]) s.disconnect();
console.log(`\nteam.e2e: ${passed} assertions passed`);
process.exit(0);
