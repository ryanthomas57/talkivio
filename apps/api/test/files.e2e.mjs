// Talkivio files + exports end-to-end test (ch. 19/20; FILE01, EXPORT01, SEC01, SEC04).
// Runs against a live api + worker (real HTTP, sockets, PostgreSQL, Redis, storage).
//
//   SCAN_MODE=clamav CLAMD_STUB_PORT=13310 node test/files.e2e.mjs   # worker started with SCAN_MODE=clamav CLAMAV_PORT=13310
//   SCAN_MODE=dev_unscanned node test/files.e2e.mjs                  # worker started with SCAN_MODE=dev_unscanned
//
// With CLAMD_STUB_PORT the test runs a protocol-faithful clamd INSTREAM stub (EICAR + a
// stub-only test marker are "infected") so the TCP client, verdict handling and the
// scanner-outage path are exercised without a real ClamAV installation.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const SCAN_MODE = process.env.SCAN_MODE ?? 'clamav';
const STUB_PORT = process.env.CLAMD_STUB_PORT ? Number(process.env.CLAMD_STUB_PORT) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const sql = (q) => execFileSync('psql', [OWNER_DB, '-At', '-c', q]).toString().trim();

// ───────────────────────── fixtures (generated, never downloaded) ─────────────────────────
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const FAKE_EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126, 0x90), Buffer.from('PE\0\0'), Buffer.alloc(128, 0x00)]);
const EICAR = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-', 'TEST-FILE!$H+H*'].join(''), 'latin1');
const STUB_MARKER = 'TALKIVIO-STUB-MALWARE';

// ───────────────────────── clamd INSTREAM stub ─────────────────────────
function startClamdStub(port) {
  const stats = { scans: 0, shas: [] };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let streaming = false;
    const chunks = [];
    sock.on('error', () => {});
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
          const data = Buffer.concat(chunks);
          stats.scans++;
          stats.shas.push(sha(data));
          const sig = data.includes(EICAR) ? 'Eicar-Test-Signature' : data.includes(STUB_MARKER) ? 'Talkivio.Test.Stub' : null;
          return void sock.end(sig ? `stream: ${sig} FOUND\0` : 'stream: OK\0');
        }
        if (buf.length < 4 + len) return;
        chunks.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ stats, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

// ───────────────────────── HTTP helpers ─────────────────────────
class Client {
  constructor(name, bearer) {
    this.name = name;
    this.cookies = {};
    this.bearer = bearer;
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method, path, body, extra = {}) {
    const res = await fetch(`${API}${path.startsWith('/widget') ? '' : '/api/v1'}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : { cookie: this.cookieHeader() }),
        ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) this.cookies[k] = decodeURIComponent(v);
      else delete this.cookies[k];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error };
  }
  async must(method, path, body, extra) {
    const r = await this.call(method, path, body, extra);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.error)}`);
    return r.data;
  }
}
const latestEmail = (to, template) => sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${to}' AND template = '${template}' ORDER BY created_at DESC LIMIT 1`);
const tokenFrom = (text, param) => decodeURIComponent((text.match(new RegExp(`[?/](?:${param})[=/]([^\\s&]+)`)) ?? [])[1] ?? '');
const waitFor = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
};
function socket(ns, ticket) {
  const s = io(`${API}${ns}`, { path: '/realtime/v1', transports: ['websocket'], auth: { ticket }, forceNew: true });
  s.frames = [];
  s.on('event', (f) => s.frames.push(f));
  return new Promise((resolve, reject) => {
    s.on('auth.ok', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(`${ns} connect_error: ${e.message}`)));
  });
}

/** Upload lifecycle helper: init → PUT → finalize. Returns { init, put, fin }. */
async function upload(client, base, chatId, name, mime, bytes, { finalize = true } = {}) {
  const init = await client.call('POST', `${base}`, { chat_id: chatId, name, size_bytes: bytes.length, mime, sha256: sha(bytes) });
  if (init.status !== 201) return { init };
  const put = await fetch(init.data.url, { method: init.data.method, headers: init.data.headers, body: bytes });
  const putJson = await put.json().catch(() => null);
  if (!finalize) return { init, put: { status: put.status, json: putJson } };
  const finPath = base.startsWith('/widget') ? `/widget/v1/uploads/${init.data.upload_id}/finalize` : `/attachments/${init.data.upload_id}/finalize`;
  const fin = await client.call('POST', finPath, { sha256: sha(bytes) });
  return { init, put: { status: put.status, json: putJson }, fin };
}
const statePath = (client, id) => (client.bearer ? `/widget/v1/uploads/${id}` : `/attachments/${id}`);
async function settle(client, id, ms = 20000) {
  return waitFor(async () => {
    const r = await client.must('GET', statePath(client, id));
    return ['clean', 'rejected', 'expired'].includes(r.state) ? r : null;
  }, ms, `attachment ${id} to settle`);
}

