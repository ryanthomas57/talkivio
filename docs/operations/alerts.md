# Alert rules

Master prompt ch. 61 (alerts) and ch. 60 (SLOs). Each alert names its runbook in
[`runbooks.md`](runbooks.md). Severity `page` wakes the on-call; `ticket` is handled in business hours.

> **Status.** The API, gateway and worker expose these metrics at `/health/metrics` (worker: its own listener on
> `WORKER_HEALTH_PORT`); see ADR 0004. Scrape is limited to private networks or a `METRICS_TOKEN` bearer.

## Conventions

- Labels are bounded: `service` (api|gateway|worker|dashboard), `env`, `region`, `route_group`,
  `queue`, `provider`. Never visitor/chat/message ids, never tenant ids in metric labels (tenant scope
  appears in the alert _annotation_ as a pseudonymous reference only when the source is a log/SQL check).
- Every notification includes: runbook link, scope (service/env/region), first occurrence time, current
  value and threshold, and safe evidence (counts, ids, states). **Never** message text, file names,
  emails or secrets.
- SLO window: 30 days. Availability objective 99.9 % for authorized chat admission and send operations
  (≈ 43.2 min budget / 30 days), excluding validation, authorization and client rate-limit denials.

## A. Available now (probes and SQL checks)

SQL checks run every minute from the monitoring system with a dedicated **read-only** role that can read
the listed tables (owner-granted SELECT, BYPASSRLS read-only replica user, or a SECURITY DEFINER view —
pick one and document it; it must not be the application role).

