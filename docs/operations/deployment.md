# Deployment, rollback and disaster recovery

Master prompt ch. 63-64. This document is the procedure; evidence of each rehearsal (dates, measured
RPO/RTO, deviations) belongs in `docs/traceability.csv` (DEPLOY02, DEPLOY03, PRIV02, AUD-72-32/33/34).

> **Status:** no staging or production environment exists yet, and none of the drills below has been
> executed against one. What _has_ been exercised locally/in CI: role bootstrap + migrations as a
> non-superuser owner, idempotent re-runs, RLS default deny, and the tombstone replay against a restored
> `pg_dump` (`apps/api/test/integrations.e2e.mjs`). Do not declare production readiness until the
> checklist at the end is complete with evidence.

## 1. Artifacts

| Artifact                         | Built by                                                                              | Notes                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talkivio/api@sha256:…`         | `infra/docker/api.Dockerfile`, target `runtime`                                       | one image for api, gateway, worker (role = command)                                                                                                            |
| `talkivio/migrate@sha256:…`     | same Dockerfile, target `migrate`                                                     | owner credentials are given to this job only                                                                                                                   |
| `talkivio/dashboard@sha256:…`   | `infra/docker/dashboard.Dockerfile`                                                   | `API_INTERNAL_URL` / `NEXT_PUBLIC_*` are build-time; build once per environment _family_ or move them to runtime config before promoting one digest everywhere |
| Widget assets                    | `apps/widget/dist` (inside the api image at `/app/widget-dist`, or uploaded to a CDN) | hashed `frame/*` files are immutable; `loader.js` is short-cached (300 s)                                                                                      |
| SBOM, Trivy report, test reports | CI artifacts named with the commit SHA                                                |                                                                                                                                                                |

Rules: images are referenced **by digest**; the digest that passed staging is the digest promoted to
production (never rebuilt from a branch); images carry `org.opencontainers.image.revision` = commit SHA.
Signing and provenance attestations are a TODO in CI until a registry is chosen.

## 2. Configuration and secrets

- Every variable is documented in [`.env.example`](../../.env.example). Production differences:
  `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS `API_URL`/`APP_URL`, `TRUST_PROXY` = the load
  balancer hop count or subnet, `EMAIL_PROVIDER=smtp`, `STORAGE_DRIVER=s3`, `SCAN_MODE=clamav`,
  `GATEWAY_SEPARATE=true`, no `TALKIVIO_WEBHOOK_ALLOW_PRIVATE` (local webhook test path only; the code
  ignores it in production anyway), no `SEED_*`, no `SCAN_MODE=dev_unscanned` (refused in production).
  Files/exports: `S3_QUARANTINE_BUCKET` / `S3_CLEAN_BUCKET` (private), `S3_*_PREFIX`, `S3_DOWNLOAD_MODE`
  (`proxy` adds nosniff/CSP; `presigned` needs `S3_PRESIGN_ENDPOINT` when browsers reach the store on a
  different host), `CLAMAV_HOST`/`CLAMAV_PORT`/`CLAMAV_TIMEOUT_MS`, `UPLOAD_DAILY_QUOTA_*`.
  Webhooks/privacy tuning: `TALKIVIO_WEBHOOK_TIMEOUT_MS`, `TALKIVIO_WEBHOOK_ROTATION_OVERLAP_MINUTES`,
  `TALKIVIO_ERASURE_TRANSCRIPT_POLICY`, `TALKIVIO_ACCESS_EXPORT_INCLUDE_NOTES`,
  `TALKIVIO_PRIVACY_EXPORT_TTL_DAYS`, `TALKIVIO_PROOF_RETENTION_DAYS`, `TALKIVIO_RETENTION_*`,
  `TALKIVIO_WEBHOOK_DELIVERY_RETENTION_DAYS` (defaults in `.env.example`).
- Secrets (`APP_SECRET`, database passwords, Redis password, S3 keys, SMTP credentials, OAuth/billing
  secrets) come from the platform secret manager as environment variables or mounted files. Prefer
  workload identity for cloud storage instead of static keys. Never as build args, never in images.
- `DATABASE_OWNER_URL` exists only in the migration job's secret scope.
- Each process role runs under its own service account; the database and object store are on private
  networks; Redis requires auth (and TLS when it leaves the private network).
- Redis must run with append-only persistence (`appendonly yes`, `appendfsync everysec` or stricter): it holds
  BullMQ jobs for internal consumers (webhooks, triggers, analytics facts), visitor capability revocations and
  presence. Restarts with AOF lose nothing (`apps/api/test/chaos.e2e.mjs` scenario C). After a failover to an empty
  replica, open sockets re-register presence on their next heartbeat and the worker re-asserts its schedulers
  within 60 s (scenario D); jobs that were only in Redis at that moment are lost, so prefer replicas with AOF.
- Containers: non-root (`node`), read-only root filesystem with tmpfs `/tmp` (dashboard also
  `/app/apps/dashboard/.next/cache`), `cap_drop: ALL`, `no-new-privileges`, CPU/memory limits.
  Probes: liveness `GET /health/live`, readiness `GET /health/ready` (api :4000, gateway :4001, worker
  `WORKER_HEALTH_PORT`, default 4010). SIGTERM drains gracefully: readiness turns 503 `draining`, in-flight
  requests finish, sockets transport-close and reconnect elsewhere (`SHUTDOWN_DRAIN_DELAY_MS`, default 5 s in
  production; `SHUTDOWN_TIMEOUT_MS`, default 25 s — keep the orchestrator grace period above their sum).

## 3. Database roles (one-time per cluster)

Run [`infra/postgres/sql/00-roles-and-database.sql`](../../infra/postgres/sql/00-roles-and-database.sql)
as a superuser (or the provider's admin role) with passwords from the secret manager:

```bash
psql "$ADMIN_URL" -X -v ON_ERROR_STOP=1 \
  -v owner_password="$OWNER_PW" -v app_password="$APP_PW" -v db_name=talkivio \
  -f infra/postgres/sql/00-roles-and-database.sql
```

It creates `talkivio_owner` (LOGIN, CREATEROLE, **BYPASSRLS**, not superuser), the `talkivio_app_role`
group and the `talkivio_app` login, and the database owned by `talkivio_owner`. The owner needs
BYPASSRLS because the narrow `SECURITY DEFINER` entry points (site-key resolution, outbox claim,
membership lookup) read across tenants under `FORCE ROW LEVEL SECURITY`. **Managed PostgreSQL:** confirm
the provider lets the admin role grant BYPASSRLS; if it does not, this is a launch blocker to resolve
(e.g. have those functions owned by a provider role that can bypass RLS) — do not work around it by
running the app as the owner.

## 4. Rollout sequence (every release)

1. **Preflight.** TLS certificates valid > 14 days; backups healthy (last base backup < 24 h, WAL archive
   lag < 5 min); alert routing on; release notes list migrations and their phase (expand/contract);
   staging smoke passed on the same digests.
2. **Validate configuration.** Start one api container with the new image and production config in a
   preflight job: it exits on `Invalid environment configuration`.
3. **Expand migrations, once, with a lock.** Run the `migrate` image as a one-shot job:
   `infra/postgres/migrate.sh` verifies the role contract, then `prisma migrate deploy` (PostgreSQL
   advisory lock; concurrent runs serialize). Only expand-phase migrations may ship in a release that
   still runs old application code (see §5). Watch lock waits (RB-04) while it runs.
4. **Workers** — deploy the new worker (it must tolerate the old api writing old-shape rows).
5. **API** — rolling deploy; readiness gates traffic.
6. **Gateway** — drain (§7), then roll; clients reconnect and replay from their cursor.
7. **Widget assets** — upload hashed files first (immutable cache), then `loader.js`; old frames keep
   loading their own hashed assets during the compatibility window.
8. **Configuration manifest** — publish any config revision the release needs.
9. **Dashboard** — rolling deploy.
10. **Warm and smoke.** Readiness on every replica; production smoke uses a dedicated synthetic tenant
    (never the demo seed — it refuses `NODE_ENV=production`): login, widget bootstrap on the synthetic
    site's origin, send/receive a message over sockets, upload a clean file, receive an email.
11. **Progressive traffic shift** (e.g. 5 % → 25 % → 100 % at the edge) while watching send latency,
    routing age, error budget and isolation canaries.

**Stop conditions (halt and roll back the app, RB-12):** send/command error rate above SLO, any tenant
isolation failure, oldest routable queued chat > 180 s caused by the release, migration lock impact on
live traffic, readiness flapping.

Compatibility window: the api/gateway accept both the previous and the new client protocol for at least
one release (old widget frames and dashboards stay open for hours).

## 5. Expand / contract migrations

Migrations are SQL files under `apps/api/prisma/migrations/<timestamp>_<name>/` and are immutable once
released (ADR 0002). Each change is split across releases:

| Phase                                          | Allowed                                                                                        | Examples                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expand** (release N)                         | additive, backward compatible, safe under concurrent writes                                    | new nullable column / column with constant default; new table with RLS + tenant FK; `CREATE INDEX CONCURRENTLY` (own migration, no transaction); new enum value; new SECURITY DEFINER function |
| **Migrate data** (release N, worker/job)       | idempotent, batched, resumable backfill                                                        | backfill in batches of ≤ 5 000 rows with `UPDATE … WHERE id IN (…) AND new_col IS NULL`                                                                                                        |
| **Switch** (release N+1)                       | code reads/writes the new shape; old shape still written if a rollback to N must stay possible | dual-write period                                                                                                                                                                              |
| **Contract** (release N+2, after a stable N+1) | destructive                                                                                    | drop old column/table, `SET NOT NULL` (after `CHECK … NOT VALID` + `VALIDATE`), remove enum use                                                                                                |

Never in one release: rename a column used by running code, drop anything the previous release reads,
add `NOT NULL` without a default on a large table, take long `ACCESS EXCLUSIVE` locks. Every new
tenant-owned table needs `ENABLE`/`FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, the
`(tenant_id) → tenants(id)` FK and composite FKs for parents. CI applies all migrations from empty on
every PR; a "from previous release schema" migration test is still to be added (AUD-72-03).

## 6. Rollback

- **Application:** redeploy the previous image **digests** (api, gateway, worker, dashboard) — safe
  because the schema only expanded. Keep the previous digests recorded in the release ticket.
- **Database:** destructive migrations are **never** reversed automatically. If a forward change is
  wrong: ship a forward-fix migration. If data was transformed incorrectly and cannot be repaired
  forward, restore (§8) with an explicitly stated data-loss window approved by the IC.
- **Configuration:** publish a new revision whose content equals the last known good one (revisions are
  append-only; do not edit history).
- **Widget:** point `loader.js` back to the previous hashed frame set (old assets are retained).

## 7. Gateway drain

1. Remove the replica from the load balancer (stop new upgrades).
2. Send SIGTERM; tini forwards it; Nest shutdown hooks close the Socket.IO server; clients receive a
   disconnect and reconnect to another replica with their `last_cursor`, replaying missed durable events
   (no persisted message is lost; ephemeral typing/presence is re-established).
3. Allow a grace period (≥ 30 s) before the orchestrator kills the container.
4. Watch reconnect rate and `outbox_events` publish lag; continue with the next replica when stable.

## 8. Backups and disaster recovery

### 8.1 PostgreSQL: base backups + continuous WAL archiving

Targets (ch. 60 objectives, subject to the measured drill): **RPO ≤ 5 minutes**, **RTO ≤ 60 minutes**, daily base backup,
continuous WAL, 35-day retention (bounded by the privacy retention policy), encrypted at rest with keys in
the KMS (not stored with the backups), backups in a separate account/region.

Self-managed example with pgBackRest (managed services: enable PITR with the same targets):

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-type=s3
repo1-s3-bucket=talkivio-pg-backups
repo1-s3-region=eu-west-1
repo1-path=/talkivio
repo1-retention-full=5
repo1-cipher-type=aes-256-cbc          # passphrase from the secret manager
start-fast=y
compress-type=zst

[talkivio]
pg1-path=/var/lib/postgresql/data
```

```
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=talkivio archive-push %p'
archive_timeout = 60
```

Daily `pgbackrest --stanza=talkivio --type=full backup` (or diff/incr), monitored by
`TalkivioWalArchiveLag` and `TalkivioBackupStale` ([alerts.md](alerts.md)).

### 8.2 Object storage

Versioning on the clean bucket (enabled by `infra/minio/init-buckets.sh` locally), cross-region
replication or scheduled copy, lifecycle rules aligned with retention (expired versions are purged so
erased data does not live forever). **Every lifecycle/expiry rule must exclude the
`exports/privacy-ledger/` prefix** (scope rules to `quarantine/`, `clean/` and `exports/` artifacts other
than the ledger, e.g. with a prefix filter per artifact type), otherwise erasures could be resurrected by a
later restore. No lifecycle rules are configured by the local MinIO init job. The **privacy erasure ledger** lives at
`exports/privacy-ledger/<tenant>/<request>.json` in the clean bucket — deliberately outside the database
backup scope — and must be backed up/replicated with the objects and restored **before** any database
restore is opened.

### 8.3 Restore drill (quarterly and before launch; also the real recovery procedure)

1. Declare the drill (or incident), record start time T0 and the target recovery point.
2. Provision an **isolated** environment (own network, no production DNS, outbound email disabled or
   pointed at a sink, webhooks disabled).
3. Restore objects (or point to the replica) including `exports/privacy-ledger/`.
4. Restore PostgreSQL: `pgbackrest --stanza=talkivio --type=time --target="<timestamp>" restore`,
   start, wait for recovery to complete. Record the last replayed transaction time = achieved RPO.
5. Verify roles/policies: `talkivio_app` is not BYPASSRLS; every tenant table has `relforcerowsecurity`.
6. **Replay the erasure ledger before any traffic** (PRIV02) with the same image digest:
   ```bash
   docker run --rm --network <isolated> --env-file restore.env talkivio/api@sha256:<digest> \
     node scripts/replay-tombstones.mjs --json
   # restore.env: DATABASE_URL (talkivio_app), REDIS_URL, APP_SECRET and the S3 settings of the restored env
   # options: --tenant <uuid>  --source ledger|db|both (default both)  --dry-run
   # exit codes: 0 ok, 1 error, 2 completed with unconfirmed targets (treat 2 as a failed drill step)
   ```
   Run it a second time: it must report no changes (idempotent).
7. Schema and data checks:
   ```sql
   SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL; -- expect none
   SELECT count(*) FROM tenants; SELECT count(*) FROM chats; SELECT count(*) FROM messages;            -- compare with source snapshot
   ```
   Attachment integrity: for a sample of `attachments` with `state = 'clean'`, download the object and
   compare its SHA-256 with `attachments.sha256`. Canary chats: known synthetic canary transcripts are
   present and still isolated; erased canary subjects are absent everywhere (DB, search, objects).
8. Functional check: start api/gateway/worker, run the synthetic-tenant smoke (login, send, reconnect
   with replay, upload, email to the sink).
9. Record T1. Achieved RTO = T1 − T0. File the drill report (date, versions, RPO/RTO vs target,
   deviations, follow-ups) and link it from the traceability ledger.

### 8.4 Database failover

Managed: provider failover; self-managed: Patroni or equivalent. After failover verify the outbox drains
without duplicate _observable_ delivery (clients dedupe by `event_id`; consumers are idempotent by
unique keys) and that `rd_claim_outbox` leases expire and are re-claimed (RB-04).

## 9. Production readiness checklist (ch. 64)

Each item needs an owner, a date and evidence before launch: domains and TLS; keys and secret rotation
plan (`APP_SECRET` re-encryption plan included); SPF/DKIM/DMARC for the sending domain; retention jobs
enabled and observed; alert routing tested end to end; capacity evidence (load test report); restore
drill with measured RPO/RTO; support ownership and on-call rota; incident communication templates;
registry, signing and provenance; BYPASSRLS availability on the managed database. A launch is not
complete while any required access or infrastructure is missing.