// ───────────────────────── setup ─────────────────────────
const stamp = Date.now();
let stub = STUB_PORT ? await startClamdStub(STUB_PORT) : null;
console.log(`Scan mode under test: ${SCAN_MODE}${stub ? ` (clamd INSTREAM stub on :${STUB_PORT})` : ''}`);

const owner = new Client('owner');
const ownerEmail = `files-owner+${stamp}@example.com`;
await owner.must('POST', '/auth/signup', { email: ownerEmail, password: 'correct horse battery', tenant_name: `Files ${stamp}`, timezone: 'Europe/London' });
await owner.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(ownerEmail, 'verify_email'), 'token') });
const support = (await owner.must('GET', '/departments')).find((d) => d.name === 'Support');
const site = await owner.must('POST', '/sites', { name: 'Files store', origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }] });
const agentEmail = `files-agent+${stamp}@example.com`;
await owner.must('POST', '/agents/invitations', { email: agentEmail, role: 'agent', department_ids: [support.id], capacity: 3 });
const agent = new Client('agent');
await agent.must('POST', '/agents/invitations/accept', { token: tokenFrom(latestEmail(agentEmail, 'agent_invitation'), 'invite'), display_name: 'Bea Agent', password: 'another strong passphrase' });
const ownerSock = await socket('/agent', (await owner.must('POST', '/socket-ticket')).ticket);
await owner.must('PUT', '/agents/me/presence', { status: 'online' });

async function newVisitor(name) {
  const anon = new Client(name);
  const sess = await anon.must('POST', '/widget/v1/sessions', { site_key: site.public_key, host_origin: 'http://localhost:5173', consent: { analytics: false, policy_version: '2026-10' } });
  return new Client(name, sess.capability);
}
const visitor = await newVisitor('visitor');
const created = await visitor.must('POST', '/widget/v1/chats', { client_request_id: randomUUID(), message: 'Hello, I need help with my order' });
const chatId = created.chat.id;
await owner.must('POST', `/chats/${chatId}/accept`, {});
const vSock = await socket('/visitor', (await visitor.must('POST', '/widget/v1/socket-ticket')).ticket);
await vSock.emitWithAck('subscribe', { scopes: [{ kind: 'chat', id: chatId }] });

console.log('FILE01 — clean PNG/PDF, short grants, state machine');
const png = await upload(owner, '/attachments/uploads', chatId, 'photo.png', 'image/png', PNG);
ok(png.init.status === 201 && png.init.data.method === 'PUT' && png.init.data.headers['content-type'] === 'image/png', 'agent upload initiated with method, required headers and expiry');
const ttl = (Date.parse(png.init.data.expires_at) - Date.now()) / 1000;
ok(ttl > 240 && ttl <= 301, `upload URL expires in ~5 minutes (${Math.round(ttl)} s)`);
const pngKey = sql(`SELECT object_key FROM attachments WHERE id = '${png.init.data.upload_id}'`);
ok(!JSON.stringify(png.init.json).includes(pngKey) && !png.init.data.url.includes(pngKey), 'response never exposes the private object key');
ok(png.put.status === 200 && png.put.json.data.state === 'uploaded', 'signed PUT stored bytes in quarantine (state uploaded)');
ok(png.fin.status === 202 && png.fin.data.state === 'scanning', 'finalize verified size + checksum and queued the scan (202 scanning)');
const reput = await fetch(png.init.data.url, { method: 'PUT', headers: png.init.data.headers, body: PNG });
ok(reput.status === 409, 'upload URL is single-use (second PUT → 409)');
const pngDone = await settle(owner, png.init.data.upload_id);
ok(pngDone.state === 'clean' && pngDone.mime === 'image/png' && pngDone.is_image, 'PNG reached clean');
const pngScan = sql(`SELECT scan_result FROM attachments WHERE id = '${pngDone.id}'`);
ok(SCAN_MODE === 'dev_unscanned' ? pngScan === 'unscanned-dev' : pngScan === 'clamav:OK', `scan_result marker recorded (${pngScan})`);
if (stub) ok(stub.stats.shas.includes(sha(PNG)), 'clamd stub received the exact PNG bytes over INSTREAM');
const fin2 = await owner.call('POST', `/attachments/${pngDone.id}/finalize`, { sha256: sha(PNG) });
ok(fin2.status === 202 && fin2.data.state === 'clean', 'finalize is idempotent');
const grant = await owner.must('GET', `/attachments/${pngDone.id}/download`);
const grantTtl = (Date.parse(grant.expires_at) - Date.now()) / 1000;
ok(grant.url && grantTtl > 0 && grantTtl <= 61 && grant.name === 'photo.png' && grant.size_bytes === PNG.length, `download grant {url, expires_at, …} lasts ≤ 60 s (${Math.round(grantTtl)} s)`);
const dl = await fetch(grant.url);
const dlBytes = Buffer.from(await dl.arrayBuffer());
ok(dl.status === 200 && sha(dlBytes) === sha(PNG), 'grant downloads the exact clean bytes');
ok(/^attachment;/.test(dl.headers.get('content-disposition') ?? '') && dl.headers.get('x-content-type-options') === 'nosniff', 'download is Content-Disposition: attachment with nosniff');
ok((dl.headers.get('cache-control') ?? '').includes('no-store') && (dl.headers.get('content-security-policy') ?? '').includes('sandbox'), 'download is no-store and sandboxed');
const vBefore = await visitor.call('GET', `/widget/v1/attachments/${pngDone.id}/download`);
ok(vBefore.status === 404, 'visitor cannot fetch an unsent agent upload');
const msgPng = await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'Here is the photo', attachment_ids: [pngDone.id] });
ok(msgPng.attachments[0].id === pngDone.id && msgPng.attachments[0].state === 'clean', 'clean attachment sent in a public message (AttachmentRef shape)');
const vGrant = await visitor.must('GET', `/widget/v1/attachments/${pngDone.id}/download`);
const vDl = await fetch(vGrant.url);
ok(vDl.status === 200 && sha(Buffer.from(await vDl.arrayBuffer())) === sha(PNG) && vGrant.expires_at, 'visitor gets a 60 s grant for a file in their chat');

