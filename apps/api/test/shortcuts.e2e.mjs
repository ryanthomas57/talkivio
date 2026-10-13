// Canned replies end-to-end (ch. 18/44/77; SHORT01): scopes, personal privacy,
// versioning, safe placeholder rendering, CSV preview → atomic commit, export.
// Run against an isolated api + worker:  node test/shortcuts.e2e.mjs
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4103';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
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
      json = null;
    }
    return { status: res.status, json, data: json?.data, error: json?.error, text, headers: res.headers };
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
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}

const stamp = Date.now();
console.log('Setup');
const owner = new Client('owner');
const ownerEmail = `shortowner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery staple', tenant_name: `Shortcuts ${stamp}`, timezone: 'UTC' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const billing = await owner.must('POST', '/departments', { name: 'Billing' });
async function invite(role, deptIds, label) {
  const email = `${label}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', { email, role, department_ids: deptIds, capacity: 2 });
  const c = new Client(label);
  await c.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(email, 'agent_invitation'), 'invite'), display_name: `${label} person`, password: 'another strong passphrase' });
  return c;
}
const agent = await invite('agent', [support.id], 'shortagent');
const supervisor = await invite('supervisor', [billing.id], 'shortsuper');
const site = await owner.must('POST', '/sites', { name: 'Acme Store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const visitor = new Client('visitor');
const sess = await visitor.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: true, policy_version: '2026-10' } });
visitor.auth = sess.capability;
const chat = (await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, I need a refund' })).chat;
ok(!!chat.id, 'tenant, departments, agents, site and a visitor chat ready');

console.log('Scopes and personal privacy');
const refundBody = 'Hi {{visitor.name|there}}, I am {{agent.display_name}} from {{department.name}} at {{site.name}}. Refunds take 5 days.';
const refund = await owner.must('POST', '/shortcuts', { slug: 'refund', title: 'Refund policy', body: refundBody, scope_type: 'tenant', tags: ['billing'], options: ['Thanks!'] });
ok(refund.scope_type === 'tenant' && refund.version === 1 && refund.placeholders.length === 4 && refund.editable, 'shared reply created with allowlisted placeholders');
ok((await owner.call('POST', '/shortcuts', { slug: 'refund', title: 'Again', body: 'x', scope_type: 'tenant' })).status === 409, 'UNIQUE(tenant, scope, slug) → 409');
const badPh = await owner.call('POST', '/shortcuts', { slug: 'bad', title: 'Bad', body: 'Hi {{visitor.email}} {{constructor}}', scope_type: 'tenant' });
ok(badPh.status === 422 && badPh.error.field_errors.body.length === 2, 'non-allowlisted placeholders rejected (422)', badPh.error);
ok((await agent.call('POST', '/shortcuts', { slug: 'shared', title: 'x', body: 'x', scope_type: 'tenant' })).status === 403, 'agents cannot create shared replies');
const mine = await agent.must('POST', '/shortcuts', { slug: 'mine', title: 'My sign-off', body: 'Cheers, {{agent.display_name}}', scope_type: 'personal' });
ok(mine.scope_type === 'personal' && mine.editable, 'agent created a personal reply');
ok((await owner.call('GET', `/shortcuts/${mine.id}`)).status === 404, 'personal reply is 404 to another user even by id (owner)');
ok((await owner.call('PATCH', `/shortcuts/${mine.id}`, { title: 'x' }, { 'if-match': '1' })).status === 404, 'personal reply cannot be edited by another user (404)');
ok((await owner.call('POST', `/shortcuts/${mine.id}/render`, { chat_id: chat.id })).status === 404, 'personal reply cannot be rendered by another user (404)');
ok(!(await owner.must('GET', '/shortcuts?limit=100')).some((r) => r.id === mine.id), 'personal reply absent from other users’ lists');
const agentList = await agent.must('GET', '/shortcuts?q=/ref');
ok(agentList.length === 1 && agentList[0].slug === 'refund' && agentList[0].editable === false, 'slash search /ref finds the shared reply (read-only for agents)');
ok((await agent.must('GET', '/shortcuts?scope=personal')).map((r) => r.slug).join() === 'mine', 'owner of a personal reply sees it');
const billingReply = await supervisor.must('POST', '/shortcuts', { slug: 'invoice', title: 'Invoice copy', body: 'Your invoice is attached.', scope_type: 'department', scope_id: billing.id });
ok(billingReply.scope_id === billing.id, 'supervisor manages replies of their own department');
ok((await supervisor.call('POST', '/shortcuts', { slug: 'support-only', title: 'x', body: 'x', scope_type: 'department', scope_id: support.id })).status === 403, 'supervisor cannot manage another department');
ok((await agent.call('GET', `/shortcuts/${billingReply.id}`)).status === 404, 'department reply hidden outside the department');
ok((await owner.must('GET', '/shortcuts?scope=department')).some((r) => r.id === billingReply.id), 'tenant-wide admin sees department replies');

console.log('Versioning');
ok((await owner.call('PATCH', `/shortcuts/${refund.id}`, { title: 'Refunds' })).status === 428, 'PATCH without If-Match → 428');
const staleEdit = await owner.call('PATCH', `/shortcuts/${refund.id}`, { title: 'Refunds' }, { 'if-match': '"7"' });
ok(staleEdit.status === 409 && staleEdit.error.code === 'VERSION_CONFLICT' && staleEdit.error.details.current_version === 1 && staleEdit.error.details.current.title === 'Refund policy', 'stale edit → 409 with current copy for reload/merge');
const edited = await owner.must('PATCH', `/shortcuts/${refund.id}`, { title: 'Refunds' }, { 'if-match': '"1"' });
ok(edited.version === 2 && edited.title === 'Refunds', 'versioned update');

console.log('Rendering (insert only, plain text)');
const rendered = await owner.must('POST', `/shortcuts/${refund.id}/render`, { chat_id: chat.id });
ok(rendered.text.startsWith('Hi there, I am') && rendered.text.includes('at Acme Store'), 'fallback for anonymous visitor name, site name resolved');
ok(JSON.stringify(rendered.unresolved) === '["department.name"]' && rendered.can_send === false && rendered.text.includes('{{department.name}}'), 'missing department name is reported unresolved and blocks send');
const html = await owner.must('POST', `/shortcuts/${refund.id}/render`, { sample: { 'visitor.name': '<img src=x onerror=alert(1)>{{agent.display_name}}', 'agent.display_name': 'Sam', 'department.name': 'Sales', 'site.name': 'Acme' } });
ok(html.text.startsWith('Hi <img src=x onerror=alert(1)>{{agent.display_name}}, I am Sam') && html.unresolved.length === 0, 'HTML in a value stays literal plain text and is not re-expanded');
const unsavedPreview = await owner.must('POST', '/shortcuts/render-preview', { body: 'Hello {{visitor.name|friend}}, this is {{agent.display_name}} from {{department.name}}', options: ['Yes', 'No'], sample: { 'agent.display_name': 'Sam', 'department.name': 'Billing' } });
ok(unsavedPreview.reply_id === null && unsavedPreview.text === 'Hello friend, this is Sam from Billing' && unsavedPreview.unresolved.length === 0 && unsavedPreview.options.length === 2, 'unsaved editor text previews with the same placeholder engine (nothing stored)');
ok((await owner.call('POST', '/shortcuts/render-preview', { body: '' })).status === 422, 'empty preview body rejected');
const msgs = await owner.must('GET', `/chats/${chat.id}/messages?limit=50`);
ok(!msgs.items.some((m) => m.body?.includes('Refunds take 5 days')), 'rendering never sends a message');

console.log('Archive and revive');
await owner.must('POST', `/shortcuts/${refund.id}/archive`, {});
ok(!(await owner.must('GET', '/shortcuts?q=refund')).length, 'archived reply removed from suggestions');
const revived = await owner.must('POST', '/shortcuts', { slug: 'refund', title: 'Refund policy v2', body: 'Refunds take 3 days.', scope_type: 'tenant' });
ok(revived.id === refund.id && revived.archived_at === null && revived.version === 4, 'creating the same slug revives the archived reply');

console.log('CSV import preview → atomic commit');
const countReplies = () => Number(sql(`SELECT count(*) FROM canned_replies WHERE tenant_id = (SELECT tenant_id FROM canned_replies WHERE id = '${refund.id}') AND archived_at IS NULL`));
const before = countReplies();
const csv = [
  'slug,title,body,scope_type,scope_id,tags,options,enabled',
  'welcome,Welcome,"Hi {{visitor.name|there}}, welcome!",tenant,,greeting|intro,Yes|No,true',
  'refund,Dup,"exists already",tenant,,,,true',
  'broken,Broken,"Hi {{visitor.phone}}",tenant,,,,true',
  'welcome,Again,"duplicate in file",tenant,,,,true',
  `formula,'=1+1,"Line one\r\nLine ""two"", with comma",tenant,,,,false`,
  `billing-hours,Hours,Billing is open 9-5,department,${billing.id},,,true`,
].join('\r\n');
const preview = await owner.must('POST', '/shortcuts/import-preview', { csv_text: csv });
ok(preview.summary.total === 6 && preview.summary.valid === 3 && preview.summary.rejected === 3 && preview.preview_token, 'preview shows valid and rejected rows with a token', preview.summary);
const reasons = Object.fromEntries(preview.rows.filter((r) => r.status === 'rejected').map((r) => [r.line, r.errors.join('; ')]));
ok(/already exists/.test(reasons[3]) && /Unknown placeholder/.test(reasons[4]) && /Duplicate/.test(reasons[5]), 'row diagnostics: existing slug, bad placeholder, duplicate in file', reasons);
ok(countReplies() === before, 'preview performs no writes');
ok((await agent.call('POST', '/shortcuts/import-preview', { csv_text: csv })).status === 403, 'import requires shared-reply permission');
const commit = await owner.call('POST', '/shortcuts/import-commit', { preview_token: preview.preview_token });
ok(commit.status === 201 && commit.data.committed === 3, 'commit imported the 3 valid rows atomically (201)');
ok(countReplies() === before + 3, 'replies created');
const formula = (await owner.must('GET', '/shortcuts?q=formula'))[0];
ok(formula.title === '=1+1' && formula.body === 'Line one\r\nLine "two", with comma' && formula.enabled === false, 'RFC 4180 quoting and neutralized formula prefix round-trip');
ok((await owner.call('POST', '/shortcuts/import-commit', { preview_token: preview.preview_token })).status === 409, 'a preview token is single-use');

const preview2 = await owner.must('POST', '/shortcuts/import-preview', { csv_text: 'slug,title,body\r\natomic-one,One,First\r\natomic-two,Two,Second\r\n' });
ok(preview2.summary.valid === 2, 'second preview ready');
await owner.must('POST', '/shortcuts', { slug: 'atomic-two', title: 'Raced', body: 'Created meanwhile', scope_type: 'tenant' });
const raced = await owner.call('POST', '/shortcuts/import-commit', { preview_token: preview2.preview_token });
ok(raced.status === 409 && raced.error.code === 'VERSION_CONFLICT', 'changed since preview → whole import rejected (409)', raced.error);
ok(!(await owner.must('GET', '/shortcuts?q=atomic-one')).length, 'no partial import (atomic)');

console.log('CSV export');
const exp = await owner.call('GET', '/shortcuts/export.csv');
ok(exp.status === 200 && /text\/csv/.test(exp.headers.get('content-type')), 'export served as text/csv');
ok(exp.text.startsWith('slug,title,body,scope_type,scope_id,tags,options,enabled\r\n'), 'header row with CRLF records');
ok(exp.text.includes("formula,'=1+1,") && exp.text.includes('"Line one\r\nLine ""two"", with comma"'), 'formula injection neutralized and RFC 4180 quoting applied');
ok(!exp.text.includes('My sign-off'), "export excludes other users' personal replies");

ownerSock.close();
console.log(`\nSHORTCUTS E2E PASSED (${passed} checks)`);
process.exit(0);
