// Real SMTP delivery and honest retry states (AUD-72-19, AUTH01, FAIL02 mail provider) on a fully isolated stack:
// its own database (talkivio_smtp), its own redis-server and its own api + worker from BUILD_DIR, configured with
// EMAIL_PROVIDER=smtp against an SMTP server run by this test (plain SMTP over TCP, RFC 5321 subset).
//   * a verification email is delivered over SMTP: one message per email, real headers and body, and the link in the
//     received message verifies the account;
//   * a temporary failure (451) leaves the email queued with attempts + last_error, never "failed" or delivered,
//     and the retry delivers it exactly once;
//   * a permanent rejection (550) ends "failed" only after the final attempt; nothing is ever reported as delivered
//     without a provider callback (status stays "accepted" after SMTP acceptance).
// TALKIVIO_EMAIL_RETRY_BASE_MS (non-production) shortens the backoff so the 8 attempts finish in seconds.
// Usage: cd apps/api && BUILD_DIR=dist node test/smtp.e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(apiDir, process.env.BUILD_DIR ?? 'dist');
const PORT = Number(process.env.SMTP_E2E_PORT ?? 4160);
const REDIS_PORT = Number(process.env.SMTP_E2E_REDIS_PORT ?? 6391);
const API = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ───────────────────────── SMTP server under test control ─────────────────────────
const received = [];
const policy = { tempFail: new Map(), reject: new Set() }; // recipient → remaining 451 replies; recipients answered 550
const smtp = createServer((sock) => {
  let state = 'cmd';
  let msg = { from: '', to: [], data: '' };
  let buf = '';
  sock.write('220 talkivio-test-smtp ESMTP ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      if (state === 'data') {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        msg.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
        buf = buf.slice(end + 5);
        received.push(msg);
        sock.write(`250 2.0.0 Ok: queued as T${received.length}\r\n`);
        msg = { from: '', to: [], data: '' };
        state = 'cmd';
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO')
        sock.write('250-talkivio-test-smtp\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      else if (cmd === 'MAIL') {
        msg.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        sock.write('250 2.1.0 Ok\r\n');
      } else if (cmd === 'RCPT') {
        const to = (/<([^>]*)>/.exec(line)?.[1] ?? '').toLowerCase();
        const left = policy.tempFail.get(to) ?? 0;
        if (policy.reject.has(to)) sock.write('550 5.1.1 Mailbox unavailable\r\n');
        else if (left > 0) {
          policy.tempFail.set(to, left - 1);
          sock.write('451 4.3.0 Temporary local problem, try again\r\n');
        } else {
          msg.to.push(to);
          sock.write('250 2.1.5 Ok\r\n');
        }
      } else if (cmd === 'DATA') {
        state = 'data';
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd === 'RSET') {
        msg = { from: '', to: [], data: '' };
        sock.write('250 2.0.0 Ok\r\n');
      } else if (cmd === 'QUIT') {
        sock.end('221 2.0.0 Bye\r\n');
        return;
      } else sock.write('250 2.0.0 Ok\r\n');
    }
  });
  sock.on('error', () => undefined);
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const SMTP_PORT = smtp.address().port;

// ───────────────────────── isolated stack ─────────────────────────
const ownerBase = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '').replace(/\/[^/]*$/, '');
const appBase = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '').replace(/\/[^/]*$/, '');
const DB = 'talkivio_smtp';
const ENV = {
  ...process.env,
  DATABASE_OWNER_URL: `${ownerBase}/${DB}?schema=public`,
  DATABASE_URL: `${appBase}/${DB}?schema=public`,
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  PORT: String(PORT),
  API_URL: API,
  WORKER_HEALTH_PORT: String(Number(process.env.SMTP_E2E_WORKER_HEALTH_PORT ?? 4061)),
  STORAGE_LOCAL_DIR: resolve(apiDir, 'storage-smtp'),
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(SMTP_PORT),
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  TALKIVIO_EMAIL_RETRY_BASE_MS: '150',
  SHUTDOWN_DRAIN_DELAY_MS: '0',
  LOG_LEVEL: 'warn',
};
const sql = (q) =>
  execFileSync('psql', [`${ownerBase}/${DB}`, '-At', '-F', '|', '-c', q])
    .toString()
    .trim();
