# Performance report

Master prompt ch. 60 (budgets, reference workload, load acceptance) · test matrix PERF01 / PERF02 · release audit
AUD-72-25. Raw results are the timestamped JSON files in this folder; harnesses and method notes are in `README.md`.

**Status, 2026-10-13.**
- The message-rate part of the reference workload passes on a single laptop: 100 msg/s sustained and 200 msg/s
  burst, with a hot tenant taking 50 % of traffic.
- Every ch. 60 latency budget held in the latest run (4).
- The reference connection scale and durations have **not** been run:
  - 1 000 agents, 10 000 visitor sessions, 1 000 active chats and 100 tenants;
  - 10 min warmup, 30 min sustained and a 5 min burst.
- PERF01 therefore stays *partial* until a staging-class run.
- PERF02 passes after four fixes found here, at the API and query-plan level and in the browser: a 10 000-session
  live list and paging through a 10 000-message transcript, with no long tasks (§7).

## 1. Summary against the ch. 60 budgets

| Budget (ch. 60)                                                  | Target                      | Measured (latest)                                                                    | Result |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ | ------ |
| Durable message commit → connected recipient, sustained baseline | p95 ≤ 500 ms, p99 ≤ 2 s     | visitor→agent p95 **15 ms**, p99 **89 ms**; agent→visitor p95 **24 ms**, p99 **99 ms** (run 4, 103 msg/s) | pass |
| Same, during the burst                                           | (same budget)               | visitor→agent p95 **439 ms**, p99 **660 ms**; agent→visitor p95 **476 ms**, p99 **666 ms** (≈200 msg/s) | pass, little margin |
| REST non-export p95 / p99                                        | ≤ 300 ms / ≤ 1 s            | admission p95 45 ms / p99 64 ms; widget session p95 20 ms; history search p95 118 ms; transcript page p95 17 ms | pass |
| Routing offer creation (eligible capacity)                       | p95 ≤ 1 s                   | admission → accepted p95 **128 ms**, p99 209 ms (includes the agent's accept round trip) | pass |
| Server search, 1 M-message scoped fixture                        | p95 ≤ 500 ms                | common term p95 **118 ms**, rare term p95 **55 ms**, no match p95 9 ms (was **5 993 ms**) | pass (after fix) |
| Tenant fairness (one tenant = 50 % of traffic)                   | others not blocked          | hot vs other p95: 194 vs 208 ms (v→a), 242 vs 250 ms (a→v)                          | pass |
| Widget loader / lazy widget (gzip)                               | ≤ 30 KiB / ≤ 200 KiB        | 4.86 KB / 74.07 KB (`apps/widget/scripts/size.mjs`)                                  | pass |
| Dashboard initial route (gzip first-load JS)                     | ≤ 300 KiB                   | /login 243 kB, /inbox 255 kB, /analytics 276 kB; trigger editor 312 kB (not an initial route) | pass (initial routes) |
| UI at data scale (production build, Playwright)                  | responsive                  | 10 000 live sessions: 18 rows in the DOM, 0 long tasks, scroll sweep p95 frame 17 ms; 10 000-message transcript: "load earlier" p95 135 ms, 0 long tasks | pass (after fix) |
| Monitor freshness ≤ 5 s (95 %); loader long task ≤ 50 ms (mobile) | —                          | not measured in this report                                                          | open |
| Load generator must not saturate                                 | —                           | 34 s CPU over a 790 s run (≈ 4 % of one core)                                        | pass |
| Persisted message loss / duplicates after dedupe                 | 0 / 0                       | 0 socket drops; every admitted chat accepted; process-kill and Redis-restart drills in `chaos.e2e.mjs` (21 checks) | pass |

## 2. Environment

One machine runs everything; no network hop separates the generator, API, database and Redis.

| Item                | Value                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Host                | Apple M2, 8 cores (4 performance + 4 efficiency), 8 GB RAM, macOS (Darwin 27)                  |
| Runtime             | Node v22.23.1                                                                                  |
| API                 | 1 process, Socket.IO gateway in-process, Prisma 6 (default pool)                               |
| Worker              | 1 process: outbox publisher (Redis-leased leader) plus BullMQ consumers                         |
| PostgreSQL          | 16 (Homebrew defaults: `shared_buffers` 128 MB, `synchronous_commit` on); data on the internal SSD |
| Redis               | 7, no persistence (the chaos drill uses AOF separately)                                        |
| Generator           | `apps/api/test/load/chat-load.mjs`, the same host, real auth, REST plus WebSocket                |
| Background load     | Desktop apps were open; swap use was already 2.2–3.6 GB before each run. Runs 2 and diagnostic A overlapped macOS photo analysis using about 2 cores |

## 3. Workload versus the reference

| Dimension                    | Reference (ch. 60) | Measured here                                               |
| ---------------------------- | ------------------ | ----------------------------------------------------------- |
| Tenants                      | 100                | 20 (tenant 0 receives 50 % of visitors: skew)               |
| Connected agents             | 1 000              | 180 (9 per tenant; the plan limit is 10)                     |
| Connected visitor sessions   | 10 000             | 360                                                         |
| Simultaneous active chats    | 1 000              | 360                                                         |
| Durable messages, sustained  | 100 / s            | **≈ 103 / s** (run 4 sustain phase: 61 596 messages in 600 s) |
| Durable messages, burst      | 200 / s for 5 min  | **≈ 200 / s** for 2 min (24 024 messages in 120 s)           |
| Warmup / sustained / burst   | 10 / 30 / 5 min    | ramp 1 / sustain 10 / burst 2 min                            |

The 8 GB host cannot also hold 11 000 client sockets, plus the server side of them, without heavy swapping. That
risk is real on this machine: memory pressure on the external project volume has corrupted files before. The
harness already supports the reference method: `WARMUP_S=600 SUSTAIN_S=1800 BURST_S=300` and larger
`TENANTS`/`AGENTS_PER_TENANT`/`VISITORS`.

## 4. Load runs (`chat-load.mjs`, 20 tenants × 9 agents, 360 visitors, 7 s message interval, halved in the burst)

Delivery is send → receipt on the other side's socket, measured on one clock. Agents reply to every visitor message
after 0.2–0.8 s of think time.

| Run (JSON)                          | Code state                                                                 | Delivery p50 | Delivery p95 (v→a / a→v) | p99           | Outbox lag after burst | Host                          |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------ | ------------------------ | ------------- | ---------------------- | ----------------------------- |
| 1 `load-20261013-0447Z`             | baseline: 250 ms idle poll, one BullMQ add per internal event, NOTIFY trigger | 148–159 ms   | 540–554 / 525–533 ms     | 1.85–1.89 s   | 2.1 s                  | quiet                         |
| 2 `load-20261013-0503Z`             | + after-commit Redis nudge, frames first, `addBulk`                        | 9–15 ms      | 15.2 / 11.1–11.3 s       | 16.8–17.8 s   | 17.8 s                 | photo analysis ≈ 2 cores      |
| diag. A (5 min, not kept)           | + publisher stage metrics                                                  | 20–27 ms     | 43.9 / 29.7–30.1 s       | 46–48 s       | 39 s                   | photo analysis ≈ 2 cores      |
| diag. B (5 min, not kept)           | + NOTIFY trigger dropped, fillfactor 70                                    | 3.1–4.8 s    | 26.4–26.7 / 23.0 s       | 25–27.7 s     | 24.9 s                 | photo analysis, swap 3.6 GB   |
| 3 `load-20261013-0545Z`             | + per-row retry schedule (current code)                                    | 10–17 ms     | 2.99–3.25 s / 193–203 ms | 5.2–5.7 s     | 4.2 s                  | memory spike at end of burst  |
| **4 `load-20261013-0601Z`**         | current code, per-phase report                                             | **9–15 ms**  | **194–208 / 242–250 ms** | **0.49–0.56 s** | 0.35 s (recovered in 5 s) | quiet                      |

Run 4 by phase of the send time:

| Phase                    | n (v→a / a→v)   | visitor → agent p50 / p95 / p99 / max | agent → visitor p50 / p95 / p99 / max |
| ------------------------ | --------------- | ------------------------------------- | ------------------------------------- |
| ramp (60 s)              | 1 362 / 1 346   | 9 / 14 / 21 / 86 ms                   | 15 / 23 / 31 / 86 ms                  |
| **sustain (600 s)**      | 30 804 / 30 792 | **8 / 15 / 89** / 858 ms              | **14 / 24 / 99** / 928 ms             |
| **burst (120 s, 2×)**    | 12 044 / 11 980 | **25 / 439 / 660** / 1 148 ms         | **41 / 476 / 666** / 1 143 ms         |
| drain (after the burst)  | 20 / 72         | stragglers while the generator closes chats (shutdown artefact) |                         |

Other run-4 figures:
- **REST:** widget session p95 20 ms; chat admission p95 45 ms / p99 64 ms; time to accept p95 128 ms.
- **Command acks:** visitor send p95 12 ms (burst p95 207 ms); agent send p95 138 ms.
- **Counters:** 0 socket disconnects; all 360 chats admitted and accepted.
- **Errors:**
  - 35 `CAPACITY_EXCEEDED` accept attempts. The hot tenant has exactly as many seats as chats (9 × 20 = 180), and
    agents already at capacity raced for broadcast offers. Capacity was enforced and no chat was lost.
  - 40 `CHAT_CLOSED` replies to chats the generator was closing at shutdown.
- **Outbox:**
  - Sustain: ≈ 580 rows/s in batches of about 6; claim and mark about 1 ms each.
  - Burst: ≈ 1 200 rows/s; claim and mark 1–4 ms each.
- **Host:** load average rose from 6 to about 20 on 8 cores over the burst, and outbox lag reached 0.5 s at the end of
  it. On this host 200 msg/s is close to the ceiling.

Run 3 had the same code as run 4. Its delivery was within budget until near the end of the burst. Then swap jumped
by 480 MB in 10 s, while autovacuum and autoanalyze were running on `outbox_events`, `metric_chat_facts` and
`visitor_sessions`. PostgreSQL stalled for about 30 s: claims took 170 ms and marks 290 ms, and outbox lag peaked at
5.3 s. Server-side commit → emit for that run was ≤ 250 ms for 94 % of messages; the 5.6 % between 1 s and 10 s all
fall in the stall window.

The two directions differ in run 3 (v→a p95 3 s, a→v 0.2 s) because the simulated agents only reply after they
receive a message. During the stall few replies were created, so few agent→visitor samples carry the delay. That is
an effect of the closed-loop measurement, not a different delivery path.

## 5. Bottlenecks found and changes made

| # | Finding (evidence)                                                                                                                                                                                                                                                                  | Change                                                                                                                                                                                                                       | Effect                                                                                     |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1 | The publisher slept 250 ms whenever the outbox was empty, so median delivery was about 150 ms (run 1).                                                                                                                                                                               | After commit, `OutboxService.append` publishes a coalesced Redis nudge (`rd:outbox:nudge`) that wakes the leader (`db/tenant-db.ts` `afterCommit`, `outbox.service.ts`).                                                      | p50 150 ms → 9–15 ms                                                                       |
| 2 | Internal events were queued one BullMQ round trip at a time, between socket emits.                                                                                                                                                                                                  | Socket frames go out first, then a single `addBulk` (`outbox.publisher.ts`).                                                                                                                                                 | Shorter publisher batches                                                                   |
| 3 | An `AFTER INSERT` trigger ran `pg_notify('rd_outbox', …)` per row, and nothing listened. Every transaction that wrote outbox rows took PostgreSQL's database-wide NOTIFY lock at commit and held it through the WAL flush, so message commits ran one at a time. Wait events showed `Lock:object`; the 200-row claim and mark slowed to 0.3–0.8 s and publisher throughput collapsed to 160 rows/s (diag. A). | Trigger and function dropped (`20261013000008_outbox_write_path`).                                                                                                                                                            | `Lock:object` waits gone; burst sustains about 1 200 outbox rows/s                         |
| 4 | Each event was written three times (insert, claim lease, mark). The claim only touches unindexed columns but had no room for a HOT update.                                                                                                                                           | `fillfactor = 70` on `outbox_events` (same migration). The per-row claim lease stays: ch. 3 requires durable worker claims, and the failover check (deployment.md §8.4, RB-04) verifies them.                                                                            | Claim stays about 1 ms under load                                                           |
| 5 | A whole batch succeeded or failed together. One event whose emit or dispatch failed was re-claimed with the same batch every 30 s, holding up to 199 healthy events with it.                                                                                                         | Rows that went out are marked; only failed rows are deferred, with 1, 2, 4 … 60 s backoff (`rd_defer_outbox`, `20261013000009_outbox_defer`). New metrics `talkivio_outbox_publish_stage_seconds`, `talkivio_outbox_batch_rows`, `talkivio_outbox_deferred_total`, and alert `TalkivioOutboxDeferred`. | Resilience (unit spec `outbox.publisher.spec.ts`)                                           |
| 6 | History search, 1 M messages (`data-scale-20261013-0615Z`): p95 **5 993 ms**. (a) Under RLS PostgreSQL never uses a non-leakproof operator (`@@`) as an index condition, so the GIN body index was unusable: a rare term scanned all 1 M tenant rows (2.9–3.3 s). (b) `ts_headline` ran for every matching message, about 24 000 per request. (c) The 2 000-chat candidate cap was applied in `chat_id` order, so newer matches could be dropped (a correctness bug). | `rd_search_chat_ids`: a narrow `SECURITY DEFINER` entry point with an explicit tenant scope from `rd_current_tenant()`, returning chat ids newest first from a keyset and planned per call (`20261013000010_history_search`). Headlines are computed only for the page's chats. Candidate batches of 500 → 4 000 continue behind each other when filters discard most of them (`chat-queries.service.ts`). | p95 118 ms (common), 55 ms (rare), 9 ms (none); paging returns all 10 000 matching chats, ordered, no duplicates |
| 7 | Deleting the 1 M-message fixture tenant did not finish in 10 minutes. `messages(tenant_id, sender_visitor_id)` (`ON DELETE SET NULL`) had no index, so each of the 10 000 deleted visitors scanned all the tenant's messages. The same cost applies to visitor erasure and tenant deletion in production. | Indexes for every foreign key that can multiply this way: messages (sender visitor, sender membership), `chat_participants`, `chats` (session, department, site), `consent_records`, `message_attachments`, and four smaller tables. Large tables use `CREATE INDEX CONCURRENTLY`, one statement per migration (`20261013000011`–`19`). | Same delete: **8.3 s**                                                                      |
| 8 | The live visitor list with 10 000 sessions: every continuation page rebuilt the whole live set (all presence entries plus sessions and open chats) before slicing 100 rows. `GET /visitors/live` p95 was 307 ms, over the REST budget. | Continuation pages reuse the tenant's resolved set for 3 s (`visitor-monitor.service.ts`). | p95 206 ms, p50 218 → 60 ms |
| 9 | History transcript of 10 000 messages: every loaded message stayed in the DOM (70 000 nodes), so each "load earlier" re-laid-out all of them. Latency grew from 105 to 608 ms, with long tasks up to 177 ms. | A rendered window of 600 messages that pages and slides (`history-detail.tsx`). | Flat 91 ms p50, 0 long tasks, 4 208 nodes |

## 6. Headroom and remaining bottlenecks (this host)

- **Sustained rate:** 100 msg/s has wide headroom: load average about 6 of 8 cores, publisher lag 0, delivery p95
  15–24 ms.
- **Burst rate:** 200 msg/s is near the single-host ceiling. Load average reaches about 20, and p95 is 439–476 ms
  against the 500 ms budget.
- **Memory:** A host memory event during the burst (run 3) stalls PostgreSQL and breaks the p99 budget. Production
  must give PostgreSQL its own host with adequate memory and `shared_buffers`, not the 128 MB default here.
- **API process:** One Node process serves HTTP and every socket, and the API reached 61–173 % CPU in bursts. The
  gateway scales out through the Redis adapter, and the publisher already runs in the worker.
- **Outbox writes:** Each event still costs an insert plus a non-HOT mark, because `published_at` is indexed.
  - Next candidates: a partial pending index, or a separate pending queue table.
  - Watch `talkivio_outbox_publish_stage_seconds{stage="claim"|"mark"}` and the lag gauge.
- **Not covered:**
  - object-store throughput (the chat load sends no files);
  - connection churn at scale;
  - DB lock and query-plan capture under the reference workload.

  Wait events were sampled during the diagnostic runs (§5).

## 7. Data scale (`data-scale.mjs`, PERF02)

Fixture: one tenant with 10 000 visitors and chats and 1 000 000 messages, including one 10 000-message chat.
It loads in 38–67 s. Latency is measured through the real API as the tenant owner; plans are captured with
`EXPLAIN (ANALYZE, BUFFERS)`.

| Read path (100 rows/page unless noted)            | Before (`…0615Z`)       | After (`data-scale-20261013-0643Z`) | Budget        |
| ------------------------------------------------- | ----------------------- | ----------------------------------- | ------------- |
| Transcript paging, `before_seq`, 101 pages        | p95 11 ms               | p95 17 ms, p99 19 ms                | REST p95 300  |
| History search, common word (50/page)             | p95 **5 993 ms**        | p95 **118 ms**, p99 251 ms          | search p95 500 |
| History search, rare order number                 | not measured            | p95 **55 ms** (20/20 found)         | search p95 500 |
| History search, no match                          | not measured            | p95 9 ms                            | search p95 500 |
| History list, unfiltered (50/page)                | p95 114 ms              | p95 104 ms                          | REST p95 300  |
| Visitor directory, 100 pages                      | p95 18 ms               | p95 17 ms                           | REST p95 300  |

Search paging for the common word covered all 10 000 matching chats in 100 pages, ordered with no duplicates. A
filter that rejects every candidate (`status=active`; all fixture chats are closed) finished in 2 requests.

Plans in the JSON file:

| Query                                          | Plan                                                                                   | Time    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| Common term                                    | nested-loop semi join, newest chats first                                              | 17.7 ms |
| Rare term                                      | `Bitmap Index Scan on messages_body_fts_idx`                                           | 13.7 ms |
| Same rare term, policy-scoped as the app role  | bitmap scan on the tenant index; 999 901 rows removed by the filter                     | 2 878 ms |
| Transcript page                                | `messages_tenant_id_chat_id_seq_key` backward                                          | 1.3 ms  |
| Visitor directory                              | `visitors_tenant_id_last_seen_at_id_idx`                                               | 0.1 ms  |

### UI responsiveness (`apps/dashboard/e2e/scale.spec.ts`, `SCALE=1`)

The spec runs against the production dashboard build (`next build` + `next start`) in Chrome at 1280 × 800. A fresh
tenant gets 10 000 live visitor sessions: database rows plus the Redis presence keys `PresenceService` writes,
refreshed every 10 s. It also gets one closed chat with 10 000 messages. The spec measures what an agent does: scroll
the live list to its end, then page a transcript back to its first message and forward again. Long tasks come from
`PerformanceObserver`; API times from the browser's request timing. The tenant is deleted afterwards (0.9 s).

| Measure                                              | First run (`scale-ui-20261013-0705Z`) | After the changes (`scale-ui-20261013-0724Z`) |
| ---------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Live list: first rows                                | 1 062 ms                              | 1 012 ms                                      |
| Live list: all 10 001 rows loaded by scrolling        | 99 pages, page p50 389 / p95 410 ms   | 99 pages, page p50 174 / p95 380 ms           |
| `GET /visitors/live` page (browser timing)           | p50 218 / p95 **307** / p99 353 ms    | p50 60 / p95 **206** / p99 224 ms             |
| Rows in the DOM / long tasks / sweep frame gap p95   | 18 / 0 / 17.5 ms                      | 18 / 0 / 17.3 ms                              |
| Transcript: "Load earlier" (50 per page), 200 pages  | p50 336 / p95 608 ms, first tenth p50 105 → last tenth p50 608 ms | p50 91 / p95 135 / max 183 ms, flat (first and last tenth p50 91 ms) |
| Transcript: long tasks                               | 118, p95 136 ms, max 177 ms           | **0**                                         |
| Transcript: DOM nodes in the log                     | 70 009                                | 4 208                                         |
| Transcript: "Show newer" back to the last message    | —                                     | 32 steps, p50 90 / p95 110 ms, 0 long tasks   |
| `GET /chats/{id}/messages` page                      | p95 37 ms                             | p95 25 ms                                     |

Changes made:
- **Live list** (`visitor-monitor.service.ts`): continuation pages reuse the tenant's resolved live set for 3 s instead
  of re-reading all 10 000 presence entries per page. First pages are always fresh; visibility and filters apply per
  request.
- **History transcript** (`history-detail.tsx`): at most 600 messages are rendered.
  - "Load earlier messages" pins the window to the oldest loaded page.
  - "Show earlier / newer messages" slide it through what is already loaded.
  - Before, every loaded message stayed in the DOM, so each page re-laid-out all of them and got slower as the
    transcript grew.
- **Tried and reverted:** `content-visibility: auto` on message bubbles made prepending slower (last tenth p50
  1 131 ms), so it was removed.
- **Not changed:** the inbox transcript of an active chat still keeps every loaded message. Active chats are short;
  a 10 000-message active chat would need the same window.

## 8. Reproduce

```bash
cd apps/api && set -a && . ../../.env && set +a        # API + worker running (README.md)
TENANTS=20 AGENTS_PER_TENANT=9 VISITORS=360 HOT_SHARE=0.5 RAMP_PER_SEC=6 SUSTAIN_S=600 BURST_S=120 MSG_INTERVAL_MS=7000 \
  node test/load/chat-load.mjs                          # run 4 configuration
node test/load/data-scale.mjs                           # leaves a fixture tenant; delete it afterwards (cascades in seconds)
cd ../dashboard && SCALE=1 npx playwright test e2e/scale.spec.ts   # production build on :3000; cleans up its tenant
```

Check `sysctl vm.swapusage` before a run, and watch the timeline (`timeline[]`: outbox lag, swap, load every 5 s) in
the JSON. A stall that lines up with a swap jump is host pressure, not the application.
