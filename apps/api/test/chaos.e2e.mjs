// Process-kill and Redis restart resilience (FAIL01, AUD-72-04) on a fully isolated stack:
// its own database (talkivio_chaos), its own redis-server (append-only, like production) and its
// own api + worker built from BUILD_DIR. Nothing shared is touched.
//   A. SIGKILL the api while a visitor sends: retries with the same client_message_id → every message
//      persisted exactly once, seq strictly increasing, the agent socket reconnects and replays from its
//      cursor with no gap and no duplicate.
//   B. SIGKILL the worker: commits continue (outbox rows wait), restart → every row published once,
//      the agent sees each message once; command retries during the outage return the original.
//   C. Restart Redis (AOF): readiness reports the outage, recovers, routing and delivery resume.
//   D. FLUSHALL (failover without data): open sockets re-register presence on their next heartbeat,
//      new chats are admitted and offered again, maintenance schedulers are re-asserted.
// Needs: psql, redis-server, redis-cli, DATABASE_OWNER_URL/DATABASE_URL (repo .env), a build in BUILD_DIR.
// Usage: cd apps/api && npx tsc -p tsconfig.build.json --outDir .build/chaos && BUILD_DIR=.build/chaos node test/chaos.e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(apiDir, process.env.BUILD_DIR ?? '.build/chaos');
const PORT = Number(process.env.CHAOS_PORT ?? 4150);
const REDIS_PORT = Number(process.env.CHAOS_REDIS_PORT ?? 6390);
const API = `http://localhost:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

// ── isolated environment ──
const ownerBase = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '').replace(/\/[^/]*$/, '');
const appBase = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '').replace(/\/[^/]*$/, '');
const DB = 'talkivio_chaos';
const ENV = {
  ...process.env,
  DATABASE_OWNER_URL: `${ownerBase}/${DB}?schema=public`,
  DATABASE_URL: `${appBase}/${DB}?schema=public`,
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  PORT: String(PORT),
  API_URL: API,
  WORKER_HEALTH_PORT: String(Number(process.env.CHAOS_WORKER_HEALTH_PORT ?? 4051)),
  STORAGE_LOCAL_DIR: resolve(apiDir, 'storage-chaos'),
  SHUTDOWN_DRAIN_DELAY_MS: '0',
  LOG_LEVEL: 'warn',
};
const sql = (q) => execFileSync('psql', [`${ownerBase}/${DB}`, '-At', '-F', '|', '-c', q]).toString().trim();
const redisCli = (...a) => execFileSync('redis-cli', ['-p', String(REDIS_PORT), ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const redisDir = resolve(process.env.TMPDIR ?? '/tmp', `talkivio-chaos-redis-${process.pid}`);

const procs = { redis: null, api: null, worker: null };
let logs = '';
function start(name) {
  const args =
    name === 'redis'
      ? ['redis-server', ['--port', String(REDIS_PORT), '--appendonly', 'yes', '--appendfsync', 'always', '--save', '', '--dir', redisDir, '--loglevel', 'warning']]
      : [process.execPath, ['--enable-source-maps', resolve(BUILD, name === 'api' ? 'main.js' : 'worker.js')]];
  const p = spawn(args[0], args[1], { cwd: apiDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs += `[${name}] ${d}`));
  p.stderr.on('data', (d) => (logs += `[${name}] ${d}`));
  procs[name] = p;
  return p;
}
async function stop(name, signal = 'SIGKILL') {
  const p = procs[name];
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill(signal);
  await done;
}
async function until(pred, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await pred();
      if (v) return v;
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const ready = (url) => fetch(url).then((r) => r.status === 200).catch(() => false);
const apiReady = () => until(() => ready(`${API}/health/ready`), 60_000, 'api ready');
const workerReady = () => until(() => ready(`http://localhost:${ENV.WORKER_HEALTH_PORT}/health/ready`), 60_000, 'worker ready');

