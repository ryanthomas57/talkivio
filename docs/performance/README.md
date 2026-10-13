# Performance testing

Master prompt ch. 60 (budgets, reference workload) and test-matrix rows PERF01/PERF02. Raw results are the
timestamped JSON files in this folder; the summary report is `performance-report.md`.

## Harnesses
| Script | What it measures |
| --- | --- |
| `apps/api/test/load/chat-load.mjs` | Mixed REST + WebSocket chat workload with real auth: tenants with broadcast routing, agents accepting and replying, visitors ramping in, sending at a steady rate and then a 2× burst. Records widget session and admission REST latency, command acknowledgement latency (visitor and agent sends), commit → recipient delivery latency in both directions per tenant (hot vs other) **and per phase of the send time** (ramp, optional `WARMUP_S`, sustain, burst, drain), time to accept, errors by code, socket drops, server gauges (outbox lag, queue age), API/worker CPU/RSS and other busy host processes during the burst, and a 5 s `timeline` of outbox lag, swap and load average. |
| `apps/api/test/load/data-scale.mjs` | Read paths at volume: a fresh tenant bulk-loaded with 10 000 visitors/chats and 1 000 000 messages plus a 10 000-message transcript; measures transcript paging (100 per page), scoped full-text history search (common words, rare order numbers, no match), search keyset paging across candidate batches and with a filter that rejects every candidate, the unfiltered history list and visitor directory paging through the real API, and captures `EXPLAIN (ANALYZE, BUFFERS)` plans (application role under RLS; the search entry point as its owner). |
| `apps/dashboard/e2e/scale.spec.ts` (`SCALE=1`) | Browser side of PERF02 against the production dashboard build: a fresh tenant with 10 000 live visitor sessions (database rows plus Redis presence, kept fresh) and a 10 000-message chat. Measures first rows, loading every live-list page by scrolling, rows in the DOM, frame gaps and long tasks during a full scroll sweep, and transcript paging back to the first message and forward again (per-page latency, long tasks, DOM size). Writes `scale-ui-<stamp>Z.json` here and deletes its tenant. |

Both scripts need the API + worker running and `DATABASE_OWNER_URL` (for email tokens / bulk load). Example:

```bash
cd apps/api && set -a && . ../../.env && set +a
TENANTS=3 AGENTS_PER_TENANT=4 VISITORS=120 SUSTAIN_S=120 BURST_S=30 node test/load/chat-load.mjs
# reference method (ch. 60): WARMUP_S=600 SUSTAIN_S=1800 BURST_S=300 with the reference tenant/agent/visitor counts
# diagnostic runs: REPORT_DIR=<scratch dir> keeps the JSON out of this folder
node test/load/data-scale.mjs
```

## Method notes
- Simulated clients sit behind the reverse proxy: requests carry `X-Forwarded-For` from private ranges and the API
  trusts the local generator (`TRUST_PROXY=loopback`), exactly like production behind Caddy. Per-client limits
  (120 widget sessions/min, 120 visitor socket connects/min, 60 agent socket connects/min per address) therefore
  apply per simulated client.
- Message bodies carry a base-36 send timestamp so delivery latency is measured on one clock (generator and
  server share the host). Card-number masking would otherwise rewrite long digit runs.
- The generator runs on the same host as the API, worker, PostgreSQL and Redis; its own CPU time is recorded.
  Results on one laptop are **not** evidence for the ch. 60 reference workload (100 tenants, 1 000 agents,
  10 000 visitors, 100 msg/s sustained); they establish the method and a single-node baseline.
- Check `sysctl vm.swapusage` before a run and read the `timeline`: on an 8 GB host a stall that lines up with a swap
  jump is host memory pressure (run 3 in the report), not the application. Server-side stage timings come from the
  worker's `/health/metrics` (`talkivio_outbox_publish_stage_seconds`, `talkivio_outbox_batch_rows`).
- Delete the data-scale fixture tenant afterwards (`DELETE FROM tenants WHERE id = …` as the owner; seconds since the
  foreign-key indexes of `20261013000011`–`19`).
