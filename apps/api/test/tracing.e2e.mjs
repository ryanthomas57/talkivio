// Message-lifecycle tracing without content leaks (AUD-72-27) on a fully isolated stack — its own database
// (talkivio_trace), redis-server and api + worker from BUILD_DIR — exporting OpenTelemetry spans to an OTLP/HTTP
// receiver run by this test. A real conversation carries canary strings (message bodies, a search term, an email,
// a password, a forwarded client address); afterwards:
//   * one trace follows an agent's message across processes: the api's POST /chats/:id/messages server span →
//     the worker's `outbox.publish message.created` span (continued from the traceparent stored with the outbox
//     row) → the Redis PUBLISH that fans the frame out to sockets;
//   * the internal event dispatch and every service are named correctly (talkivio-api / talkivio-worker);
//   * no exported byte contains a canary, the download grant's signature, the visitor capability or the client
//     address, while the requests that carried them were traced (with their query strings removed).
// Usage: cd apps/api && BUILD_DIR=dist node test/tracing.e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(apiDir, process.env.BUILD_DIR ?? 'dist');
const PORT = Number(process.env.TRACE_PORT ?? 4185);
const WORKER_PORT = Number(process.env.TRACE_WORKER_HEALTH_PORT ?? 4085);
const REDIS_PORT = Number(process.env.TRACE_REDIS_PORT ?? 6394);
const API = `http://localhost:${PORT}`;
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
  let last = null;
  while (Date.now() < end) {
    try {
      const v = await pred();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? ` (last error: ${last.message}${last.cause ? ` — ${last.cause.code ?? ''} ${last.cause.message}` : ''})` : ''}`,
  );
}

// ───────────────────────── OTLP/HTTP (JSON) receiver ─────────────────────────
const raw = [];
const spans = [];
const value = (v) =>
  v?.stringValue ??
  v?.intValue ??
  v?.doubleValue ??
  v?.boolValue ??
  (v?.arrayValue ? v.arrayValue.values?.map(value) : undefined);
const attrs = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));
// Stable HTTP semantic conventions, with the older names as a fallback.
const method = (s) => s.attributes['http.request.method'] ?? s.attributes['http.method'];
const path = (s) => String(s.attributes['url.path'] ?? s.attributes['http.target'] ?? '').split('?')[0];
const otlp = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    raw.push(text);
    try {
      for (const rs of JSON.parse(text).resourceSpans ?? []) {
        const service = attrs(rs.resource?.attributes)['service.name'];
        for (const ss of rs.scopeSpans ?? [])
          for (const s of ss.spans ?? [])
            spans.push({ ...s, service, scope: ss.scope?.name, attributes: attrs(s.attributes) });
      }
    } catch {
      /* non-JSON payloads are still scanned as raw text */
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((r) => otlp.listen(0, '127.0.0.1', r));

// ───────────────────────── isolated stack ─────────────────────────
const DB = 'talkivio_trace';
const ownerUrl = new URL(process.env.DATABASE_OWNER_URL);
ownerUrl.pathname = `/${DB}`;
ownerUrl.search = '?schema=public';
const appUrl = new URL(process.env.DATABASE_URL);
appUrl.pathname = `/${DB}`;
appUrl.search = '?schema=public';
const storageDir = resolve(tmpdir(), `talkivio-trace-storage-${process.pid}`);
const redisDir = resolve(tmpdir(), `talkivio-trace-redis-${process.pid}`);
const ENV = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_OWNER_URL: ownerUrl.toString(),
  DATABASE_URL: appUrl.toString(),
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  PORT: String(PORT),
  API_URL: API,
  WORKER_HEALTH_PORT: String(WORKER_PORT),
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: storageDir,
  SCAN_MODE: 'dev_unscanned',
  EMAIL_PROVIDER: 'console',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlp.address().port}`,
  OTEL_BSP_SCHEDULE_DELAY: '200',
  OTEL_TRACES_SAMPLER: 'always_on',
  SHUTDOWN_DRAIN_DELAY_MS: '0',
  LOG_LEVEL: process.env.TRACE_LOG_LEVEL ?? 'warn',
};
const ownerDb = new URL(ownerUrl);
ownerDb.search = '';
const sql = (q) => execFileSync('psql', [ownerDb.toString(), '-At', '-c', q]).toString().trim();
const procs = [];
let logs = '';
function start(name, cmd, args) {
  const p = spawn(cmd, args, { cwd: apiDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs += `[${name}] ${d}`));
  p.stderr.on('data', (d) => (logs += `[${name}] ${d}`));
  p.on('exit', (code, signal) => (logs += `[${name}] exited (code ${code}, signal ${signal})\n`));
  procs.push(p);
}
const ready = (url) => fetch(url).then((r) => r.status === 200);

const CLIENT_IP = '203.0.113.77';
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
        'x-forwarded-for': CLIENT_IP,
        'user-agent': 'TraceCanaryAgent/1.0',
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
    return { status: res.status, data: json?.data, error: json?.error };
  }
  async must(method, path, body) {
    const r = await this.call(method, path, body);
    if (r.status >= 400)
      throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}

