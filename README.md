<p><img src="docs/brand/talkivio-mark-256.png" alt="" height="56"></p>

# Talkivio

Talkivio is a multi-tenant live chat platform: a website widget for visitors, a real-time agent
workspace, routing with capacity and departments, operating hours, canned replies, file uploads with
malware scanning, transcripts and exports, webhooks, analytics and privacy tooling (access export,
erasure, retention). Every tenant is isolated in PostgreSQL with row-level security.

The implementation authority is [`docs/master-prompt.txt`](docs/master-prompt.txt); architecture decisions
live in [`docs/adr/`](docs/adr). Workspace packages: `@talkivio/api`, `@talkivio/dashboard`, `@talkivio/widget`,
`@talkivio/contracts`. Brand assets and the colour system are in [`docs/brand/`](docs/brand/README.md).

## Architecture

```
  Agent browser                                   Visitor browser on a customer site
  dashboard + REST + Socket.IO                    loader.js -> isolated iframe -> /widget/v1 + Socket.IO
          |                                                   |
          v                                                   v
 +------------------------ reverse proxy (TLS in production; Caddy :8080 locally) -------------------------+
 |   /realtime/*  -> gateway        /api/* /widget/* /health/*  -> api        everything else -> dashboard |
 +--------------------------------------------------------------------------------------------------------+
        |                                  |                                        |
  gateway (dist/gateway.js)        api (dist/main.js)                      dashboard (apps/dashboard, Next.js
  Socket.IO /realtime/v1,          NestJS REST, widget assets,             standalone; proxies /api/v1/*
  ticket auth, exact Origin        commands write state + outbox            to the api when hit directly)
        |  ^                       rows in ONE transaction
        |  | redis adapter                 |
        v  |                               v
      Redis 7  <------------  worker (dist/worker.js): outbox publisher, BullMQ jobs, timers,
   (presence, tickets,          routing sweeps, email, file scans, exports, webhooks, retention
    queues; never the
    source of truth)
                     PostgreSQL 16 (RLS, app role talkivio_app)   S3/MinIO (quarantine + clean buckets)
                     ClamAV (clamd :3310)   SMTP (Mailpit locally)   webhook endpoints (SSRF-guarded)
```

- One backend image, three process roles (`api`, `gateway`, `worker`) — [ADR 0001](docs/adr/0001-stack-and-process-topology.md).
- Durable state lives in PostgreSQL; Redis loss never loses messages — [ADR 0002](docs/adr/0002-data-layer-rls-and-migrations.md).
- Socket protocol, single-use tickets and replay — [ADR 0003](docs/adr/0003-realtime-protocol.md).

| Path                               | What                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                         | NestJS API, gateway and worker (`src/main.ts`, `src/gateway.ts`, `src/worker.ts`), Prisma schema + SQL migrations, demo seed (`src/seed.ts`) |
| `apps/dashboard`                         | Agent/admin dashboard (Next.js, port 3000)                                                                                                   |
| `apps/widget`                      | Widget loader + iframe app (Vite/Preact), demo storefront in `apps/widget/demo`                                                              |
| `packages/contracts`                  | Shared contracts, schemas and pure logic                                                                                                     |
| `infra/`                           | Dockerfiles, Caddy, PostgreSQL bootstrap + migration job, MinIO init, CI helpers, webhook test receiver                                      |
| `docs/operations`, `docs/security` | Runbooks, deployment/rollback/backup, alert rules, threat model                                                                              |

## Prerequisites

| Tool                            | Version                                                                                  | Needed for                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Node.js                         | 22.x (CI and images use 22.23.3)                                                         | everything                                     |
| pnpm                            | 10.9.0 (`packageManager` in `package.json`; `corepack enable` or `npm i -g pnpm@10.9.0`) | everything                                     |
| Docker Engine + Compose v2.20+  | recent                                                                                   | the containerised stack                        |
| PostgreSQL 16 + `psql`, Redis 7 | local services                                                                           | running without Docker                         |
| ~6 GB free RAM                  |                                                                                          | full Compose stack (ClamAV alone needs 2-3 GB) |

## Quick start with Docker (recommended)

```bash
pnpm install --frozen-lockfile      # only needed to run tests from the host
docker compose up --build           # builds images, migrates, seeds Alpha/Beta, starts everything
```

