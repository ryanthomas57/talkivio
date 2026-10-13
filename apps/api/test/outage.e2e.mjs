// Dependency outages (FAIL02, AUD-72-28): database, object store, scanner and mail provider, each cut and restored
// on a fully isolated stack — its own database (talkivio_outage), redis-server and api + worker from BUILD_DIR.
// The test owns every dependency it breaks:
//   * PostgreSQL is reached through a TCP proxy run by this test (cut = every connection reset, new ones refused);
//   * object storage is the local driver in a private temp directory (cut = chmod 000, so every read/write fails);
//   * the scanner is a protocol-faithful clamd INSTREAM stub (cut = listener closed);
//   * mail goes to an in-test SMTP server (cut = listener closed).
// For each outage: honest API and job states (503 SERVICE_UNAVAILABLE + Retry-After, pending/queued, never
// "delivered"/"ready"/"clean" early, never a false permanent failure), the metric its alert watches moves, and the
// same processes recover on their own once the dependency returns (no restart, no lost or duplicated writes).
// Alert rules and runbooks are checked too: every rule names an existing runbook, every metric a rule reads is
// exported by the running api or worker, and the error-budget burn condition is met during the database outage
// and not in a quiet window.
// Usage: cd apps/api && BUILD_DIR=dist node test/outage.e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import YAML from 'yaml';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(apiDir, '../..');
const BUILD = resolve(apiDir, process.env.BUILD_DIR ?? 'dist');
const PORT = Number(process.env.OUTAGE_PORT ?? 4170);
const WORKER_PORT = Number(process.env.OUTAGE_WORKER_HEALTH_PORT ?? 4071);
const REDIS_PORT = Number(process.env.OUTAGE_REDIS_PORT ?? 6392);
const API = `http://localhost:${PORT}`;
const WORKER = `http://localhost:${WORKER_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let passed = 0;
function ok(cond, msg, detail) {
  if (!cond)
    throw new Error(`ASSERTION FAILED: ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  passed++;
  console.log(`  ✓ ${msg}`);
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ───────────────────────── dependencies under test control ─────────────────────────
/** A TCP listener that can be closed and reopened on the same port (cut / restore). */
function controllable(handler) {
  const sockets = new Set();
  let server = null;
  let port = 0;
  const api = {
    get port() {
      return port;
    },
    async up() {
      server = createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => undefined);
        handler(sock, sockets);
      });
      await new Promise((r, j) => {
        server.once('error', j);
        server.listen(port, '127.0.0.1', r);
      });
      port = server.address().port;
      return api;
    },
    async down() {
      const s = server;
      server = null;
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      if (s) await new Promise((r) => s.close(() => r()));
    },
  };
  return api;
}

// PostgreSQL proxy: pipes each client to the real server; cutting it resets every connection.
const appUrl = new URL(process.env.DATABASE_URL);
const pgTarget = {
  host: appUrl.hostname === 'localhost' ? '127.0.0.1' : appUrl.hostname,
  port: Number(appUrl.port || 5432),
};
const pg = controllable((client, sockets) => {
  const upstream = connect(pgTarget.port, pgTarget.host);
  sockets.add(upstream);
  upstream.on('close', () => sockets.delete(upstream));
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close).on('close', close);
  upstream.on('error', close).on('close', close);
  client.pipe(upstream);
  upstream.pipe(client);
});

// SMTP (RFC 5321 subset): accepts every message.
const received = [];
const smtp = controllable((sock) => {
  let state = 'cmd';
  let buf = '';
  let msg = { to: [], data: '' };
  sock.write('220 talkivio-outage-smtp ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      if (state === 'data') {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        msg.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        received.push(msg);
        msg = { to: [], data: '' };
        state = 'cmd';
        sock.write(`250 2.0.0 Ok: queued as O${received.length}\r\n`);
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-talkivio-outage-smtp\r\n250 8BITMIME\r\n');
      else if (cmd === 'RCPT') {
        msg.to.push((/<([^>]*)>/.exec(line)?.[1] ?? '').toLowerCase());
        sock.write('250 2.1.5 Ok\r\n');
      } else if (cmd === 'DATA') {
        state = 'data';
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd === 'QUIT') return void sock.end('221 2.0.0 Bye\r\n');
      else sock.write('250 2.0.0 Ok\r\n');
    }
  });
});

