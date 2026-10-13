// Talkivio data-scale checks (ch. 60, PERF02): read-path latency and query plans at volume.
//
//   node test/load/data-scale.mjs   (needs DATABASE_OWNER_URL; API on API_URL)
//
// Fixture (one fresh tenant, bulk-loaded as the migration owner because only the read paths are
// under test — write paths are exercised by chat-load.mjs):
//   - VISITORS visitors (default 10 000) with one closed chat each;
//   - TOTAL_MESSAGES messages (default 1 000 000) spread across those chats, plus one long chat of
//     LONG_CHAT_MESSAGES (default 10 000) messages for transcript paging.
// Measured through the real API with the owner's session: transcript paging (before_seq, 100/page),
// full-text history search (common words, rare order numbers, no match; snippets), search keyset paging across
// candidate batches and with a filter that rejects every candidate, visitor directory paging, plus
// EXPLAIN (ANALYZE, BUFFERS) of the underlying queries. The fixture tenant is left in place for inspection; delete it with
// DELETE FROM tenants WHERE id = '<id>' (cascades) when done.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = (process.env.DATABASE_OWNER_URL ?? '').replace(/\?.*$/, '');
const VISITORS = Number(process.env.VISITORS ?? 10_000);
const TOTAL_MESSAGES = Number(process.env.TOTAL_MESSAGES ?? 1_000_000);
const LONG_CHAT_MESSAGES = Number(process.env.LONG_CHAT_MESSAGES ?? 10_000);
const now = () => performance.timeOrigin + performance.now();
const sql = (q) => execFileSync('psql', [OWNER_DB, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { maxBuffer: 64 * 1024 * 1024 }).toString().trim();

class Client {
  cookies = {};
  async call(method, path, body) {
    const t0 = now();
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.250.0.1', cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...(this.cookies.rd_csrf ? { 'x-csrf-token': this.cookies.rd_csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) this.cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error)}`);
    return { json, ms: now() - t0 };
  }
}
const stats = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const p = (q) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  return { n: v.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: v[v.length - 1] };
};

const started = new Date();
const owner = new Client();
const email = `scale-${Date.now().toString(36)}@talkivio.test`;
const signup = (await owner.call('POST', '/auth/signup', { email, password: `scale-${randomUUID()}`, tenant_name: 'Scale fixture', timezone: 'UTC' })).json.data;
const tenantId = signup.tenant_id;
const site = (await owner.call('POST', '/sites', { name: 'Scale site', origins: [{ origin: 'http://localhost:5173', pattern_type: 'exact' }] })).json.data;
const me = (await owner.call('GET', '/agents/me')).json.data.agent;
console.log(`tenant ${tenantId}; loading ${VISITORS} visitors, ${TOTAL_MESSAGES} messages …`);

