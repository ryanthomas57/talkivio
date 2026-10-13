# Talkivio operational runbooks

Master prompt ch. 61. Every alert in [`alerts.md`](alerts.md) links to a section here by its `RB-` id.
Commands are written for the Docker Compose topology (`docker compose ...`); on Kubernetes or another
orchestrator substitute the equivalent (`kubectl rollout restart deploy/talkivio-gateway`, etc.).

> **Status:** these runbooks are written against the current code but have **not yet been rehearsed**
> with fault injection (ch. 61 acceptance: "inject one dependency fault at a time and prove alert plus
> actionable runbook"). Until a drill records evidence in `docs/traceability.csv`, treat every step as
> untested and note deviations in the incident log.

## Ground rules (all incidents)

- **Roles.** Incident commander (IC) owns decisions and communication; the on-call engineer for the
  failing component executes; Security on-call joins any incident touching credentials or tenant data;
  the Privacy officer joins anything involving personal data exposure. Escalate one level after
  15 minutes without measurable improvement on a SEV1/SEV2.
- **Severity.** SEV1: chats cannot be started/answered for many tenants, or any cross-tenant exposure.
  SEV2: one capability degraded (uploads, email, webhooks, exports) or a single large tenant impacted.
  SEV3: degradation with workaround, no customer-visible loss.
- **Evidence first.** Never delete logs, audit rows, outbox rows, tokens or objects while mitigating.
  Snapshot what you need (`docker compose logs --no-color --timestamps <svc> > incident-<id>-<svc>.log`,
  query output) before restarting anything. Evidence must not contain message bodies, file contents or
  secrets: select ids, counts, states and timestamps only.
- **Database access for diagnosis.** Tenant tables use `FORCE ROW LEVEL SECURITY`; the application role
  sees nothing without a tenant context. Cross-tenant diagnosis uses the owner connection in a
  read-only session through the break-glass procedure (logged, two-person approved in production):

  ```sql
  BEGIN READ ONLY;  -- every diagnosis query below runs inside a read-only transaction
  SET LOCAL statement_timeout = '15s';
  -- query
  ROLLBACK;
  ```

  Locally: `psql "postgresql://talkivio_owner:local-dev-only-owner-db@localhost:55432/talkivio"`.

- **Health endpoints.** `GET /health/live` (process up) and `GET /health/ready` (database + Redis) on the
  api (`:4000`) and gateway (`:4001`); through the proxy `https://<host>/health/ready` reaches the api.
  The worker has no HTTP endpoint yet: check its log and the outbox/job queries below.
- **Communication.** IC posts status at start, every 30 minutes for SEV1/SEV2, at mitigation and at
  resolution. Customer-facing copy states impact and workaround, never internal identifiers.
- **Close-out.** Incident ticket, timeline, evidence links, follow-up actions with owners, and a
  traceability ledger update if a test or alert was added.

---

## RB-01 API outage

**Signals.** `TalkivioApiReadinessLost`, `TalkivioErrorBudgetBurnFast`; 5xx or timeouts on `/api/v1`
and `/widget/v1`; dashboards fail to load data; widget shows "connection problem".

**Diagnosis.**

1. `curl -s -o /dev/null -w '%{http_code}\n' https://<host>/health/live` and `/health/ready` — the ready
   body names the failing dependency (`database`, `redis`).
2. `docker compose ps api` — restart loop? `docker compose logs --since 15m api | grep -E '"level":(50|60)'`
   (pino error/fatal). Look for `Invalid environment configuration` (bad deploy config),
   `ECONNREFUSED` (dependency), heap/OOM kills (`docker inspect talkivio-api-1 --format '{{.State.OOMKilled}}'`).
3. If only some routes fail: check request ids from client reports (`X-Request-Id`) in the api log.
4. Recent change? Compare running image digest with the last known good release.

**Mitigation.**

- Dependency down -> follow RB-04 (database) or RB-03 (Redis); the api recovers on its own once ready.
- Crash loop after a deploy -> RB-12 (roll back the image).
- Resource exhaustion -> scale api replicas / raise memory limit; the api is stateless.
- Overload from a single tenant or abusive client -> rate limits are enforced in Redis; temporarily block
  the source at the edge (WAF/proxy) and record the reason.

**Verification.** `/health/ready` 200 on every replica for 10 minutes; error rate back under SLO;
`node apps/api/test/smoke-v2.mjs` against staging passes after a code-level fix.

**Rollback.** Mitigations are reversible: scale back down, remove temporary edge blocks once rate
limits hold.

**Owner / escalation.** Backend on-call -> Platform on-call (infrastructure) -> IC (SEV1 if both REST
and widget admission are down for > 5 minutes).

---

## RB-02 Socket (gateway) outage

**Signals.** `TalkivioGatewayReadinessLost`, connected sockets drop sharply, reconnect storm,
`TalkivioMessagePublishLag` if the publisher cannot fan out. Agents see "Reconnecting…", visitors keep
REST fallback for history.

**Diagnosis.**

1. `curl -s http://<gateway>:4001/health/ready`; `docker compose logs --since 15m gateway`.
2. Through the proxy: `curl -si 'https://<host>/realtime/v1/?EIO=4&transport=polling'` must return `200`
   with a Socket.IO open packet. 502/504 = proxy cannot reach the gateway; 400 = protocol/path mismatch.
3. Origin rejections spiking after a domain change: compare `APP_URL` / `CORS_ORIGINS` and site origins
   with what browsers send (gateway enforces exact Origin).
4. Redis adapter errors (`ECONNRESET`, `READONLY`) -> RB-03.
5. Ticket failures (`AUTH_REQUIRED` on connect) while REST works: Redis key `rt:ticket:*` writes failing,
   or clock skew between api and gateway (30 s ticket TTL).

**Mitigation.**

- Restart / scale gateway replicas (`docker compose restart gateway`). Messages are durable in PostgreSQL;
  clients reconnect and replay from their cursor, so a restart loses no persisted message.
- Multiple replicas behind a proxy that uses HTTP long-polling need sticky sessions; WebSocket-only
  clients do not.
- Drain before planned restarts (deployment.md "Gateway drain").

**Verification.** Connected socket gauge back to baseline; smoke v2 socket steps pass; spot-check that an
agent receives a new chat within 2 s; no growth in `outbox_events` unpublished count.

**Rollback.** Revert gateway image (RB-12) if the outage followed a deploy.

**Owner / escalation.** Backend on-call (realtime) -> Platform on-call.

---

## RB-03 Redis loss or failover

**Signals.** `TalkivioRedisDown`, api/gateway `/health/ready` 503 with `"redis":"unavailable"`, BullMQ
worker errors, presence shows everyone offline, socket tickets fail.

**What is at risk.** Redis holds presence, socket tickets, rate-limit counters, socket fan-out and
BullMQ scheduling. Messages, offers, outbox rows, jobs and trigger effects are in PostgreSQL (ADR 0001),
so Redis loss must cause **temporary presence uncertainty and reconnection, not transcript loss**.

**Diagnosis.**

1. `docker compose exec redis redis-cli ping` (with `REDISCLI_AUTH`), `INFO persistence`,
   `INFO memory` (`maxmemory` reached? BullMQ requires `noeviction`; evictions corrupt queues).
2. Did the instance restart empty? `INFO server` uptime, `DBSIZE`.

**Mitigation.**

1. Restore Redis (restart, fail over to replica, or provision new and update `REDIS_URL`).
2. Restart worker so BullMQ job schedulers are re-created (`upsertJobScheduler` runs at start).
3. Restart gateway replicas if the adapter does not reconnect; clients reconnect and replay.
4. Presence rebuilds from heartbeats within `AGENT_TIMEOUT_MS` (45 s); routing waits for fresh presence.
5. Durable timers are re-derived from PostgreSQL by the maintenance sweeps (`offer-sweep`,
   `queue-drain`); confirm pending offers expire or are re-offered.

**Verification.**

```sql
-- outbox drains (no growth of unpublished rows after recovery)
SELECT count(*) AS unpublished, min(occurred_at) AS oldest FROM outbox_events WHERE published_at IS NULL;
-- no orphaned pending offers past expiry
SELECT count(*) FROM assignment_offers WHERE status = 'pending' AND expires_at < now() - interval '1 minute';
```

Both should trend to 0 within minutes. Agents appear online again after reconnect.

**Rollback.** None needed; if a new Redis endpoint was introduced, keep the old one isolated for
forensics until the incident closes.

**Owner / escalation.** Platform on-call -> Backend on-call (queue/presence semantics).

---

## RB-04 Database unavailable or degraded

**Signals.** `TalkivioApiReadinessLost` with `"database":"unavailable"`, `TalkivioDbDiskHigh`,
`TalkivioDbConnectionsSaturated`, `TalkivioWalArchiveLag`, Prisma `P1001`/`P1017`/`P2024` errors.

**Diagnosis.**

1. Reachability: `pg_isready -h <host> -p 5432`; provider status page for managed databases.
2. Saturation (owner, read-only):
   ```sql
   SELECT state, wait_event_type, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 3 DESC;
   SELECT pid, now() - xact_start AS xact_age, state, left(query, 80) FROM pg_stat_activity
    WHERE datname = current_database() AND xact_start IS NOT NULL ORDER BY xact_age DESC LIMIT 10;
   SELECT pg_size_pretty(pg_database_size(current_database()));
   ```
3. Lock waits from a migration: `SELECT pid, mode, granted, relation::regclass FROM pg_locks WHERE NOT granted;`
4. Disk: provider metrics / `df -h` on the volume. WAL archive: `SELECT * FROM pg_stat_archiver;`
   (`failed_count` growing, `last_archived_time` stale -> RPO at risk).

**Mitigation.**

- Long-running idle-in-transaction sessions: `SELECT pg_terminate_backend(<pid>)` (record pid, role, age).
- Connection exhaustion: lower replica count or Prisma `connection_limit`, put PgBouncer (transaction mode)
  in front — `set_config(..., true)` is transaction-local, so transaction pooling is compatible.
- Disk > 85 %: extend the volume first; then investigate bloat/retention backlog (RB-08 is unrelated);
  never delete WAL files manually.
- Primary lost: fail over per provider; then verify outbox recovery (below). Writes rejected during
  failover surface as retryable errors to clients.
- If a migration holds locks: stop the rollout (RB-12), cancel the migration session only if it has not
  committed DDL that later steps depend on.

**Verification.** `/health/ready` green; `pg_stat_archiver.failed_count` stable; outbox drains without
duplicate observable delivery (clients dedupe by `event_id`):

```sql
SELECT count(*) FILTER (WHERE published_at IS NULL) AS unpublished,
       max(attempt_count) AS max_attempts FROM outbox_events WHERE occurred_at > now() - interval '1 hour';
```

**Rollback.** Failover back only in a maintenance window after replication catches up.

**Owner / escalation.** Platform on-call (DBA) -> provider support -> IC (SEV1 if writes fail > 5 minutes).

---

## RB-05 Slow routing / queue backlog

**Signals.** `TalkivioRoutingQueueAge` (oldest routable queued chat > 180 s), visitors wait, agents
online with free capacity but no offers.

**Diagnosis.**

```sql
-- oldest queued chats per tenant (ids and timestamps only)
SELECT tenant_id, department_id, count(*) AS queued, min(requested_at) AS oldest
FROM chats WHERE status IN ('queued', 'offered') GROUP BY 1, 2 ORDER BY oldest LIMIT 20;
-- offers stuck pending past expiry (timers not firing)
SELECT tenant_id, count(*) FROM assignment_offers WHERE status = 'pending' AND expires_at < now() GROUP BY 1;
-- unpublished outbox backlog (chat.requested not reaching agents)
SELECT event_type, count(*), min(occurred_at) FROM outbox_events WHERE published_at IS NULL GROUP BY 1 ORDER BY 3;
```

Check the worker log for `offer-sweep` / `queue-drain` failures and serialization retries
(`could not serialize access` warnings are expected occasionally; sustained bursts mean contention).
Check presence: agents `online` in the dashboard but stale heartbeats -> RB-02/RB-03.

**Mitigation.**

- Worker down or stuck -> restart worker; sweeps re-offer queued chats.
- Outbox backlog -> RB-09 style triage of the publisher (worker log), then restart worker.
- Capacity genuinely exhausted -> supervisors raise capacity or bring agents online; enable the
  department fallback / offline form (no code change).
- A single tenant flooding admission -> per-tenant limits; contact tenant.

**Verification.** Oldest queued age < 60 s; pending-past-expiry offers = 0; outbox unpublished stable.

**Rollback.** Return capacity/fallback settings to their pre-incident values (record them first).

**Owner / escalation.** Backend on-call (routing) -> Support lead (customer comms).

---

## RB-06 Scanner (ClamAV) outage

**Signals.** `TalkivioScanBacklog` (oldest attachment in `scanning` > 5 minutes), `clamav` unhealthy,
upload UI shows "Checking file…" indefinitely.

**Expected behaviour.** Files stay in `uploaded`/`scanning` and are **never** downloadable until clean
(ch. 19). Do not switch production to `SCAN_MODE=dev_unscanned` — it is refused in production and would
remove the malware control.

**Diagnosis.**

```sql
SELECT state, count(*), min(updated_at) AS oldest FROM attachments
WHERE deleted_at IS NULL AND state IN ('uploaded', 'scanning') GROUP BY 1;
```

`docker compose logs --since 30m clamav` (freshclam errors, OOM), `docker compose exec clamav clamdcheck.sh`,
TCP check from the worker network to `clamav:3310`. clamd needs 2-3 GB RAM; OOM kills are the usual cause.

**Mitigation.** Restart clamav (signatures persist in the `clamav_db` volume); raise memory limit; if
signature downloads fail (egress blocked, rate limited), restore egress or mount a mirror. Scan jobs
retry automatically once clamd answers.

**Verification.** Backlog drains; a clean PNG becomes downloadable; the EICAR test string is rejected
(`state = 'rejected'`).

**Rollback.** Not applicable; never mark files clean by hand.

**Owner / escalation.** Platform on-call -> Security on-call if the outage exceeds 1 hour (decide
whether to disable uploads tenant-wide with customer notice).

---

## RB-07 Object store loss or outage (S3 / MinIO)

**Signals.** Upload init/finalize errors, downloads 5xx, export jobs failing (`jobs.last_error_code`),
`TalkivioObjectStoreErrors`.

**Diagnosis.** Endpoint reachability from api/worker (`S3_ENDPOINT`), credential errors
(`AccessDenied` = policy/credential change, `NoSuchBucket` = wrong bucket or lost data), provider status.

```sql
SELECT kind, state, last_error_code, count(*) FROM jobs WHERE updated_at > now() - interval '1 hour' GROUP BY 1, 2, 3;
```

**Mitigation.**

- Outage: uploads and exports fail honestly (no fake success); jobs retry. Communicate degraded files.
- Credential problem: rotate back to a working least-privilege key (never use root credentials in apps).
- Data loss: restore objects from versioning/replica per [deployment.md](deployment.md) "Object storage".
  The privacy ledger (`exports/privacy-ledger/…`) must be restored **before** any database restore so
  tombstone replay is complete.

**Verification.** Upload -> scan -> download works; a historical attachment checksum (`attachments.sha256`)
matches the restored object; export job succeeds.

**Rollback.** Revert credential changes; keep the damaged bucket read-only for forensics.

**Owner / escalation.** Platform on-call -> Privacy officer if restored objects could include erased subjects.

---

## RB-08 SMTP outage / email delivery failures

**Signals.** `TalkivioEmailFailures` warning (> 5 % failed or > 10 queued older than 10 minutes) /
critical (> 25 % or > 100 older than 30 minutes); verification and invitation mails missing.

**Diagnosis.**

```sql
SELECT status, count(*), min(created_at) AS oldest, max(attempts) FROM outbound_emails
WHERE created_at > now() - interval '6 hours' GROUP BY 1;
SELECT left(last_error, 120) AS error, count(*) FROM outbound_emails
WHERE status IN ('queued', 'sending', 'failed') AND created_at > now() - interval '6 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

Provider status page; DNS/TLS to `SMTP_HOST:SMTP_PORT` from the worker; credential expiry; SPF/DKIM/DMARC
rejections (bounces) vs transport failures.

**Mitigation.** Emails are persisted before delivery and retried by the worker, so recovery resumes
automatically; never mark rows delivered manually. Fail over to a secondary SMTP relay by changing
`SMTP_*` and restarting the worker. Offline forms still save (they distinguish "saved" from "emailed").

**Verification.** Queue drains and new rows reach `status = 'accepted'` with `accepted_at` set (SMTP accepted; `delivered_at` stays empty unless the provider confirms delivery — the UI must not claim "delivered" before that); a test verification email arrives.

**Rollback.** Switch back to the primary relay after it is healthy for 1 hour.

**Owner / escalation.** Platform on-call -> Support lead (customer comms if > 1 hour).

---

## RB-09 Third-party provider outage (webhook targets, OAuth, billing, connectors)

**Signals.** `TalkivioWebhookFailures` warning/critical, dead-lettered deliveries, OAuth sign-in errors,
billing webhooks failing signature checks.

**Diagnosis.**

```sql
SELECT status, count(*), max(attempts), min(next_attempt_at) FROM webhook_deliveries
WHERE created_at > now() - interval '24 hours' GROUP BY 1;
SELECT endpoint_id, response_status, count(*) FROM webhook_deliveries
WHERE status <> 'delivered' AND created_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;
```

Distinguish one tenant's broken endpoint (customer problem, keep retrying per schedule) from a provider-wide
outage (OAuth/billing).

**Mitigation.** Retries follow the bounded schedule (≈ 0 s, 10 s, 1 m, 5 m, 30 m, 2 h, 8 h, 24 h) then dead
letter; dead letters stay visible to the tenant for redelivery with the **same event id**. For OAuth, users
fall back to password + MFA. Never disable SSRF protection to "fix" delivery.

**Verification.** New deliveries succeed; tenant redelivery of dead letters works and is de-duplicated by
the receiver.

**Rollback.** Re-enable any connector disabled during the incident.

**Owner / escalation.** Backend on-call (integrations) -> Support lead (tenant outreach).

---

## RB-10 Leaked token or credential

**Applies to.** API tokens (`integration_credentials`), webhook signing secrets, session cookies, site
identity secrets, database/Redis/S3/SMTP credentials, `APP_SECRET`, CI secrets.

**Diagnosis.** Identify what leaked, where (repo, log, ticket, screenshot), since when, and its scope.
For API tokens use the prefix only:

```sql
SELECT id, tenant_id, prefix, scopes, last_used_at, revoked_at, expires_at FROM integration_credentials WHERE prefix = '<prefix>';
```

Pull access logs for the window (request ids, IP hashes, routes) — do not copy payloads.

**Mitigation (in order; do not delete evidence).**

1. **Revoke/rotate** at the source: revoke the API token (tenant admin UI or `revoked_at`), rotate the
   webhook secret with the documented overlap, revoke user sessions (`auth_sessions.revoked_at`; password
   reset forces revocation), rotate infrastructure credentials in the secret manager and roll the pods.
2. `APP_SECRET` leak: it encrypts secrets at rest and keys HMACs — rotation needs a re-encryption plan;
   escalate to Security on-call immediately; treat stored integration secrets as exposed.
3. Database role password: `ALTER ROLE talkivio_app PASSWORD …` (superuser / secret manager), update
   `DATABASE_URL`, restart api/gateway/worker.
4. Purge the secret from the exposure location (git history rewrite, log redaction) **after** evidence is
   preserved; for git, rotate first — history rewrites do not un-leak.
5. Review audit events for the window: `SELECT action, object_type, count(*) FROM audit_events WHERE tenant_id = '<t>' AND occurred_at BETWEEN … GROUP BY 1, 2;`

**Verification.** Old credential is rejected (try it in a controlled call); no further use in logs; new
credential works.

**Rollback.** None for revocation. Keep the revoked credential record for audit.

**Owner / escalation.** Security on-call (owner) -> IC -> Privacy officer if personal data may have been
accessed; customer notification per contract/jurisdiction.

---

## RB-11 Tenant data exposure / isolation failure

**Signals.** A customer reports another tenant's data, a canary string (e.g. `RD-CANARY-BETA-7Q4X-PRIVATE`
in test environments) appears in the wrong tenant, a TEN0x test fails in CI/staging, RLS policy errors.
This is always **SEV1**.

**Immediate actions (first 15 minutes).**

1. IC declares SEV1, Security on-call and Privacy officer paged.
2. **Disable the affected capability**, not the whole product, if it is identifiable (feature flag, route
   block at the proxy, disable exports/search/webhooks). If not identifiable, stop the rollout and roll
   back to the last known good release (RB-12).
3. **Preserve evidence**: request ids, logs, database snapshot (provider snapshot or `pg_dump` of
   affected tables to secure storage), audit events. Do not "clean up" rows.
4. Revoke tokens/sessions that could have been used to pull data (RB-10).

**Diagnosis.**

- Confirm the role in use: `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;`
  from the app's connection — it must be `talkivio_app`, `false`. A service accidentally running with
  the owner/superuser URL bypasses RLS.
- Verify policies are intact: `SELECT tablename FROM pg_tables t WHERE schemaname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = t.tablename) AND tablename NOT IN ('users','auth_sessions','auth_tokens','oauth_accounts','trusted_devices','outbound_emails','_prisma_migrations','billing_events');`
  plus `relforcerowsecurity` on each tenant table.
- Check new SECURITY DEFINER functions introduced by recent migrations.
- Reproduce with the A/B tenant tests (`apps/api/test/smoke-v2.mjs` isolation section,
  `infra/test/seed-fixtures.mjs`).

**Mitigation.** Fix forward with a test that fails before the fix; deploy via the normal pipeline with
the isolation tests as required gates.

**Verification.** Isolation tests pass in staging and production smoke; affected capability re-enabled
only after IC + Security sign-off.

**Communication.** Privacy officer determines notification obligations; follow the customer communication
process; preserve the evidence package for regulators/customers.

**Owner / escalation.** IC + Security on-call (joint owners) -> executive sponsor.

---

## RB-12 Failed deployment

**Signals.** Rollout halted by health checks, error-budget burn after a release, migration job failure,
smoke tests failing after promotion.

**Diagnosis.** Which step failed (see [deployment.md](deployment.md) sequence)? `migrate` job log;
new pods' `/health/ready`; error rate per version; whether a migration already committed.

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at, left(logs, 200) FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;
```

**Mitigation.**

- Stop the rollout (stop shifting traffic).
- App images: roll back to the previous **digest** (immutable artifact) — compatible because migrations
  are expand-only during a rollout.
- Migration failed before commit: fix and re-run (Prisma records the failure; resolve with
  `prisma migrate resolve --rolled-back <name>` only after confirming nothing was applied).
- Migration applied but app broken: roll back the app; **do not** reverse destructive migrations
  automatically — forward-fix, or restore with a clearly stated data-loss window (deployment.md).
- Config regression: publish a new config revision pointing to the prior safe content.

**Verification.** Smoke v2 + seed-fixture checks pass against the rolled-back environment; error rate
back to baseline; `_prisma_migrations` consistent.

**Rollback.** Re-attempt the release only after root cause and a new artifact.

**Owner / escalation.** Release captain -> Backend on-call -> IC if customer impact > 15 minutes.
