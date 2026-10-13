# ADR 0002 — Data layer: SQL migrations, RLS and tenant context

Status: accepted · 2026-10-12

## Decision
* **Schema authority** is the ordered SQL in `apps/api/prisma/migrations/*/migration.sql`. `schema.prisma`
  mirrors the tables for typed client generation only. Migrations are applied with `prisma migrate deploy`
  (never `migrate dev` against shared databases) and are immutable once released.
* **Two database roles.** `talkivio_owner` owns tables and runs migrations. `talkivio_app` is used by
  api/gateway/worker; it does not own tables, has no `BYPASSRLS`, and receives only DML grants
  (`audit_events`: SELECT/INSERT only).
* **Row level security** on every tenant-owned table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy
  `tenant_id = current_setting('app.tenant_id', true)::uuid` for both `USING` and `WITH CHECK`.
* **Tenant context** is set transaction-locally (`set_config('app.tenant_id', $1, true)`) by
  `TenantDb.tx()` / `TenantDb.forTenant()`; pooled connections never keep context between transactions.
* **Composite foreign keys** `(tenant_id, parent_id) → parent(tenant_id, id)` on child tables, so a
  cross-tenant reference fails even if application validation is wrong. Optional references use
  `MATCH SIMPLE` semantics (NULL child id = no reference).
* **Narrow public entry points** are `SECURITY DEFINER` functions with fixed `search_path`
  (`rd_resolve_site_key`, `rd_user_memberships`, `rd_active_tenants`, `rd_claim_outbox`, `rd_defer_outbox`,
  `rd_search_chat_ids`), never a broad bypass. A tenant-scoped entry point takes its tenant from `rd_current_tenant()`
  (the transaction context), never from a parameter, and returns nothing without one.
* Global identity tables (`users`, `auth_sessions`, `auth_tokens`, `oauth_accounts`, `trusted_devices`,
  `outbound_emails`) are not tenant-owned and have no tenant policy.

* **Drift gate.** `pnpm db:drift` (`apps/api/scripts/schema-drift.mjs`, CI integration job) replays every
  migration into a throwaway database with `prisma migrate deploy`, diffs it against `schema.prisma` and fails on
  any difference except the SQL-only tenant foreign keys (named `*_fk`; Prisma-modelled ones are `*_fkey`), which
  the datamodel intentionally omits. With `--compare-url` it also compares a migrated database with the fresh
  replay, including what Prisma does not diff: RLS flags, policies, functions, triggers and app-role grants.
  New migrations are generated with `pnpm db:migration:new <name>` (the same diff, minus the tenant foreign keys),
  never `prisma migrate dev`, which would emit `DROP CONSTRAINT` for all of them.

## Consequences
Every service method that touches tenant data takes a tenant id and uses `TenantDb`; tests run as
`talkivio_app` to prove isolation (TEN03).

Pre-release amendment (2026-10-13): `20261012000002_security` guards `REVOKE … ON _prisma_migrations` with
`to_regclass(...) IS NOT NULL` so the migration also replays where that table does not exist (Prisma shadow
databases). Behaviour is unchanged wherever the table exists; databases migrated before the amendment only differ in
the stored checksum, which `prisma migrate deploy` does not re-verify (the dev database checksum was updated).

Amendment (2026-10-13, performance work — docs/performance/performance-report.md):
* **RLS and index use.** Under row level security PostgreSQL never turns a non-leakproof operator into an index
  condition ahead of the policy, so policy-scoped full-text search (`tsvector @@ tsquery`) could not use the GIN body
  index and read every message of the tenant. Lookups that need such an index go through a narrow `SECURITY DEFINER`
  entry point that applies the tenant scope explicitly and returns ids only (`rd_search_chat_ids`); the caller then
  applies permissions and filters as `talkivio_app`.
* **Foreign keys are indexed** on the referencing columns whenever the parent can be deleted (cascade, set null or
  restrict checks), so a parent delete never scans the child table per row; `schema.prisma` declares each index.
* **Indexes on large live tables** are built with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, **one statement per
  migration**: `prisma migrate deploy` sends a migration as one script, and PostgreSQL runs a multi-statement script
  as an implicit transaction, where `CONCURRENTLY` is refused. An interrupted build leaves an `INVALID` index, which
  is dropped and the migration re-run.
* The unused per-row `pg_notify` outbox trigger was removed (`20261013000008`): it serialized every committing
  transaction that wrote outbox rows on the database-wide notify lock. Publishers are woken through Redis after commit.

Amendment (2026-10-13, AUD-72-01 — migrations `20261013000025_text_bounds` / `…026_text_bounds_validate`):
* **Bounded text.** Every `text` column carries a CHECK on that column: closed sets (statuses, kinds, reasons,
  sources, actor types) list their values; machine-generated identifiers keep their shape (hex hashes, `v1:`
  ciphertexts, dotted event/action names, IANA zones, origins); everything else has a length bound no tighter than the
  API's own validation. `scripts/schema-drift.mjs` fails on any text column of a fresh database without a bound, and
  compares CHECK constraints when checking a live database. A new value in a closed set needs a migration.
* **Constraints on live tables** are added `NOT VALID` in one migration and `VALIDATE`d in the next: the first takes
  brief locks without scanning, the second scans under `SHARE UPDATE EXCLUSIVE`, so reads and writes continue.
* A write that still violates a CHECK (or exceeds a length) is answered 422 `VALIDATION_FAILED`, not a retryable 500.