const cleanup = () => {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  otlp.close();
  rmSync(redisDir, { recursive: true, force: true });
  rmSync(storageDir, { recursive: true, force: true });
};
try {
  console.log(
    `Setup (isolated: db ${DB}, redis :${REDIS_PORT}, api :${PORT}, OTLP receiver :${otlp.address().port})`,
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
  await until(() => ready(`${API}/health/ready`), 60_000, 'api ready');
  await until(() => ready(`http://localhost:${WORKER_PORT}/health/ready`), 60_000, 'worker ready');

  const stamp = Date.now().toString(36);
  const canary = {
    visitorBody: `VisitorBodyCanary${stamp}`,
    agentBody: `AgentBodyCanary${stamp}`,
    search: `SearchCanary${stamp}`,
    email: `trace-owner+${stamp}@example.com`,
    password: `PasswordCanary${stamp}`,
    file: `FileContentCanary${stamp}`,
  };
  const owner = new Client('owner');
  await owner.must('POST', '/auth/signup', {
    email: canary.email,
    password: canary.password,
    tenant_name: `Trace ${stamp}`,
    timezone: 'UTC',
  });
  const verifyText = await until(
    () =>
      sql(
        `SELECT text_body FROM outbound_emails WHERE recipient = '${canary.email}' AND template = 'verify_email' LIMIT 1`,
      ),
    10_000,
    'verification email',
  );
  await owner.must('POST', '/auth/verify-email', {
    token: decodeURIComponent(/[?&]token=([^\s&]+)/.exec(verifyText)[1]),
  });
  const agentSock = io(`${API}/agent`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket: (await owner.must('POST', '/socket-ticket')).ticket },
    forceNew: true,
  });
  await new Promise((r, j) => {
    agentSock.once('auth.ok', r);
    agentSock.once('connect_error', j);
  });
  await owner.must('PUT', '/agents/me/presence', { status: 'online' });
  const site = await owner.must('POST', '/sites', {
    name: 'Trace site',
    origins: [{ origin: 'https://trace.example', pattern_type: 'exact' }],
  });
  const sess = await new Client('anon').must('POST', '/widget/v1/sessions', {
    site_key: site.public_key,
    host_origin: 'https://trace.example',
    consent: { analytics: false, policy_version: '2026-10' },
  });
  const visitor = new Client('visitor', sess.capability);
  const chatId = (
    await visitor.must('POST', '/widget/v1/chats', {
      client_request_id: randomUUID(),
      message: canary.visitorBody,
    })
  ).chat.id;
  const vSock = io(`${API}/visitor`, {
    path: '/realtime/v1',
    transports: ['websocket'],
    auth: { ticket: (await visitor.must('POST', '/widget/v1/socket-ticket')).ticket },
    forceNew: true,
  });
  const frames = [];
  vSock.on('event', (f) => frames.push(f));
  await new Promise((r, j) => {
    vSock.once('auth.ok', r);
    vSock.once('connect_error', j);
  });
  await vSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });
  await owner.must('POST', `/chats/${chatId}/accept`, {});
  const sent = await owner.must('POST', `/chats/${chatId}/messages`, {
    client_message_id: randomUUID(),
    body: canary.agentBody,
  });
  await until(
    () => frames.find((f) => f.type === 'message.created' && f.payload.message.id === sent.id),
    10_000,
    'visitor socket frame',
  );
  const bytes = Buffer.from(`${canary.file}\n`);
  const up = await owner.must('POST', '/attachments/uploads', {
    chat_id: chatId,
    name: 'notes.txt',
    size_bytes: bytes.length,
    mime: 'text/plain',
    sha256: sha(bytes),
  });
  await fetch(up.url, { method: up.method, headers: up.headers, body: bytes });
  await owner.must('POST', `/attachments/${up.upload_id}/finalize`, { sha256: sha(bytes) });
  await until(
    async () => (await owner.must('GET', `/attachments/${up.upload_id}`)).state === 'clean',
    20_000,
    'file clean',
  );
  const grant = await owner.must('GET', `/attachments/${up.upload_id}/download`);
  const sig = new URL(grant.url).searchParams.get('sig');
  ok(
    (await fetch(grant.url)).status === 200 && sig.length > 20,
    'conversation, socket delivery, upload and signed download done (canaries in bodies, search, email, password, file)',
  );
  await owner.must('GET', `/chats/history?q=${canary.search}`);

  console.log('One trace follows the message across processes');
  const isPostMessages = (s) =>
    s.service === 'talkivio-api' &&
    s.kind === 2 &&
    method(s) === 'POST' &&
    path(s) === `/api/v1/chats/${chatId}/messages`;
  const post = await until(() => spans.find(isPostMessages), 20_000, 'api server span for the send');
  const publish = await until(
    () =>
      spans.find(
        (s) =>
          s.service === 'talkivio-worker' &&
          s.name === 'outbox.publish message.created' &&
          s.traceId === post.traceId,
      ),
    20_000,
    'worker publish span in the same trace',
  );
  const traceSpans = spans.filter((s) => s.traceId === post.traceId);
  ok(
    traceSpans.some((s) => s.spanId === publish.parentSpanId && s.service === 'talkivio-api'),
    `the worker's publish span is a child of the api request (trace ${post.traceId.slice(0, 8)}…, ${traceSpans.length} spans)`,
  );
  ok(
    publish.attributes['talkivio.event_type'] === 'message.created' &&
      publish.attributes['talkivio.audience'] &&
      Number(publish.attributes['talkivio.outbox.lag_ms']) >= 0,
    `publish span carries identifiers and timing (audience ${publish.attributes['talkivio.audience']}, lag ${publish.attributes['talkivio.outbox.lag_ms']} ms)`,
  );
  const fanout = await until(
    () =>
      spans.find(
        (s) =>
          s.traceId === post.traceId &&
          s.parentSpanId === publish.spanId &&
          /^publish$/i.test(String(s.attributes['db.query.text'] ?? s.attributes['db.statement'] ?? '')),
      ),
    10_000,
    'redis publish under the publish span',
  );
  ok(
    fanout,
    `the socket fan-out (Redis ${fanout.attributes['db.query.text'] ?? fanout.attributes['db.statement']}) is inside the publish span, recorded as the command name only`,
  );
  const dispatch = await until(
    () => spans.find((s) => s.service === 'talkivio-worker' && s.name === 'outbox.dispatch internal'),
    10_000,
    'internal dispatch span',
  );
  ok(
    Number(dispatch.attributes['messaging.batch.message_count']) >= 1,
    'internal event dispatch is traced (batch span joined to or linking the originating traces)',
  );
  ok(
    new Set(spans.map((s) => s.service)).size === 2 && spans.some((s) => s.service === 'talkivio-worker'),
    `services are named per process (${[...new Set(spans.map((s) => s.service))].join(', ')})`,
  );

  console.log('No content, credentials or personal data in any exported span');
  await sleep(1500);
  const exported = raw.join('\n');
  const cookies = Object.fromEntries(
    Object.entries(owner.cookies)
      .filter(([, v]) => v.length >= 16)
      .map(([k, v]) => [`cookie ${k}`, v]),
  );
  const leaks = Object.entries({
    ...canary,
    emailEncoded: encodeURIComponent(canary.email),
    grantSignature: sig,
    capability: sess.capability,
    clientAddress: CLIENT_IP,
    userAgent: 'TraceCanaryAgent',
    ...cookies,
  }).filter(([, v]) => exported.includes(v));
  ok(
    spans.length > 50 && leaks.length === 0,
    `${spans.length} spans (${(exported.length / 1024).toFixed(0)} KiB) contain none of the canaries, the grant signature, the capability, session/CSRF cookies (${Object.keys(cookies).length}), the client address or the user agent`,
    leaks.map(([k]) => k),
  );
  const searchSpan = spans.find((s) => s.kind === 2 && path(s) === '/api/v1/chats/history');
  ok(
    searchSpan &&
      !JSON.stringify(searchSpan.attributes).includes('?') &&
      !('url.query' in searchSpan.attributes),
    'the search request was traced without its query string',
  );
  const grantSpan = spans.find(
    (s) => s.kind === 2 && path(s) === `/api/v1/attachments/${up.upload_id}/content`,
  );
  ok(
    grantSpan && !JSON.stringify(grantSpan.attributes).includes('sig='),
    'the signed download was traced without its signature',
  );
  const forbiddenKeys = [
    'http.client_ip',
    'client.address',
    'http.user_agent',
    'user_agent.original',
    'url.query',
    'exception.message',
  ];
  ok(
    !spans.some((s) => forbiddenKeys.some((k) => k in s.attributes)),
    `no span carries ${forbiddenKeys.join(', ')}`,
  );
  const redisStatements = spans
    .filter((s) => s.attributes['db.system.name'] === 'redis' || s.attributes['db.system'] === 'redis')
    .map((s) => s.attributes['db.query.text'] ?? s.attributes['db.statement'])
    .filter((v) => typeof v === 'string');
  ok(
    redisStatements.length > 20 && redisStatements.every((v) => /^[A-Za-z.]+$/.test(v)),
    `Redis spans record command names only (${new Set(redisStatements).size} distinct, e.g. ${[...new Set(redisStatements)].slice(0, 4).join(', ')})`,
  );
  vSock.close();
  agentSock.close();
} catch (err) {
  const dump = resolve(tmpdir(), 'talkivio-trace-spans.json');
  writeFileSync(
    dump,
    JSON.stringify(
      spans.map((x) => ({
        service: x.service,
        scope: x.scope,
        name: x.name,
        kind: x.kind,
        traceId: x.traceId,
        spanId: x.spanId,
        parentSpanId: x.parentSpanId,
        attributes: x.attributes,
      })),
      null,
      1,
    ),
  );
  console.error(`${spans.length} spans received; summary written to ${dump}`);
  console.error(logs.split('\n').slice(-30).join('\n'));
  cleanup();
  throw err;
}
cleanup();
console.log(`\nTRACING E2E PASSED (${passed} checks)`);
process.exit(0);
