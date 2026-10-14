#!/usr/bin/env node
/**
 * Captures the product screenshots used on the public home page (public/site/shot-*.webp) from a real local stack.
 *
 * It signs up (or signs in) a demo owner in a "Northwind Goods" workspace, serves a small storefront with the real
 * install snippet on :5180, opens several visitors from different countries and networks (one through a VPN), has one
 * of them start a chat that the owner accepts in a docked window, and photographs the dashboard and the widget.
 *
 * Needs: the API (with GEO_TRUSTED_HEADERS=proxy so the per-visitor location headers below are read), the worker,
 * the dashboard on :3000, Mailpit on :8025 (to confirm the demo owner's email) and Chrome. Run from apps/dashboard:
 *   node scripts/site-shots.mjs
 * The demo owner's generated sign-in is kept in SHOTS_STATE (default: the OS temp dir), never in the repository.
 */
import { chromium, request } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../public/site');
const RAW = process.env.SHOTS_RAW ?? join(tmpdir(), 'talkivio-site-shots');
const STATE = process.env.SHOTS_STATE ?? join(tmpdir(), 'talkivio-site-shots.json');
const DASH = process.env.DASH_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const STORE_PORT = 5180;
const STORE = `http://localhost:${STORE_PORT}`;
mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── storefront ──────────────────────────────────────────────────────────────────────────────────────────────────
const PAGES = {
  '/': { title: 'Northwind Goods | Handmade oak furniture', h: 'Handmade oak furniture, built to last.' },
  '/shop/oak-writing-desk': { title: 'Oak writing desk | Northwind Goods', h: 'Oak writing desk' },
  '/shop/walnut-dining-table': { title: 'Walnut dining table | Northwind Goods', h: 'Walnut dining table' },
  '/shop': { title: 'Shop all | Northwind Goods', h: 'Shop all furniture' },
  '/delivery': { title: 'Delivery and returns | Northwind Goods', h: 'Delivery and returns' },
  '/checkout': { title: 'Checkout | Northwind Goods', h: 'Checkout' },
  '/journal/caring-for-solid-oak': {
    title: 'Caring for solid oak | Northwind Goods',
    h: 'Caring for solid oak',
  },
  '/trade': { title: 'Trade programme | Northwind Goods', h: 'Trade programme' },
};
let siteKey = '';
const storePage = (path) => {
  const p = PAGES[path] ?? PAGES['/'];
  const card = (name, price, tone) =>
    `<article><div class="img" style="background:${tone}"></div><h3>${name}</h3><p>${price}</p></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Georgia,'Times New Roman',serif;background:#f6f1ea;color:#2b241d}
header{display:flex;align-items:center;justify-content:space-between;padding:22px 56px;border-bottom:1px solid #e3d8ca}
.logo{font-size:22px;letter-spacing:.18em;text-transform:uppercase}nav a{margin-left:28px;color:#5a4a3a;text-decoration:none;font:15px system-ui}
.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:48px;padding:64px 56px 40px;align-items:center}
.hero h1{font-size:54px;line-height:1.05;margin:0 0 18px;font-weight:400}.hero p{font:17px/1.6 system-ui;color:#6b5a48;max-width:440px}
.btn{display:inline-block;margin-top:18px;padding:14px 26px;background:#2b241d;color:#f6f1ea;font:15px system-ui;border-radius:2px}
.pic{height:380px;border-radius:4px;background:linear-gradient(135deg,#c8a27a,#8a5f3c 55%,#5b3b22)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;padding:8px 56px 80px}.grid .img{height:200px;border-radius:4px}
.grid h3{font-weight:400;font-size:19px;margin:14px 0 4px}.grid p{font:15px system-ui;color:#6b5a48;margin:0}
</style>
<script>window.Talkivio=window.Talkivio||function(){(window.Talkivio.q=window.Talkivio.q||[]).push(arguments)};</script>
<script async src="${API}/widget/loader.js" data-site-key="${siteKey}"></script>
</head><body><header><div class="logo">Northwind</div><nav><a href="/shop">Shop</a><a href="/journal/caring-for-solid-oak">Journal</a><a href="/delivery">Delivery</a><a href="/trade">Trade</a></nav></header>
<section class="hero"><div><h1>${p.h}</h1><p>Solid European oak and walnut, joined by hand in our workshop and delivered to your door.</p><span class="btn">Shop the collection</span></div><div class="pic"></div></section>
<section class="grid">${card('Oak writing desk', '$1,240', 'linear-gradient(135deg,#d9b48c,#a47448)')}${card('Walnut dining table', '$2,980', 'linear-gradient(135deg,#8b6247,#4f3424)')}${card('Ash bench', '$540', 'linear-gradient(135deg,#e6d3b8,#bf9d74)')}</section>
</body></html>`;
};
const store = createServer((req, res) => {
  const path = new URL(req.url ?? '/', STORE).pathname;
  if (path === '/favicon.ico') return void res.writeHead(204).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(storePage(path));
});

