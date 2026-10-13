-- Talkivio cluster bootstrap. Run ONCE per cluster as a PostgreSQL SUPERUSER.
--
-- Creates the role contract from docs/adr/0002:
--   talkivio_owner     LOGIN, owns tables, runs migrations. CREATEROLE + BYPASSRLS so the
--                       SECURITY DEFINER entry points (rd_resolve_site_key, rd_claim_outbox, ...)
--                       can do their narrow cross-tenant lookups. NOT a superuser.
--   talkivio_app_role  NOLOGIN group that receives DML grants from the migrations (RLS applies).
--   talkivio_app       LOGIN used by api/gateway/worker/seed. Member of talkivio_app_role.
--                       No BYPASSRLS, no ownership, no DDL.
-- and the application database owned by talkivio_owner.
--
-- Required psql variables (never hard-code secrets in this file):
--   owner_password, app_password, db_name
-- Used by:
--   * docker-compose  -> infra/postgres/init/10-talkivio.sh (first start of an empty volume)
--   * CI integration  -> .github/workflows/ci.yml ("Bootstrap database roles")
--   * manual          -> psql "$SUPERUSER_URL" -v owner_password=... -v app_password=... -v db_name=talkivio -f this file
-- Idempotent: re-running converges role attributes/passwords and grants.

\set ON_ERROR_STOP on

SELECT (:'owner_password' = '' OR :'app_password' = '' OR :'db_name' = '') AS rd_missing_input \gset
\if :rd_missing_input
  DO $$ BEGIN RAISE EXCEPTION 'owner_password, app_password and db_name psql variables must be non-empty'; END $$;
\endif

-- ───────────── Migration owner ─────────────
SELECT 'CREATE ROLE talkivio_owner LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_owner') \gexec
ALTER ROLE talkivio_owner LOGIN NOSUPERUSER CREATEROLE BYPASSRLS NOCREATEDB NOREPLICATION;
SELECT format('ALTER ROLE talkivio_owner PASSWORD %L', :'owner_password') \gexec

-- ───────────── Application roles ─────────────
SELECT 'CREATE ROLE talkivio_app_role NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app_role') \gexec
ALTER ROLE talkivio_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT 'CREATE ROLE talkivio_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app') \gexec
ALTER ROLE talkivio_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
SELECT format('ALTER ROLE talkivio_app PASSWORD %L', :'app_password') \gexec
GRANT talkivio_app_role TO talkivio_app;

-- ───────────── Database ─────────────
SELECT format('CREATE DATABASE %I OWNER talkivio_owner', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO talkivio_owner', :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO talkivio_app_role', :'db_name') \gexec

\connect :"db_name"
-- PostgreSQL 15+: schema public is owned by pg_database_owner (= talkivio_owner here).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO talkivio_app_role;
