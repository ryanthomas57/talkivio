// Talkivio chat load test (ch. 60): real auth, real tenants, REST + WebSocket mix.
//
//   node test/load/chat-load.mjs            (env overrides below)
//
// Workload: TENANTS tenants (tenant 0 is "hot" and receives HOT_SHARE of all visitors), each with
// AGENTS_PER_TENANT agents (broadcast routing, capacity 20). Visitors ramp at RAMP_PER_SEC, admit a
// chat, then send a message every MSG_INTERVAL_MS (halved during the BURST_S window); the owning agent
// replies to every visitor message after a short think time. Message bodies carry a send timestamp
// (base-36, so card-number masking never alters it) and delivery latency is measured in one clock.
//
// Simulated clients behind the reverse proxy: REST calls carry X-Forwarded-For from a private range
// (TRUST_PROXY=loopback trusts the local generator), sockets carry the same header for the handshake.
// The JSON report goes to docs/performance/ (REPORT_DIR overrides, e.g. for diagnostic runs). Delivery latency is
// also reported per phase of the send time (ramp, warmup = WARMUP_S, sustain, burst, drain) with a 5 s timeline of
// outbox lag, swap and load. Reference method (ch. 60): WARMUP_S=600 SUSTAIN_S=1800 BURST_S=300.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const cfg = {
  tenants: Number(process.env.TENANTS ?? 3),
  agentsPerTenant: Number(process.env.AGENTS_PER_TENANT ?? 4),
  visitors: Number(process.env.VISITORS ?? 120),
  hotShare: Number(process.env.HOT_SHARE ?? 0.5),
  rampPerSec: Number(process.env.RAMP_PER_SEC ?? 1.8),
  warmupS: Number(process.env.WARMUP_S ?? 0),
  sustainS: Number(process.env.SUSTAIN_S ?? 120),
  burstS: Number(process.env.BURST_S ?? 30),
  msgIntervalMs: Number(process.env.MSG_INTERVAL_MS ?? 5000),
  origin: 'http://localhost:5173',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();

// ─────────────────────────── metrics ───────────────────────────
const series = new Map();
function record(name, ms) {
  if (!Number.isFinite(ms)) return;
  let s = series.get(name);
  if (!s) series.set(name, (s = []));
  s.push(ms);
}
// Phase boundaries (generator clock); delivery samples are also filed under the phase their message was sent in,
// so the sustained baseline and the burst have their own percentiles (ch. 60 budgets apply to the baseline).
const phaseAt = { rampEnd: Infinity, warmupEnd: Infinity, burstStart: Infinity, burstEnd: Infinity };
function phaseOf(sentAt) {
  if (sentAt < phaseAt.rampEnd) return 'ramp';
  if (sentAt < phaseAt.warmupEnd) return 'warmup';
  if (sentAt < phaseAt.burstStart) return 'sustain';
  return sentAt < phaseAt.burstEnd ? 'burst' : 'drain';
}
function recordDelivery(direction, tenant, sentAt) {
  const ms = now() - sentAt;
  record(`${direction}.tenant${tenant.t === 0 ? '_hot' : '_other'}`, ms);
  record(`${direction}.${phaseOf(sentAt)}`, ms);
}
const errors = new Map();
function fail(kind, detail) {
  errors.set(`${kind}:${detail}`, (errors.get(`${kind}:${detail}`) ?? 0) + 1);
}
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
function summarize() {
  const out = {};
  for (const [name, values] of [...series.entries()].sort()) {
    const v = [...values].sort((a, b) => a - b);
    out[name] = { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: v[v.length - 1] };
  }
  return out;
}
let counters = { visitorMessages: 0, agentMessages: 0, chatsAdmitted: 0, chatsAccepted: 0, socketDisconnects: 0 };

