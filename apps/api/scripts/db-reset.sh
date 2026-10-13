#!/usr/bin/env bash
# DESTRUCTIVE (local development only): drop and recreate the database, then apply migrations.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_OWNER_URL:?Set DATABASE_OWNER_URL (owner/superuser connection)}"
DB_NAME="$(node -e "console.log(new URL(process.env.DATABASE_OWNER_URL).pathname.slice(1))")"
ADMIN_URL="$(node -e "const u=new URL(process.env.DATABASE_OWNER_URL);u.pathname='/postgres';u.search='';console.log(u.toString())")"
if [ "${NODE_ENV:-development}" = "production" ]; then echo "Refusing to reset a production database" >&2; exit 1; fi
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" -c "CREATE DATABASE \"$DB_NAME\";"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -f scripts/db-bootstrap.sql
DATABASE_URL="$DATABASE_OWNER_URL" npx prisma migrate deploy
echo "Database $DB_NAME reset and migrated."
