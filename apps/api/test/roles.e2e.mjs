// Role matrix (ROLE01, AUD-71-03, ch. 41/44) — end-to-end against a running api + worker (node test/roles.e2e.mjs).
// Every route guarded by @Require / @AuditedRequire is read from the controllers, and every role (owner, admin,
// supervisor, agent, analyst) calls it with its real session. The expected outcome comes from the member's own
// permission list (GET /agents/me), not from a copy of the role table:
//   * a role missing any required permission gets 403 PERMISSION_DENIED — for every method, before validation or
//     lookup, so the request has no effect;
//   * a role holding them is not refused on read routes (GET). Write routes are only exercised for denial, so the
//     matrix never changes data.
// Needs DATABASE_OWNER_URL (verification and invitation tokens are read from outbound_emails).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-c', q]).toString().trim();
const stamp = Date.now().toString(36);
const PASSWORD = 'role matrix passphrase';
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond)
    throw new Error(
      `ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
    );
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
const latestEmail = (to, template) =>
  sql(
    `SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
const tokenFrom = (text, param) =>
  decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

class Client {
  constructor(name, ip) {
    this.name = name;
    this.ip = ip;
    this.cookies = {};
  }
  async call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}/api/v1${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': this.ip,
          ...(Object.keys(this.cookies).length
            ? {
                cookie: Object.entries(this.cookies)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('; '),
              }
            : {}),
          ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
      }
      const text = await res.text();
      // Rate limits are per member; back off rather than count a 429 as an authorization outcome.
      if (res.status === 429 && attempt < 6) {
        await sleep(Math.min(10_000, 1000 * Number(res.headers.get('retry-after') ?? 1)));
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON bodies (downloads) */
      }
      return { status: res.status, code: json?.error?.code ?? null, data: json?.data };
    }
  }
  async must(method, path, body) {
    const r = await this.call(method, path, body);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${r.code}`);
    return r.data;
  }
}

// ───────────────────────── routes and their required permissions, read from the controllers ─────────────────────────
function controllerFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (n.startsWith('._')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...controllerFiles(p));
    else if (n.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}
const ROUTES = [];
for (const f of controllerFiles(join(here, '../src'))) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let prefix = '';
  let pending = null;
  for (const line of lines) {
    const c = /@Controller\('([^']*)'\)/.exec(line);
    if (c) prefix = c[1];
    const r =
      /^\s*@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/.exec(line) ??
      /^\s*@(Get|Post|Put|Patch|Delete)\(\)/.exec(line);
    if (r)
      pending = {
        method: r[1].toUpperCase(),
        path: `/${prefix}/${r[2] ?? ''}`.replace(/\/+/g, '/').replace(/\/$/, ''),
        perms: null,
        public: false,
      };
    if (!pending) continue;
    if (/@Public\(\)/.test(line)) pending.public = true;
    const req = /@Require\(([^)]*)\)/.exec(line);
    const aud = /@AuditedRequire\('[^']*'(?:,\s*([^)]*))?\)/.exec(line);
    const list = req?.[1] ?? aud?.[1];
    if (list !== undefined) pending.perms = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // The method signature ends the decorator block.
    if (/^\s*(async\s+)?[a-zA-Z_]\w*\(/.test(line) && !/^\s*@/.test(line)) {
      if (pending.perms && !pending.public && !pending.path.startsWith('/widget')) ROUTES.push(pending);
      pending = null;
    }
  }
}
const concrete = (path) =>
  path
    .split('/')
    .map((seg) =>
      !seg.startsWith(':')
        ? seg
        : seg === ':date'
          ? '2031-01-02'
          : /revision|seq/i.test(seg)
            ? '1'
            : /id$/i.test(seg)
              ? randomUUID()
              : 'x',
    )
    .join('/');

// ───────────────────────── setup: one workspace, one member per role ─────────────────────────
console.log('Setup — a workspace with an owner, admin, supervisor, agent and analyst');
const owner = new Client('owner', '10.40.0.1');
const ownerEmail = `roles-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', {
  email: ownerEmail,
  password: PASSWORD,
  tenant_name: `Roles ${stamp}`,
  timezone: 'UTC',
});
await owner.must('POST', '/auth/verify-email', {
  token: tokenFrom(
    await waitFor(() => latestEmail(ownerEmail, 'verify_email'), 5000, 'verification email'),
    'token',
  ),
});
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const members = { owner };
let n = 2;
for (const role of ['admin', 'supervisor', 'agent', 'analyst']) {
  const email = `roles-${role}+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', {
    email,
    role,
    department_ids: ['supervisor', 'agent'].includes(role) ? [support.id] : [],
    capacity: 3,
  });
  const c = new Client(role, `10.40.0.${n++}`);
  await c.must('POST', '/agents/invitations/accept', {
    token: tokenFrom(
      await waitFor(() => latestEmail(email, 'agent_invitation'), 5000, `${role} invitation`),
      'invite',
    ),
    display_name: `Role ${role}`,
    password: PASSWORD,
  });
  members[role] = c;
}
const perms = {};
for (const [role, c] of Object.entries(members)) {
  const me = await c.must('GET', '/agents/me');
  ok(me.agent.role === role, `${role} signed in with role ${role}`);
  perms[role] = new Set(me.permissions);
}
// One real chat (with an attachment) so handler-level checks run against an existing resource, not a 404.
// Admission needs an online agent with a live connection.
const ownerSock = io(`${API}/agent`, {
  path: '/realtime/v1',
  transports: ['websocket'],
  auth: { ticket: (await owner.must('POST', '/socket-ticket')).ticket },
  forceNew: true,
  reconnection: false,
});
await new Promise((resolve, reject) => {
  ownerSock.once('connect', resolve);
  ownerSock.once('connect_error', reject);
});
await owner.must('PUT', '/agents/me/presence', { status: 'online' });
const site = await owner.must('POST', '/sites', {
  name: `Roles site ${stamp}`,
  origins: [{ origin: 'https://roles.example', pattern_type: 'exact' }],
});
const sess = (
  await fetch(`${API}/widget/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.40.0.9' },
    body: JSON.stringify({
      site_key: site.public_key,
      host_origin: 'https://roles.example',
      consent: { analytics: false, policy_version: '2026-10' },
    }),
  }).then((r) => r.json())
).data;
const vCall = (method, path, body) =>
  fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sess.capability}`,
      'x-forwarded-for': '10.40.0.9',
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
const chatId = (
  await vCall('POST', '/widget/v1/chats', {
    client_request_id: randomUUID(),
    message: 'Hello from the role matrix',
  })
).data.chat.id;
ok(!!chatId, 'a visitor chat exists in the workspace');
const tag = await owner.must('POST', '/tags', { label: `Roles ${stamp}` });
ok(ROUTES.length >= 130, `${ROUTES.length} permission-guarded routes read from the controllers`);

// ───────────────────────── the matrix ─────────────────────────
console.log('Matrix — every guarded route × every role');
const wrongDenials = [];
const wrongAllows = [];
let denials = 0;
let allows = 0;
for (const route of ROUTES) {
  const path = concrete(route.path);
  for (const [role, c] of Object.entries(members)) {
    const missing = route.perms.filter((p) => !perms[role].has(p));
    if (missing.length) {
      const r = await c.call(
        route.method,
        path,
        route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      );
      if (r.status === 403 && r.code === 'PERMISSION_DENIED') denials++;
      else
        wrongAllows.push(
          `${role} ${route.method} ${route.path} (needs ${missing.join(', ')}) → ${r.status} ${r.code ?? ''}`,
        );
    } else if (route.method === 'GET') {
      const r = await c.call('GET', path);
      if (r.status === 403 && r.code === 'PERMISSION_DENIED')
        wrongDenials.push(`${role} GET ${route.path} → 403`);
      else allows++;
    }
  }
}
ok(
  wrongAllows.length === 0,
  `every role lacking a required permission is refused with 403 PERMISSION_DENIED (${denials} calls, all methods)`,
  wrongAllows.slice(0, 20).join('; '),
);
ok(
  wrongDenials.length === 0,
  `every role holding the permissions reaches the read routes (${allows} calls)`,
  wrongDenials.slice(0, 20).join('; '),
);

// Business rule: the websites and their chat widget (site keys, installation code, widget configuration) belong to
// the workspace owner and admins only. The matrix above follows whatever the permission model says; this pins the rule.
const widgetReads = [
  `/sites`,
  `/sites/${site.id}`,
  `/sites/${site.id}/widget-config`,
  `/sites/${site.id}/installation-status`,
];
const widgetAccess = {};
for (const [role, c] of Object.entries(members))
  widgetAccess[role] = (await Promise.all(widgetReads.map((p) => c.call('GET', p)))).map((r) => r.status);
ok(
  ['owner', 'admin'].every((r) => widgetAccess[r].every((s) => s === 200)) &&
    ['supervisor', 'agent', 'analyst'].every((r) => widgetAccess[r].every((s) => s === 403)),
  `websites and the chat widget (list, site, widget configuration, installation) are visible to owner and admin only (${JSON.stringify(widgetAccess)})`,
);

// Routes that authorize inside the handler (chat access, member edits, export ownership) — the decorator matrix
// cannot see them, so the important ones are asserted directly.
console.log('Handler-level authorization');
const ownerId = (await owner.must('GET', '/agents/me')).agent.id;
for (const [label, path] of [
  ['chat snapshot', `/chats/${randomUUID()}`],
  ['transcript page', `/chats/${randomUUID()}/messages`],
]) {
  const r = await members.analyst.call('GET', path);
  ok(
    r.status === 403 && r.code === 'PERMISSION_DENIED',
    `analyst (no chat or history access) is refused the ${label} before any lookup`,
    `${r.status} ${r.code}`,
  );
}
{
  const transcript = await members.analyst.call('GET', `/chats/${chatId}/messages`);
  ok(
    transcript.status === 403 && transcript.code === 'PERMISSION_DENIED',
    `analyst cannot read an existing chat's transcript (${transcript.status})`,
  );
  const tagging = await members.analyst.call('PUT', `/chats/${chatId}/tags`, { tag_ids: [tag.id] });
  ok(tagging.status === 403, `analyst cannot tag an existing chat (${tagging.status} ${tagging.code})`);
  ok(
    sql(`SELECT count(*) FROM chat_tags WHERE chat_id = '${chatId}'`) === '0',
    'the chat has no tags (psql)',
  );
  const ownerTagging = await owner.call('PUT', `/chats/${chatId}/tags`, { tag_ids: [tag.id] });
  ok(
    ownerTagging.status === 200,
    `the owner (tenant-wide, may serve chats) can tag it (${ownerTagging.status})`,
  );
  const ownerTranscript = await owner.call('GET', `/chats/${chatId}/messages`);
  ok(
    ownerTranscript.status === 200 && ownerTranscript.data.items.length >= 1,
    'the owner reads the transcript',
  );
}
for (const role of ['agent', 'supervisor', 'analyst']) {
  const r = await members[role].call('PATCH', `/agents/${ownerId}`, {
    display_name: 'Renamed by someone else',
  });
  ok(r.status === 403 || r.status === 404, `${role} cannot edit another member (${r.status} ${r.code})`);
}
ok(
  (await owner.must('GET', '/agents/me')).agent.display_name !== 'Renamed by someone else',
  "the owner's profile is unchanged",
);
const ownerExport = await owner.must('POST', '/analytics/exports', {
  report: 'chats',
  format: 'csv',
  filters: {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date().toISOString(),
    timezone: 'UTC',
    group_by: 'day',
  },
});
for (const role of ['agent', 'analyst']) {
  const r = await members[role].call('GET', `/analytics/exports/${ownerExport.id}`);
  ok(r.status === 404 || r.status === 403, `${role} cannot read the owner's export (${r.status})`);
}