const words = ['refund', 'shipping', 'invoice', 'password', 'delivery', 'order', 'discount', 'warranty', 'account', 'subscription', 'canada', 'return', 'exchange', 'tracking', 'payment'];
const loadStarted = now();
sql(`BEGIN;
SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO visitors (id, tenant_id, site_id, anonymous_label, name, first_seen_at, last_seen_at, chat_count)
  SELECT gen_random_uuid(), '${tenantId}', '${site.id}', 'Visitor ' || g, CASE WHEN g % 3 = 0 THEN 'Customer ' || g END,
         now() - (g || ' minutes')::interval, now() - (g || ' seconds')::interval, 1
    FROM generate_series(1, ${VISITORS}) g;
INSERT INTO chats (id, tenant_id, number, site_id, visitor_id, owner_membership_id, status, requested_at, first_assigned_at, closed_at, close_reason, next_seq, last_message_at, last_message_preview, version)
  SELECT gen_random_uuid(), v.tenant_id, row_number() OVER (ORDER BY v.first_seen_at) + 1000, v.site_id, v.id, '${me.id}', 'closed',
         v.first_seen_at, v.first_seen_at + interval '20 seconds', v.first_seen_at + interval '10 minutes', 'resolved', 1, v.first_seen_at, '', 1
    FROM visitors v WHERE v.tenant_id = '${tenantId}';
COMMIT;`);
const perChat = Math.max(1, Math.floor((TOTAL_MESSAGES - LONG_CHAT_MESSAGES) / VISITORS));
const wordArr = `ARRAY[${words.map((w) => `'${w}'`).join(',')}]`;
sql(`BEGIN;
SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO messages (id, tenant_id, chat_id, seq, sender_type, sender_visitor_id, sender_membership_id, sender_name_snapshot, body, sent_at)
  SELECT gen_random_uuid(), c.tenant_id, c.id, s,
         CASE WHEN s % 2 = 1 THEN 'visitor'::"ActorType" ELSE 'agent'::"ActorType" END,
         CASE WHEN s % 2 = 1 THEN c.visitor_id END, CASE WHEN s % 2 = 0 THEN c.owner_membership_id END,
         CASE WHEN s % 2 = 1 THEN 'Visitor' ELSE 'Agent' END,
         'Message ' || s || ' about ' || (${wordArr})[1 + ((abs(hashtext(c.id::text)) + s) % ${words.length})] || ' and ' || (${wordArr})[1 + ((abs(hashtext(c.id::text)) + s * 7) % ${words.length})] || ' for order #' || (abs(hashtext(c.id::text)) % 100000),
         c.requested_at + (s || ' seconds')::interval
    FROM chats c CROSS JOIN generate_series(1, ${perChat}) s
   WHERE c.tenant_id = '${tenantId}';
UPDATE chats SET next_seq = ${perChat + 1} WHERE tenant_id = '${tenantId}';
COMMIT;`);
// One long chat for transcript paging.
const longChatId = sql(`SELECT id FROM chats WHERE tenant_id = '${tenantId}' ORDER BY number LIMIT 1`);
sql(`BEGIN;
SET LOCAL app.tenant_id = '${tenantId}';
INSERT INTO messages (id, tenant_id, chat_id, seq, sender_type, sender_visitor_id, sender_membership_id, sender_name_snapshot, body, sent_at)
  SELECT gen_random_uuid(), c.tenant_id, c.id, ${perChat} + s,
         CASE WHEN s % 2 = 1 THEN 'visitor'::"ActorType" ELSE 'agent'::"ActorType" END,
         CASE WHEN s % 2 = 1 THEN c.visitor_id END, CASE WHEN s % 2 = 0 THEN c.owner_membership_id END,
         CASE WHEN s % 2 = 1 THEN 'Visitor' ELSE 'Agent' END, 'Long transcript line ' || s, c.requested_at + (s || ' seconds')::interval
    FROM chats c CROSS JOIN generate_series(1, ${LONG_CHAT_MESSAGES}) s WHERE c.id = '${longChatId}';
UPDATE chats SET next_seq = ${perChat + LONG_CHAT_MESSAGES + 1} WHERE id = '${longChatId}';
COMMIT;
ANALYZE messages; ANALYZE chats; ANALYZE visitors;`);
const loadS = (now() - loadStarted) / 1000;
const counts = sql(`SELECT (SELECT count(*) FROM messages WHERE tenant_id = '${tenantId}') || ' ' || (SELECT count(*) FROM visitors WHERE tenant_id = '${tenantId}')`).split(' ').map(Number);
console.log(`loaded ${counts[0]} messages, ${counts[1]} visitors in ${loadS.toFixed(1)} s`);

// Transcript paging: newest page, then before_seq back through the whole long chat.
const paging = [];
let page = await owner.call('GET', `/chats/${longChatId}/messages?limit=100`);
paging.push(page.ms);
let pages = 1;
while (page.json.data.has_more && pages < 200) {
  const first = page.json.data.items[0].seq;
  page = await owner.call('GET', `/chats/${longChatId}/messages?before_seq=${first}&limit=100`);
  paging.push(page.ms);
  pages++;
}

// Full-text history search (scoped to the tenant by RLS + filters): common words (in most chats), rare order
// numbers (one chat each) and a term with no match.
const search = [];
for (let i = 0; i < 40; i++) {
  const q = words[i % words.length];
  search.push((await owner.call('GET', `/chats/history?q=${encodeURIComponent(q)}&limit=50`)).ms);
}
const rareTerms = sql(`SELECT string_agg(n, ' ') FROM (SELECT DISTINCT substring(body from '#([0-9]+)') AS n FROM messages WHERE tenant_id = '${tenantId}' AND body LIKE '%order #%' LIMIT 20) x`).split(' ').filter(Boolean);
const searchRare = [];
let rareHits = 0;
for (const n of rareTerms) {
  const r = await owner.call('GET', `/chats/history?q=${n}&limit=50`);
  searchRare.push(r.ms);
  if (r.json.data.length > 0) rareHits++;
}
const searchNone = [];
for (let i = 0; i < 10; i++) searchNone.push((await owner.call('GET', `/chats/history?q=zzq${i}nomatch&limit=50`)).ms);

