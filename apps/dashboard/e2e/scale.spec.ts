import { expect, test, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PERF02 (ch. 60): UI responsiveness at data scale, measured in the production dashboard build. Opt-in
 * (SCALE=1) because it bulk-loads a fixture tenant:
 *   - a fresh tenant with SCALE_VISITORS (10 000) live visitor sessions — database rows plus Redis presence
 *     (the keys PresenceService writes), refreshed while the test runs so they stay inside the live window;
 *   - one closed chat with SCALE_MESSAGES (10 000) messages.
 * Live visitors: time to the first rows, loading every page by scrolling (100 rows per snapshot page), a full
 * scroll sweep with frame gaps, long tasks, and how many rows are actually in the DOM (windowing).
 * Transcript: paging back through every message with "Load earlier messages", per-page latency and long tasks,
 * then sliding the rendered window forward with "Show newer messages" back to the last message.
 * Results: docs/performance/scale-ui-<stamp>.json. The fixture tenant and its presence keys are removed afterwards.
 * Needs DATABASE_OWNER_URL (psql) and REDIS_URL (redis-cli), e.g. `set -a; . ../../.env; set +a`.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const VISITORS = Number(process.env.SCALE_VISITORS ?? 10_000);
const MESSAGES = Number(process.env.SCALE_MESSAGES ?? 10_000);
const AUTH_FILE = 'e2e/.auth/scale.json';

const sql = (q: string) =>
  execFileSync('psql', [OWNER_DB, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { maxBuffer: 64 << 20 })
    .toString()
    .trim();
const resp = (args: string[]) =>
  `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
const redis = (commands: string[][]) =>
  execFileSync('redis-cli', ['-u', REDIS_URL, '--pipe'], {
    input: commands.map(resp).join(''),
    maxBuffer: 16 << 20,
  });

const stats = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const p = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))] ?? null;
  return { n: v.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: v[v.length - 1] ?? null };
};

let tenantId = '';
let siteId = '';
let chatId = '';
let pairs: Array<[string, string]> = []; // [visitorId, sessionId]
let refresher: NodeJS.Timeout | null = null;
const report: Record<string, unknown> = {
  started_at: new Date().toISOString(),
  fixture: { visitors: VISITORS, messages: MESSAGES },
};

/** Presence for every fixture visitor with a fresh heartbeat (live list reads pv:z / pv:state / pv:conn). */
function presence(): void {
  const now = Date.now();
  const cmds: string[][] = [['SADD', 'pv:tenants', tenantId]];
  for (const [v, s] of pairs) {
    cmds.push(['ZADD', `pv:z:${tenantId}`, String(now), v]);
    cmds.push([
      'HSET',
      `pv:state:${tenantId}:${v}`,
      'siteId',
      siteId,
      'sessionId',
      s,
      'lastActivityAt',
      String(now),
      'sessionStartedAt',
      String(now - 600_000),
      'pageEnteredAt',
      String(now - 60_000),
    ]);
    cmds.push([
      'HSET',
      `pv:conn:${tenantId}:${v}`,
      `scale-${v}`,
      JSON.stringify({ sessionId: s, siteId, ts: now, visible: true }),
    ]);
  }
  redis(cmds);
}

/** Long tasks (PerformanceObserver 'longtask') since the last call. */
async function observeLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __lt?: number[] };
    if (w.__lt) return;
    w.__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt!.push(e.duration);
    }).observe({ type: 'longtask' });
  });
}
const takeLongTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lt: number[] }).__lt.splice(0));

/** Request start → response end of matching API calls, as the browser saw them (timing is final once finished). */
function trackRequests(page: Page, match: RegExp): number[] {
  const out: number[] = [];
  page.on('requestfinished', (r: Request) => {
    if (!match.test(r.url())) return;
    const t = r.timing();
    if (t.responseEnd > 0) out.push(t.responseEnd - Math.max(0, t.requestStart));
  });
  return out;
}

test.skip(!process.env.SCALE, 'opt-in: SCALE=1 bulk-loads a 10 000-visitor / 10 000-message fixture tenant');
test.describe.configure({ mode: 'serial', timeout: 900_000 });
test.use({ storageState: AUTH_FILE });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  for (const pattern of ['rl:signup:*', 'rl:login:*']) {
    const keys = execFileSync('redis-cli', ['-u', REDIS_URL, '--scan', '--pattern', pattern])
      .toString()
      .split('\n')
      .filter(Boolean);
    if (keys.length) redis(keys.map((k) => ['DEL', k]));
  }
  // A fresh owner and tenant; the browser context keeps the session cookies for the tests.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const email = `scale-ui-${Date.now().toString(36)}@talkivio.test`;
  const signup = await ctx.request.post(`${API}/api/v1/auth/signup`, {
    data: {
      email,
      password: `scale-${randomUUID()}`,
      tenant_name: 'Scale UI fixture',
      timezone: 'UTC',
      display_name: 'Scale Owner',
    },
  });
  expect(signup.status(), await signup.text()).toBe(201);
  tenantId = (await signup.json()).data.tenant_id;
  const csrf = (await ctx.cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
  const site = await ctx.request.post(`${API}/api/v1/sites`, {
    data: { name: 'Scale site', origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }] },
    headers: { 'x-csrf-token': csrf },
  });
  expect(site.status(), await site.text()).toBe(201);
  siteId = (await site.json()).data.id;
  const me = (await (await ctx.request.get(`${API}/api/v1/agents/me`)).json()).data.agent.id as string;
  mkdirSync('e2e/.auth', { recursive: true });
  await ctx.storageState({ path: AUTH_FILE });
  await ctx.close();

  const t0 = Date.now();
  sql(`BEGIN; SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO visitors (id, tenant_id, site_id, anonymous_label, name, first_seen_at, last_seen_at)
  SELECT gen_random_uuid(), '${tenantId}', '${siteId}', 'Visitor ' || g, CASE WHEN g % 4 = 0 THEN 'Scale customer ' || g END,
         now() - interval '1 hour', now() - (g || ' milliseconds')::interval
    FROM generate_series(1, ${VISITORS}) g;
INSERT INTO visitor_sessions (id, tenant_id, visitor_id, site_id, session_key_hash, started_at, last_seen_at, analytics_consent)
  SELECT gen_random_uuid(), v.tenant_id, v.id, v.site_id, md5(v.id::text), now() - interval '10 minutes', now(), 'granted'
    FROM visitors v WHERE v.tenant_id = '${tenantId}';
COMMIT;`);
  pairs = sql(`SELECT s.visitor_id || ' ' || s.id FROM visitor_sessions s WHERE s.tenant_id = '${tenantId}'`)
    .split('\n')
    .map((l) => l.split(' ') as [string, string]);
  const longVisitor = pairs[0]![0];
  chatId = sql(`BEGIN; SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO chats (id, tenant_id, number, site_id, visitor_id, owner_membership_id, status, requested_at, first_assigned_at, closed_at, close_reason, next_seq, last_message_at, last_message_preview, version)
  VALUES (gen_random_uuid(), '${tenantId}', 1, '${siteId}', '${longVisitor}', '${me}', 'closed', now() - interval '3 hours', now() - interval '3 hours', now() - interval '1 minute', 'resolved', ${MESSAGES + 1}, now() - interval '1 minute', 'Long transcript', 1)
  RETURNING id;
COMMIT;`)
    .split('\n')
    .find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  sql(`BEGIN; SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO messages (id, tenant_id, chat_id, seq, sender_type, sender_visitor_id, sender_membership_id, sender_name_snapshot, body, sent_at)
  SELECT gen_random_uuid(), '${tenantId}', '${chatId}', s,
         CASE WHEN s % 2 = 1 THEN 'visitor'::"ActorType" ELSE 'agent'::"ActorType" END,
         CASE WHEN s % 2 = 1 THEN '${longVisitor}'::uuid END, CASE WHEN s % 2 = 0 THEN '${me}'::uuid END,
         CASE WHEN s % 2 = 1 THEN 'Visitor' ELSE 'Scale Owner' END,
         'Transcript line ' || s || CASE WHEN s % 7 = 0 THEN ', a longer message that wraps onto a second line in the transcript so row heights vary like a real conversation' ELSE '' END,
         now() - interval '3 hours' + (s || ' seconds')::interval
    FROM generate_series(1, ${MESSAGES}) s;
COMMIT; ANALYZE visitors; ANALYZE visitor_sessions; ANALYZE messages;`);
  presence();
  refresher = setInterval(() => {
    try {
      presence();
    } catch {
      /* next tick retries */
    }
  }, 10_000);
  report.fixture = {
    visitors: VISITORS,
    messages: MESSAGES,
    tenant_id: tenantId,
    load_s: (Date.now() - t0) / 1000,
  };
});

test.afterAll(async () => {
  if (refresher) clearInterval(refresher);
  if (tenantId) {
    const cmds: string[][] = [
      ['DEL', `pv:z:${tenantId}`],
      ['SREM', 'pv:tenants', tenantId],
    ];
    for (const [v] of pairs) cmds.push(['DEL', `pv:state:${tenantId}:${v}`, `pv:conn:${tenantId}:${v}`]);
    redis(cmds);
    const t0 = Date.now();
    sql(`DELETE FROM tenants WHERE id = '${tenantId}' AND name = 'Scale UI fixture'`);
    report.cleanup_s = (Date.now() - t0) / 1000;
  }
  const dir = resolve(process.cwd(), '../../docs/performance');
  mkdirSync(dir, { recursive: true });
  const stamp = String(report.started_at).slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  writeFileSync(resolve(dir, `scale-ui-${stamp}Z.json`), `${JSON.stringify(report, null, 2)}\n`);
});

test('live visitors: 10 000 sessions stay windowed and responsive', async ({ page }) => {
  const snapshots = trackRequests(page, /\/api\/v1\/visitors\/live/);
  const t0 = Date.now();
  await page.goto('/visitors');
  const table = page.locator('table[aria-rowcount]');
  await expect(page.locator('[data-visitor-button]').first()).toBeVisible({ timeout: 60_000 });
  const firstRowsMs = Date.now() - t0;
  await observeLongTasks(page);
  const region = page.locator('[role="region"]').filter({ has: table });
  const rowCount = async () => Number(await table.getAttribute('aria-rowcount'));

  // Load every page the way an agent would: scroll to the end, the table asks for the next page near the end.
  const pageLoads: number[] = [];
  let rows = await rowCount();
  for (let i = 0; i < 200 && rows < VISITORS; i++) {
    const t = Date.now();
    await region.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = rows;
    await expect
      .poll(rowCount, { timeout: 30_000, intervals: [50, 100, 200] })
      .toBeGreaterThan(before)
      .catch(() => undefined);
    rows = await rowCount();
    if (rows === before) break;
    pageLoads.push(Date.now() - t);
  }
  const loadLongTasks = await takeLongTasks(page);

  // A full sweep from top to bottom, one animation frame per step.
  const gaps = await region.evaluate(async (el) => {
    const out: number[] = [];
    const steps = 120;
    el.scrollTop = 0;
    let last = performance.now();
    for (let i = 1; i <= steps; i++) {
      el.scrollTop = (el.scrollHeight * i) / steps;
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          const n = performance.now();
          out.push(n - last);
          last = n;
          r();
        }),
      );
    }
    return out;
  });
  const sweepLongTasks = await takeLongTasks(page);
  const renderedRows = await page.locator('[data-visitor-button]').count();
  const lastLabel = await page.locator('[data-visitor-button]').last().textContent();

  report.live_visitors = {
    first_rows_ms: firstRowsMs,
    loaded_rows: rows,
    pages_loaded_by_scrolling: pageLoads.length,
    page_load_ms: stats(pageLoads),
    snapshot_api_ms: stats(snapshots),
    rendered_rows_in_dom: renderedRows,
    long_tasks_while_loading_ms: stats(loadLongTasks),
    sweep_frame_gap_ms: stats(gaps),
    long_tasks_during_sweep_ms: stats(sweepLongTasks),
  };
  console.log('live visitors', JSON.stringify(report.live_visitors));
  expect(rows, 'every live session reachable by scrolling').toBeGreaterThanOrEqual(VISITORS);
  expect(renderedRows, 'only a window of rows is in the DOM').toBeLessThan(300);
  expect(lastLabel, 'the end of the list renders').toBeTruthy();
});

test('transcript: paging back through 10 000 messages stays responsive', async ({ page }) => {
  const pagesApi = trackRequests(page, new RegExp(`/api/v1/chats/${chatId}/messages`));
  const t0 = Date.now();
  await page.goto(`/history/${chatId}`);
  const log = page.getByRole('log');
  const earlier = page.getByRole('button', { name: 'Load earlier messages' });
  await expect(earlier).toBeVisible({ timeout: 60_000 });
  const firstPageMs = Date.now() - t0;
  await observeLongTasks(page);
  const start = page.getByText('Start of conversation');
  const clicks: number[] = [];
  for (let i = 0; i < 400 && (await earlier.isVisible().catch(() => false)); i++) {
    const t = Date.now();
    const before = pagesApi.length;
    await earlier.click();
    // The page is in once its request finished and the button (or the start marker) is back.
    await expect
      .poll(() => pagesApi.length, { timeout: 30_000, intervals: [20, 50, 100] })
      .toBeGreaterThan(before);
    await expect(earlier.or(start)).toBeVisible({ timeout: 30_000 });
    clicks.push(Date.now() - t);
  }
  const longTasks = await takeLongTasks(page);
  await expect(start).toBeVisible();
  const domNodes = await log.evaluate((el) => el.querySelectorAll('*').length);
  const firstLine = await log.getByText('Transcript line 1', { exact: true }).count();

  // Forward again through what is loaded: the window slides without fetching until the last message shows.
  const newer = page.getByRole('button', { name: 'Show newer messages' });
  const ended = page.getByRole('separator', { name: 'Chat ended' });
  const slides: number[] = [];
  for (let i = 0; i < 200 && (await newer.isVisible().catch(() => false)); i++) {
    const t = Date.now();
    const firstBefore = await log.locator('time').first().getAttribute('datetime');
    await newer.click();
    await expect
      .poll(() => log.locator('time').first().getAttribute('datetime'), {
        timeout: 15_000,
        intervals: [20, 50, 100],
      })
      .not.toBe(firstBefore);
    slides.push(Date.now() - t);
  }
  const slideLongTasks = await takeLongTasks(page);
  await expect(ended).toBeVisible();
  const lastLine = await log.getByText(`Transcript line ${MESSAGES}`, { exact: false }).count();
  const domNodesAtEnd = await log.evaluate((el) => el.querySelectorAll('*').length);
  report.transcript = {
    first_page_ms: firstPageMs,
    pages_loaded: clicks.length + 1,
    load_earlier_ms: stats(clicks),
    first_vs_last_tenth_ms: {
      first: stats(clicks.slice(0, Math.ceil(clicks.length / 10))),
      last: stats(clicks.slice(-Math.ceil(clicks.length / 10))),
    },
    messages_api_ms: stats(pagesApi),
    long_tasks_ms: stats(longTasks),
    dom_nodes_in_log: domNodes,
    show_newer_ms: stats(slides),
    long_tasks_while_sliding_ms: stats(slideLongTasks),
    dom_nodes_in_log_at_end: domNodesAtEnd,
  };
  console.log('transcript', JSON.stringify(report.transcript));
  expect(firstLine, 'the first message is reachable').toBeGreaterThan(0);
  expect(lastLine, 'the last message is reachable again').toBeGreaterThan(0);
  expect(domNodes, 'the rendered transcript stays bounded').toBeLessThan(10_000);
});
