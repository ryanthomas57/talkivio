#!/bin/sh
# Talkivio migration job (Compose `migrate` service, CI, manual releases).
#   1. waits for PostgreSQL,
#   2. verifies/creates the role contract (infra/postgres/bootstrap-roles.sql) as the OWNER role,
#   3. runs `prisma migrate deploy` as the OWNER role (Prisma takes a PostgreSQL advisory lock,
#      so concurrent runs serialize instead of racing),
#   4. exits. Application processes never receive DATABASE_OWNER_URL.
#
# Env:
#   DATABASE_OWNER_URL      required  postgresql://talkivio_owner:...@host:5432/db?schema=public
#   TALKIVIO_APP_PASSWORD  optional  only used if talkivio_app does not exist yet
#   TALKIVIO_API_DIR       optional  directory containing prisma/ and node_modules/.bin/prisma
#   MIGRATE_WAIT_SECONDS    optional  default 60
set -eu

: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL (migration owner connection) is required}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
API_DIR="${TALKIVIO_API_DIR:-$SCRIPT_DIR/../../apps/api}"
# libpq rejects Prisma's ?schema=public query parameter, so strip the query for psql.
PSQL_URL="${DATABASE_OWNER_URL%%\?*}"
WAIT="${MIGRATE_WAIT_SECONDS:-60}"

echo "[migrate] waiting up to ${WAIT}s for PostgreSQL"
i=0
until psql "$PSQL_URL" -X -q -t -c 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$WAIT" ]; then
    echo "[migrate] PostgreSQL not reachable after ${WAIT}s" >&2
    psql "$PSQL_URL" -X -q -t -c 'SELECT 1' || true
    exit 1
  fi
  sleep 1
done

echo "[migrate] verifying role contract (docs/adr/0002)"
psql "$PSQL_URL" -X -q -v ON_ERROR_STOP=1 -v app_password="${TALKIVIO_APP_PASSWORD:-}" -f "$SCRIPT_DIR/bootstrap-roles.sql"

echo "[migrate] prisma migrate deploy"
cd "$API_DIR"
export CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
DATABASE_URL="$DATABASE_OWNER_URL" ./node_modules/.bin/prisma migrate deploy

echo "[migrate] done"