// ROLE01 in its own words: an agent calling owner, admin, private-export and analyst routes.
const agentPerms = perms.agent;
const groups = {
  'owner-only': (r) => r.perms.includes('tenant.owner'),
  admin: (r) => r.perms.some((p) => /\.manage$/.test(p) && !['shortcuts.manage_personal'].includes(p)),
  analyst: (r) => r.perms.some((p) => p.startsWith('analytics.')),
};
for (const [label, match] of Object.entries(groups)) {
  const inGroup = ROUTES.filter((r) => match(r) && r.perms.some((p) => !agentPerms.has(p)));
  ok(
    inGroup.length > 0,
    `agent is refused on all ${inGroup.length} ${label} routes (covered by the matrix above)`,
  );
}
// Private (internal-note) exports are authorized in the export handler: the include_internal flag needs exports.internal.
for (const [role, c] of Object.entries(members)) {
  const allowed = perms[role].has('exports.create') && perms[role].has('exports.internal');
  const r = await c.call('POST', '/exports', { chat_ids: [chatId], format: 'json', include_internal: true });
  ok(
    allowed ? r.status === 202 : r.status === 403,
    `${role} ${allowed ? 'may' : 'cannot'} create a private export including internal notes (${r.status} ${r.code ?? ''})`,
  );
}
const auditRows = Number(
  sql(
    `SELECT count(*) FROM audit_events WHERE tenant_id = (SELECT tenant_id FROM memberships WHERE id = '${(await members.agent.must('GET', '/agents/me')).agent.id}') AND action = 'authorization.denied'`,
  ),
);
ok(
  auditRows > 0,
  `refusals on audited routes are recorded as security telemetry (${auditRows} authorization.denied events)`,
);

ownerSock.close();
console.log(`\nROLES E2E PASSED (${passed} checks)`);
process.exit(0);
