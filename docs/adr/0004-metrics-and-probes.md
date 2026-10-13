# ADR 0004 — Metrics and health probes

Status: accepted · 2026-10-12

## Context
Ch. 60–61 define SLOs (REST p95/p99, message commit → recipient latency, routing offer time, monitor freshness,
outbox publish lag) and alert rules (`docs/operations/alerts.md`). Containers need liveness/readiness probes for
api, gateway **and** worker; the worker originally had no HTTP listener.

## Decision
- A small dependency-free Prometheus registry (`apps/api/src/core/metrics.service.ts`, text format 0.0.4) holds
  counters, gauges and histograms with **bounded** label sets only (route groups, command names, outcomes,
  namespaces, queues). No ids, emails or URLs ever become label values.
- Exposition at `GET /health/metrics` on api/gateway (excluded from the `/api/v1` prefix next to `/health/live` and
  `/health/ready`). The worker serves the same three paths on its own listener (`WORKER_HEALTH_PORT`, default 4010).
- Scrape authorization: bearer `METRICS_TOKEN` when set; otherwise only loopback/private-network clients. Other
  callers get `404`.
- DB-derived gauges (oldest queued chat, oldest unscanned upload, oldest unpublished outbox row) come from
  `rd_metrics_snapshot()` — a `SECURITY DEFINER` function returning ages only — cached for 5 s per process.
- Instrumented: HTTP duration + command outcomes (REST mutations and socket commands), durable message emit
  latency, socket connections, routing offer time, job duration/failures, email and webhook delivery outcomes,
  scan duration, monitor freshness.

## Consequences
- Metrics are per process; Prometheus aggregates across replicas. Histograms use fixed buckets sized to the SLO
  thresholds.
- Message delivery latency is measured from commit (`occurred_at`) to socket emit on the publishing node, which is
  an upper bound for connected recipients on that node and excludes client rendering.
- Adding a dependency (e.g. `prom-client`) later is a drop-in change behind `MetricsService`.