Order is enforced by health checks, not sleeps: `postgres` (healthy) -> `migrate` (role bootstrap +
`prisma migrate deploy` as the owner role, exits 0) -> `seed` (idempotent fixtures) and `api` / `gateway` /
`worker` -> `dashboard` -> `reverse-proxy`. The first start downloads ClamAV signatures (a few minutes);
uploads stay in the scanning state until clamd is healthy.

| URL (all bound to 127.0.0.1)                                              | What                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| http://localhost:8080                                                     | Dashboard, REST (`/api/v1`), widget assets (`/widget`), sockets (`/realtime/v1`), `/health/live`, `/health/ready`          |
| http://localhost:5173/?api=http://localhost:8080&w=rds_AlphaLocalDemo0001 | Demo store, origin A, tenant **Alpha**                                                                                     |
| http://localhost:5174/?api=http://localhost:8080&w=rds_AlphaLocalDemo0001 | Demo store, origin B, tenant **Alpha** (cross-origin tests)                                                                |
| http://127.0.0.1:5173/?api=http://localhost:8080&w=rds_BetaLocalDemo00001 | Demo store, tenant **Beta** (Alpha's key is refused here)                                                                  |
| http://localhost:8025                                                     | Mailpit — every email the stack sends                                                                                      |
| http://localhost:9001                                                     | MinIO console (root user from `docker-compose.yml` defaults) — check uploads in `talkivio-quarantine` / `talkivio-clean` |
| http://localhost:4196/events                                              | Webhook test receiver (signed deliveries, de-duplicated)                                                                   |
| `localhost:55432`                                                         | PostgreSQL (`talkivio_owner` / `talkivio_app`, passwords in `docker-compose.yml`)                                        |

**Demo logins** (local only): the seed prints them at the end of `docker compose logs seed`. Emails are
`owner@alpha.test`, `ana.sales@alpha.test` (agent, capacity 1, Sales + Support), `ben.support@alpha.test`
(agent, capacity 2), `sam.supervisor@alpha.test`, `alex.analyst@alpha.test`, `owner@beta.test`,
`bo.agent@beta.test`; the password is `SEED_DEMO_PASSWORD` from [`.env.example`](.env.example). Beta holds a
private canary transcript containing `RD-CANARY-BETA-7Q4X-PRIVATE`, which must never appear in Alpha.

Useful commands:

```bash
docker compose ps                       # health of every service
docker compose logs -f api worker       # follow logs
docker compose run --rm seed            # re-apply fixtures (idempotent)
docker compose restart gateway          # e.g. reconnect/replay testing
docker compose down                     # stop, keep data
```

Override any local credential or port with `RD_*` variables (listed at the end of `.env.example`) in
your shell or a git-ignored `.env`.

## Running without Docker

```bash
# 1. dependencies
pnpm install --frozen-lockfile
brew services start postgresql@16 && brew services start redis     # or your OS equivalent

# 2. configuration
cp .env.example .env
#    edit DATABASE_OWNER_URL to a local superuser, e.g. postgresql://$USER@localhost:5432/talkivio_dev?schema=public
set -a; . ./.env; set +a

# 3. database — DESTRUCTIVE for the database named in DATABASE_OWNER_URL (drops and recreates it):
apps/api/scripts/db-reset.sh          # creates roles (db-bootstrap.sql), database, applies migrations

# 4. build (order matters: shared -> widget -> api -> dashboard)
pnpm build

# 5. demo fixtures (refuses NODE_ENV=production; idempotent)
pnpm db:seed

# 6. run (separate terminals)
pnpm --filter @talkivio/api start             # api + sockets on :4000 (GATEWAY_SEPARATE=false)
pnpm --filter @talkivio/api start:worker      # worker: outbox, jobs, email, scans
NEXT_PUBLIC_REALTIME_ORIGIN=http://localhost:4000 pnpm --filter @talkivio/dashboard dev   # dashboard :3000
pnpm --filter @talkivio/widget dev            # widget watch build + demo store :5173
```

`pnpm dev` starts all of step 6 with file watching. Demo store without Docker:
`http://localhost:5173/?w=rds_AlphaLocalDemo0001` (the demo defaults to the API at `http://localhost:4000`).
Without ClamAV, uploads stay unscanned/blocked; for local-only experiments `SCAN_MODE=dev_unscanned`
marks validated files clean **without** malware scanning (refused in production). To exercise the
same role bootstrap + migration path as Compose and CI against an existing database, run
`pnpm db:prepare` (`infra/postgres/migrate.sh`, uses `DATABASE_OWNER_URL`).