// Search paging: keyset order holds across candidate batches (no duplicates, strictly older each row), and a filter
// that rejects every candidate still terminates in a bounded number of requests.
const seenIds = new Set();
let ordered = true;
let prevKey = null;
let searchPages = 0;
let nextCursor = null;
do {
  const r = await owner.call('GET', `/chats/history?q=warranty&limit=100${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`);
  for (const c of r.json.data) {
    const key = `${c.requested_at}|${c.id}`;
    if (seenIds.has(c.id) || (prevKey && !(key < prevKey))) ordered = false;
    seenIds.add(c.id);
    prevKey = key;
  }
  nextCursor = r.json.page?.next_cursor ?? null;
  searchPages++;
} while (nextCursor && searchPages < 200);
const matchingChats = Number(sql(`SELECT count(DISTINCT chat_id) FROM messages WHERE tenant_id = '${tenantId}' AND to_tsvector('simple', coalesce(body, '')) @@ websearch_to_tsquery('simple', 'warranty')`));
let filteredRequests = 0;
let filteredItems = 0;
nextCursor = null;
do {
  const r = await owner.call('GET', `/chats/history?q=warranty&status=active&limit=50${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`);
  filteredItems += r.json.data.length;
  nextCursor = r.json.page?.next_cursor ?? null;
  filteredRequests++;
} while (nextCursor && filteredRequests < 50);
const searchPaging = { term: 'warranty', matching_chats: matchingChats, paged_chats: seenIds.size, pages: searchPages, ordered_without_duplicates: ordered, filtered_all_rejected: { requests: filteredRequests, items: filteredItems, terminated: !nextCursor } };
console.log(`search paging: ${seenIds.size}/${matchingChats} chats in ${searchPages} pages, ordered=${ordered}; all-rejected filter: ${filteredItems} items in ${filteredRequests} requests`);
const unfiltered = [];
for (let i = 0; i < 20; i++) unfiltered.push((await owner.call('GET', `/chats/history?limit=50`)).ms);

// Visitor directory paging through the whole tenant.
const visitorPages = [];
let cursor = null;
let seen = 0;
for (let i = 0; i < 300; i++) {
  const r = await owner.call('GET', `/visitors?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  visitorPages.push(r.ms);
  seen += r.json.data.length;
  cursor = r.json.page?.next_cursor;
  if (!cursor) break;
}

const explain = (q) => sql(`BEGIN; SET LOCAL app.tenant_id = '${tenantId}'; SET LOCAL ROLE talkivio_app; EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}; ROLLBACK;`);
// History search candidates run inside rd_search_chat_ids (SECURITY DEFINER, owner role, explicit tenant scope).
const explainOwner = (q) => sql(`BEGIN; SET LOCAL app.tenant_id = '${tenantId}'; EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}; ROLLBACK;`);
const candidatesSql = (term) => `SELECT c.id, c.requested_at FROM chats c WHERE c.tenant_id = rd_current_tenant() AND c.is_preview = false AND c.requested_at >= now() - interval '30 days' AND c.requested_at < now() AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.chat_id = c.id AND m.redacted_at IS NULL AND to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', '${term}')) ORDER BY c.requested_at DESC, c.id DESC LIMIT 500`;
const plans = {
  transcript_page: explain(`SELECT * FROM messages WHERE tenant_id = '${tenantId}' AND chat_id = '${longChatId}' AND seq < 5000 ORDER BY seq DESC LIMIT 101`),
  fts_candidates_common: explainOwner(candidatesSql('warranty')),
  fts_candidates_rare: explainOwner(candidatesSql(rareTerms[0] ?? '0')),
  // For contrast: the same rare-term lookup policy-scoped as the application role cannot use the body index.
  fts_rls_scoped_rare: explain(`SELECT DISTINCT m.chat_id FROM messages m WHERE m.tenant_id = '${tenantId}' AND to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', '${rareTerms[0] ?? '0'}')`),
  visitor_directory: explain(`SELECT * FROM visitors WHERE tenant_id = '${tenantId}' AND erased_at IS NULL ORDER BY last_seen_at DESC, id DESC LIMIT 101`),
};

const report = {
  started_at: started.toISOString(),
  environment: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30), node: process.version, note: 'API, worker, PostgreSQL 16, Redis and the generator on one machine; project on an external volume' },
  fixture: { tenant_id: tenantId, messages: counts[0], visitors: counts[1], long_chat_messages: LONG_CHAT_MESSAGES, bulk_load_s: loadS },
  latencies_ms: { transcript_page_100: stats(paging), transcript_pages: pages, history_search_fts: stats(search), history_search_fts_rare: stats(searchRare), rare_terms_found: `${rareHits}/${rareTerms.length}`, history_search_fts_no_match: stats(searchNone), history_list_unfiltered: stats(unfiltered), visitor_directory_page_100: stats(visitorPages), visitors_paged: seen },
  search_paging: searchPaging,
  budgets: { search_p95_ms: 500, rest_p95_ms: 300, rest_p99_ms: 1000 },
  plans,
};
const outDir = resolve(here, '../../../../docs/performance');
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `data-scale-${started.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}Z.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.latencies_ms, null, 2));
console.log(`report: ${file}`);