const redisDir = resolve(process.env.TMPDIR ?? '/tmp', `talkivio-smtp-redis-${process.pid}`);
const procs = [];
let logs = '';
function start(name, cmd, args) {
  const p = spawn(cmd, args, { cwd: apiDir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs += `[${name}] ${d}`));
  p.stderr.on('data', (d) => (logs += `[${name}] ${d}`));
  procs.push(p);
  return p;
}
const ready = (url) =>
  fetch(url)
    .then((r) => r.status === 200)
    .catch(() => false);

class Client {
  constructor() {
    this.cookies = {};
  }
  async call(method, path, body) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: Object.entries(this.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
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
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const emailRow = (to, template) => {
  const row = sql(
    `SELECT status, attempts, coalesce(last_error, ''), coalesce(provider_message_id, '') FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!row) return null;
  const [status, attempts, lastError, providerId] = row.split('|');
  return { status, attempts: Number(attempts), lastError, providerId };
};
const messagesTo = (to) => received.filter((m) => m.to.includes(to.toLowerCase()));
// Quoted-printable soft breaks and =XX escapes, enough to read links back out of the received body.
const decodeQp = (s) =>
  s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const cleanup = () => {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  smtp.close();
  rmSync(redisDir, { recursive: true, force: true });
};
try {
  console.log(
    `Setup (isolated: db ${DB}, redis :${REDIS_PORT}, api :${PORT}, smtp :${SMTP_PORT}, build ${BUILD})`,
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
  await until(() => ready(`http://localhost:${ENV.WORKER_HEALTH_PORT}/health/ready`), 60_000, 'worker ready');
  ok(true, 'isolated stack up with EMAIL_PROVIDER=smtp');

  console.log('Delivery over SMTP');
  const stamp = Date.now().toString(36);
  const owner = new Client();
  const email = `smtp-owner+${stamp}@example.com`;
  await owner.must('POST', '/auth/signup', {
    email,
    password: 'smtp passphrase long',
    tenant_name: `SMTP ${stamp}`,
    timezone: 'UTC',
  });
  const msg = await until(() => messagesTo(email)[0], 20_000, 'verification email over SMTP');
  const headers = msg.data.split('\r\n\r\n')[0];
  ok(
    /^Subject: Confirm your email address/m.test(headers) &&
      /^Content-Type: multipart\/alternative/m.test(headers) &&
      msg.from.length > 0,
    `the verification email arrived over SMTP (from ${msg.from}, multipart text + HTML)`,
  );
  const row = await until(
    () => (emailRow(email, 'verify_email')?.status === 'accepted' ? emailRow(email, 'verify_email') : null),
    10_000,
    'accepted status',
  );
  ok(
    row.attempts === 1 && row.providerId.length > 0,
    `the row is "accepted" with the provider's message id after one attempt (${row.providerId})`,
  );
  const token = decodeURIComponent((/[?&]token=([^\s&"<]+)/.exec(decodeQp(msg.data)) ?? [])[1] ?? '');
  const verified = await owner.call('POST', '/auth/verify-email', { token });
  ok(token.length > 10 && verified.status < 300, 'the link inside the received message verifies the account');
  // AUTH01: the token exists only as a hash at rest, and a consumed link cannot be replayed.
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const stored = sql(
    `SELECT count(*) FILTER (WHERE token_hash = '${tokenHash}') || '|' || count(*) FILTER (WHERE token_hash = '${token}' OR coalesce(payload::text, '') LIKE '%${token}%') || '|' || bool_and(consumed_at IS NOT NULL) FILTER (WHERE token_hash = '${tokenHash}') FROM auth_tokens`,
  );
  ok(
    stored === '1|0|true',
    `the verification token is stored as its SHA-256 only, and marked consumed (${stored})`,
  );
  const replay = await new Client().call('POST', '/auth/verify-email', { token });
  ok(
    replay.status >= 400 && replay.status < 500,
    `replaying the consumed link fails (${replay.status} ${replay.error?.code})`,
  );

  console.log('Temporary failure (451): queued with the error, then delivered once');
  const flaky = `smtp-flaky+${stamp}@example.com`;
  policy.tempFail.set(flaky, 2);
  await owner.must('POST', '/agents/invitations', {
    email: flaky,
    role: 'agent',
    department_ids: [],
    capacity: 2,
  });
  const interim = await until(
    () => {
      const r = emailRow(flaky, 'agent_invitation');
      return r && r.attempts >= 1 && r.status !== 'accepted' ? r : null;
    },
    10_000,
    'first failed attempt',
  );
  ok(
    interim.status === 'queued' && /451|Temporary/i.test(interim.lastError),
    `after a temporary failure the email stays "queued" with the error recorded, not "failed" (${interim.status}, ${interim.lastError.slice(0, 60)})`,
  );
  const done = await until(
    () =>
      emailRow(flaky, 'agent_invitation')?.status === 'accepted' ? emailRow(flaky, 'agent_invitation') : null,
    30_000,
    'retried delivery',
  );
  ok(
    done.attempts === 3 && done.lastError === '' && messagesTo(flaky).length === 1,
    `the retry delivered it exactly once (attempt ${done.attempts}, ${messagesTo(flaky).length} message received)`,
  );

  console.log('Permanent rejection (550): failed only after the final attempt, never delivered');
  const bounce = `smtp-bounce+${stamp}@example.com`;
  policy.reject.add(bounce);
  await owner.must('POST', '/agents/invitations', {
    email: bounce,
    role: 'agent',
    department_ids: [],
    capacity: 2,
  });
  const early = await until(
    () => {
      const r = emailRow(bounce, 'agent_invitation');
      return r && r.attempts >= 1 ? r : null;
    },
    10_000,
    'first rejection',
  );
  ok(
    early.status === 'queued',
    `while retries remain the rejected email is "queued" (attempt ${early.attempts})`,
  );
  const final = await until(
    () =>
      emailRow(bounce, 'agent_invitation')?.status === 'failed' ? emailRow(bounce, 'agent_invitation') : null,
    90_000,
    'final failure',
  );
  ok(
    final.attempts === 8 && /550/.test(final.lastError) && messagesTo(bounce).length === 0,
    `after the 8th attempt it is "failed" with the provider's reason (${final.lastError.slice(0, 60)})`,
  );
  ok(
    sql(`SELECT count(*) FROM outbound_emails WHERE status = 'delivered'`) === '0',
    'no email is reported as delivered without a provider delivery callback',
  );
  const metrics = await fetch(`http://localhost:${ENV.WORKER_HEALTH_PORT}/health/metrics`).then((r) =>
    r.text(),
  );
  const count = (outcome) =>
    Number(
      new RegExp(`talkivio_email_deliveries_total\\{[^}]*outcome="${outcome}"[^}]*\\} (\\d+)`).exec(
        metrics,
      )?.[1] ?? 0,
    );
  ok(
    count('accepted') >= 2 && count('retried') >= 2 + 7 && count('failed') === 1,
    `delivery metrics: accepted ${count('accepted')}, retried ${count('retried')}, failed ${count('failed')}`,
  );
} catch (err) {
  console.error(logs.split('\n').slice(-30).join('\n'));
  cleanup();
  throw err;
}
cleanup();
console.log(`\nSMTP E2E PASSED (${passed} checks)`);
process.exit(0);
