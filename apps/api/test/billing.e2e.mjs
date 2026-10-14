// Subscriptions, free trial and automatic charging, end to end (node test/billing.e2e.mjs, repo .env sourced, against a
// running api + worker for email delivery). Starts its own API on :4041 with BILLING_PROVIDER=fake (the test gateway)
// and runs the billing sweep with dist/billing-sweep.js, moving dates in PostgreSQL instead of waiting for them.
//   BIL01 a new workspace is blocked (402, no widget) until a card starts the trial; billing off changes nothing
//   BIL02 the trial needs the exact automatic-renewal wording (hash), a card the gateway accepts; consent is evidence
//   BIL03 plan limits: Business features, the Starter website and history limits, paid agents for invitations
//   BIL04 the reminder 7 days before the trial ends, then the first charge with a receipt
//   BIL05 an upgrade is charged now (prorated), a downgrade waits for the renewal
//   BIL06 a declined renewal: past due with retries, then paused (402, no widget), then a new card pays and reopens
//   BIL07 cancel and resume; the subscription ends at the period end and can be restarted
//   BIL08 an unknown charge outcome is held for review and never retried automatically
//   BIL09 only the owner manages billing; charges and consents cannot be rewritten by the application
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = resolve(apiDir, process.env.BUILD_DIR ?? 'dist');
const MAIN_API = process.env.API_URL ?? 'http://localhost:4000';
const PORT = Number(process.env.BILLING_API_PORT ?? 4041);
const API = `http://localhost:${PORT}`;
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const APP_DB = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
const ORIGIN = 'http://localhost:5173';
const BILLING_ENV = { BILLING_PROVIDER: 'fake', BILLING_SWEEP_SECONDS: '3600' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q, db = OWNER_DB) =>
  execFileSync('psql', [db, '-At', '-F', '|', '-c', q], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
function clearRateLimits(...patterns) {
  for (const p of patterns) {
    const keys = execFileSync('redis-cli', ['--scan', '--pattern', p]).toString().split('\n').filter(Boolean);
    if (keys.length) execFileSync('redis-cli', ['del', ...keys]);
  }
}

class Client {
  constructor(name, base = API) {
    this.name = name;
    this.base = base;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${this.base}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
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
    return { status: res.status, json, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) =>
  sql(
    `SELECT coalesce(text_body, '') FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
const emailCount = (to, template) =>
  Number(sql(`SELECT count(*) FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}'`));
const tokenFrom = (text, param) =>
  decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
const waitFor = async (pred, ms = 30_000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};
/** A test card as the browser's hosted form would hand it over: only the last four digits reach the server. */
const card = (last4) => `fake_${last4}_${Math.random().toString(36).slice(2, 12)}`;

// ═══════════════════════════ A billing API beside the main stack ═══════════════════════════
const children = [];
const apiLog = [];
const p = spawn(process.execPath, ['--enable-source-maps', resolve(BUILD_DIR, 'main.js')], {
  env: { ...process.env, ...BILLING_ENV, PORT: String(PORT), API_URL: API },
  stdio: ['ignore', 'pipe', 'pipe'],
});
p.stdout.on('data', (d) => apiLog.push(String(d)));
p.stderr.on('data', (d) => apiLog.push(String(d)));
children.push(p);
process.on('exit', () => children.forEach((c) => c.kill('SIGTERM')));
await waitFor(
  async () => (await fetch(`${API}/health/ready`).catch(() => null))?.ok,
  40_000,
  'billing API ready',
);
const sweep = () =>
  execFileSync(process.execPath, [resolve(BUILD_DIR, 'billing-sweep.js')], {
    env: { ...process.env, ...BILLING_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

const stamp = Date.now();
clearRateLimits('rl:signup:*', 'rl:widget-session:*', 'rl:login:*');
const ownerEmail = `billing-owner-${stamp}@example.test`;
const owner = new Client('owner');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL01 — blocked until a card starts the trial');
const signup = await owner.must('POST', '/auth/signup', {
  email: ownerEmail,
  password: 'correct horse battery',
  tenant_name: `Billing ${stamp}`,
  timezone: 'UTC',
  plan: 'team',
  cycle: 'yearly',
});
const tenantId = signup.me.active_tenant_id;
await owner.must('POST', '/auth/verify-email', {
  token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token'),
});
ok(
  sql(`SELECT state || ':' || plan || ':' || cycle FROM billing_accounts WHERE tenant_id = '${tenantId}'`) ===
    'incomplete:team:yearly',
  'signup opens an incomplete Team yearly account (plan and cycle from the pricing page)',
);
const blocked = await owner.call('GET', '/chats?view=queue');
ok(
  blocked.status === 402 &&
    blocked.error?.code === 'PAYMENT_REQUIRED' &&
    blocked.error?.details?.billing_state === 'incomplete',
  'the workspace answers 402 PAYMENT_REQUIRED before a card is added',
);
ok(
  (await owner.must('GET', '/billing/status')).state === 'incomplete',
  'billing status and the workspace itself stay readable',
);
ok((await owner.call('GET', '/tenants/current')).status === 200, 'GET /tenants/current is exempt');
// Billing off (the main API): a new workspace has no account and nothing is gated.
const plain = new Client('plain', MAIN_API);
const plainSignup = await plain.must('POST', '/auth/signup', {
  email: `billing-off-${stamp}@example.test`,
  password: 'correct horse battery',
  tenant_name: `Plain ${stamp}`,
  timezone: 'UTC',
  plan: 'starter',
});
ok(
  sql(`SELECT count(*) FROM billing_accounts WHERE tenant_id = '${plainSignup.me.active_tenant_id}'`) === '0',
  'with BILLING_PROVIDER=none a new workspace has no billing account',
);
ok((await plain.must('GET', '/billing/status')).enabled === false, 'and billing status says billing is off');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL02 — the trial: exact wording, a real card, consent as evidence');
const q1 = await owner.must('GET', '/billing/quote?plan=team&cycle=yearly&seats=1');
ok(
  q1.kind === 'trial' && q1.due_now_cents === 0 && q1.period_cents === 28800,
  'the quote is a free trial; Team yearly is $288 per agent per year',
);
ok(
  /Your 14-day free trial of the Team plan starts today\. Unless you cancel before .+, your card will be charged \$288 on .+ for 1 agent, billed yearly, and then \$288 every year until you cancel\./.test(
    q1.disclosure,
  ),
  'the disclosure states the trial, the amount, the date, the cycle and how renewal works',
);
ok(
  /non-refundable/.test(q1.disclosure) && /cancel at any time in Settings, Billing/.test(q1.disclosure),
  'and that payments are non-refundable and cancellation is online',
);
const session = await owner.must('POST', '/billing/card-session');
ok(
  session.provider === 'fake' && /^fake_session_/.test(session.token),
  'a hosted card form session is issued',
);
const sub = { plan: 'team', cycle: 'yearly', seats: 1, accepted_terms: true };
let r = await owner.call('POST', '/billing/subscribe', {
  ...sub,
  card_token: card('4242'),
  disclosure_hash: '0'.repeat(32),
});
ok(r.status === 409, 'agreeing to different wording than the quote (stale hash) is refused');
r = await owner.call('POST', '/billing/subscribe', {
  ...sub,
  card_token: card('4242'),
  disclosure_hash: q1.disclosure_hash,
  accepted_terms: false,
});
ok(r.status === 422, 'the terms must be accepted explicitly');
r = await owner.call('POST', '/billing/subscribe', {
  ...sub,
  card_token: card('0002'),
  disclosure_hash: q1.disclosure_hash,
});
ok(
  r.status === 402 && /declined/i.test(r.error?.message ?? ''),
  'a card the gateway refuses is not saved (402 with the reason)',
);
r = await owner.call('POST', '/billing/subscribe', {
  ...sub,
  card_token: 'not-a-token',
  disclosure_hash: q1.disclosure_hash,
});
ok(r.status === 402, 'a token the gateway does not know is refused');
const trial = await owner.must('POST', '/billing/subscribe', {
  ...sub,
  card_token: card('4242'),
  disclosure_hash: q1.disclosure_hash,
});
const trialEnd = new Date(trial.trial_ends_at).getTime();
ok(
  trial.state === 'trialing' && Math.abs(trialEnd - (Date.now() + 14 * 86_400_000)) < 120_000,
  'the trial runs for 14 days',
);
ok(
  trial.card?.last4 === '4242' && trial.card?.brand === 'Visa',
  'the card is shown by brand and last four digits only',
);
ok(
  !/4242/.test(sql(`SELECT card_token_ciphertext FROM billing_accounts WHERE tenant_id = '${tenantId}'`)),
  'the stored card token is encrypted at rest',
);
const consent = sql(
  `SELECT kind || '|' || terms_version || '|' || (ip_address IS NOT NULL) || '|' || (user_agent IS NOT NULL) || '|' || disclosure FROM billing_consents WHERE tenant_id = '${tenantId}' ORDER BY created_at DESC LIMIT 1`,
);
ok(
  consent.startsWith('trial|terms-2026-10-14|true|true|') && consent.endsWith(q1.disclosure),
  'the consent is kept word for word with the terms version, IP address and browser',
);
ok(
  (await owner.call('GET', '/chats?view=queue')).status === 200,
  'the workspace opens once the trial starts',
);
await waitFor(() => emailCount(ownerEmail, 'trial_started') === 1, 10_000, 'trial email');
const started = latestEmail(ownerEmail, 'trial_started');
ok(
  /will be charged \$288/.test(started) && /Visa ending 4242/.test(started) && /reminder/.test(started),
  'the trial confirmation email repeats the charge, the card and the reminder date',
);

// ───────────────────────────────────────────────────────────────────────
console.log('BIL03 — plan limits');
r = await owner.call('POST', '/webhooks', {
  url: 'https://example.com/hook',
  events: ['chat.closed'],
  name: 'Hook',
});
ok(
  r.status === 402 && r.error?.code === 'PLAN_LIMIT' && /Business plan/.test(r.error.message),
  'webhooks need the Business plan (402 PLAN_LIMIT naming the plan)',
);
const siteA = await owner.must('POST', '/sites', {
  name: 'Shop A',
  origins: [{ origin: ORIGIN, pattern_type: 'exact' }],
});
r = await owner.call('POST', '/agents/invitations', {
  email: `agent-${stamp}@example.test`,
  role: 'agent',
  department_ids: [],
  capacity: 2,
});
ok(
  r.status === 409 && r.error?.code === 'PLAN_LIMIT' && /1 agent/.test(r.error.message),
  'one paid agent (the owner) leaves no room for an invitation',
);
// Change to Starter, 2 agents, during the trial: applies at once, nothing charged.
const qs = await owner.must('GET', '/billing/quote?plan=starter&cycle=monthly&seats=2');
ok(qs.kind === 'trial' && qs.due_now_cents === 0, 'changes during the trial are free and keep the trial end');
const starter = await owner.must('PATCH', '/billing/subscription', {
  plan: 'starter',
  cycle: 'monthly',
  seats: 2,
  accepted_terms: true,
  disclosure_hash: qs.disclosure_hash,
});
ok(
  starter.plan === 'starter' &&
    starter.seats === 2 &&
    starter.state === 'trialing' &&
    starter.trial_ends_at === trial.trial_ends_at,
  'the plan changes now; the trial end does not move',
);
r = await owner.call('POST', '/sites', {
  name: 'Shop B',
  origins: [{ origin: 'http://localhost:5174', pattern_type: 'exact' }],
});
ok(r.status === 402 && /1 website/.test(r.error?.message ?? ''), 'Starter includes one website');
const range = `from=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
r = await owner.call('GET', `/analytics/agents?${range}`);
ok(r.status === 402 && /Team plan/.test(r.error?.message ?? ''), 'agent analytics need the Team plan');
ok(
  (await owner.call('GET', `/analytics/chats?${range}`)).status === 200,
  'the chats report (Overview) works on every plan',
);
r = await owner.call('POST', '/triggers', {
  name: 'Greet',
  event: 'page_view',
  conditions: { all: [] },
  actions: [],
});
ok(r.status === 402, 'triggers need the Team plan');
const inv = await owner.must('POST', '/agents/invitations', {
  email: `agent-${stamp}@example.test`,
  role: 'agent',
  department_ids: [],
  capacity: 2,
});
ok(!!inv.id, 'with 2 paid agents the invitation goes out');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL04 — reminder, then the first charge');
sql(`UPDATE billing_accounts SET trial_ends_at = now() + interval '6 days' WHERE tenant_id = '${tenantId}'`);
sweep();
await waitFor(() => emailCount(ownerEmail, 'trial_reminder') === 1, 10_000, 'reminder email');
ok(
  /Cancel before .+ in Settings, Billing and you will not be charged/.test(
    latestEmail(ownerEmail, 'trial_reminder'),
  ),
  'the reminder goes out 7 days ahead with how to cancel',
);
sweep();
ok(emailCount(ownerEmail, 'trial_reminder') === 1, 'and only once');
sql(
  `UPDATE billing_accounts SET trial_ends_at = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
sweep();
let acct = await owner.must('GET', '/billing');
ok(
  acct.state === 'active' && acct.current_period_start && acct.current_period_end,
  'when the trial ends the card is charged and the subscription is active',
);
const first = sql(
  `SELECT kind || '|' || amount_cents || '|' || status || '|' || seats FROM billing_charges WHERE tenant_id = '${tenantId}' ORDER BY created_at DESC LIMIT 1`,
);
ok(first === 'first|3000|approved|2', 'the first charge is 2 agents × $15 for the month');
await waitFor(() => emailCount(ownerEmail, 'payment_receipt') === 1, 10_000, 'receipt');
ok(
  /We charged \$30 to your Visa ending 4242/.test(latestEmail(ownerEmail, 'payment_receipt')),
  'a receipt is emailed',
);
sweep();
ok(
  sql(`SELECT count(*) FROM billing_charges WHERE tenant_id = '${tenantId}' AND status = 'approved'`) === '1',
  'a second sweep charges nothing more',
);

// ───────────────────────────────────────────────────────────────────────
console.log('BIL05 — upgrade now (prorated), downgrade at renewal');
const qu = await owner.must('GET', '/billing/quote?plan=business&cycle=monthly&seats=2');
ok(
  qu.kind === 'upgrade' && qu.due_now_cents > 0 && qu.due_now_cents <= 6800,
  'an upgrade costs the prorated difference for the rest of the period',
);
const business = await owner.must('PATCH', '/billing/subscription', {
  plan: 'business',
  cycle: 'monthly',
  seats: 2,
  accepted_terms: true,
  disclosure_hash: qu.disclosure_hash,
});
ok(business.plan === 'business', 'and applies straight away');
ok(
  sql(
    `SELECT kind || '|' || status FROM billing_charges WHERE tenant_id = '${tenantId}' ORDER BY created_at DESC LIMIT 1`,
  ) === 'proration|approved',
  'the prorated amount is charged',
);
ok((await owner.call('GET', '/webhooks')).status === 200, 'Business features open after the upgrade');
const qd = await owner.must('GET', '/billing/quote?plan=team&cycle=monthly&seats=2');
ok(
  qd.kind === 'scheduled' && qd.due_now_cents === 0 && /No refund or credit/.test(qd.disclosure),
  'a downgrade waits for the renewal, with no refund for the current period',
);
acct = await owner.must('PATCH', '/billing/subscription', {
  plan: 'team',
  cycle: 'monthly',
  seats: 2,
  accepted_terms: true,
  disclosure_hash: qd.disclosure_hash,
});
ok(
  acct.plan === 'business' && acct.pending?.plan === 'team' && acct.next_charge_cents === 5800,
  'the plan stays Business until the renewal, which is charged at the Team price',
);
r = await owner.call('PATCH', '/billing/subscription', {
  plan: 'team',
  cycle: 'monthly',
  seats: 0,
  accepted_terms: true,
  disclosure_hash: qd.disclosure_hash,
});
ok(r.status === 422, 'fewer than one agent is refused');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL06 — declined renewal: past due, paused, recovered');
await owner.must('PUT', '/billing/card', { card_token: card('0341') });
sql(
  `UPDATE billing_accounts SET current_period_end = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
sweep();
acct = await owner.must('GET', '/billing');
ok(
  acct.state === 'past_due' && acct.last_error && acct.grace_ends_at && acct.next_charge_at,
  'a declined renewal is past due, retried later, with a grace period',
);
ok(
  acct.plan === 'team' || acct.pending?.plan === 'team',
  'the downgrade is part of the renewal being collected',
);
ok(
  (await owner.call('GET', '/chats?view=queue')).status === 200,
  'the workspace keeps working during the grace period',
);
await waitFor(() => emailCount(ownerEmail, 'payment_failed') === 1, 10_000, 'payment failed email');
sql(
  `UPDATE billing_accounts SET next_attempt_at = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
sweep();
ok(
  sql(`SELECT failed_attempts FROM billing_accounts WHERE tenant_id = '${tenantId}'`) === '2',
  'the charge is retried on schedule',
);
ok(emailCount(ownerEmail, 'payment_failed') === 1, 'without another email for every retry');
sql(
  `UPDATE billing_accounts SET grace_ends_at = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
sweep();
ok(
  (await owner.must('GET', '/billing/status')).state === 'suspended',
  'when the grace period ends unpaid the workspace is paused',
);
r = await owner.call('GET', '/chats?view=queue');
ok(r.status === 402 && r.error?.details?.billing_state === 'suspended', 'a paused workspace answers 402');
const siteKey = siteA.public_key;
r = await fetch(`${API}/widget/v1/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ site_key: siteKey, host_origin: ORIGIN }),
});
ok(r.status === 404, 'and its chat widget does not load');
await waitFor(() => emailCount(ownerEmail, 'billing_suspended') === 1, 10_000, 'suspended email');
r = await owner.call('PUT', '/billing/card', { card_token: card('0341') });
ok(r.status === 402, 'a new card that also declines leaves it paused');
acct = await owner.must('PUT', '/billing/card', { card_token: card('4242') });
ok(
  acct.state === 'active' && acct.plan === 'team',
  'a working card pays at once and reopens the workspace on the renewed (Team) plan',
);
ok(
  Math.abs(new Date(acct.current_period_start).getTime() - Date.now()) < 120_000,
  'the paused days are not charged: the new period starts now',
);
ok((await owner.call('GET', '/chats?view=queue')).status === 200, 'the workspace answers again');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL07 — cancel, resume, end, restart');
acct = await owner.must('POST', '/billing/cancel');
ok(
  acct.cancel_at_period_end === true && acct.next_charge_at === null,
  'cancelling stops future charges and keeps access until the period ends',
);
await waitFor(() => emailCount(ownerEmail, 'subscription_canceled') === 1, 10_000, 'cancel email');
acct = await owner.must('POST', '/billing/resume');
ok(acct.cancel_at_period_end === false && acct.next_charge_at, 'resume before the end undoes it');
await owner.must('POST', '/billing/cancel');
sql(
  `UPDATE billing_accounts SET current_period_end = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
const chargesBefore = sql(`SELECT count(*) FROM billing_charges WHERE tenant_id = '${tenantId}'`);
sweep();
ok(
  (await owner.must('GET', '/billing/status')).state === 'ended',
  'at the period end a cancelled subscription ends',
);
ok(
  sql(`SELECT count(*) FROM billing_charges WHERE tenant_id = '${tenantId}'`) === chargesBefore,
  'without a charge',
);
ok((await owner.call('GET', '/chats?view=queue')).status === 402, 'an ended workspace answers 402');
await waitFor(() => emailCount(ownerEmail, 'subscription_ended') === 1, 10_000, 'ended email');
const qr = await owner.must('GET', '/billing/quote?plan=team&cycle=monthly&seats=2');
ok(
  qr.kind === 'subscribe' && qr.due_now_cents === 5800 && /charged \$58 today/.test(qr.disclosure),
  'restarting charges the first period today (no second trial)',
);
acct = await owner.must('POST', '/billing/subscribe', {
  plan: 'team',
  cycle: 'monthly',
  seats: 2,
  card_token: card('4242'),
  accepted_terms: true,
  disclosure_hash: qr.disclosure_hash,
});
ok(acct.state === 'active', 'a restart with a working card reopens the workspace');

// ───────────────────────────────────────────────────────────────────────
console.log('BIL08 — unknown outcome is held for review');
await owner.must('PUT', '/billing/card', { card_token: card('0259') });
sql(
  `UPDATE billing_accounts SET current_period_end = now() - interval '1 minute' WHERE tenant_id = '${tenantId}'`,
);
sweep();
ok(
  sql(`SELECT needs_review || '|' || state FROM billing_accounts WHERE tenant_id = '${tenantId}'`) ===
    'true|active',
  'a charge with an unknown outcome flags the account and changes nothing else',
);
const n = sql(`SELECT count(*) FROM billing_charges WHERE tenant_id = '${tenantId}'`);
sweep();
ok(
  sql(`SELECT count(*) FROM billing_charges WHERE tenant_id = '${tenantId}'`) === n,
  'and it is not charged again until someone reviews it',
);
sql(
  `UPDATE billing_accounts SET needs_review = false, current_period_end = now() + interval '20 days' WHERE tenant_id = '${tenantId}'`,
);

// ───────────────────────────────────────────────────────────────────────
console.log('BIL09 — permissions and evidence');
const agentEmail = `agent-${stamp}@example.test`;
const agent = new Client('agent');
await agent.must('POST', '/agents/invitations/accept', {
  token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'),
  display_name: 'Ana Agent',
  password: 'another strong passphrase',
});
ok((await agent.call('GET', '/billing')).status === 403, 'an agent cannot see the subscription');
ok((await agent.call('POST', '/billing/cancel')).status === 403, 'or cancel it');
ok(
  (await agent.must('GET', '/billing/status')).state === 'active',
  'but can see whether the workspace is usable',
);
if (APP_DB) {
  let refused = false;
  try {
    sql(
      `SET app.tenant_id = '${tenantId}'; UPDATE billing_consents SET disclosure = 'x' WHERE tenant_id = '${tenantId}'`,
      APP_DB,
    );
  } catch (e) {
    refused = /permission denied/.test(String(e.stderr ?? e.message));
  }
  ok(refused, 'the application role cannot rewrite a consent record');
  refused = false;
  try {
    sql(
      `SET app.tenant_id = '${tenantId}'; DELETE FROM billing_charges WHERE tenant_id = '${tenantId}'`,
      APP_DB,
    );
  } catch (e) {
    refused = /permission denied/.test(String(e.stderr ?? e.message));
  }
  ok(refused, 'or delete a charge record');
}

console.log(`\nbilling.e2e: ${passed} assertions passed`);
process.exit(0);
