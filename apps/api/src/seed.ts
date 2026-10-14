/**
 * Talkivio local demo fixtures (master prompt ch. 62). LOCAL / CI ONLY.
 *
 *   pnpm --filter @talkivio/api build && pnpm db:seed        # node apps/api/dist/seed.js
 *   docker compose up                                       # `seed` one-shot service
 *
 * Guarantees
 *  - Refuses NODE_ENV=production (exit 1, nothing written).
 *  - Idempotent: deterministic UUIDs derived from fixture names + INSERT ... ON CONFLICT, so re-running
 *    converges instead of duplicating tenants, users, departments or chats. Admin edits to settings,
 *    extra origins and extra rows are left alone; fixture-defining fields (roles, capacities, site keys,
 *    schedule intervals, reply bodies, field definitions) are reset to the fixture values.
 *  - Tenant isolation is exercised, not bypassed: the seed connects with DATABASE_URL (the RLS-bound
 *    `talkivio_app` role, never the owner) and performs every tenant-owned write inside
 *    `TenantDb.tx(tenantId)`, which sets `app.tenant_id` transaction-locally exactly like the services
 *    (docs/adr/0002). Only the global `users` table is written outside a tenant context.
 *  - Credentials come only from the SEED_* variables documented in .env.example (environment first,
 *    then the file named by SEED_ENV_FILE, then the repository's .env.example). Nothing secret is
 *    hard-coded here. Demo logins are printed only when NODE_ENV is development/test.
 *
 * Fixtures
 *  Alpha (alpha-demo): owner, Sales + Support, agents with capacity 1 (Sales+Support) and 2 (Support),
 *    supervisor, analyst; site key SEED_ALPHA_SITE_KEY on http://localhost:5173 and :5174.
 *  Beta (beta-demo): owner, one agent, Support; site key SEED_BETA_SITE_KEY on http://127.0.0.1:5173/:5174;
 *    a closed private transcript containing the canary string (must never surface in Alpha).
 *  Both: online (24/7), offline (always closed) and DST test (America/New_York) schedules with exceptions,
 *    sample tags, canned replies with placeholders (tenant / department / personal scopes), permitted
 *    (public_writable) and denied (staff-only) custom field definitions, published widget config rev 1.
 *  Not seeded (contracts not final yet): triggers / proactive invitations ("pricing invitation",
 *    "queue apology trigger"), integrations, webhooks.
 *
 * Canned reply scope keys use the convention `tenant`, `department:<uuid>`, `personal:<membership uuid>`.
 */
import './config/load-env';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  DEFAULT_WIDGET_CONFIG,
  defaultSchedule,
  mergeOrgSettings,
  type WidgetConfig,
} from '@talkivio/contracts';
import { TenantDb, type Tx } from './db/tenant-db';
import { hashConfig } from './features/workspace/sites.service';

// Same parameters as AuthService.hashPassword so seeded hashes are indistinguishable from signup hashes.
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const BETA_CANARY = 'RD-CANARY-BETA-7Q4X-PRIVATE';

// ───────────────────────── configuration ─────────────────────────

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

let exampleCache: Record<string, string> | null = null;
function exampleEnv(): Record<string, string> {
  if (exampleCache) return exampleCache;
  const candidates = [
    process.env.SEED_ENV_FILE,
    resolve(__dirname, '../../../.env.example'),
    resolve(process.cwd(), '.env.example'),
    resolve(process.cwd(), '../../.env.example'),
  ];
  const file = candidates.find((p): p is string => !!p && existsSync(p));
  exampleCache = file ? parseEnvFile(file) : {};
  return exampleCache;
}

function setting(key: string, fallback?: string): string {
  const v = process.env[key] ?? exampleEnv()[key] ?? fallback;
  if (!v)
    throw new Error(`${key} is not set (define it in the environment or keep the default in .env.example)`);
  return v;
}

// ───────────────────────── deterministic ids ─────────────────────────

