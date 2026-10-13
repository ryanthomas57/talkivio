-- One-time database bootstrap (run as a superuser): owner + application login roles.
-- Docker runs this automatically via infra/postgres/init; locally: psql -f apps/api/scripts/db-bootstrap.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app_role') THEN
    CREATE ROLE talkivio_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app') THEN
    CREATE ROLE talkivio_app LOGIN PASSWORD 'talkivio_app_dev_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE talkivio_app_role;
  END IF;
END $$;