// ─────────────────────────── http ───────────────────────────
class Client {
  constructor(name, xff) {
    this.name = name;
    this.cookies = {};
    this.xff = xff;
  }
  async call(method, path, body, extra = {}) {
    const started = now();
    const url = `${API}${path.startsWith('/widget') || path.startsWith('/health') ? '' : '/api/v1'}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...(this.xff ? { 'x-forwarded-for': this.xff } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) this.cookies[pair.slice(0, i)] = decodeURIComponent(v);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, data: json?.data, error: json?.error, ms: now() - started };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r;
  }
}

function sql(q) {
  return execFileSync('psql', [OWNER_DB, '-At', '-c', q]).toString().trim();
}
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');

function connect(ns, ticket, xff) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true, extraHeaders: xff ? { 'x-forwarded-for': xff } : {} });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${ns} connect timeout`)), 15000);
    s.on('auth.ok', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(t);
      reject(new Error(`${ns} connect_error: ${e.message}`));
    });
    s.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') counters.socketDisconnects++;
    });
  });
}
async function command(sock, type, payload) {
  const started = now();
  const ack = await sock.timeout(15000).emitWithAck('command', { v: 1, command_id: randomUUID(), type, payload });
  if (ack.type !== 'command.ack') throw Object.assign(new Error(ack.code ?? 'command.error'), { code: ack.code });
  return { result: ack.result, ms: now() - started };
}

// ─────────────────────────── setup ───────────────────────────
const stamp = Date.now().toString(36);
const password = `load-${randomUUID()}`;
const xffFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

async function setupTenant(t) {
  const owner = new Client(`owner${t}`, xffFor(60000 + t));
  const email = `load-owner-${stamp}-${t}@talkivio.test`;
  await owner.must('POST', '/auth/signup', { email, password, tenant_name: `Load ${stamp} ${t}`, timezone: 'UTC' });
  const verify = sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${email}' AND template = 'verify_email' ORDER BY created_at DESC LIMIT 1`);
  await owner.must('POST', '/auth/verify-email', { token: tokenFrom(verify, 'token') });
  const depts = (await owner.must('GET', '/departments')).data;
  const dept = depts[0];
  await owner.must('PATCH', `/departments/${dept.id}`, { routing_mode: 'broadcast', expected_version: dept.version });
  const site = (await owner.must('POST', '/sites', { name: 'Load site', origins: [{ origin: cfg.origin, pattern_type: 'exact' }] })).data;
  const agents = [];
  for (let a = 0; a < cfg.agentsPerTenant; a++) {
    const aEmail = `load-agent-${stamp}-${t}-${a}@talkivio.test`;
    await owner.must('POST', '/agents/invitations', { email: aEmail, role: 'agent', department_ids: [dept.id], capacity: 20 });
    const inv = sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${aEmail}' AND template = 'agent_invitation' ORDER BY created_at DESC LIMIT 1`);
    const agent = new Client(`agent${t}.${a}`, xffFor(61000 + t * 100 + a));
    await agent.must('POST', '/agents/invitations/accept', { token: tokenFrom(inv, 'invite'), display_name: `Agent ${t}.${a}`, password });
    agents.push(agent);
  }
  return { t, owner, dept, site, agents };
}

const chatOwner = new Map(); // chatId → agent runtime that won the accept
async function startAgent(tenant, agent, index) {
  const ticket = (await agent.must('POST', '/socket-ticket')).data.ticket;
  const sock = await connect('/agent', ticket, xffFor(61000 + tenant.t * 100 + index));
  await sock.timeout(15000).emitWithAck('subscribe', { scopes: [{ kind: 'queue', id: 'none' }, { kind: 'queue', id: tenant.dept.id }] });
  await agent.must('PUT', '/agents/me/presence', { status: 'online' });
  const rt = { tenant, agent, sock };
  sock.on('event', async (f) => {
    if (f.type === 'chat.requested') {
      const chatId = f.payload.chat.id;
      const requestedAt = Date.parse(f.payload.chat.requested_at);
      // Stagger so agents don't all race for every chat; first winner owns it.
      await sleep(Math.random() * 300);
      if (chatOwner.has(chatId)) return;
      try {
        await command(sock, 'offer.accept', { chat_id: chatId, offer_id: null });
        chatOwner.set(chatId, rt);
        counters.chatsAccepted++;
        record('time_to_accept_ms', now() - requestedAt);
        await sock.timeout(15000).emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
      } catch (e) {
        if (e.code !== 'CHAT_ALREADY_ASSIGNED') fail('accept', e.code ?? e.message);
      }
      return;
    }
    if (f.type === 'message.created' && f.payload.message?.sender?.type === 'visitor') {
      const m = f.payload.message;
      if (chatOwner.get(m.chat_id) !== rt) return;
      const sentAt = parseInt(/t=([0-9a-z]+)/.exec(m.body ?? '')?.[1] ?? '', 36);
      if (sentAt) recordDelivery('visitor_to_agent_ms', tenant, sentAt);
      await sleep(200 + Math.random() * 600);
      try {
        const r = await command(sock, 'message.send', { chat_id: m.chat_id, client_message_id: randomUUID(), body: `Reply t=${Math.round(now()).toString(36)}` });
        record('agent_send_ack_ms', r.ms);
        counters.agentMessages++;
      } catch (e) {
        fail('agent_send', e.code ?? e.message);
      }
    }
  });
  return rt;
}