| Alert                                 | Condition                                                                                                                                                                                            | For       | Severity                      | Runbook          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------- | ---------------- |
| `TalkivioApiReadinessLost`           | `GET /health/ready` (api) non-200 from ≥ 2 probe locations                                                                                                                                           | 2 min     | page                          | RB-01            |
| `TalkivioGatewayReadinessLost`       | gateway `:4001/health/ready` non-200, or Socket.IO polling handshake `GET /realtime/v1/?EIO=4&transport=polling` ≠ 200 through the edge                                                              | 2 min     | page                          | RB-02            |
| `TalkivioDashboardDown`              | dashboard `/` ≥ 500 or timeout                                                                                                                                                                       | 5 min     | page                          | RB-01            |
| `TalkivioMessagePublishLag`          | `SELECT extract(epoch FROM now() - min(occurred_at)) FROM outbox_events WHERE published_at IS NULL` **> 30 s**                                                                                       | 5 min     | page                          | RB-02 / RB-03    |
| `TalkivioRoutingQueueAge`            | `SELECT extract(epoch FROM now() - min(requested_at)) FROM chats WHERE status = 'queued'` **> 180 s** (only counts departments that currently have eligible capacity once the routing metric exists) | 2 min     | page                          | RB-05            |
| `TalkivioOffersStuck`                | `SELECT count(*) FROM assignment_offers WHERE status = 'pending' AND expires_at < now() - interval '1 minute'` > 0                                                                                   | 5 min     | page                          | RB-05            |
| `TalkivioScanBacklog`                | `SELECT extract(epoch FROM now() - min(updated_at)) FROM attachments WHERE state IN ('uploaded','scanning') AND deleted_at IS NULL` **> 300 s**                                                      | 5 min     | page                          | RB-06            |
| `TalkivioEmailFailures` (warning)    | last 30 min: failed / total > **5 %**, or > **10** rows `status = 'queued'` older than 10 min (`outbound_emails`)                                                                                    | 10 min    | ticket                        | RB-08            |
| `TalkivioEmailFailures` (critical)   | failed / total > **25 %**, or > **100** queued older than 30 min                                                                                                                                     | 10 min    | page                          | RB-08            |
| `TalkivioWebhookFailures` (warning)  | last 1 h: `webhook_deliveries` non-delivered attempts / total > **10 %** for a single endpoint, or any new `status = 'dead'`                                                                         | 15 min    | ticket (tenant-facing notice) | RB-09            |
| `TalkivioWebhookFailures` (critical) | > **50 %** failing across **≥ 3 tenants** (provider-wide or egress problem)                                                                                                                          | 10 min    | page                          | RB-09            |
| `TalkivioJobFailures`                | `SELECT count(*) FROM jobs WHERE state = 'failed' AND updated_at > now() - interval '15 minutes'` > 5, or running jobs with `lease_until < now() - interval '5 minutes'`                             | 10 min    | ticket                        | RB-05 / RB-07    |
| `TalkivioErasureStuck`               | `SELECT count(*) FROM privacy_requests WHERE kind = 'erase' AND state IN ('queued','running') AND updated_at < now() - interval '1 hour'` > 0                                                        | 15 min    | page (privacy deadline)       | RB-07 / RB-11    |
| `TalkivioDbDiskHigh`                 | database volume used **> 85 %** (provider metric)                                                                                                                                                    | 10 min    | page                          | RB-04            |
| `TalkivioDbConnectionsSaturated`     | `count(*) FROM pg_stat_activity` > 80 % of `max_connections`                                                                                                                                         | 5 min     | page                          | RB-04            |
| `TalkivioWalArchiveLag`              | `pg_stat_archiver`: `now() - last_archived_time` **> 5 min** while writes occur, or `failed_count` increasing (threatens RPO ≤ 5 min)                                                                | 5 min     | page                          | RB-04            |
| `TalkivioBackupStale`                | newest successful base backup older than **26 h**                                                                                                                                                    | 30 min    | page                          | deployment.md §8 |
| `TalkivioReplicationLag`             | replica replay lag > **60 s** (if replicas are used)                                                                                                                                                 | 5 min     | page                          | RB-04            |
| `TalkivioCertificateExpiry`          | any public certificate expires in **< 14 days**                                                                                                                                                      | 1 h       | ticket; **< 3 days**: page    | deployment.md §4 |
| `TalkivioRedisDown`                  | `redis-cli ping` fails or readiness reports `redis: unavailable`                                                                                                                                     | 1 min     | page                          | RB-03            |
| `TalkivioObjectStoreErrors`          | synthetic put/get/delete of a canary object in the clean bucket fails                                                                                                                                | 5 min     | page                          | RB-07            |
| `TalkivioIsolationCanary`            | scheduled synthetic check (A/B synthetic tenants, `infra/test/seed-fixtures.mjs` pattern) observes another tenant's canary                                                                           | immediate | page SEV1                     | RB-11            |

## B. Metric contract (to be implemented by the application)

| Metric                                                              | Type                | Labels                                                                                                                                                          | Used by                      |
| ------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `talkivio_commands_total`                                          | counter             | `service`, `command` (bounded list: chat.admit, message.send, chat.accept, …), `outcome` (ok, validation, denied, rate_limited, server_error, dependency_error) | error budget                 |
| `talkivio_http_request_duration_seconds`                           | histogram           | `service`, `route_group`, `method`, `status_class`                                                                                                              | REST p95/p99                 |
| `talkivio_message_delivery_seconds`                                | histogram           | `audience` (staff, public)                                                                                                                                      | commit → connected recipient |
| `talkivio_outbox_oldest_unpublished_seconds`                       | gauge               | —                                                                                                                                                               | publish lag                  |
| `talkivio_outbox_publish_stage_seconds`                            | histogram           | `stage` (claim, emit, dispatch, mark)                                                                                                                           | publisher bottleneck         |
| `talkivio_outbox_batch_rows`                                       | histogram           | —                                                                                                                                                               | publisher backlog            |
| `talkivio_outbox_deferred_total`                                   | counter             | —                                                                                                                                                               | failed emits/dispatches      |
| `talkivio_routing_queue_oldest_seconds`                            | gauge               | `routable` (true/false)                                                                                                                                         | routing age                  |
| `talkivio_routing_offer_seconds`                                   | histogram           | `mode`                                                                                                                                                          | offer creation               |
| `talkivio_sockets_connected` / `talkivio_socket_reconnects_total` | gauge / counter     | `namespace` (agent, visitor)                                                                                                                                    | socket health                |
| `talkivio_job_failures_total`, `talkivio_job_duration_seconds`    | counter / histogram | `queue`                                                                                                                                                         | jobs                         |
| `talkivio_scan_duration_seconds`, `talkivio_scan_backlog_seconds` | histogram / gauge   | `verdict`                                                                                                                                                       | scanner                      |
| `talkivio_email_deliveries_total`                                  | counter             | `outcome` (accepted, failed, retried)                                                                                                                           | SMTP                         |
| `talkivio_webhook_deliveries_total`                                | counter             | `outcome`, `status_class`                                                                                                                                       | webhooks                     |
| `talkivio_monitor_freshness_seconds`                               | gauge               | —                                                                                                                                                               | monitor ≤ 5 s (95 %)         |