const pdf = await upload(visitor, '/widget/v1/uploads', chatId, 'invoice.pdf', 'application/pdf', PDF);
ok(pdf.init.status === 201 && pdf.put.status === 200 && pdf.fin.status === 202, 'visitor PDF upload accepted (widget init/PUT/finalize)');
const pdfDone = await settle(visitor, pdf.init.data.upload_id);
ok(pdfDone.state === 'clean' && pdfDone.mime === 'application/pdf', 'PDF reached clean');
await waitFor(() => vSock.frames.find((f) => f.type === 'attachment.updated' && f.payload.attachment_id === pdfDone.id && f.payload.state === 'clean'), 5000, 'attachment.updated on visitor socket');
const frames = vSock.frames.filter((f) => f.type === 'attachment.updated' && f.payload.attachment_id === pdfDone.id);
const pdfKey = sql(`SELECT object_key FROM attachments WHERE id = '${pdfDone.id}'`);
ok(frames.map((f) => f.payload.state).includes('scanning') && !JSON.stringify(frames).includes(pdfKey) && !JSON.stringify(frames).includes('scan_result'), 'attachment.updated events reach the uploader (no keys, no scanner output)');
await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'My invoice', attachment_ids: [pdfDone.id] });
const aGrant = await owner.must('GET', `/attachments/${pdfDone.id}/download`);
ok((await fetch(aGrant.url)).status === 200, 'staff download of the visitor PDF');
const otherVisitor = await newVisitor('other-visitor');
ok((await otherVisitor.call('GET', `/widget/v1/attachments/${pdfDone.id}/download`)).status === 404, "another visitor cannot download this chat's file");