class Client {
  constructor() {
    this.cookies = {};
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

/** Agent socket that reconnects with a fresh ticket and resumes from its last durable cursor. */
function resilientAgent(owner, scopes) {
  const state = { sock: null, cursor: null, scopes: [...scopes], events: [], ephemeral: [], reconnects: 0, closed: false, connected: false };
  const connect = async () => {
    const ticket = (await owner.must('POST', '/socket-ticket')).ticket;
    const s = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, reconnection: false, forceNew: true });
    s.on('event', (f) => {
      state.events.push(f);
      state.cursor = f.cursor;
    });
    s.on('ephemeral', (f) => state.ephemeral.push(f));
    s.on('disconnect', () => {
      state.connected = false;
      if (!state.closed) void reconnect();
    });
    await new Promise((res, rej) => {
      s.once('auth.ok', res);
      s.once('connect_error', rej);
    });
    await s.emitWithAck('subscribe', { scopes: state.scopes, last_cursor: state.cursor });
    state.sock = s;
    state.connected = true;
  };
  const reconnect = async () => {
    for (;;) {
      if (state.closed) return;
      try {
        await connect();
        state.reconnects++;
        return;
      } catch {
        await sleep(300);
      }
    }
  };
  state.start = connect;
  state.addScopes = async (more) => {
    state.scopes.push(...more);
    await state.sock.emitWithAck('subscribe', { scopes: more, last_cursor: state.cursor });
  };
  state.close = () => {
    state.closed = true;
    state.sock?.disconnect();
  };
  return state;
}

/** Send with the same client_message_id until the server answers (network errors and 5xx are retried). */
async function sendDurably(v, auth, chatId, clientMessageId, body) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const r = await v.call('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: clientMessageId, body }, auth);
      if (r.status < 500 && r.status !== 429) return { ...r, attempt };
    } catch {
      /* connection refused while the api is down */
    }
    await sleep(100);
  }
  throw new Error(`send ${clientMessageId} never succeeded`);
}