Running a private copy next to other developers (own database, Redis index and port) is described in
[`docs/dev/backend-conventions.md`](docs/dev/backend-conventions.md). Avoid ports on the browser "bad
ports" list (e.g. 4190) — `fetch` refuses them.

## Tests and checks

```bash
pnpm typecheck                 # all packages (build packages/contracts first: pnpm --filter @talkivio/contracts build)
pnpm test                      # vitest in every package
pnpm build                     # shared, widget, api, dashboard
pnpm verify:all                # typecheck + test + build
pnpm test:integration          # apps/api/test/smoke-v2.mjs against a RUNNING api + worker
node infra/test/seed-fixtures.mjs   # seeded logins, origins and canary isolation through the API
```

Integration env: `API_URL` (default `http://localhost:4000`; Docker: `http://localhost:8080`) and
`DATABASE_OWNER_URL` (smoke v2 reads verification emails with `psql`; Docker:
`postgresql://talkivio_owner:local-dev-only-owner-db@localhost:55432/talkivio`).

End-to-end suites (real HTTP, sockets, PostgreSQL and Redis; each needs a running api + worker and
`psql`; headers of each file list extra settings):

| Script                               | Covers                                                                                           | Extra requirements                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/smoke-v2.mjs`         | identity, chat vertical slice, accept race, notes, isolation                                     | —                                                                                                                                                 |
| `infra/test/seed-fixtures.mjs`       | seeded logins, origins, Beta canary isolation                                                    | seeded database                                                                                                                                   |
| `apps/api/test/shortcuts.e2e.mjs`    | canned replies (SHORT01)                                                                         | —                                                                                                                                                 |
| `apps/api/test/triggers.e2e.mjs`     | trigger DSL, invitations (TRIG01-03, INV01-02)                                                   | `REDIS_URL`                                                                                                                                       |
| `apps/api/test/offline.e2e.mjs`      | schedules, closures, offline forms, overflow                                                     | `REDIS_URL`, `redis-cli`; unreachable SMTP on the worker for the OFF01 outage path                                                                |
| `apps/api/test/analytics.e2e.mjs`    | facts, measures, monitor, notifications                                                          | —                                                                                                                                                 |
| `apps/api/test/visitors.e2e.mjs`     | visitors, verified identity, consent, bans                                                       | —                                                                                                                                                 |
| `apps/api/test/files.e2e.mjs`        | uploads, scanning, exports (FILE01, EXPORT01)                                                    | worker `SCAN_MODE=clamav CLAMAV_PORT=<p>` + test `CLAMD_STUB_PORT=<p>` (built-in clamd stub)                                                      |
| `apps/api/test/integrations.e2e.mjs` | tokens, signed webhooks, SSRF, access export, erasure, tombstone replay (HOOK01, PRIV01, PRIV02) | second api without the private-webhook exception (`API_URL_NO_PRIVATE`), `BUILD_DIR`, `pg_dump`/`pg_restore`, a role allowed to `CREATE DATABASE` |

The CI integration job runs all of them in this order against one api, a second api without the
private-webhook exception and one worker, clearing `rl:*` rate-limit keys between suites (the suites
together exceed the per-IP signup limit). Mirror it locally with your own database, Redis index and ports.

Master prompt command contract (ch. 62) — current status, so nothing is mistaken for passing:

| Command                                                                                                   | Status                                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`                             | available                                                             |
| `pnpm lint`                                                                                               | available, currently `tsc --noEmit` per package (no ESLint rules yet) |
| `pnpm test:integration`                                                                                   | available (smoke v2; needs running api + worker)                      |
| `docker compose up --build`, `pnpm db:migration:new <name>` (dev), `pnpm db:drift`, `pnpm db:deploy`, `pnpm db:prepare`, `pnpm db:seed` | available                                                             |
| `pnpm verify:all`                                                                                         | available (typecheck + unit + build; not yet e2e/load)                |
| `pnpm contracts:generate`, `pnpm test:e2e`, `pnpm test:load`                                              | **not implemented yet**                                               |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lockfile integrity, compose validation,
format (changed files), typecheck, unit tests (`pnpm -r test`, JUnit artifacts), build, an integration job
(PostgreSQL 16 + Redis 7 + the official ClamAV container, role bootstrap, migrations twice, RLS probe, seed
twice, all e2e suites above — `files.e2e` runs once against real ClamAV and once against its clamd stub for
the scanner-outage path),
gitleaks and `pnpm audit --audit-level=high` on every PR; on `main` it also builds the images, checks labels and
non-root user, runs a Trivy gate (fixable CRITICAL), produces SPDX SBOMs and runs the full Compose
stack with smoke v2 through the proxy.