// clamd INSTREAM stub: every stream is clean (detection itself is covered against real ClamAV in files.e2e).
const scans = { count: 0 };
const clamd = controllable((sock) => {
  let buf = Buffer.alloc(0);
  let streaming = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!streaming) {
        const i = buf.indexOf(0);
        if (i < 0) return;
        const cmd = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 1);
        if (cmd === 'zPING') return void sock.end('PONG\0');
        if (cmd !== 'zINSTREAM') return void sock.end('UNKNOWN COMMAND\0');
        streaming = true;
        continue;
      }
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len === 0) {
        scans.count++;
        return void sock.end('stream: OK\0');
      }
      if (buf.length < 4 + len) return;
      buf = buf.subarray(4 + len);
    }
  });
});

await pg.up();
await smtp.up();
await clamd.up();
// chmod-based outages need a filesystem with POSIX permissions (not exFAT) and a non-root user.
const storageDir = mkdtempSync(join(tmpdir(), 'talkivio-outage-storage-'));
const storage = {
  down: () => chmodSync(storageDir, 0o000),
  up: () => chmodSync(storageDir, 0o700),
};
if (process.getuid?.() === 0)
  throw new Error('outage.e2e must not run as root: chmod 000 cannot lock root out of the storage directory');

// ───────────────────────── isolated stack ─────────────────────────
const DB = 'talkivio_outage';
const ownerUrl = new URL(process.env.DATABASE_OWNER_URL);
ownerUrl.pathname = `/${DB}`;
ownerUrl.search = '?schema=public';
const proxiedApp = new URL(process.env.DATABASE_URL);
proxiedApp.hostname = '127.0.0.1';
proxiedApp.port = String(pg.port);
proxiedApp.pathname = `/${DB}`;
proxiedApp.search = '?schema=public&connect_timeout=3&pool_timeout=5';
const ENV = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_OWNER_URL: ownerUrl.toString(),
  DATABASE_URL: proxiedApp.toString(),
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  PORT: String(PORT),
  API_URL: API,
  WORKER_HEALTH_PORT: String(WORKER_PORT),
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: storageDir,
  SCAN_MODE: 'clamav',
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: String(clamd.port),
  CLAMAV_TIMEOUT_MS: '2000',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  TALKIVIO_EMAIL_RETRY_BASE_MS: '500',
  SHUTDOWN_DRAIN_DELAY_MS: '0',
  LOG_LEVEL: 'warn',
};
const ownerDb = new URL(ownerUrl);
ownerDb.search = '';
const sql = (q) => execFileSync('psql', [ownerDb.toString(), '-At', '-F', '|', '-c', q]).toString().trim();
const redisDir = resolve(tmpdir(), `talkivio-outage-redis-${process.pid}`);
const procs = {};
let logs = '';
function start(name, cmd, args) {
  const p = spawn(cmd, args, { cwd: apiDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs += `[${name}] ${d}`));
  p.stderr.on('data', (d) => (logs += `[${name}] ${d}`));
  procs[name] = p;
  return p;
}
const probe = (url) =>
  fetch(url)
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch(() => ({ status: 0, body: null }));
const scrape = (base) => fetch(`${base}/health/metrics`).then((r) => r.text());
/** Sum of every sample of `name` whose labels match all of `match` (label → value or RegExp). */
function sample(text, name, match = {}) {
  let total = 0;
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const labels = Object.fromEntries(
      [...(/\{([^}]*)\}/.exec(line)?.[1] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    if (
      !Object.entries(match).every(([k, v]) =>
        v instanceof RegExp ? v.test(labels[k] ?? '') : labels[k] === v,
      )
    )
      continue;
    total += Number(line.slice(line.lastIndexOf(' ') + 1));
    found = true;
  }
  return found ? total : null;
}

class Client {
  constructor(name, bearer) {
    this.name = name;
    this.bearer = bearer;
    this.cookies = {};
  }
  async call(method, path, body) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.bearer
          ? { authorization: `Bearer ${this.bearer}` }
          : {
              cookie: Object.entries(this.cookies)
                .map(([k, v]) => `${k}=${v}`)
                .join('; '),
            }),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      data: json?.data,
      error: json?.error,
    };
  }
  async must(method, path, body) {
    const r = await this.call(method, path, body);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const unavailable = (r) =>
  r.status === 503 &&
  r.error?.code === 'SERVICE_UNAVAILABLE' &&
  r.error?.retryable === true &&
  r.retryAfter === '5';
const emailRow = (to, template) => {
  const row = sql(
    `SELECT status, attempts, coalesce(last_error, '') FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!row) return null;
  const [status, attempts, lastError] = row.split('|');
  return { status, attempts: Number(attempts), lastError };
};
const messagesTo = (to) => received.filter((m) => m.to.includes(to.toLowerCase()));
const decodeQp = (s) =>
  s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const linkToken = (to, param) =>
  decodeURIComponent(
    (new RegExp(`[?&]${param}=([^\\s&"<]+)`).exec(decodeQp(messagesTo(to).at(-1)?.data ?? '')) ?? [])[1] ??
      '',
  );
function socket(ns, ticket) {
  const s = io(`${API}${ns}`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket },
    forceNew: true,
  });
  s.frames = [];
  s.disconnects = [];
  s.on('event', (f) => s.frames.push(f));
  s.on('disconnect', (reason) => s.disconnects.push(reason));
  return new Promise((r, j) => {
    s.once('auth.ok', () => r(s));
    s.once('connect_error', (e) => j(new Error(`${ns} connect_error: ${e.message}`)));
  });
}
async function upload(client, base, chatId, name, mime, bytes) {
  const init = await client.must('POST', base, {
    chat_id: chatId,
    name,
    size_bytes: bytes.length,
    mime,
    sha256: sha(bytes),
  });
  const put = async () => {
    const res = await fetch(init.url, { method: init.method, headers: init.headers, body: bytes });
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      error: (await res.json().catch(() => null))?.error,
    };
  };
  const finPath = base.startsWith('/widget')
    ? `/widget/v1/uploads/${init.upload_id}/finalize`
    : `/attachments/${init.upload_id}/finalize`;
  return { id: init.upload_id, put, finalize: () => client.call('POST', finPath, { sha256: sha(bytes) }) };
}
const attachmentState = (client, id) =>
  client.must('GET', client.bearer ? `/widget/v1/uploads/${id}` : `/attachments/${id}`);

const cleanup = () => {
  for (const p of Object.values(procs)) if (p.exitCode === null) p.kill('SIGKILL');
  try {
    storage.up();
  } catch {
    /* already gone */
  }
  rmSync(storageDir, { recursive: true, force: true });
  rmSync(redisDir, { recursive: true, force: true });
  void pg.down();
  void smtp.down();
  void clamd.down();
};

try {
  console.log(
    `Setup (isolated: db ${DB} via proxy :${pg.port}, redis :${REDIS_PORT}, api :${PORT}, smtp :${smtp.port}, clamd :${clamd.port}, storage ${storageDir})`,
  );
  rmSync(redisDir, { recursive: true, force: true });
  mkdirSync(redisDir, { recursive: true });
  start('redis', 'redis-server', [
    '--port',
    String(REDIS_PORT),
    '--save',
    '',
    '--appendonly',
    'no',
    '--dir',
    redisDir,
    '--loglevel',
    'warning',
  ]);
  await until(
    () =>
      execFileSync('redis-cli', ['-p', String(REDIS_PORT), 'ping'])
        .toString()
        .trim() === 'PONG',
    10_000,
    'redis',
  );
  execFileSync('bash', ['scripts/db-reset.sh'], { cwd: apiDir, env: ENV, stdio: 'ignore' });
  start('api', process.execPath, ['--enable-source-maps', resolve(BUILD, 'main.js')]);
  start('worker', process.execPath, ['--enable-source-maps', resolve(BUILD, 'worker.js')]);
  await until(async () => (await probe(`${API}/health/ready`)).status === 200, 60_000, 'api ready');
  await until(async () => (await probe(`${WORKER}/health/ready`)).status === 200, 60_000, 'worker ready');
  const pids = { api: procs.api.pid, worker: procs.worker.pid };

  const stamp = Date.now().toString(36);
  const owner = new Client('owner');
  const ownerEmail = `outage-owner+${stamp}@example.com`;
  await owner.must('POST', '/auth/signup', {
    email: ownerEmail,
    password: 'outage passphrase long',
    tenant_name: `Outage ${stamp}`,
    timezone: 'UTC',
  });
  await until(() => messagesTo(ownerEmail).length, 20_000, 'verification email');
  await owner.must('POST', '/auth/verify-email', { token: linkToken(ownerEmail, 'token') });
  const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
  await owner.must('PUT', '/agents/me/presence', { status: 'online' });
  const site = await owner.must('POST', '/sites', {
    name: 'Outage site',
    origins: [{ origin: 'https://outage.example', pattern_type: 'exact' }],
  });
  const sess = await new Client('anon').must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: 'https://outage.example',
    consent: { analytics: false, policy_version: '2026-10' },
  });
  const visitor = new Client('visitor', sess.capability);
  const chatId = (
    await visitor.must('POST', '/widget/v1/chats', {
      client_request_id: randomUUID(),
      message: 'Hello, is anyone there?',
    })
  ).chat.id;
  await owner.must('POST', `/chats/${chatId}/accept`, {});
  await ownerSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex',
  );
  const photo = await upload(owner, '/attachments/uploads', chatId, 'photo.png', 'image/png', PNG);
  ok(
    (await photo.put()).status === 200 && (await photo.finalize()).status === 202,
    'baseline: upload stored and finalized',
  );
  await until(
    async () => (await attachmentState(owner, photo.id)).state === 'clean',
    20_000,
    'baseline scan',
  );
  ok(
    scans.count === 1,
    'baseline: stack up (database via proxy, SMTP, clamd, local storage) and the first file scanned clean',
  );

  // Quiet window: ordinary traffic must not meet the fast-burn condition. Only writes are commands (reads are not
  // part of the error budget), so the traffic here and during the database outage is presence updates.
  const burn = (before, after) => {
    const total = (t) =>
      sample(t, 'talkivio_commands_total', { outcome: /^(?!validation$|denied$|rate_limited$)/ }) ?? 0;
    const bad = (t) =>
      sample(t, 'talkivio_commands_total', { outcome: /^(server_error|dependency_error)$/ }) ?? 0;
    const dTotal = total(after) - total(before);
    return { ratio: dTotal > 0 ? (bad(after) - bad(before)) / dTotal : 0, commands: dTotal };
  };
  const quiet0 = await scrape(API);
  for (let i = 0; i < 10; i++) await owner.must('PUT', '/agents/me/presence', { status: 'online' });
  const quiet = burn(quiet0, await scrape(API));
  ok(
    quiet.commands >= 10 && quiet.ratio / 0.001 < 14.4,
    `quiet window: error-budget burn ${(quiet.ratio / 0.001).toFixed(1)}× over ${quiet.commands} commands — below the 14.4× fast-burn threshold`,
  );

  // ───────────────────────── mail provider (RB-08) ─────────────────────────
  console.log('Mail provider outage (SMTP refused)');
  const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
  const workerBefore = await scrape(WORKER);
  await smtp.down();
  const invitee = `outage-invitee+${stamp}@example.com`;
  await owner.must('POST', '/agents/invitations', {
    email: invitee,
    role: 'agent',
    department_ids: [support.id],
    capacity: 3,
  });
  const pendingMail = await until(
    () => {
      const r = emailRow(invitee, 'agent_invitation');
      return r && r.attempts >= 2 ? r : null;
    },
    15_000,
    'two failed SMTP attempts',
  );
  ok(
    pendingMail.status === 'queued' && /ECONNREFUSED/.test(pendingMail.lastError),
    `while SMTP is down the invitation stays "queued" with the connection error (${pendingMail.attempts} attempts, ${pendingMail.lastError.slice(0, 50)})`,
  );
  ok(
    (sample(await scrape(WORKER), 'talkivio_email_deliveries_total', { outcome: 'retried' }) ?? 0) >
      (sample(workerBefore, 'talkivio_email_deliveries_total', { outcome: 'retried' }) ?? 0),
    'talkivio_email_deliveries_total{outcome="retried"} counts the failed attempts',
  );
  // OFF01: an offline form submitted during the outage is saved at once; its two emails wait and are sent once later.
  const offlineEmail = `outage-visitor+${stamp}@example.com`;
  const offSess = await new Client('anon').must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: 'https://outage.example',
    consent: { analytics: false, policy_version: '2026-10' },
  });
  const offVisitor = new Client('offline-visitor', offSess.capability);
  const offline = await offVisitor.call('POST', '/widget/v1/offline-submissions', {
    client_request_id: randomUUID(),
    name: 'Otto Outage',
    email: offlineEmail,
    message: 'Please write back when you can',
  });
  ok(
    offline.status === 201 && /^R-/.test(offline.data?.reference ?? ''),
    `offline form accepted during the mail outage (${offline.status} ${offline.data?.reference ?? offline.error?.code})`,
  );
  const offlineQueued = await until(
    () => {
      const c = emailRow(offlineEmail, 'offline_confirmation');
      const t = emailRow(ownerEmail, 'offline_team_notification');
      return c && t && c.attempts >= 1 && t.attempts >= 1 ? { c, t } : null;
    },
    20_000,
    'offline emails attempted',
  );
  ok(
    offlineQueued.c.status === 'queued' &&
      offlineQueued.t.status === 'queued' &&
      /ECONNREFUSED/.test(offlineQueued.c.lastError),
    'its visitor confirmation and team notification stay "queued" with the connection error',
  );
  await smtp.up();
  const delivered = await until(
    () =>
      emailRow(invitee, 'agent_invitation')?.status === 'accepted'
        ? emailRow(invitee, 'agent_invitation')
        : null,
    30_000,
    'delivery after SMTP returns',
  );
  ok(
    messagesTo(invitee).length === 1 && delivered.lastError === '',
    `after SMTP returns the same email is delivered exactly once (attempt ${delivered.attempts})`,
  );
  await until(
    () =>
      emailRow(offlineEmail, 'offline_confirmation')?.status === 'accepted' &&
      emailRow(ownerEmail, 'offline_team_notification')?.status === 'accepted',
    30_000,
    'offline emails after SMTP returns',
  );
  const teamCopies = messagesTo(ownerEmail).filter((m) => m.data.includes(offline.data.reference));
  ok(
    messagesTo(offlineEmail).length === 1 && teamCopies.length === 1,
    `after SMTP returns the confirmation and the team notification are each delivered exactly once (reference ${offline.data.reference})`,
  );

  // ───────────────────────── scanner (RB-06) ─────────────────────────
  console.log('Scanner outage (clamd unreachable)');
  await clamd.down();
  const note = await upload(
    visitor,
    '/widget/v1/uploads',
    chatId,
    'notes.txt',
    'text/plain',
    Buffer.from('scan me after the outage\n'),
  );
  ok(
    (await note.put()).status === 200 && (await note.finalize()).status === 202,
    'upload accepted while the scanner is down',
  );
  const pendingScan = await until(
    async () => {
      const r = await attachmentState(visitor, note.id);
      return r.error_code === 'FILE_SCAN_PENDING' ? r : null;
    },
    15_000,
    'pending scan state',
  );
  ok(
    pendingScan.state === 'scanning' && pendingScan.error_message,
    `the file stays "scanning" with FILE_SCAN_PENDING ("${pendingScan.error_message}")`,
  );
  const sendPending = await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, {
    client_message_id: randomUUID(),
    attachment_ids: [note.id],
  });
  ok(
    sendPending.status === 409 && sendPending.error.code === 'FILE_SCAN_PENDING',
    'an unscanned file cannot be sent',
  );
  const backlog1 = await until(
    async () => sample(await scrape(WORKER), 'talkivio_scan_backlog_seconds'),
    10_000,
    'scan backlog gauge',
  );
  await sleep(5500);
  const backlog2 = sample(await scrape(WORKER), 'talkivio_scan_backlog_seconds');
  ok(
    backlog1 > 0 && backlog2 > backlog1,
    `talkivio_scan_backlog_seconds grows during the outage (${backlog1} → ${backlog2} s; TalkivioScanBacklog fires above 300 s)`,
  );
  await clamd.up();
  const clean = await until(
    async () => {
      const r = await attachmentState(visitor, note.id);
      return r.state === 'clean' ? r : null;
    },
    45_000,
    'scan after the scanner returns',
  );
  ok(
    clean.state === 'clean' && scans.count === 2,
    'the queued scan retried on its own once clamd returned and the file became clean',
  );
  await sleep(5500);
  ok(sample(await scrape(WORKER), 'talkivio_scan_backlog_seconds') === 0, 'scan backlog gauge back to 0');

  // ───────────────────────── object store (RB-07) ─────────────────────────
  console.log('Object store outage (storage unreadable and unwritable)');
  const apiBefore = await scrape(API);
  storage.down();
  const grant = await owner.must('GET', `/attachments/${photo.id}/download`);
  const dl = await fetch(grant.url);
  const dlBody = await dl.json().catch(() => null);
  ok(
    dl.status === 503 &&
      dlBody?.error?.code === 'SERVICE_UNAVAILABLE' &&
      dlBody.error.retryable === true &&
      dl.headers.get('retry-after') === '5',
    `download → 503 SERVICE_UNAVAILABLE "${dlBody?.error?.message}" with Retry-After: 5`,
  );
  const late = await upload(owner, '/attachments/uploads', chatId, 'late.png', 'image/png', PNG);
  const putDown = await late.put();
  ok(unavailable(putDown), `upload PUT → 503 SERVICE_UNAVAILABLE, retryable (${putDown.error?.message})`);
  ok(
    sql(`SELECT state FROM attachments WHERE id = '${late.id}'`) === 'initiated',
    'the upload returns to "initiated", so the same link can be retried',
  );
  const exp = await owner.call('POST', '/exports', { chat_ids: [chatId], format: 'json' });
  ok(exp.status === 202, 'export request accepted (queued) while storage is down');
  const jobId = sql(`SELECT job_id FROM exports WHERE id = '${exp.data.id}'`);
  const failedAttempt = await until(
    () => {
      const [state, attempts, code] = sql(
        `SELECT state, attempts, coalesce(last_error_code, '') FROM jobs WHERE id = '${jobId}'`,
      ).split('|');
      return Number(attempts) >= 1 && state === 'queued' ? { state, attempts: Number(attempts), code } : null;
    },
    15_000,
    'first failed export attempt',
  );
  const expView = await owner.must('GET', `/exports/${exp.data.id}`);
  ok(
    failedAttempt.code === 'SERVICE_UNAVAILABLE' && expView.state === 'queued',
    `the export job recorded SERVICE_UNAVAILABLE and is queued for retry — not ready, not failed (attempt ${failedAttempt.attempts})`,
  );
  const apiDuring = await scrape(API);
  const depErrors = (t) => sample(t, 'talkivio_commands_total', { outcome: 'dependency_error' }) ?? 0;
  ok(
    depErrors(apiDuring) - depErrors(apiBefore) >= 1,
    `storage failures count as dependency_error commands (+${depErrors(apiDuring) - depErrors(apiBefore)})`,
  );
  storage.up();
  ok(
    (await late.put()).status === 200 && (await late.finalize()).status === 202,
    'after storage returns the same upload link works',
  );
  await until(
    async () => (await attachmentState(owner, late.id)).state === 'clean',
    30_000,
    'late upload clean',
  );
  const regrant = await owner.must('GET', `/attachments/${photo.id}/download`);
  const again = await fetch(regrant.url);
  ok(
    again.status === 200 && sha(Buffer.from(await again.arrayBuffer())) === sha(PNG),
    'downloads serve the exact bytes again',
  );
  const ready = await until(
    async () => {
      const r = await owner.must('GET', `/exports/${exp.data.id}`);
      return r.state === 'ready' ? r : null;
    },
    30_000,
    'export ready after storage returns',
  );
  ok(ready.state === 'ready', 'the export retried and became ready without a new request');

  // ───────────────────────── database (RB-04) ─────────────────────────
  console.log('Database outage (every connection reset, new connections refused)');
  const dbBefore = await scrape(API);
  await pg.down();
  const apiReady = await until(
    async () => {
      const r = await probe(`${API}/health/ready`);
      return r.status === 503 ? r : null;
    },
    15_000,
    'api readiness to drop',
  );
  ok(
    apiReady.body?.data?.checks?.database === 'unavailable' && apiReady.body.data.checks.redis === 'ok',
    'api /health/ready → 503 {database: unavailable, redis: ok} (TalkivioApiReadinessLost)',
  );
  const workerReady = await until(
    async () => {
      const r = await probe(`${WORKER}/health/ready`);
      return r.status === 503 ? r : null;
    },
    15_000,
    'worker readiness to drop',
  );
  ok(
    workerReady.body?.data?.checks?.database === 'unavailable',
    'worker /health/ready → 503 {database: unavailable}',
  );
  ok(
    (await probe(`${API}/health/live`)).status === 200,
    'liveness stays 200: the process is healthy, so the orchestrator does not restart-loop it',
  );
  const read = await owner.call('GET', '/departments');
  ok(
    unavailable(read),
    `staff read → 503 SERVICE_UNAVAILABLE, retryable, Retry-After: 5 ("${read.error?.message}")`,
  );
  const agentMsgId = randomUUID();
  const agentSend = await owner.call('POST', `/chats/${chatId}/messages`, {
    client_message_id: agentMsgId,
    body: 'Sent during the database outage',
  });
  ok(unavailable(agentSend), 'agent send → 503 SERVICE_UNAVAILABLE, retryable');
  const visitorMsgId = randomUUID();
  const visitorSend = await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, {
    client_message_id: visitorMsgId,
    body: 'Visitor message during the outage',
  });
  ok(unavailable(visitorSend), 'visitor send → 503 SERVICE_UNAVAILABLE, retryable');
  const lateSignup = `outage-late+${stamp}@example.com`;
  ok(
    unavailable(
      await new Client('late').call('POST', '/auth/signup', {
        email: lateSignup,
        password: 'outage passphrase long',
        tenant_name: 'Late',
        timezone: 'UTC',
      }),
    ),
    'signup → 503 SERVICE_UNAVAILABLE',
  );
  const presence = [];
  for (let i = 0; i < 5; i++)
    presence.push(await owner.call('PUT', '/agents/me/presence', { status: 'online' }));
  ok(presence.every(unavailable), 'presence updates → 503 SERVICE_UNAVAILABLE');
  const gaugesGone = await until(
    async () => {
      const [a, w] = await Promise.all([scrape(API), scrape(WORKER)]);
      return sample(a, 'talkivio_outbox_oldest_unpublished_seconds') === null &&
        sample(w, 'talkivio_outbox_oldest_unpublished_seconds') === null &&
        sample(w, 'talkivio_scan_backlog_seconds') === null
        ? a
        : null;
    },
    15_000,
    'DB-derived gauges to disappear',
  );
  ok(true, 'DB-derived gauges are absent, not frozen at their last value (TalkivioOperationalSignalsAbsent)');
  const outageBurn = burn(dbBefore, gaugesGone);
  ok(
    outageBurn.ratio / 0.001 > 14.4,
    `outage window: error-budget burn ${(outageBurn.ratio / 0.001).toFixed(0)}× over ${outageBurn.commands} commands — meets the 14.4× fast-burn condition (TalkivioErrorBudgetBurnFast)`,
  );
  await pg.up();
  await until(
    async () =>
      (await probe(`${API}/health/ready`)).status === 200 &&
      (await probe(`${WORKER}/health/ready`)).status === 200,
    60_000,
    'readiness after the database returns',
  );
  ok(
    procs.api.pid === pids.api &&
      procs.worker.pid === pids.worker &&
      procs.api.exitCode === null &&
      procs.worker.exitCode === null,
    'api and worker recovered on their own — same processes, no restart',
  );
  ok(
    (
      await owner.call('POST', `/chats/${chatId}/messages`, {
        client_message_id: agentMsgId,
        body: 'Sent during the database outage',
      })
    ).status === 201,
    'the agent retry with the same client_message_id succeeds',
  );
  ok(
    (
      await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, {
        client_message_id: visitorMsgId,
        body: 'Visitor message during the outage',
      })
    ).status === 201,
    'the visitor retry succeeds',
  );
  ok(
    sql(
      `SELECT count(*) FROM messages WHERE chat_id = '${chatId}' AND client_message_id IN ('${agentMsgId}', '${visitorMsgId}')`,
    ) === '2',
    'exactly one stored message per retried send (nothing half-written during the outage)',
  );
  ok(
    sql(`SELECT count(*) FROM users WHERE email = '${lateSignup}'`) === '0',
    'the refused signup left no account behind',
  );
  const live = await until(
    () =>
      ownerSock.frames.find(
        (f) => f.type === 'message.created' && f.payload.message?.client_message_id === visitorMsgId,
      ),
    15_000,
    'live delivery after recovery',
  ).catch((err) => {
    console.error('owner socket', {
      connected: ownerSock.connected,
      disconnects: ownerSock.disconnects,
      frames: ownerSock.frames.slice(-8).map((f) => f.type),
    });
    throw err;
  });
  ok(
    live && ownerSock.connected,
    'the agent socket stayed connected and received the retried visitor message live',
  );
  await until(
    () => sql(`SELECT count(*) FROM outbox_events WHERE published_at IS NULL`) === '0',
    15_000,
    'outbox drained',
  );
  ok(true, 'outbox drained after recovery (no event stuck unpublished)');

  // ───────────────────────── alert rules and runbooks (AUD-72-28) ─────────────────────────
  console.log('Alert rules and runbooks');
  const rules = YAML.parse(
    readFileSync(resolve(repoDir, 'infra/observability/alert-rules.yml'), 'utf8'),
  ).groups.flatMap((g) => g.rules);
  const alerts = rules.filter((r) => r.alert);
  const runbooks = readFileSync(resolve(repoDir, 'docs/operations/runbooks.md'), 'utf8');
  const runbookIds = new Set([...runbooks.matchAll(/^## (RB-\d+)/gm)].map((m) => m[1]));
  const alertDoc = readFileSync(resolve(repoDir, 'docs/operations/alerts.md'), 'utf8');
  const missingRunbook = alerts.filter((a) => !runbookIds.has(a.labels?.runbook)).map((a) => a.alert);
  ok(
    alerts.length >= 10 && missingRunbook.length === 0,
    `all ${alerts.length} Prometheus alerts name an existing runbook section`,
    missingRunbook,
  );
  const tableRows = alertDoc.split('\n').filter((l) => /^\| `Talkivio\w+`/.test(l));
  const docRunbooks = tableRows.flatMap((l) => [...l.matchAll(/RB-\d+/g)].map((m) => m[0]));
  ok(
    docRunbooks.length >= 20 && docRunbooks.every((id) => runbookIds.has(id)),
    `every runbook referenced from alerts.md exists (${new Set(docRunbooks).size} distinct)`,
  );
  const undocumented = alerts.filter((a) => !alertDoc.includes(`\`${a.alert}\``)).map((a) => a.alert);
  ok(undocumented.length === 0, 'every Prometheus alert is documented in alerts.md', undocumented);
  const exported = `${await scrape(API)}\n${await scrape(WORKER)}`;
  const exportedNames = new Set([...exported.matchAll(/^# TYPE (\w+)/gm)].map((m) => m[1]));
  const referenced = new Set(
    rules.flatMap((r) =>
      [...String(r.expr).matchAll(/\b(talkivio_\w+)/g)].map((m) => m[1].replace(/_(bucket|sum|count)$/, '')),
    ),
  );
  const dead = [...referenced].filter((n) => !exportedNames.has(n));
  ok(
    referenced.size >= 8 && dead.length === 0,
    `every metric the rules read is exported by the running api/worker (${referenced.size} metrics)`,
    dead,
  );
} catch (err) {
  console.error(logs.split('\n').slice(-40).join('\n'));
  cleanup();
  throw err;
}
cleanup();
console.log(`\nOUTAGE E2E PASSED (${passed} checks)`);
process.exit(0);