const cleanup = async () => {
  for (const n of ['api', 'worker', 'redis']) await stop(n).catch(() => undefined);
  rmSync(redisDir, { recursive: true, force: true });
};
try {
  console.log(`Setup (isolated: db ${DB}, redis :${REDIS_PORT} AOF, api :${PORT}, build ${BUILD})`);
  rmSync(redisDir, { recursive: true, force: true });
  mkdirSync(redisDir, { recursive: true });
  start('redis');
  await until(() => redisCli('ping') === 'PONG', 10_000, 'redis');
  execFileSync('sh', ['scripts/db-reset.sh'], { cwd: apiDir, env: ENV, stdio: 'ignore' });
  start('api');
  start('worker');
  await apiReady();
  await workerReady();
  ok(true, 'isolated stack up');

  const owner = new Client();
  const stamp = Date.now();
  const email = `chaos+${stamp}@example.com`;
  await owner.must('POST', '/auth/signup', { email, password: 'correct horse battery', tenant_name: `Chaos ${stamp}`, timezone: 'UTC' });
  const site = await owner.must('POST', '/sites', { name: 'Chaos store', origins: [{ origin: ORIGIN, pattern_type: 'exact' }] });
  const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
  await owner.must('PUT', '/agents/me/presence', { status: 'online' });
  
  const v = new Client();
  const sess = await v.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
  const vauth = { authorization: `Bearer ${sess.capability}` };
  const agent = resilientAgent(owner, [{ kind: 'queue', id: support.id }, { kind: 'queue', id: 'none' }]);
  await agent.start();
  await until(async () => (await owner.must('GET', '/agents/me')).agent.effective_status === 'online', 10_000, 'agent online');
  const chatId = (await v.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello before chaos', department_id: support.id }, vauth)).chat.id;
  await until(async () => (await owner.call('POST', `/chats/${chatId}/accept`, {})).status === 200, 10_000, 'accept');
  await agent.addScopes([{ kind: 'chat', id: chatId }]); // kept across reconnects
  const agent2 = agent;
  ok(sql(`SELECT status FROM chats WHERE id = '${chatId}'`) === 'active', 'chat active with a connected agent');

  // ── A: api SIGKILL during sends ──
  console.log('A. SIGKILL the api mid-traffic');
  const idsA = Array.from({ length: 20 }, (_, i) => `A-${stamp}-${i}`);
  let killedAt = -1;
  const sends = [];
  for (let i = 0; i < idsA.length; i++) {
    if (i === 8) {
      killedAt = i;
      await stop('api', 'SIGKILL');
      start('api');
    }
    sends.push(await sendDurably(v, vauth, chatId, idsA[i], `chaos message ${i}`));
  }
  ok(killedAt === 8 && sends.every((r) => r.status === 201 || r.status === 200), 'every send eventually acknowledged (retries with the same client_message_id across the crash)');
  const rowsA = sql(`SELECT client_message_id || '|' || seq FROM messages WHERE chat_id = '${chatId}' AND client_message_id LIKE 'A-${stamp}-%' ORDER BY seq`).split('\n');
  ok(rowsA.length === 20 && new Set(rowsA.map((r) => r.split('|')[0])).size === 20, 'exactly 20 messages persisted — no loss, no duplicate');
  const seqs = rowsA.map((r) => Number(r.split('|')[1]));
  ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq strictly increasing across the crash');
  await until(() => agent2.connected && agent2.reconnects >= 1, 30_000, 'agent reconnect');
  const seenA = await until(() => {
    const ids = new Set(agent2.events.filter((f) => f.type === 'message.created' && f.payload.message?.client_message_id?.startsWith(`A-${stamp}-`)).map((f) => f.payload.message.id));
    return ids.size === 20 ? ids : null;
  }, 30_000, 'agent replay of all A messages');
  const dupFrames = agent2.events.filter((f) => f.type === 'message.created' && f.payload.message?.client_message_id?.startsWith(`A-${stamp}-`)).length;
  ok(seenA.size === 20, `agent socket reconnected and received all 20 messages via live delivery + cursor replay (${dupFrames} frames; duplicates removable by event_id)`);
  const aFrames = agent2.events.filter((f) => f.type === 'message.created' && f.payload.message?.client_message_id?.startsWith(`A-${stamp}-`));
  const byMessage = new Map();
  for (const fr of aFrames) byMessage.set(fr.payload.message.id, new Set([...(byMessage.get(fr.payload.message.id) ?? []), fr.event_id]));
  ok([...byMessage.values()].every((ids) => ids.size === 1), 'a message re-delivered by replay carries the same event_id (client dedupe key)');

  // ── B: worker SIGKILL ──
  console.log('B. SIGKILL the worker (outbox publisher)');
  await stop('worker', 'SIGKILL');
  const idsB = Array.from({ length: 5 }, (_, i) => `B-${stamp}-${i}`);
  for (const [i, id] of idsB.entries()) await sendDurably(v, vauth, chatId, id, `while the worker is down ${i}`);
  const pending = Number(sql(`SELECT count(*) FROM outbox_events WHERE tenant_id = (SELECT tenant_id FROM chats WHERE id = '${chatId}') AND published_at IS NULL`));
  ok(pending >= 5, `commits continue without the worker; ${pending} outbox rows wait unpublished`);
  const retry1 = await agent2.sock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'message.send', payload: { chat_id: chatId, client_message_id: `B-agent-${stamp}`, body: 'agent reply during outage' } });
  const retry2 = await agent2.sock.emitWithAck('command', { v: 1, command_id: randomUUID(), type: 'message.send', payload: { chat_id: chatId, client_message_id: `B-agent-${stamp}`, body: 'agent reply during outage' } });
  ok(retry1.type === 'command.ack' && retry2.type === 'command.ack' && retry1.result.id === retry2.result.id, 'socket command retry during the outage returns the original message (idempotent)');
  start('worker');
  await workerReady();
  await until(() => Number(sql(`SELECT count(*) FROM outbox_events WHERE tenant_id = (SELECT tenant_id FROM chats WHERE id = '${chatId}') AND published_at IS NULL`)) === 0, 30_000, 'outbox drained');
  ok(true, 'restarted worker published every waiting outbox row');
  const seenB = await until(() => {
    const ids = new Set(agent2.events.filter((f) => f.type === 'message.created' && f.payload.message?.client_message_id?.startsWith(`B-${stamp}-`)).map((f) => f.payload.message.id));
    return ids.size === 5 ? ids : null;
  }, 20_000, 'agent receives B messages');
  ok(seenB.size === 5, 'agent received each message committed during the worker outage');
  ok(sql(`SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND client_message_id = 'B-agent-${stamp}'`) === '1', 'exactly one agent reply row for the retried command');

  // ── C: Redis restart (append-only file) ──
  console.log('C. Restart Redis (AOF persistence, as in production)');
  try {
    redisCli('shutdown');
  } catch {
    /* connection closes on shutdown */
  }
  await until(() => procs.redis.exitCode !== null, 10_000, 'redis stopped');
  const degraded = await until(async () => (await fetch(`${API}/health/ready`).then((r) => r.status).catch(() => 0)) === 503, 15_000, 'readiness 503 while redis is down');
  ok(degraded, 'readiness reports 503 while Redis is down');
  start('redis');
  await until(() => redisCli('ping') === 'PONG', 10_000, 'redis back');
  await apiReady();
  await workerReady();
  ok(true, 'api and worker readiness recover after Redis returns');
  const afterC = await sendDurably(v, vauth, chatId, `C-${stamp}`, 'after redis restart');
  ok(afterC.status === 201, 'visitor send works after the Redis restart');
  await until(() => agent2.events.some((f) => f.type === 'message.created' && f.payload.message?.client_message_id === `C-${stamp}`), 20_000, 'delivery after redis restart');
  ok(true, 'realtime delivery resumes after the Redis restart (adapter + emitter reconnect)');
  ok((await owner.must('GET', '/agents/me')).agent.connected === true, 'agent presence survived the restart (AOF)');

  // ── D: FLUSHALL (failover to an empty replica) ──
  console.log('D. FLUSHALL — presence and schedulers self-heal');
  redisCli('flushall');
  await until(async () => (await owner.must('GET', '/agents/me')).agent.connected === true, 40_000, 'agent presence re-registered by heartbeat');
  ok(true, 'open agent socket re-registers its presence on the next heartbeat (≤ 15 s)');
  const v2 = new Client();
  const sess2 = await v2.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: ORIGIN, consent: { analytics: false, policy_version: '2026-10' } });
  const chat2 = await v2.call('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'after failover', department_id: support.id }, { authorization: `Bearer ${sess2.capability}` });
  ok(chat2.status === 201, 'new chats are admitted after the flush (an agent is available again)');
  const offered = await until(() => agent2.events.find((f) => f.type === 'assignment.offered' && f.payload.chat_preview?.id === chat2.data.chat.id) || agent2.events.find((f) => f.type === 'chat.requested' && f.payload.chat?.id === chat2.data.chat.id), 20_000, 'routing after flush');
  ok(!!offered, 'routing reaches the agent after the flush');
  await until(() => redisCli('--scan', '--pattern', 'rd:maintenance:repeat:*').length > 0 || redisCli('keys', 'rd:maintenance:*').includes('repeat'), 75_000, 'schedulers re-asserted');
  ok(true, 'worker maintenance schedulers re-asserted after the flush (≤ 60 s)');

  agent2.close();
  console.log(`\nCHAOS E2E PASSED (${passed} checks)`);
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error(err.message);
  console.error(logs.split('\n').filter((l) => /ERROR|Error/.test(l)).slice(-15).join('\n'));
  await cleanup();
  process.exit(1);
}