async function startVisitor(tenant, i, phase) {
  const xff = xffFor(i + 1);
  const v = new Client(`visitor${i}`, xff);
  const sess = await v.call('POST', '/widget/v1/sessions', { site_key: tenant.site.public_key, host_origin: cfg.origin, consent: { analytics: true, policy_version: '2026-10' }, page: { url: `${cfg.origin}/products/${i}`, title: 'Product' } });
  record('rest_widget_session_ms', sess.ms);
  if (sess.status >= 400) return fail('session', sess.error?.code ?? sess.status);
  const auth = { authorization: `Bearer ${sess.data.capability}` };
  const vt = await v.call('POST', '/widget/v1/socket-ticket', undefined, auth);
  if (vt.status >= 400) return fail('visitor_ticket', vt.error?.code ?? vt.status);
  let sock;
  try {
    sock = await connect('/visitor', vt.data.ticket, xff);
  } catch (e) {
    return fail('visitor_socket', e.message);
  }
  const admit = await v.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: `Hello t=${Math.round(now()).toString(36)}` }, auth);
  record('rest_admission_ms', admit.ms);
  if (admit.status >= 400) {
    sock.disconnect();
    return fail('admission', admit.error?.code ?? admit.status);
  }
  counters.chatsAdmitted++;
  const chatId = admit.data.chat.id;
  await sock.timeout(15000).emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
  sock.on('event', (f) => {
    if (f.type === 'message.created' && f.payload.message?.sender?.type === 'agent') {
      const sentAt = parseInt(/t=([0-9a-z]+)/.exec(f.payload.message.body ?? '')?.[1] ?? '', 36);
      if (sentAt) recordDelivery('agent_to_visitor_ms', tenant, sentAt);
    }
  });
  const loop = async () => {
    while (!phase.stopped) {
      const interval = phase.burst ? cfg.msgIntervalMs / 2 : cfg.msgIntervalMs;
      await sleep(interval * (0.6 + Math.random() * 0.8));
      if (phase.stopped) break;
      try {
        const r = await command(sock, 'message.send', { chat_id: chatId, client_message_id: randomUUID(), body: `Question t=${Math.round(now()).toString(36)}` });
        record(phase.burst ? 'visitor_send_ack_ms.burst' : 'visitor_send_ack_ms', r.ms);
        counters.visitorMessages++;
      } catch (e) {
        fail('visitor_send', e.code ?? e.message);
      }
    }
    await command(sock, 'chat.close', { chat_id: chatId }).catch(() => undefined);
    sock.disconnect();
  };
  return loop();
}

function processStats() {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid,%cpu,rss,command']).toString().split('\n');
    const pick = (needle) => out.filter((l) => l.includes(needle) && !l.includes('ps -Ao')).map((l) => l.trim().split(/\s+/)).map(([pid, cpu, rss]) => ({ pid: Number(pid), cpu: Number(cpu), rssMb: Math.round(Number(rss) / 1024) }));
    // Anything else busy on the host (OS indexing, photo analysis…) skews a single-host run; record it.
    const stack = /dist\/(main|worker)\.js|postgres:|redis-server|chat-load\.mjs/;
    const other = out.slice(1).map((l) => l.trim().split(/\s+/)).filter(([, cpu]) => Number(cpu) >= 20).map(([pid, cpu, , ...cmd]) => ({ pid: Number(pid), cpu: Number(cpu), command: cmd.join(' ') })).filter((x) => !stack.test(x.command)).map((x) => ({ ...x, command: x.command.split(' ')[0].split('/').pop() }));
    return { api: pick('dist/main.js'), worker: pick('dist/worker.js'), postgres: pick('postgres:').length, redis: pick('redis-server'), other_busy: other };
  } catch {
    return null;
  }
}
/** Every 5 s: outbox lag (API gauge), host swap and load, so a stall can be matched to host pressure. */
async function sampleTimeline(timeline) {
  const text = await fetch(`${API}/health/metrics`).then((r) => r.text()).catch(() => '');
  const lag = Number(/^talkivio_outbox_oldest_unpublished_seconds\S* (\S+)/m.exec(text)?.[1] ?? NaN);
  let swapMb = null;
  try {
    swapMb = Number(/used = ([\d.]+)M/.exec(execFileSync('sysctl', ['-n', 'vm.swapusage']).toString())?.[1] ?? NaN);
  } catch {
    // not macOS
  }
  timeline.push({ t_s: Math.round((now() - phaseAt.rampEnd) / 1000), phase: phaseOf(now()), outbox_lag_s: Number.isFinite(lag) ? Math.round(lag * 1000) / 1000 : null, swap_used_mb: swapMb, load1: Math.round(os.loadavg()[0] * 100) / 100 });
}
async function scrape() {
  const text = await fetch(`${API}/health/metrics`).then((r) => r.text()).catch(() => '');
  const grab = (name) => text.split('\n').filter((l) => l.startsWith(name)).join('\n');
  return { outboxLag: grab('talkivio_outbox_oldest_unpublished_seconds'), queue: grab('talkivio_routing_queue_oldest_seconds') };
}