console.log('FILE01 — oversized, renamed EXE, EICAR');
const before = sql(`SELECT count(*) FROM attachments WHERE chat_id = '${chatId}'`);
const big = await visitor.call('POST', '/widget/v1/uploads', { chat_id: chatId, name: 'huge.pdf', size_bytes: 10 * 1024 * 1024 + 1, mime: 'application/pdf' });
ok(big.status === 413 && big.error.code === 'FILE_TOO_LARGE' && sql(`SELECT count(*) FROM attachments WHERE chat_id = '${chatId}'`) === before, 'oversized file rejected at init (413 FILE_TOO_LARGE), before any transfer');
const lying = await visitor.must('POST', '/widget/v1/uploads', { chat_id: chatId, name: 'small.txt', size_bytes: 100, mime: 'text/plain' });
const overPut = await fetch(lying.url, { method: 'PUT', headers: lying.headers, body: Buffer.from('b'.repeat(5000)) });
ok(overPut.status === 413 && sql(`SELECT state FROM attachments WHERE id = '${lying.upload_id}'`) === 'initiated', 'body larger than the declared size is refused by Content-Length before storage (413)');
const blockedExt = await visitor.call('POST', '/widget/v1/uploads', { chat_id: chatId, name: 'setup.exe', size_bytes: 300, mime: 'application/x-msdownload' });
ok(blockedExt.status === 422 && blockedExt.error.code === 'FILE_TYPE_BLOCKED', 'executable extension blocked at init (FILE_TYPE_BLOCKED)');
const svg = await visitor.call('POST', '/widget/v1/uploads', { chat_id: chatId, name: 'x.svg', size_bytes: 300, mime: 'image/svg+xml' });
ok(svg.status === 422 && svg.error.code === 'FILE_TYPE_BLOCKED', 'SVG blocked at init');
const exe = await upload(visitor, '/widget/v1/uploads', chatId, 'holiday.png', 'image/png', FAKE_EXE);
ok(exe.fin.status === 202, 'renamed executable passes declaration checks');
const exeDone = await settle(visitor, exe.init.data.upload_id);
ok(exeDone.state === 'rejected' && exeDone.error_code === 'FILE_TYPE_BLOCKED' && !/MZ|magic/i.test(exeDone.error_message), 'renamed .exe rejected by magic bytes (safe message, no internals)');
const exeSend = await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), attachment_ids: [exeDone.id] });
ok(exeSend.status === 409 && exeSend.error.code === 'FILE_REJECTED', 'rejected file cannot be sent in a message');
const exeGrant = await visitor.call('GET', `/widget/v1/attachments/${exeDone.id}/download`);
ok(exeGrant.status === 409 && exeGrant.error.code === 'FILE_REJECTED' && !exeGrant.data, 'no download grant for a rejected file (409 FILE_REJECTED)');
const eicar = await upload(visitor, '/widget/v1/uploads', chatId, 'eicar.txt', 'text/plain', EICAR);
const eicarDone = await settle(visitor, eicar.init.data.upload_id);
ok(eicarDone.state === 'rejected' && eicarDone.error_code === 'FILE_REJECTED', `EICAR rejected (${SCAN_MODE})`);
ok(sql(`SELECT deleted_at IS NULL AND state = 'rejected' FROM attachments WHERE id = '${eicarDone.id}'`) === 't', 'EICAR bytes stay quarantined (never promoted to clean)');
// SEC01: a PDF that would run script when opened (OpenAction → JavaScript) never becomes downloadable.
const MAL_PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(document.cookie)) >> >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const malPdf = await upload(visitor, '/widget/v1/uploads', chatId, 'statement.pdf', 'application/pdf', MAL_PDF);
const malDone = await settle(visitor, malPdf.init.data.upload_id);
ok(malDone.state === 'rejected' && /scripts, launch actions/.test(malDone.error_message ?? '') && sql(`SELECT reject_reason FROM attachments WHERE id = '${malDone.id}'`) === 'pdf_active_content', 'a PDF with an OpenAction JavaScript is rejected (pdf_active_content) with a safe message');
ok((await visitor.call('GET', `/widget/v1/attachments/${malDone.id}/download`)).status === 409 && (await owner.call('GET', `/attachments/${malDone.id}/download`)).status !== 200, 'and neither the visitor nor staff can obtain a download grant for it');
if (stub) {
  const marked = await upload(visitor, '/widget/v1/uploads', chatId, 'notes.txt', 'text/plain', Buffer.from(`hello ${STUB_MARKER}\n`));
  const markedDone = await settle(visitor, marked.init.data.upload_id);
  ok(markedDone.state === 'rejected' && sql(`SELECT scan_result FROM attachments WHERE id = '${markedDone.id}'`) === 'rejected:Talkivio.Test.Stub', 'clamd INSTREAM "FOUND" verdict rejects the file');
}
const ownerGrantRejected = await owner.call('GET', `/attachments/${eicarDone.id}/download`);
ok(ownerGrantRejected.status === 404 || ownerGrantRejected.error?.code === 'FILE_REJECTED', 'zero download grants for rejected files');

if (stub) {
  console.log('FILE01 — scanner outage keeps files pending, then recovers');
  await stub.close();
  const late = await upload(visitor, '/widget/v1/uploads', chatId, 'later.txt', 'text/plain', Buffer.from('scan me when the scanner is back\n'));
  const pending = await waitFor(async () => {
    const r = await visitor.must('GET', `/widget/v1/uploads/${late.init.data.upload_id}`);
    return r.error_code === 'FILE_SCAN_PENDING' ? r : null;
  }, 15000, 'pending scan status');
  ok(pending.state === 'scanning' && pending.error_message, 'scanner down → file stays scanning with honest FILE_SCAN_PENDING status');
  await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'checking' });
  const sendPending = await visitor.call('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), attachment_ids: [pending.id] });
  ok(sendPending.status === 409 && sendPending.error.code === 'FILE_SCAN_PENDING', 'unverified file cannot be sent');
  stub = await startClamdStub(STUB_PORT);
  const recovered = await settle(visitor, pending.id, 45000);
  ok(recovered.state === 'clean', 'scan retried after the outage and the file became clean');
}