Rules once the metrics exist:

| Alert                            | Expression (PromQL sketch)                                                                                                     | Severity                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `TalkivioErrorBudgetBurnFast`   | burn rate > **14.4** over 1 h **and** > 14.4 over 5 m, where burn = `(sum(rate(talkivio_commands_total{outcome=~"server_error | dependency_error"}[W])) / sum(rate(talkivio_commands_total{outcome!~"validation | denied | rate_limited"}[W]))) / 0.001` | page |
| `TalkivioErrorBudgetBurnSlow`   | burn rate > **6** over 6 h **and** > 6 over 30 m                                                                               | page                                                                             |
| `TalkivioErrorBudgetBurnTicket` | burn rate > **1** over 3 d **and** > 1 over 6 h                                                                                | ticket                                                                           |
| `TalkivioSendLatency`           | p95 `talkivio_message_delivery_seconds` > 0.5 s or p99 > 2 s for 15 min                                                       | ticket (page if burn alerts fire)                                                |
| `TalkivioRestLatency`           | p95 `talkivio_http_request_duration_seconds{route_group!="export"}` > 0.3 s or p99 > 1 s for 15 min                           | ticket                                                                           |
| `TalkivioMessagePublishLag`     | `talkivio_outbox_oldest_unpublished_seconds > 30` for 5 min (replaces the SQL check)                                          | page                                                                             |
| `TalkivioOutboxDeferred`        | `increase(talkivio_outbox_deferred_total[15m]) > 0` (an event failed to emit or reach the events queue)                       | ticket; page if the publish-lag alert also fires                                 |
| `TalkivioOperationalSignalsAbsent` | `absent(talkivio_outbox_oldest_unpublished_seconds)` for 5 min — the DB-derived gauges are dropped, not frozen, while their snapshot query fails (database unreachable) | page (RB-04) |
| `TalkivioRoutingQueueAge`       | `talkivio_routing_queue_oldest_seconds{routable="true"} > 180` for 2 min                                                      | page                                                                             |
| `TalkivioScanBacklog`           | `talkivio_scan_backlog_seconds > 300` for 5 min                                                                               | page                                                                             |
| `TalkivioMonitorStale`          | `talkivio_monitor_freshness_seconds > 15` for 5 min (ch. 61: stale data marked within 15 s)                                   | ticket                                                                           |
| `TalkivioReconnectStorm`        | `rate(talkivio_socket_reconnects_total[5m])` > 5× the 1-day baseline                                                          | page                                                                             |

## Notification template

```
[{{severity}}] {{alertname}} — {{env}}/{{region}} {{service}}
Since: {{first_occurrence}}   Value: {{value}} (threshold {{threshold}})
Scope: {{scope}}   Tenant ref: {{tenant_pseudonym | default "n/a"}}
Evidence: {{safe_evidence}}          # counts, states, ids only
Runbook: docs/operations/runbooks.md#{{runbook_anchor}}
```