// ─── visitors: real public addresses so the network column is real; location from the trusted proxy headers ───
const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};
const VISITORS = [
  {
    ip: '99.230.14.8',
    cc: 'CA',
    city: 'Toronto',
    ua: UA.macChrome,
    path: ['/shop', '/shop/oak-writing-desk'],
    chat: true,
  },
  {
    ip: '73.162.10.21',
    cc: 'US',
    city: 'San Francisco',
    ua: UA.macSafari,
    path: ['/', '/shop/walnut-dining-table'],
  },
  { ip: '87.123.45.67', cc: 'DE', city: 'Berlin', ua: UA.winFirefox, path: ['/delivery'] },
  { ip: '185.156.175.40', cc: 'NL', city: 'Amsterdam', ua: UA.winEdge, path: ['/checkout'] },
  {
    ip: '82.132.215.10',
    cc: 'GB',
    city: 'London',
    ua: UA.iphone,
    mobile: true,
    path: ['/', '/journal/caring-for-solid-oak'],
  },
  { ip: '1.120.140.9', cc: 'AU', city: 'Sydney', ua: UA.macChrome, path: ['/trade'] },
  { ip: '90.24.110.5', cc: 'FR', city: 'Paris', ua: UA.android, mobile: true, path: ['/shop'] },
  {
    ip: '172.58.20.4',
    cc: 'US',
    city: 'Seattle',
    ua: UA.iphone,
    mobile: true,
    path: ['/shop/oak-writing-desk'],
  },
];

// ─── account ──────────────────────────────────────────────────────────────────────────────────────────────────────
const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : {
      email: `maya.collins+${Date.now().toString(36)}@northwind.test`,
      password: `Nw-${randomBytes(12).toString('base64url')}`,
    };
writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });

const api = await request.newContext({ baseURL: DASH });
const csrf = async () => {
  const c = (await api.storageState()).cookies.find((k) => k.name === 'rd_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
};
const call = async (method, path, data) => {
  const r = await api.fetch(`/api/v1${path}`, { method, data, headers: await csrf() });
  const body = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${JSON.stringify(body).slice(0, 300)}`);
  return body.data ?? body;
};

let r = await api.post('/api/v1/auth/login', { data: { email: state.email, password: state.password } });
if (!r.ok()) {
  r = await api.post('/api/v1/auth/signup', {
    data: {
      email: state.email,
      password: state.password,
      tenant_name: 'Northwind Goods',
      display_name: 'Maya Collins',
      timezone: 'America/Toronto',
    },
  });
  if (!r.ok()) throw new Error(`signup failed: ${r.status()} ${await r.text()}`);
  console.log('signed up the demo owner');
}
const me = await call('GET', '/auth/me');
if (!me.emailVerified && !me.email_verified && !me.email_verified_at && !me.emailVerifiedAt) {
  // Confirm the address through the real email in Mailpit.
  let token = null;
  for (let i = 0; i < 20 && !token; i++) {
    const list = await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${state.email}`)}`)
    ).json();
    const id = list.messages?.find((m) => /confirm/i.test(m.Subject))?.ID;
    if (id) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const raw = (msg.Text ?? msg.HTML ?? '').match(/verify-email\?token=([^"&\s<>]+)/)?.[1];
      token = raw ? decodeURIComponent(raw) : null;
    }
    if (!token) await sleep(500);
  }
  // A link used by an earlier run is fine: the address is already confirmed.
  if (token)
    await call('POST', '/auth/verify-email', { token }).catch((e) => {
      if (!/TOKEN_USED/.test(e.message)) throw e;
    });
  else console.warn('no verification email found; the dashboard may show the confirm-email banner');
}
await call('PATCH', '/tenants/current/onboarding', { completed: true });
const sites = await call('GET', '/sites');
let site = (Array.isArray(sites) ? sites : (sites.items ?? [])).find((s) =>
  (s.origins ?? []).some((o) => (o.origin ?? o) === STORE),
);
if (!site)
  site = await call('POST', '/sites', {
    name: 'northwindgoods.com',
    origins: [{ origin: STORE, pattern_type: 'exact' }],
  });
siteKey = site.public_key ?? site.publicKey;
// A US storefront that lists browsing visitors without a consent banner, and shows their IP and network.
await call('PATCH', '/tenants/current', {
  settings: { tracking: { analyticsConsentRequired: false, retainIp: true } },
});
console.log('site ready');
await call('PUT', '/agents/me/presence', { status: 'online' });

// Close anything left from an earlier run so the shots start clean.
for (const view of ['mine', 'queue']) {
  const list = await call('GET', `/chats?view=${view}`).catch(() => []);
  for (const c of Array.isArray(list) ? list : [])
    await call('POST', `/chats/${c.id}/close`, { reason: 'resolved' }).catch(() => undefined);
}

await new Promise((ok) => store.listen(STORE_PORT, '127.0.0.1', ok));
const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL ?? 'chrome' });
const contexts = [];
try {
  // ─── the agent ─────────────────────────────────────────────────────────────────────────────────────────────────
  const agentCtx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1360, height: 850 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  contexts.push(agentCtx);
  const page = await agentCtx.newPage();
  await page.goto(`${DASH}/visitors`);
  await page
    .getByRole('heading', { name: /visitors/i })
    .first()
    .waitFor({ timeout: 30_000 });
  await call('PUT', '/agents/me/presence', { status: 'online' });

  // ─── the visitors ──────────────────────────────────────────────────────────────────────────────────────────────
  let chatter = null;
  for (const v of VISITORS) {
    const ctx = await browser.newContext({
      userAgent: v.ua,
      viewport: v.mobile ? { width: 390, height: 844 } : { width: 1360, height: 850 },
      deviceScaleFactor: 2,
      isMobile: !!v.mobile,
      hasTouch: !!v.mobile,
      extraHTTPHeaders: { 'x-forwarded-for': v.ip, 'x-country-code': v.cc, 'x-geo-city': v.city },
    });
    contexts.push(ctx);
    const vp = await ctx.newPage();
    for (const p of v.path) {
      await vp.goto(`${STORE}${p}`);
      await vp
        .waitForFunction(() => window.Talkivio?.('getState')?.ready === true, undefined, { timeout: 20_000 })
        .catch(() => undefined);
      await sleep(600);
    }
    if (v.chat) chatter = vp;
  }
  await sleep(4000);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: join(RAW, 'visitors.png') });
  console.log('captured the visitors list');

  // ─── one visitor asks a question; the owner accepts it in a docked window ───────────────────────────────────────
  const name = 'Olivia Martin';
  await chatter.evaluate(() => window.Talkivio('open'));
  const ui = chatter.frameLocator('iframe[title="Chat"]');
  const question = 'Hi! Does the oak writing desk ship to Toronto, and how long does delivery take?';
  const start = ui.getByRole('button', { name: 'Start chat' });
  await sleep(1200);
  if (await start.isVisible().catch(() => false)) {
    if (
      await ui
        .getByLabel('Name')
        .isVisible()
        .catch(() => false)
    )
      await ui.getByLabel('Name').fill(name);
    if (
      await ui
        .getByLabel(/email/i)
        .isVisible()
        .catch(() => false)
    )
      await ui.getByLabel(/email/i).fill('olivia.martin@example.com');
    await ui.getByRole('textbox', { name: 'Message' }).fill(question);
    await start.click();
  } else {
    await ui.getByRole('textbox', { name: 'Message' }).fill(question);
    await ui.getByRole('button', { name: 'Send message' }).click();
  }
  const accept = page.getByRole('button', { name: /^Accept chat with/ }).first();
  await accept.waitFor({ timeout: 30_000 });
  await sleep(800);
  await page.screenshot({ path: join(RAW, 'request.png') });
  await accept.click();
  const dock = page.getByRole('region', { name: 'Chat windows' });
  const reply = dock.getByRole('textbox', { name: /^Reply to / });
  await reply.waitFor({ timeout: 20_000 });
  const say = async (text) => {
    await reply.fill(text);
    await dock.getByRole('button', { name: 'Send reply' }).click();
    await sleep(900);
  };
  const visitorSays = async (text) => {
    await ui.getByRole('textbox', { name: 'Message' }).fill(text);
    await ui.getByRole('button', { name: 'Send message' }).click();
    await sleep(1400);
  };
  await say(
    'Hi Olivia, yes we deliver across Canada. The oak writing desk ships from our workshop in 5 to 7 business days.',
  );
  await visitorSays('Perfect. Is assembly included?');
  await say('It arrives fully assembled, and our two-person team will carry it to the room you choose.');
  await visitorSays('Great, I will order it today. Thank you!');

  // Fill the visitor's details beside the conversation, the way an agent would.
  for (const [label, value] of [
    [/^Name$/, name],
    [/^Email$/, 'olivia.martin@example.com'],
    [/^Phone/i, '+1 416 555 0182'],
    [/^Notes/i, 'Ordering the oak writing desk. Wants delivery to Toronto; asked about assembly.'],
  ]) {
    const field = dock.getByLabel(label).first();
    if (await field.isVisible().catch(() => false)) await field.fill(value);
  }
  const save = dock.getByRole('button', { name: /^Save/ }).first();
  if (await save.isVisible().catch(() => false)) await save.click();
  // Close the "saved" toast before the photograph.
  await sleep(600);
  for (const close of await page.getByRole('button', { name: 'Close notification' }).all())
    await close.click().catch(() => undefined);
  await page
    .getByText('Visitor details saved')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
  await sleep(800);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: join(RAW, 'chat.png') });
  console.log('captured the chat window');

  await sleep(800);
  await chatter.screenshot({ path: join(RAW, 'widget.png') });
  console.log('captured the widget');
} finally {
  for (const c of contexts) await c.close().catch(() => undefined);
  await browser.close();
  store.close();
  await api.dispose();
}
console.log(
  `raw shots in ${RAW}; convert with: for f in visitors chat widget; do cwebp -q 82 -resize 1600 0 $RAW/$f.png -o public/site/shot-$f.webp; done`,
);