console.log('Cancel + SEC04 — cross-tenant and stolen keys');
const cancelMe = await upload(visitor, '/widget/v1/uploads', chatId, 'draft.txt', 'text/plain', Buffer.from('draft'), { finalize: false });
ok((await visitor.call('DELETE', `/widget/v1/uploads/${cancelMe.init.data.upload_id}`)).status === 204, 'visitor can cancel an unsent upload');
ok((await visitor.call('POST', `/widget/v1/uploads/${cancelMe.init.data.upload_id}/finalize`, { sha256: sha(Buffer.from('draft')) })).status === 404, 'cancelled upload cannot be finalized');
ok((await owner.call('DELETE', `/attachments/${pngDone.id}`)).status === 409, 'sent attachment cannot be cancelled (needs redaction)');

const beta = new Client('beta');
const betaEmail = `files-beta+${stamp}@example.com`;
await beta.must('POST', '/auth/signup', { email: betaEmail, password: 'yet another passphrase', tenant_name: `Beta ${stamp}` });
await beta.must('POST', '/auth/verify-email', { token: tokenFrom(latestEmail(betaEmail, 'verify_email'), 'token') });
const pend = await upload(owner, '/attachments/uploads', chatId, 'pending.txt', 'text/plain', Buffer.from('tenant A pending'), { finalize: false });
ok((await beta.call('POST', `/attachments/${pend.init.data.upload_id}/finalize`, { sha256: sha(Buffer.from('tenant A pending')) })).status === 404, "other tenant cannot finalize tenant A's upload id (404)");
ok((await beta.call('GET', `/attachments/${pngDone.id}/download`)).status === 404, "other tenant cannot get a grant for tenant A's attachment (404)");
ok((await beta.call('GET', `/attachments/${pngDone.id}`)).status === 404, 'other tenant cannot read attachment metadata');
ok((await beta.call('DELETE', `/attachments/${pend.init.data.upload_id}`)).status === 404, 'other tenant cannot cancel the upload');
const betaUp = await beta.call('POST', '/attachments/uploads', { chat_id: chatId, name: 'x.png', size_bytes: PNG.length, mime: 'image/png' });
ok(betaUp.status === 404, "other tenant cannot initiate an upload into tenant A's chat");
const stolenKey = sql(`SELECT object_key FROM attachments WHERE id = '${pngDone.id}'`);
ok((await fetch(`${API}/api/v1/attachments/${pngDone.id}/content?sig=${encodeURIComponent(stolenKey)}`)).status === 403, 'object key used as a signature → 403');
ok([400, 404].includes((await fetch(`${API}/api/v1/attachments/${encodeURIComponent(stolenKey)}/content`)).status), 'object key used as a path → rejected');
const forged = grant.url.replace(/sig=[^&]+/, (s) => s.slice(0, -4) + 'AAAA');
ok((await fetch(forged)).status === 403, 'tampered grant signature → 403');
const crossId = grant.url.replace(pngDone.id, pdfDone.id);
ok((await fetch(crossId)).status === 403, 'grant bound to one attachment cannot fetch another');
const betaVisitorSite = await beta.must('POST', '/sites', { name: 'Beta site', origins: [{ origin: 'http://localhost:5174', pattern_type: 'exact' }] });
const bAnon = new Client('beta-visitor');
const bSess = await bAnon.must('POST', '/widget/v1/sessions', { site_key: betaVisitorSite.public_key, host_origin: 'http://localhost:5174', consent: { analytics: false, policy_version: '2026-10' } });
const betaVisitor = new Client('beta-visitor', bSess.capability);
ok((await betaVisitor.call('GET', `/widget/v1/attachments/${pdfDone.id}/download`)).status === 404, "other tenant's visitor cannot download (404)");
ok((await betaVisitor.call('GET', `/widget/v1/uploads/${pdf.init.data.upload_id}`)).status === 404, "other tenant's visitor cannot read upload state");

const noteFile = await upload(owner, '/attachments/uploads', chatId, 'internal.txt', 'text/plain', Buffer.from('internal only'));
const noteDone = await settle(owner, noteFile.init.data.upload_id);
await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), visibility: 'internal', body: 'SECRET-NOTE-123 do not share', attachment_ids: [noteDone.id] });
ok((await visitor.call('GET', `/widget/v1/attachments/${noteDone.id}/download`)).status === 404, 'visitor cannot download an internal-note attachment');