// ─────────────────────────── run ───────────────────────────
const startedAt = new Date();
console.log(`Talkivio load: ${JSON.stringify(cfg)}`);
const tenants = [];
for (let t = 0; t < cfg.tenants; t++) tenants.push(await setupTenant(t));
console.log(`setup: ${tenants.length} tenants × ${cfg.agentsPerTenant} agents`);
const agentRts = [];
for (const tenant of tenants) for (const [i, a] of tenant.agents.entries()) agentRts.push(await startAgent(tenant, a, i));
const cpuStart = process.cpuUsage();
const phase = { stopped: false, burst: false };
const visitorRuns = [];
const rampMs = 1000 / cfg.rampPerSec;
const rampStarted = now();
for (let i = 0; i < cfg.visitors; i++) {
  // Interleave so the hot tenant receives HOT_SHARE of arrivals throughout the run, not all first.
  const hot = (i % 20) < Math.round(cfg.hotShare * 20) || tenants.length === 1;
  const tenant = hot ? tenants[0] : tenants[1 + (i % (tenants.length - 1))];
  visitorRuns.push(startVisitor(tenant, i, phase).catch((e) => fail('visitor', e.message)));
  await sleep(rampMs);
}
phaseAt.rampEnd = now();
const timeline = [];
const sampler = setInterval(() => void sampleTimeline(timeline), 5000);
if (cfg.warmupS > 0) {
  console.log(`ramp done in ${Math.round((now() - rampStarted) / 1000)} s; warming up ${cfg.warmupS} s`);
  await sleep(cfg.warmupS * 1000);
}
phaseAt.warmupEnd = now();
console.log(`${cfg.warmupS > 0 ? 'warmup' : 'ramp'} done; sustaining ${cfg.sustainS} s`);
const metricsBefore = await scrape();
await sleep(cfg.sustainS * 1000);
phaseAt.burstStart = now();
phase.burst = true;
console.log(`burst ${cfg.burstS} s`);
const procDuringBurst = processStats();
await sleep(cfg.burstS * 1000);
phaseAt.burstEnd = now();
phase.burst = false;
const metricsAfter = await scrape();
phase.stopped = true;
await Promise.race([Promise.allSettled(visitorRuns), sleep(30000)]);
for (const rt of agentRts) rt.sock.disconnect();
clearInterval(sampler);
const cpu = process.cpuUsage(cpuStart);
const elapsedS = (now() - rampStarted) / 1000;

const report = {
  started_at: startedAt.toISOString(),
  environment: { host: os.hostname(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version, api: API, topology: 'single api (gateway in-process) + single worker, PostgreSQL 16, Redis 7, same host as the generator' },
  config: cfg,
  counters,
  throughput: { messages_per_s: (counters.visitorMessages + counters.agentMessages) / elapsedS },
  latencies_ms: summarize(),
  errors: Object.fromEntries(errors),
  server_metrics: { before: metricsBefore, after: metricsAfter },
  processes_during_burst: procDuringBurst,
  timeline,
  generator_cpu_s: (cpu.user + cpu.system) / 1e6,
  elapsed_s: elapsedS,
};
const outDir = process.env.REPORT_DIR ? resolve(process.env.REPORT_DIR) : resolve(here, '../../../../docs/performance');
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `load-${startedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}Z.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ counters: report.counters, throughput: report.throughput, latencies_ms: report.latencies_ms, errors: report.errors }, null, 2));
console.log(`report: ${file}`);
process.exit(0);
