# Observability assets

- `prometheus.yml` — scrape config for api (`:4000`), gateway (`:4001`) and worker (`:4010`) at `/health/metrics`.
- `alert-rules.yml` — Prometheus recording + alert rules generated from `docs/operations/alerts.md` (runbook ids
  refer to `docs/operations/runbooks.md`).
- `alert-rules.test.yml` — promtool unit tests: each alert stays quiet before its condition and its `for:` window,
  then fires with its exact labels and summary (`promtool test rules infra/observability/alert-rules.test.yml`).
- `alertmanager.yml` — routing: `severity: page` → the paging receiver, `severity: ticket` → the ticket receiver;
  receiver webhook URLs are read from mounted secret files. `alertmanager-routes.test.sh` proves every alert reaches
  the receiver its severity names (runs in CI with `amtool`).
- `grafana-talkivio-health.json` — Grafana dashboard (import; choose your Prometheus data source).

Metric names, labels and semantics: ADR 0004 and `docs/operations/alerts.md`. These files are not part of the
Compose stack; run Prometheus/Grafana in your monitoring environment and point them at the private network.

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, e.g. an OpenTelemetry Collector on `:4318`) on the api, gateway and
worker; each process reports as `talkivio-api`, `talkivio-gateway` or `talkivio-worker`.

- **Message lifecycle.** A request that commits domain events stores its W3C `traceparent` on the outbox rows
  (`outbox_events.trace_parent`); the worker's `outbox.publish <event type>` span continues that trace, and the Redis
  `PUBLISH` that fans the frame out to sockets is its child. Internal consumers are queued under one
  `outbox.dispatch internal` span per batch, joined to the first event's trace and linking the others. One trace
  therefore runs from the HTTP or socket command through commit to delivery (`apps/api/test/tracing.e2e.mjs`).
- **No content in spans.** Every span is scrubbed before export (`apps/api/src/common/trace-scrub.ts`): query
  strings (download-grant signatures, search terms), client addresses, user agents, Redis command arguments (job
  data, socket frames) and exception messages are removed, and calls to external URLs keep only their origin.
  Health probes and metric scrapes are not traced; Redis commands are traced only inside traced work.