console.log('EXPORT01 — staff and visitor transcripts');
await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: "=cmd|' /C calc'!A0" });
// Hostile links for the PDF renderer: they must stay text (no /URI actions, nothing fetched).
await visitor.must('POST', `/widget/v1/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: 'see https://evil.example/x.png <img src="https://evil.example/pixel.gif"> javascript:alert(1)' });
await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: '+SUM(1,2)' });
await owner.must('POST', `/chats/${chatId}/messages`, { client_message_id: randomUUID(), body: '@evil and -10 and مرحبا 👋 "quoted", comma' });
await owner.must('POST', `/chats/${chatId}/close`, { reason: 'resolved' });
await visitor.must('PUT', `/widget/v1/chats/${chatId}/rating`, { rating: 'good', comment: 'Thanks!' });
const staffMsgs = await owner.must('GET', `/chats/${chatId}/messages?limit=100`);

async function runExport(client, path, body, readyPath, dlPath) {
  const r = await client.call('POST', path, body);
  if (r.status !== 202) throw new Error(`export ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.error)}`);
  const id = r.data.id;
  const done = await waitFor(async () => {
    const s = await client.must('GET', readyPath(id));
    return ['ready', 'failed'].includes(s.state) ? s : null;
  }, 20000, `export ${id}`);
  if (done.state !== 'ready') throw new Error(`export ${id} failed: ${done.error_code}`);
  const g = await client.must('GET', dlPath(id));
  const res = await fetch(g.url);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { id, resource: done, grant: g, res, bytes };
}
const staffExport = (format, extra = {}) => runExport(owner, '/exports', { chat_ids: [chatId], format, timezone: 'Asia/Kolkata', ...extra }, (id) => `/exports/${id}`, (id) => `/exports/${id}/download`);

const txt = await staffExport('txt');
const txtBody = txt.bytes.toString('utf8');
ok(txt.res.status === 200 && txt.resource.sha256 === sha(txt.bytes) && !JSON.stringify(txt.resource).includes('object_key'), 'TXT export ready with checksum; status never exposes the object key');
ok(txtBody.includes(`Chat #`) && txtBody.includes(chatId) && txtBody.includes('Files store') && txtBody.includes('Department:') && /\+05:30/.test(txtBody), 'TXT has chat id, site, department and RFC 3339 times in the chosen zone');
ok(!txtBody.includes('SECRET-NOTE-123') && txtBody.includes('Notice:'), 'TXT excludes notes by default and carries the redaction notice');
const json = await staffExport('json');
const jdoc = JSON.parse(json.bytes.toString('utf8'));
const jm = jdoc.chats[0].messages;
ok(jdoc.chats[0].id === chatId && jm.every((m, i) => i === 0 || m.seq > jm[i - 1].seq), 'JSON keeps exact ids and deterministic seq order');
ok(jm.some((m) => m.body === '@evil and -10 and مرحبا 👋 "quoted", comma') && jm.every((m) => staffMsgs.items.some((s) => s.id === m.id)), 'JSON preserves Unicode and exact message ids');
ok(!jm.some((m) => (m.body ?? '').includes('SECRET-NOTE-123')) && jdoc.chats[0].rating?.rating === 'good', 'JSON excludes notes and includes the rating');
ok(jm.some((m) => m.attachments.some((a) => a.id === pdfDone.id && a.name === 'invoice.pdf' && a.size_bytes === PDF.length)), 'attachment metadata included (no bytes)');
const csv = await staffExport('csv');
const csvBody = csv.bytes.toString('utf8');
ok(csvBody.startsWith('chat_id,chat_number,site,') && csvBody.includes('\r\n'), 'CSV header + CRLF records (RFC 4180)');
ok(csvBody.includes(`"'=cmd|' /C calc'!A0"`) || csvBody.includes(`'=cmd|' /C calc'!A0`), 'CSV neutralises a leading = (formula injection)');
ok(csvBody.includes(`'+SUM(1,2)`) && csvBody.includes(`"'@evil and -10 and مرحبا 👋 ""quoted"", comma"`), 'CSV neutralises + and @ and quotes commas/quotes');
ok(!/(^|,)[=+@]/m.test(csvBody.replace(/"[^"]*"/g, '""')), 'no unquoted CSV cell starts with = + @');
const pdfx = await staffExport('pdf');
ok(pdfx.bytes.subarray(0, 5).toString() === '%PDF-' && pdfx.res.headers.get('content-type') === 'application/pdf' && /^attachment/.test(pdfx.res.headers.get('content-disposition')), 'PDF export downloads as an attachment');
ok(!/\/URI|\/JavaScript|\/Launch/.test(pdfx.bytes.toString('latin1')), 'PDF has no remote resources or actions');
const internal = await staffExport('json', { include_internal: true });
ok(internal.bytes.toString('utf8').includes('SECRET-NOTE-123'), 'internal notes only with exports.internal + explicit include_internal');
const agentInternal = await agent.call('POST', '/exports', { chat_ids: [chatId], format: 'json', include_internal: true });
ok(agentInternal.status === 403, 'agent without exports.internal cannot include notes');
const preview = await owner.must('POST', '/exports/preview', { filters: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }, format: 'csv' });
ok(preview.count >= 1 && preview.allowed === true && preview.limit > 0, `bulk export count preview (${preview.count} chats)`);
const tooWide = await agent.call('POST', '/exports', { filters: { from: new Date(Date.now() - 60 * 86_400_000).toISOString(), to: new Date().toISOString() }, format: 'csv' });
ok(tooWide.status === 422, 'agent bulk export limited by date range');
const bulk = await runExport(owner, '/exports', { filters: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }, format: 'csv', timezone: 'UTC' }, (id) => `/exports/${id}`, (id) => `/exports/${id}/download`);
ok(bulk.bytes.toString('utf8').includes(chatId), 'filtered bulk export is asynchronous and downloadable');