/** Name-based UUID (version-5 layout over SHA-256) so every fixture row has a stable primary key. */
function sid(name: string): string {
  const h = createHash('sha256').update(`talkivio-seed-v1:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ───────────────────────── fixture definitions ─────────────────────────

type Role = 'owner' | 'admin' | 'supervisor' | 'agent' | 'analyst';
interface UserFx {
  key: string;
  email: string;
  name: string;
}
interface MemberFx {
  user: string;
  role: Role;
  capacity: number;
  title: string;
  departments: Array<{ dept: string; serve: boolean; monitor: boolean }>;
}
interface TenantFx {
  key: 'alpha' | 'beta';
  slug: string;
  name: string;
  timezone: string;
  owner: string;
  siteName: string;
  siteKeyVar: string;
  origins: string[];
  primaryColor: string;
  departments: Array<{
    key: string;
    name: string;
    description: string;
    routingMode: 'broadcast' | 'assigned' | 'manual';
    schedule: string | null;
    fallback?: string;
    maxWaitSeconds: number;
  }>;
  members: MemberFx[];
  tags: Array<[slug: string, label: string]>;
}

const USERS: UserFx[] = [
  { key: 'alpha.owner', email: 'owner@alpha.test', name: 'Avery Owner' },
  { key: 'alpha.agent1', email: 'ana.sales@alpha.test', name: 'Ana Sales' },
  { key: 'alpha.agent2', email: 'ben.support@alpha.test', name: 'Ben Support' },
  { key: 'alpha.supervisor', email: 'sam.supervisor@alpha.test', name: 'Sam Supervisor' },
  { key: 'alpha.analyst', email: 'alex.analyst@alpha.test', name: 'Alex Analyst' },
  { key: 'beta.owner', email: 'owner@beta.test', name: 'Blake Owner' },
  { key: 'beta.agent', email: 'bo.agent@beta.test', name: 'Bo Agent' },
];

const TENANTS: TenantFx[] = [
  {
    key: 'alpha',
    slug: 'alpha-demo',
    name: 'Alpha Demo Co',
    timezone: 'America/New_York',
    owner: 'alpha.owner',
    siteName: 'Alpha storefront',
    siteKeyVar: 'SEED_ALPHA_SITE_KEY',
    origins: ['http://localhost:5173', 'http://localhost:5174'],
    primaryColor: '#07778A',
    departments: [
      {
        key: 'support',
        name: 'Support',
        description: 'General questions and help',
        routingMode: 'broadcast',
        schedule: null,
        maxWaitSeconds: 300,
      },
      {
        key: 'sales',
        name: 'Sales',
        description: 'Pricing, plans and demos',
        routingMode: 'assigned',
        schedule: 'online',
        fallback: 'support',
        maxWaitSeconds: 180,
      },
    ],
    members: [
      {
        user: 'alpha.owner',
        role: 'owner',
        capacity: 3,
        title: 'Owner',
        departments: [
          { dept: 'support', serve: true, monitor: true },
          { dept: 'sales', serve: true, monitor: true },
        ],
      },
      // Capacity 1 and a member of BOTH departments: global capacity must prevent double allocation (CHAT03).
      {
        user: 'alpha.agent1',
        role: 'agent',
        capacity: 1,
        title: 'Sales agent',
        departments: [
          { dept: 'sales', serve: true, monitor: false },
          { dept: 'support', serve: true, monitor: false },
        ],
      },
      {
        user: 'alpha.agent2',
        role: 'agent',
        capacity: 2,
        title: 'Support agent',
        departments: [{ dept: 'support', serve: true, monitor: false }],
      },
      {
        user: 'alpha.supervisor',
        role: 'supervisor',
        capacity: 3,
        title: 'Team lead',
        departments: [
          { dept: 'support', serve: true, monitor: true },
          { dept: 'sales', serve: true, monitor: true },
        ],
      },
      { user: 'alpha.analyst', role: 'analyst', capacity: 1, title: 'Analyst', departments: [] },
    ],
    tags: [
      ['billing', 'Billing'],
      ['refund', 'Refund'],
      ['vip', 'VIP'],
      ['bug', 'Bug report'],
      ['feedback', 'Feedback'],
    ],
  },
  {
    key: 'beta',
    slug: 'beta-demo',
    name: 'Beta Demo Ltd',
    timezone: 'Europe/London',
    owner: 'beta.owner',
    siteName: 'Beta help center',
    siteKeyVar: 'SEED_BETA_SITE_KEY',
    origins: ['http://127.0.0.1:5173', 'http://127.0.0.1:5174'],
    primaryColor: '#5B3FA8',
    departments: [
      {
        key: 'support',
        name: 'Support',
        description: 'Beta customer support',
        routingMode: 'broadcast',
        schedule: null,
        maxWaitSeconds: 300,
      },
    ],
    members: [
      {
        user: 'beta.owner',
        role: 'owner',
        capacity: 3,
        title: 'Owner',
        departments: [{ dept: 'support', serve: true, monitor: true }],
      },
      {
        user: 'beta.agent',
        role: 'agent',
        capacity: 2,
        title: 'Support agent',
        departments: [{ dept: 'support', serve: true, monitor: false }],
      },
    ],
    tags: [
      ['beta-internal', 'Beta internal'],
      ['billing', 'Billing'],
    ],
  },
];

type Intervals = Array<{ start: string; end: string }>;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const allWeek = (r: Intervals) =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, r])) as Record<(typeof WEEKDAYS)[number], Intervals>;

/** Schedules are expressed as `weekly_intervals` = Record<weekday, [{start,end}]> (shared/logic/hours.ts). */
function schedulesFor(t: TenantFx) {
  return [
    // Ranges whose end <= start continue past midnight, so 00:00-12:00 + 12:00-00:00 is a full day.
    {
      key: 'online',
      name: 'Always open (24/7)',
      timezone: t.timezone,
      days: allWeek([
        { start: '00:00', end: '12:00' },
        { start: '12:00', end: '00:00' },
      ]),
      exceptions: [] as Array<{ date: string; intervals: Intervals; reason: string }>,
    },
    {
      key: 'offline',
      name: 'Always closed (offline demo)',
      timezone: t.timezone,
      days: allWeek([]),
      exceptions: [],
    },
    {
      key: 'business',
      name: 'Business hours',
      timezone: t.timezone,
      days: defaultSchedule(t.timezone).days as Record<(typeof WEEKDAYS)[number], Intervals>,
      exceptions: [{ date: '2026-12-25', intervals: [], reason: 'Holiday closure' }],
    },
    {
      key: 'dst',
      name: 'DST test (America/New_York)',
      timezone: 'America/New_York',
      days: {
        sun: [{ start: '01:30', end: '03:30' }], // spans the 02:00 spring-forward gap and the 01:00-02:00 fall-back fold
        mon: [{ start: '09:00', end: '17:00' }],
        tue: [{ start: '09:00', end: '17:00' }],
        wed: [{ start: '09:00', end: '17:00' }],
        thu: [{ start: '09:00', end: '17:00' }],
        fri: [
          { start: '09:00', end: '17:00' },
          { start: '22:00', end: '02:00' },
        ], // overnight into Saturday
        sat: [],
      },
      exceptions: [
        {
          date: '2026-11-01',
          intervals: [{ start: '01:15', end: '01:45' }],
          reason: 'Fall back: ambiguous local times (fold)',
        },
        { date: '2026-12-24', intervals: [{ start: '09:00', end: '12:00' }], reason: 'Short day' },
        { date: '2026-12-25', intervals: [], reason: 'Holiday closure' },
        {
          date: '2027-03-14',
          intervals: [{ start: '02:30', end: '04:00' }],
          reason: 'Spring forward: 02:30 does not exist (gap)',
        },
      ],
    },
  ];
}

function repliesFor(t: TenantFx, deptIds: Record<string, string>, membershipIds: Record<string, string>) {
  const r: Array<{
    scopeType: 'tenant' | 'department' | 'personal';
    scopeId: string | null;
    slug: string;
    title: string;
    body: string;
    options?: string[];
    tags?: string[];
  }> = [
    {
      scopeType: 'tenant',
      scopeId: null,
      slug: 'hi',
      title: 'Greeting',
      body: 'Hi {{visitor.name}}! Thanks for contacting {{site.name}}. How can I help today?',
    },
    {
      scopeType: 'tenant',
      scopeId: null,
      slug: 'refund',
      title: 'Refund started',
      body: "I'm sorry about that, {{visitor.name}}. {{agent.display_name}} from {{department.name}} has started your refund; you'll get an email confirmation shortly.",
      tags: ['refund'],
    },
    {
      scopeType: 'tenant',
      scopeId: null,
      slug: 'anything',
      title: 'Anything else',
      body: 'Is there anything else I can help you with?',
      options: ['Yes, another question', "No, that's all"],
    },
    // Placeholder value containing markup must render as plain text; unresolved placeholders must block send.
    {
      scopeType: 'tenant',
      scopeId: null,
      slug: 'followup',
      title: 'Follow-up by email (may be unresolved)',
      body: 'We will follow up at {{visitor.email}} within one business day. <b>This markup is plain text.</b>',
    },
  ];
  if (t.key === 'alpha') {
    r.push(
      {
        scopeType: 'tenant',
        scopeId: null,
        slug: 'pricing',
        title: 'Pricing overview',
        body: 'Our plans are listed on the pricing page. {{agent.display_name}} can help you pick the right one, {{visitor.name}}.',
        tags: ['billing'],
      },
      {
        scopeType: 'department',
        scopeId: deptIds.sales,
        slug: 'demo',
        title: 'Book a demo (Sales only)',
        body: '{{department.name}} would love to show you around. What time zone are you in?',
      },
      {
        scopeType: 'personal',
        scopeId: membershipIds['alpha.agent1'],
        slug: 'sig',
        title: "Ana's sign-off (personal)",
        body: 'Thanks for chatting! {{agent.display_name}}, Sales',
      },
    );
  }
  return r;
}

const CUSTOM_FIELDS = [
  // permitted: the widget SDK may write these (public_writable)
  {
    key: 'plan',
    label: 'Plan',
    dataType: 'enum',
    publicWritable: true,
    visibleToVisitor: false,
    validation: { options: ['free', 'pro', 'enterprise'] },
  },
  {
    key: 'cart_value',
    label: 'Cart value',
    dataType: 'number',
    publicWritable: true,
    visibleToVisitor: false,
    validation: { min: 0, max: 1000000 },
  },
  {
    key: 'order_id',
    label: 'Order ID',
    dataType: 'string',
    publicWritable: true,
    visibleToVisitor: true,
    validation: { max_length: 40, pattern: '^[A-Za-z0-9-]+$' },
  },
  // denied: staff-only, a client write must be rejected
  {
    key: 'account_tier',
    label: 'Account tier',
    dataType: 'enum',
    publicWritable: false,
    visibleToVisitor: false,
    validation: { options: ['standard', 'gold', 'platinum'] },
  },
  {
    key: 'risk_score',
    label: 'Internal risk score',
    dataType: 'number',
    publicWritable: false,
    visibleToVisitor: false,
    validation: { min: 0, max: 100 },
  },
  {
    key: 'is_vip',
    label: 'VIP',
    dataType: 'boolean',
    publicWritable: false,
    visibleToVisitor: false,
    validation: {},
  },
];

// ───────────────────────── writers ─────────────────────────

async function upsertUser(db: TenantDb, u: UserFx, password: string): Promise<string> {
  const existing = await db.root.$queryRaw<Array<{ id: string; password_hash: string | null }>>`
    SELECT id::text, password_hash FROM users WHERE lower(email) = lower(${u.email})`;
  let passwordHash = existing[0]?.password_hash ?? null;
  const valid = passwordHash ? await argonVerify(passwordHash, password).catch(() => false) : false;
  if (!valid) passwordHash = await argonHash(password, ARGON_OPTS);
  const rows = await db.root.$queryRaw<Array<{ id: string }>>`
    INSERT INTO users (id, email, display_name, password_hash, email_verified_at, updated_at)
    VALUES (${sid(`user:${u.email}`)}::uuid, ${u.email}, ${u.name}, ${passwordHash}, now(), now())
    ON CONFLICT (email) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      password_hash = EXCLUDED.password_hash,
      email_verified_at = COALESCE(users.email_verified_at, EXCLUDED.email_verified_at),
      disabled_at = NULL,
      updated_at = now()
    RETURNING id::text`;
  return rows[0].id;
}

async function seedTenant(db: TenantDb, t: TenantFx, userIds: Record<string, string>) {
  const tenantId = sid(`tenant:${t.slug}`);
  const siteKey = setting(t.siteKeyVar);
  const schedules = schedulesFor(t);
  const scheduleIds = Object.fromEntries(schedules.map((s) => [s.key, sid(`${t.key}:schedule:${s.key}`)]));
  const deptIds = Object.fromEntries(t.departments.map((d) => [d.key, sid(`${t.key}:department:${d.key}`)]));
  const siteId = sid(`${t.key}:site:main`);

  const slugOwner = await db.root.$queryRaw<
    Array<{ taken: boolean }>
  >`SELECT rd_slug_taken(${t.slug}) AS taken`;

  return db.tx(tenantId, async (tx: Tx) => {
    const mine = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id::text FROM tenants WHERE id = ${tenantId}::uuid`;
    if (!mine.length && slugOwner[0]?.taken) {
      throw new Error(
        `Tenant slug "${t.slug}" belongs to a non-seed tenant; rename it or reset the local database before seeding.`,
      );
    }
    const created = !mine.length;

    // Tenant (settings only on first insert so admin changes survive a re-seed).
    const settings = {
      ...mergeOrgSettings({ locale: { timezone: t.timezone } }),
      availability: { defaultScheduleId: null, suggestedScheduleId: scheduleIds.business },
    };
    await tx.$executeRaw`
      INSERT INTO tenants (id, slug, name, timezone, owner_user_id, settings, onboarding_completed_at, updated_at)
      VALUES (${tenantId}::uuid, ${t.slug}, ${t.name}, ${t.timezone}, ${userIds[t.owner]}::uuid, ${JSON.stringify(settings)}::jsonb, now(), now())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, owner_user_id = EXCLUDED.owner_user_id,
        status = 'active', deleted_at = NULL, updated_at = now()`;

    // Memberships + capacity rows.
    const membershipIds: Record<string, string> = {};
    for (const m of t.members) {
      const u = USERS.find((x) => x.key === m.user)!;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memberships (id, tenant_id, user_id, role, capacity, display_name, title, updated_at)
        VALUES (${sid(`${t.key}:membership:${m.user}`)}::uuid, ${tenantId}::uuid, ${userIds[m.user]}::uuid, ${m.role}::"Role", ${m.capacity}, ${u.name}, ${m.title}, now())
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, capacity = EXCLUDED.capacity, enabled = true,
          archived_at = NULL, title = EXCLUDED.title, updated_at = now()
        RETURNING id::text`;
      membershipIds[m.user] = rows[0].id;
      await tx.$executeRaw`
        INSERT INTO agent_capacity (tenant_id, membership_id) VALUES (${tenantId}::uuid, ${rows[0].id}::uuid)
        ON CONFLICT (tenant_id, membership_id) DO NOTHING`;
    }

    // Schedules + dated exceptions.
    for (const s of schedules) {
      await tx.$executeRaw`
        INSERT INTO schedules (id, tenant_id, name, timezone, weekly_intervals, updated_at)
        VALUES (${scheduleIds[s.key]}::uuid, ${tenantId}::uuid, ${s.name}, ${s.timezone}, ${JSON.stringify(s.days)}::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, weekly_intervals = EXCLUDED.weekly_intervals,
          archived_at = NULL, updated_at = now()`;
      for (const e of s.exceptions) {
        await tx.$executeRaw`
          INSERT INTO schedule_exceptions (id, tenant_id, schedule_id, local_date, intervals, reason)
          VALUES (${sid(`${t.key}:schedule:${s.key}:${e.date}`)}::uuid, ${tenantId}::uuid, ${scheduleIds[s.key]}::uuid, ${e.date}::date, ${JSON.stringify(e.intervals)}::jsonb, ${e.reason})
          ON CONFLICT (tenant_id, schedule_id, local_date) DO UPDATE SET intervals = EXCLUDED.intervals, reason = EXCLUDED.reason`;
      }
    }

    // Departments (fallback targets first) + memberships.
    const ordered = [...t.departments].sort((a, b) => Number(!!a.fallback) - Number(!!b.fallback));
    for (const d of ordered) {
      await tx.$executeRaw`
        INSERT INTO departments (id, tenant_id, name, normalized_name, public_label, description, routing_mode, schedule_id, max_wait_seconds, fallback_department_id, updated_at)
        VALUES (${deptIds[d.key]}::uuid, ${tenantId}::uuid, ${d.name}, ${d.name.toLowerCase()}, ${d.name}, ${d.description}, ${d.routingMode}::"RoutingMode",
          ${d.schedule ? scheduleIds[d.schedule] : null}::uuid, ${d.maxWaitSeconds}, ${d.fallback ? deptIds[d.fallback] : null}::uuid, now())
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name, public_label = EXCLUDED.public_label,
          routing_mode = EXCLUDED.routing_mode, schedule_id = EXCLUDED.schedule_id, max_wait_seconds = EXCLUDED.max_wait_seconds,
          fallback_department_id = EXCLUDED.fallback_department_id, enabled = true, archived_at = NULL, updated_at = now()`;
    }
    for (const m of t.members) {
      for (const d of m.departments) {
        await tx.$executeRaw`
          INSERT INTO department_members (tenant_id, department_id, membership_id, can_serve, can_monitor)
          VALUES (${tenantId}::uuid, ${deptIds[d.dept]}::uuid, ${membershipIds[m.user]}::uuid, ${d.serve}, ${d.monitor})
          ON CONFLICT (tenant_id, department_id, membership_id) DO UPDATE SET can_serve = EXCLUDED.can_serve, can_monitor = EXCLUDED.can_monitor`;
      }
    }

    // Site, allowed origins and published widget configuration revision 1.
    const defaultDept = t.departments.find((d) => d.key === 'sales') ? deptIds.sales : deptIds.support;
    await tx.$executeRaw`
      INSERT INTO sites (id, tenant_id, name, public_key, default_department_id, timezone, installed_at, updated_at)
      VALUES (${siteId}::uuid, ${tenantId}::uuid, ${t.siteName}, ${siteKey}, ${defaultDept}::uuid, ${t.timezone}, now(), now())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public_key = EXCLUDED.public_key, default_department_id = EXCLUDED.default_department_id,
        enabled = true, archived_at = NULL, updated_at = now()`;
    for (const origin of t.origins) {
      await tx.$executeRaw`
        INSERT INTO site_origins (tenant_id, site_id, origin, pattern_type) VALUES (${tenantId}::uuid, ${siteId}::uuid, ${origin}, 'exact')
        ON CONFLICT (tenant_id, site_id, origin) DO NOTHING`;
    }
    const config: WidgetConfig = {
      ...DEFAULT_WIDGET_CONFIG,
      appearance: { ...DEFAULT_WIDGET_CONFIG.appearance, companyName: t.name, primaryColor: t.primaryColor },
    };
    await tx.$executeRaw`
      INSERT INTO widget_configs (id, tenant_id, site_id, revision, config, config_hash, published_at, created_by)
      VALUES (${sid(`${t.key}:widget-config:1`)}::uuid, ${tenantId}::uuid, ${siteId}::uuid, 1, ${JSON.stringify(config)}::jsonb, ${hashConfig(config)}, now(), ${membershipIds[t.owner]}::uuid)
      ON CONFLICT (tenant_id, site_id, revision) DO NOTHING`;
    await tx.$executeRaw`UPDATE sites SET config_revision = GREATEST(config_revision, 1) WHERE tenant_id = ${tenantId}::uuid AND id = ${siteId}::uuid`;

    // Tags.
    for (const [slug, label] of t.tags) {
      await tx.$executeRaw`
        INSERT INTO tags (id, tenant_id, slug, label) VALUES (${sid(`${t.key}:tag:${slug}`)}::uuid, ${tenantId}::uuid, ${slug}, ${label})
        ON CONFLICT (tenant_id, slug) DO UPDATE SET label = EXCLUDED.label, archived_at = NULL`;
    }

    // Canned replies (tenant / department / personal scopes).
    for (const r of repliesFor(t, deptIds, membershipIds)) {
      const scopeKey = r.scopeType === 'tenant' ? 'tenant' : `${r.scopeType}:${r.scopeId}`;
      await tx.$executeRaw`
        INSERT INTO canned_replies (id, tenant_id, scope_type, scope_id, scope_key, slug, title, body, options, tags, created_by, updated_at)
        VALUES (${sid(`${t.key}:reply:${scopeKey}:${r.slug}`)}::uuid, ${tenantId}::uuid, ${r.scopeType}::"ScopeType", ${r.scopeId}::uuid, ${scopeKey}, ${r.slug},
          ${r.title}, ${r.body}, ${r.options ?? []}::text[], ${r.tags ?? []}::text[], ${membershipIds[t.owner]}::uuid, now())
        ON CONFLICT (tenant_id, scope_key, slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, options = EXCLUDED.options,
          tags = EXCLUDED.tags, enabled = true, archived_at = NULL, updated_at = now()`;
    }

    // Custom field definitions (permitted vs denied for visitor/SDK writes).
    for (const f of CUSTOM_FIELDS) {
      await tx.$executeRaw`
        INSERT INTO custom_field_definitions (id, tenant_id, key, label, data_type, public_writable, visible_to_visitor, validation, updated_at)
        VALUES (${sid(`${t.key}:field:${f.key}`)}::uuid, ${tenantId}::uuid, ${f.key}, ${f.label}, ${f.dataType}, ${f.publicWritable}, ${f.visibleToVisitor}, ${JSON.stringify(f.validation)}::jsonb, now())
        ON CONFLICT (tenant_id, key) DO UPDATE SET label = EXCLUDED.label, data_type = EXCLUDED.data_type, public_writable = EXCLUDED.public_writable,
          visible_to_visitor = EXCLUDED.visible_to_visitor, validation = EXCLUDED.validation, archived_at = NULL, updated_at = now()`;
    }

    if (t.key === 'beta')
      await seedBetaCanary(tx, tenantId, siteId, deptIds.support, membershipIds['beta.agent']);

    // One audit record per tenant creation (append-only table: INSERT ... DO NOTHING keeps it single).
    await tx.$executeRaw`
      INSERT INTO audit_events (id, tenant_id, actor_type, actor_name, action, object_type, object_id, safe_diff)
      VALUES (${sid(`${t.key}:audit:seeded`)}::uuid, ${tenantId}::uuid, 'system', 'seed', 'tenant.seeded', 'tenant', ${tenantId}, ${JSON.stringify({ fixture: 'talkivio-seed-v1' })}::jsonb)
      ON CONFLICT (id) DO NOTHING`;

    return { tenantId, siteId, siteKey, created, membershipIds, deptIds, scheduleIds };
  });
}

/** Closed Beta transcript containing a distinctive canary string (TEN01 / PRIV01 evidence). */
async function seedBetaCanary(
  tx: Tx,
  tenantId: string,
  siteId: string,
  departmentId: string,
  agentMembershipId: string,
) {
  const visitorId = sid('beta:visitor:canary');
  const chatId = sid('beta:chat:canary');
  await tx.$executeRaw`
    INSERT INTO visitors (id, tenant_id, site_id, anonymous_label, name, language, visit_count, chat_count, updated_at)
    VALUES (${visitorId}::uuid, ${tenantId}::uuid, ${siteId}::uuid, 'Visitor 4711', 'Canary Visitor', 'en', 1, 1, now())
    ON CONFLICT (id) DO NOTHING`;
  const exists = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id::text FROM chats WHERE tenant_id = ${tenantId}::uuid AND id = ${chatId}::uuid`;
  if (!exists.length) {
    // Same numbering path as ChatCommandsService (tenant chat_counter).
    const [{ chat_counter }] = await tx.$queryRaw<Array<{ chat_counter: number }>>`
      UPDATE tenants SET chat_counter = chat_counter + 1 WHERE id = ${tenantId}::uuid RETURNING chat_counter`;
    await tx.$executeRaw`
      INSERT INTO chats (id, tenant_id, number, site_id, visitor_id, department_id, acquisition_department_id, owner_membership_id, status, started_by,
        requested_at, first_assigned_at, first_response_at, closed_at, close_reason, closed_by_actor, closed_by_id, next_seq,
        last_message_at, last_message_preview, last_public_sender_type, last_visitor_message_at, last_agent_reply_at, updated_at)
      VALUES (${chatId}::uuid, ${tenantId}::uuid, ${Number(chat_counter)}, ${siteId}::uuid, ${visitorId}::uuid, ${departmentId}::uuid, ${departmentId}::uuid,
        ${agentMembershipId}::uuid, 'closed'::"ChatStatus", 'visitor', now() - interval '2 days', now() - interval '2 days' + interval '20 seconds',
        now() - interval '2 days' + interval '45 seconds', now() - interval '2 days' + interval '10 minutes', 'resolved', 'agent', ${agentMembershipId}::uuid, 4,
        now() - interval '2 days' + interval '2 minutes', ${`Thanks, ${BETA_CANARY} is noted on your file.`}, 'agent'::"ActorType",
        now() - interval '2 days', now() - interval '2 days' + interval '45 seconds', now())`;
  }
  await tx.$executeRaw`
    INSERT INTO chat_participants (id, tenant_id, chat_id, actor_type, visitor_id, role, joined_at, left_at, last_read_seq, last_delivered_seq)
    VALUES (${sid('beta:participant:visitor')}::uuid, ${tenantId}::uuid, ${chatId}::uuid, 'visitor'::"ActorType", ${visitorId}::uuid, 'visitor'::"ParticipantRole",
      now() - interval '2 days', now() - interval '2 days' + interval '10 minutes', 2, 2)
    ON CONFLICT (id) DO NOTHING`;
  await tx.$executeRaw`
    INSERT INTO chat_participants (id, tenant_id, chat_id, actor_type, membership_id, role, joined_at, left_at, last_read_seq, last_delivered_seq)
    VALUES (${sid('beta:participant:agent')}::uuid, ${tenantId}::uuid, ${chatId}::uuid, 'agent'::"ActorType", ${agentMembershipId}::uuid, 'primary'::"ParticipantRole",
      now() - interval '2 days' + interval '20 seconds', now() - interval '2 days' + interval '10 minutes', 3, 3)
    ON CONFLICT (id) DO NOTHING`;
  const messages: Array<{
    seq: number;
    sender: 'visitor' | 'agent';
    visibility: 'public' | 'internal';
    body: string;
    offset: string;
  }> = [
    {
      seq: 1,
      sender: 'visitor',
      visibility: 'public',
      body: `Hello, my private reference is ${BETA_CANARY}. Please keep it confidential.`,
      offset: '0 seconds',
    },
    {
      seq: 2,
      sender: 'agent',
      visibility: 'public',
      body: `Thanks, ${BETA_CANARY} is noted on your file.`,
      offset: '45 seconds',
    },
    {
      seq: 3,
      sender: 'agent',
      visibility: 'internal',
      body: `Internal note: canary ${BETA_CANARY} must never be visible to visitors or to tenant Alpha.`,
      offset: '60 seconds',
    },
  ];
  for (const m of messages) {
    await tx.$executeRaw`
      INSERT INTO messages (id, tenant_id, chat_id, seq, client_message_id, sender_type, sender_membership_id, sender_visitor_id, sender_name_snapshot, visibility, type, body, sent_at)
      VALUES (${sid(`beta:message:canary:${m.seq}`)}::uuid, ${tenantId}::uuid, ${chatId}::uuid, ${m.seq}, ${`seed-canary-${m.seq}`}, ${m.sender}::"ActorType",
        ${m.sender === 'agent' ? agentMembershipId : null}::uuid, ${m.sender === 'visitor' ? visitorId : null}::uuid,
        ${m.sender === 'agent' ? 'Bo Agent' : 'Canary Visitor'}, ${m.visibility}::"MessageVisibility", 'text'::"MessageType", ${m.body},
        now() - interval '2 days' + ${m.offset}::interval)
      ON CONFLICT (id) DO NOTHING`;
  }
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    console.error('[seed] Refusing to seed demo fixtures with NODE_ENV=production.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (application role) is required');
  if (/\/\/(talkivio_owner|postgres)[:@]/.test(process.env.DATABASE_URL)) {
    console.warn(
      '[seed] WARNING: DATABASE_URL looks like an owner/superuser connection; use the talkivio_app role so RLS is exercised.',
    );
  }
  const password = setting('SEED_DEMO_PASSWORD');
  if (password.length < 12)
    throw new Error('SEED_DEMO_PASSWORD must be at least 12 characters (password policy)');
  const base = (process.env.SEED_PUBLIC_BASE_URL ?? process.env.API_URL ?? 'http://localhost:4000').replace(
    /\/$/,
    '',
  );

  const db = new TenantDb();
  await db.root.$connect();
  try {
    const userIds: Record<string, string> = {};
    for (const u of USERS) userIds[u.key] = await upsertUser(db, u, password);
    const results = [];
    for (const t of TENANTS) results.push({ t, r: await seedTenant(db, t, userIds) });

    console.log('\nTalkivio demo fixtures applied (idempotent).');
    for (const { t, r } of results) {
      console.log(`\n  ${t.name}  [${t.slug}]  ${r.created ? 'created' : 'already present — converged'}`);
      console.log(`    site key   ${r.siteKey}   allowed origins: ${t.origins.join(', ')}`);
      for (const o of t.origins) console.log(`    demo       ${o}/?api=${base}&w=${r.siteKey}`);
    }
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      console.log(
        `\n  Demo logins (local only; password = SEED_DEMO_PASSWORD from .env.example): ${password}`,
      );
      for (const u of USERS) {
        const m = TENANTS.flatMap((t) => t.members.map((x) => ({ ...x, tenant: t.slug }))).find(
          (x) => x.user === u.key,
        )!;
        console.log(
          `    ${m.tenant.padEnd(11)} ${m.role.padEnd(10)} cap ${String(m.capacity).padEnd(2)} ${u.email}`,
        );
      }
      console.log(
        `\n  Beta canary string (must never appear in Alpha, exports or public transcripts): ${BETA_CANARY}`,
      );
      console.log(`  Dashboard: ${base}    Mail: http://localhost:8025\n`);
    }
  } finally {
    await db.root.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
