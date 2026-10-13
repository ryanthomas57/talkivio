// Graceful drain (ch. 45, AUD-72-26, deployment.md §7) — starts its own API instance on DRAIN_PORT
// (default 4111) next to the running stack, then sends it SIGTERM and checks:
//   * /health/ready turns 503 {status: draining} immediately while the process keeps serving
//   * a request already in flight (headers received, body still streaming) completes normally
//   * new requests during the drain get 503 SERVICE_UNAVAILABLE, retryable, Connection: close
//   * sockets end with a transport close (clients auto-reconnect and replay), not a server disconnect
//   * the drain does not mark the connected agent offline (no availability interval closed)
//   * the process exits 0 after the drain delay
// Needs the built api (dist/), PostgreSQL, Redis and DATABASE_OWNER_URL (node test/drain.e2e.mjs).
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const PORT = Number(process.env.DRAIN_PORT ?? 4111);
const API = `http://localhost:${PORT}`;
const DELAY_MS = 1500;
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-F', '|', '-c', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

const child = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
  cwd: apiDir,
  env: { ...process.env, PORT: String(PORT), API_URL: API, SHUTDOWN_DRAIN_DELAY_MS: String(DELAY_MS), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
let exited = null;
child.on('exit', (code, signal) => (exited = { code, signal, at: Date.now() }));
const fail = (err) => {
  if (!exited) child.kill('SIGKILL');
  console.error(err.message);
  console.error(output.split('\n').slice(-20).join('\n'));
  process.exit(1);
};
process.on('unhandledRejection', fail);

try {
  console.log(`Setup (separate API instance on :${PORT})`);
  for (let i = 0; i < 240 && !exited; i++) {
    try {
      if ((await fetch(`${API}/health/ready`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  ok(!exited && (await fetch(`${API}/health/ready`)).status === 200, 'instance ready');

  const cookies = {};
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, path, body) => {
    const r = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieHeader(), ...(cookies.rd_csrf ? { 'x-csrf-token': cookies.rd_csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
  };
  const stamp = Date.now();
  const signup = await call('POST', '/auth/signup', { email: `drain+${stamp}@example.com`, password: 'correct horse battery', tenant_name: `Drain ${stamp}`, timezone: 'UTC' });
  ok(signup.status === 201, 'owner signed up on the instance');
  const membershipId = (await call('GET', '/agents/me')).json.data.agent.id;
  await call('PUT', '/agents/me/presence', { status: 'online' });
  const ticket = (await call('POST', '/socket-ticket')).json.data.ticket;
  const sock = io(`${API}/agent`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, reconnection: false });
  await new Promise((res, rej) => {
    sock.on('auth.ok', res);
    sock.on('connect_error', rej);
  });
  let disconnectReason = null;
  sock.on('disconnect', (reason) => (disconnectReason = reason));
  await sleep(300);
  const openIntervals = () => sql(`SELECT count(*) FROM availability_intervals WHERE membership_id = '${membershipId}' AND ended_at IS NULL AND status = 'online'`);
  ok(openIntervals() === '1', 'agent connected and online (open availability interval)');

  console.log('SIGTERM with a request in flight');
  // Headers now, body later: the request is in flight when the signal arrives.
  const body = JSON.stringify({ status: 'away' });
  const inflight = new Promise((res, rej) => {
    const req = http.request(`${API}/api/v1/agents/me/presence`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie: cookieHeader(), 'x-csrf-token': cookies.rd_csrf },
    });
    req.on('response', (r) => {
      let text = '';
      r.on('data', (d) => (text += d));
      r.on('end', () => res({ status: r.statusCode, text }));
    });
    req.on('error', rej);
    req.write(body.slice(0, 5));
    setTimeout(() => req.end(body.slice(5)), 900);
  });
  await sleep(200);
  const t0 = Date.now();
  child.kill('SIGTERM');
  await sleep(100);
  const ready = await fetch(`${API}/health/ready`);
  const readyBody = await ready.json();
  ok(ready.status === 503 && readyBody.data.status === 'draining', 'readiness reports 503 draining right after SIGTERM');
  const fresh = await call('GET', '/agents/me');
  ok(fresh.status === 503 && fresh.json.error.code === 'SERVICE_UNAVAILABLE' && fresh.json.error.retryable === true && fresh.headers.get('connection') === 'close', 'new requests during the drain get 503 SERVICE_UNAVAILABLE (retryable, Connection: close)');
  const done = await inflight;
  ok(done.status === 200 && JSON.parse(done.text).data.desired_status === 'away', 'the in-flight request completed normally (200) during the drain');

  for (let i = 0; i < 100 && !exited; i++) await sleep(100);
  ok(exited && exited.code === 0, `process exited 0 (${exited ? exited.at - t0 : '?'} ms after SIGTERM, drain delay ${DELAY_MS} ms)`);
  ok(exited.at - t0 >= DELAY_MS, 'the process stayed up for the configured drain delay');
  ok(disconnectReason === 'transport close', `socket ended with a transport close (auto-reconnect), got "${disconnectReason}"`);
  ok(!/Response from the Engine was empty|ERROR/.test(output), 'no errors logged during shutdown');
  const status = sql(`SELECT count(*) FROM availability_intervals WHERE membership_id = '${membershipId}' AND ended_at IS NULL AND status IN ('online', 'away')`);
  ok(status === '1', 'the drain did not record the agent as offline (reconnect to another replica keeps presence)');
  console.log(`\nDRAIN E2E PASSED (${passed} checks)`);
  process.exit(0);
} catch (err) {
  fail(err);
}