const vtxt = await runExport(visitor, `/widget/v1/chats/${chatId}/exports`, { format: 'txt' }, (id) => `/widget/v1/exports/${id}`, (id) => `/widget/v1/exports/${id}/download`);
const vtxtBody = vtxt.bytes.toString('utf8');
ok(!vtxtBody.includes('SECRET-NOTE-123') && !vtxtBody.includes('internal.txt') && vtxtBody.includes('My invoice') && vtxtBody.includes('visible to the visitor'), 'visitor TXT transcript is public-only (no notes or note files)');
ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(vtxtBody) && !vtxtBody.includes(ownerEmail), 'public transcript has no IP addresses or staff emails');
const vpdf = await runExport(visitor, `/widget/v1/chats/${chatId}/exports`, { format: 'pdf' }, (id) => `/widget/v1/exports/${id}`, (id) => `/widget/v1/exports/${id}/download`);
ok(vpdf.bytes.subarray(0, 5).toString() === '%PDF-', 'visitor PDF transcript downloads');
ok((await visitor.call('POST', `/widget/v1/chats/${chatId}/exports`, { format: 'csv' })).status === 422, 'visitor exports limited to txt/pdf');
ok((await otherVisitor.call('GET', `/widget/v1/exports/${vtxt.id}`)).status === 404, "another visitor cannot see this visitor's export");
ok((await beta.call('GET', `/exports/${txt.id}`)).status === 404 && (await beta.call('GET', `/exports/${txt.id}/download`)).status === 404, 'other tenant cannot read or download an export (404)');
ok((await agent.call('GET', `/exports/${txt.id}/download`)).status === 404, "another member cannot download someone else's export");

console.log('EXPORT01 — expiry and erasure invalidation');
sql(`UPDATE exports SET expires_at = now() - interval '1 minute' WHERE id = '${csv.id}'`);
const expired = await owner.call('GET', `/exports/${csv.id}/download`);
ok(expired.status === 410 && expired.error.code === 'EXPORT_EXPIRED', 'expired export → 410 EXPORT_EXPIRED');
const erasedMsg = jm.find((m) => m.body === '+SUM(1,2)');
sql(`UPDATE messages SET redacted_at = now() WHERE id = '${erasedMsg.id}'`);
const afterErase = await owner.call('GET', `/exports/${json.id}/download`);
ok(afterErase.status === 410, 'erasure after rendering invalidates the existing export artifact');
ok(sql(`SELECT erased_at IS NOT NULL AND object_key IS NULL FROM exports WHERE id = '${json.id}'`) === 't', 'invalidated export has its object key scrubbed');
ok([403, 410].includes((await fetch(txt.grant.url)).status), 'previously issued grant for an invalidated/expired export no longer serves bytes');
const reExport = await staffExport('json');
ok(JSON.parse(reExport.bytes.toString('utf8')).chats[0].messages.find((m) => m.id === erasedMsg.id)?.redacted === true, 'new export renders current erasure state');

