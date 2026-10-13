-- Talkivio pre-migration role bootstrap. Runs as the MIGRATION OWNER (not a superuser)
-- immediately before `prisma migrate deploy` (Compose `migrate` job, CI, infra/postgres/migrate.sh).
--
-- * Verifies the owner can satisfy docs/adr/0002 (superuser or BYPASSRLS, needed by the
--   SECURITY DEFINER entry points created in 20261012000002_security).
-- * Creates talkivio_app_role / talkivio_app only when they are missing AND the owner has
--   CREATEROLE AND an app_password was supplied. Never alters existing roles (password rotation
--   is a superuser/secret-manager operation, see docs/operations/runbooks.md "Leaked token").
-- * Fails loudly if the application roles could bypass RLS.
--
-- psql variable: app_password (may be empty when roles are pre-provisioned).

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Migration role "%" needs BYPASSRLS (or superuser) for the SECURITY DEFINER entry points. See docs/adr/0002 and infra/postgres/sql/00-roles-and-database.sql.', current_user;
  END IF;
END $$;

SELECT 'CREATE ROLE talkivio_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app_role') \gexec

SELECT format('CREATE ROLE talkivio_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE talkivio_app_role PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app') AND :'app_password' <> '' \gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app') THEN
    RAISE EXCEPTION 'Login role talkivio_app is missing. Provision it (infra/postgres/sql/00-roles-and-database.sql) or pass app_password.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('talkivio_app', 'talkivio_app_role') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'talkivio_app / talkivio_app_role must not be SUPERUSER or BYPASSRLS (tenant isolation relies on RLS).';
  END IF;
  IF NOT pg_has_role('talkivio_app', 'talkivio_app_role', 'MEMBER') THEN
    RAISE EXCEPTION 'talkivio_app must be a member of talkivio_app_role.';
  END IF;
END $$;

SELECT format('GRANT CONNECT ON DATABASE %I TO talkivio_app_role', current_database()) \gexec
