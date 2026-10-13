// Verifies the demo fixtures from apps/api/src/seed.ts through the REAL running API (no DB shortcuts):
// seeded logins, departments, site keys bound to their exact origins, and Beta canary isolation.
//
//   API_URL=http://localhost:8080 node infra/test/seed-fixtures.mjs        # docker compose stack
//   API_URL=http://localhost:4000 node infra/test/seed-fixtures.mjs        # local api + worker
//
// SEED_DEMO_PASSWORD / SEED_ALPHA_SITE_KEY / SEED_BETA_SITE_KEY default to the values in .env.example.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const examplePath = fileURLToPath(new URL('../../.env.example', import.meta.url));
const example = existsSync(examplePath)
  ? Object.fromEntries(
      readFileSync(examplePath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
    )
  : {};
const cfg = (k) => process.env[k] ?? example[k];
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const PW = cfg('SEED_DEMO_PASSWORD');
const ALPHA_KEY = cfg('SEED_ALPHA_SITE_KEY');
const BETA_KEY = cfg('SEED_BETA_SITE_KEY');
const CANARY = 'RD-CANARY-BETA-7Q4X-PRIVATE';

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    console.error(`\nSEED FIXTURES FAILED after ${passed} checks`);
    process.exit(1);
  }
  passed++;
  console.log(`  ✓ ${msg}`);
}

async function login(email, password = PW) {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookies = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, body: await r.json().catch(() => null), cookies };
}
async function get(session, path) {
  const r = await fetch(`${API}/api/v1${path}`, { headers: { cookie: session.cookies } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const bootstrap = (siteKey, hostOrigin) =>
  fetch(`${API}/widget/v1/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ site_key: siteKey, host_origin: hostOrigin }),
  }).then((r) => r.json());

console.log(`Seed fixtures against ${API}`);
const accounts = [
  'owner@alpha.test',
  'ana.sales@alpha.test',
  'ben.support@alpha.test',
  'sam.supervisor@alpha.test',
  'alex.analyst@alpha.test',
  'owner@beta.test',
  'bo.agent@beta.test',
];
for (const email of accounts) {
  const s = await login(email);
  ok(s.status === 200 && s.body?.data?.active_tenant_id, `login ${email}`);
}
ok(
  (await login('owner@alpha.test', 'definitely-not-the-password')).status === 401,
  'wrong password rejected',
);

const alpha = await login('owner@alpha.test');
const depts = await get(alpha, '/departments');
const names = (depts.body?.data ?? [])
  .map((d) => d.name)
  .sort()
  .join(',');
ok(names === 'Sales,Support', `Alpha departments: ${names}`);
const sites = await get(alpha, '/sites');
const site = sites.body?.data?.[0];
ok(site?.public_key === ALPHA_KEY && site.origins.length >= 2, 'Alpha site key and allowed origins');

const a1 = await bootstrap(ALPHA_KEY, 'http://localhost:5173');
ok(
  a1.data && !a1.error,
  `Alpha widget bootstraps on http://localhost:5173 (availability=${a1.data?.availability?.state})`,
);
ok(
  (await bootstrap(ALPHA_KEY, 'http://localhost:5174')).data,
  'Alpha widget bootstraps on http://localhost:5174',
);
const cross = await bootstrap(ALPHA_KEY, 'http://127.0.0.1:5173');
ok(cross.error?.code === 'ORIGIN_NOT_ALLOWED' && !cross.data, 'Alpha key refused on a Beta origin');
ok(
  (await bootstrap(BETA_KEY, 'http://127.0.0.1:5173')).data,
  'Beta widget bootstraps on http://127.0.0.1:5173',
);
ok(
  (await bootstrap(BETA_KEY, 'http://localhost:5173')).error?.code === 'ORIGIN_NOT_ALLOWED',
  'Beta key refused on an Alpha origin',
);

const alphaSearch = await get(alpha, `/chats/history?q=${encodeURIComponent(CANARY)}`);
ok(
  alphaSearch.status === 200 &&
    !JSON.stringify(alphaSearch.body).includes(CANARY) &&
    (alphaSearch.body?.data ?? []).length === 0,
  'Alpha search never returns the Beta canary',
);
const beta = await login('bo.agent@beta.test');
const betaSearch = await get(beta, `/chats/history?q=${encodeURIComponent(CANARY)}`);
ok((betaSearch.body?.data ?? []).length === 1, 'Beta agent finds the canary transcript');
const chatId = betaSearch.body.data[0].id;
ok((await get(alpha, `/chats/${chatId}`)).status === 404, 'Alpha gets 404 for the Beta canary chat id');
ok((await get(alpha, `/chats/${chatId}/messages`)).status === 404, 'Alpha cannot read Beta canary messages');

console.log(`\nSEED FIXTURES PASSED (${passed} checks)`);