## Containers

- `infra/docker/api.Dockerfile` — targets `runtime` (default; `node dist/main.js`, `dist/gateway.js` or
  `dist/worker.js` by command) and `migrate` (role bootstrap + `prisma migrate deploy`). Non-root `node`
  user, `tini` as PID 1, root filesystem can be read-only (tmpfs `/tmp`), `HEALTHCHECK` on `/health/live`
  (`HEALTHCHECK_PORT=4001` for the gateway).
- `infra/docker/dashboard.Dockerfile` — Next.js standalone server, non-root. `API_INTERNAL_URL` and
  `NEXT_PUBLIC_*` are **build-time** values (Next bakes rewrites and public env into the build).
- Build args are non-secret metadata only (`GIT_SHA`, `BUILD_TIME`, `VERSION`, `SOURCE_URL`) and end up
  as OCI labels. Secrets are runtime environment / secret mounts.

## Troubleshooting

**Port already in use** (`bind: address already in use`): something else listens on 8080, 5173, 5174,
8025, 9001, 4196 or 55432 — often a local `vite` demo server (5173) or Postgres. Stop it, or override
`RD_HTTP_PORT` / `RD_POSTGRES_PORT`. The demo ports 5173/5174 are fixed because they are the seeded
allowed origins. Find the owner with `lsof -nP -iTCP:5173 -sTCP:LISTEN`.

**A service is unhealthy / the stack does not come up**: `docker compose ps` then
`docker compose logs <service>`.

- `migrate` exited non-zero: read its log — role contract errors name the missing role/attribute;
  an existing `pg_data` volume created with different passwords keeps the old ones (init scripts run
  only on an empty volume).
- `api`/`gateway` unhealthy: `curl -s http://localhost:8080/health/ready` shows which dependency
  (`database`, `redis`) is unavailable.
- `clamav` stays `starting` for several minutes on first boot (signature download, needs internet) and
  needs 2-3 GB RAM; raise Docker Desktop's memory limit if it restarts.
- `minio-init` failed: usually MinIO not reachable yet or changed root credentials on an existing volume.
- Apple Silicon: all pinned images are multi-arch (amd64 + arm64).

**Reset local demo data — DESTRUCTIVE.** This permanently deletes the local database, uploaded objects,
captured mail, scanner signatures and proxy state for this Compose project. It cannot be undone and must
never be pointed at a shared or production environment:

```bash
docker compose down -v --remove-orphans     # or: pnpm docker:destroy
docker compose up --build                   # fresh database, migrations and fixtures
```

Without Docker, `apps/api/scripts/db-reset.sh` drops and recreates the database named in
`DATABASE_OWNER_URL` (it refuses `NODE_ENV=production`), then run `pnpm db:seed`. To only re-apply
fixtures without deleting anything: `pnpm db:seed` / `docker compose run --rm seed`.

**macOS external volumes** create `._*` AppleDouble files; they are ignored by git, Docker and the vitest
configs (`exclude: ['**/._*']`).

## Known gaps (tracked in the ledger and release audit)

- Metrics are exposed at `/health/metrics` (api/gateway) and on the worker's `WORKER_HEALTH_PORT` listener
  (ADR 0004); the Prometheus scrape config and dashboards for [`docs/operations/alerts.md`](docs/operations/alerts.md)
  are not shipped yet.
- Triggers and proactive invitations are not seeded until their DSL is final.
- Official MinIO images are no longer published publicly; Compose uses the `pgsty/minio` community
  rebuild (replace with an internal mirror if you have one).
- Image push, signing and provenance attestations wait for a registry decision (TODO in CI).

## Documentation

- Operations: [runbooks](docs/operations/runbooks.md), [deployment, rollback, backup/restore](docs/operations/deployment.md), [alerts](docs/operations/alerts.md)
- Security: [threat model](docs/security/threat-model.md)
- Evidence: [traceability ledger](docs/traceability.csv), [release audit](docs/release-audit.md)
- Engineering: [ADRs](docs/adr), [backend conventions](docs/dev/backend-conventions.md)