console.log('EXPORT01 — transcript email');
const vEmail = `files-visitor+${stamp}@example.com`;
const e1 = await visitor.call('POST', `/widget/v1/chats/${chatId}/transcript-email`, { email: vEmail, format: 'txt' });
const e2 = await visitor.call('POST', `/widget/v1/chats/${chatId}/transcript-email`, { email: vEmail, format: 'txt' });
ok(e1.status === 202 && e2.status === 202 && e1.data.id === e2.data.id && e2.data.duplicate === true, 'visitor transcript email is accepted once; retry returns the same job');
await waitFor(() => sql(`SELECT count(*) FROM outbound_emails WHERE recipient = '${vEmail}'`) === '1', 15000, 'transcript email row');
await sleep(1500);
ok(sql(`SELECT count(*) FROM outbound_emails WHERE recipient = '${vEmail}'`) === '1', 'exactly one outbound_emails row after retry');
const mailText = sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${vEmail}'`);
ok(!mailText.includes('SECRET-NOTE-123') && mailText.includes('My invoice'), 'emailed public transcript has no private notes');
const badRecipient = await owner.call('POST', `/chats/${chatId}/transcript-email`, { recipient: 'random@example.net', format: 'txt' });
ok(badRecipient.status === 422, 'agent cannot email transcripts to unverified recipients');
const idem = `transcript-${randomUUID()}`;
const s1 = await owner.call('POST', `/chats/${chatId}/transcript-email`, { recipient: ownerEmail, format: 'pdf', include_internal: true }, { 'idempotency-key': idem });
const s2 = await owner.call('POST', `/chats/${chatId}/transcript-email`, { recipient: ownerEmail, format: 'pdf', include_internal: true }, { 'idempotency-key': idem });
ok(s1.status === 202 && s2.status === 202 && s1.data.id === s2.data.id, 'agent transcript email (pdf, with notes, to own verified address) is idempotent');
const st = await waitFor(async () => {
  const r = await owner.must('GET', `/chats/${chatId}/transcript-emails/${s1.data.id}`);
  return ['accepted', 'sending', 'delivered', 'failed'].includes(r.state) ? r : null;
}, 20000, 'agent transcript email');
ok(sql(`SELECT count(*) FROM outbound_emails WHERE recipient = '${ownerEmail}' AND template = 'transcript_export'`) === '1', 'exactly one staff transcript email row');
ok(['accepted', 'sending', 'delivered'].includes(st.state) && st.delivered_at === null, `email status reports ${st.state}, separately from delivered`);
const agentMail = sql(`SELECT text_body FROM outbound_emails WHERE recipient = '${ownerEmail}' AND template = 'transcript_export'`);
const link = (agentMail.match(/https?:\/\/\S+\/widget\/v1\/exports\/\S+/) ?? [])[0];
ok(agentMail.includes('SECRET-NOTE-123') && link, 'staff copy includes notes and a PDF link');
const linked = await fetch(link);
ok(linked.status === 200 && Buffer.from(await linked.arrayBuffer()).subarray(0, 5).toString() === '%PDF-', 'emailed PDF link serves the transcript');
const auditRows = sql(`SELECT count(*) FROM audit_events WHERE tenant_id = (SELECT tenant_id FROM chats WHERE id = '${chatId}') AND action IN ('transcript.email_requested', 'export.created', 'export.ready')`);
ok(Number(auditRows) >= 3, `exports and transcript emails are audited (${auditRows} rows)`);

console.log('AUD-71-29 — a download grant issued before an erasure stops serving bytes');
const preErase = await owner.must('GET', `/attachments/${pngDone.id}/download`);
ok((await fetch(preErase.url)).status === 200, 'a fresh grant serves the attachment before the erasure');
const chatView = await owner.must('GET', `/chats/${chatId}`);
const subject = chatView.visitor?.id ?? chatView.visitor_id;
ok(!!subject, 'chat names its visitor (erasure subject)');
const erase = await owner.must('POST', '/privacy/requests', { kind: 'erase', visitor_id: subject, proof_reference: `FILES-${stamp}` });
await owner.must('POST', `/privacy/requests/${erase.id}/verify`, { method: 'verified_identity' });
const erased = await waitFor(async () => {
  const r = await owner.must('GET', `/privacy/requests/${erase.id}`);
  if (r.state === 'failed') throw new Error(`erasure failed: ${JSON.stringify(r.report)}`);
  return r.state === 'completed' ? r : null;
}, 45_000, 'erasure');
ok(erased.report.counts.attachments_erased >= 1, `erasure erased the chat's attachments (${erased.report.counts.attachments_erased})`);
// Uploads deleted earlier (the abandoned draft above) kept their file name and hash until the erasure scrubbed them.
const leftovers = sql(`SELECT count(*) FROM attachments WHERE (chat_id IN (SELECT id FROM chats WHERE visitor_id = '${subject}') OR (uploaded_by_actor = 'visitor' AND uploaded_by_id = '${subject}')) AND (original_name <> '[erased]' OR sha256 IS NOT NULL OR deleted_at IS NULL)`);
ok(leftovers === '0', 'no attachment row of the subject keeps a file name or hash, including uploads deleted before the erasure');
const staleGrant = await fetch(preErase.url);
ok(staleGrant.status !== 200 && staleGrant.status >= 400, `the grant issued before the erasure no longer serves bytes (${staleGrant.status}), well inside its 60 s lifetime`);
ok((await owner.call('GET', `/attachments/${pngDone.id}/download`)).status >= 400, 'no new grant for an erased attachment');

vSock.close();
ownerSock.close();
if (stub) await stub.close();
console.log(`\nFILES/EXPORTS E2E PASSED (${passed} checks, scan mode ${SCAN_MODE})`);
process.exit(0);
