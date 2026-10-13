#!/bin/sh
# postgres:16 docker-entrypoint-initdb.d hook. Runs ONCE, on the first start of an EMPTY data
# volume, as the image superuser over the local socket. Creates the Talkivio owner/app roles and
# database from environment secrets (see docker-compose.yml `postgres.environment`).
# To re-run it you must delete the volume (destructive) — see README "Reset local demo data".
set -eu

: "${TALKIVIO_OWNER_PASSWORD:?TALKIVIO_OWNER_PASSWORD is required}"
: "${TALKIVIO_APP_PASSWORD:?TALKIVIO_APP_PASSWORD is required}"
TALKIVIO_DB="${TALKIVIO_DB:-talkivio}"

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$TALKIVIO_OWNER_PASSWORD" \
  -v app_password="$TALKIVIO_APP_PASSWORD" \
  -v db_name="$TALKIVIO_DB" \
  -f /talkivio-sql/00-roles-and-database.sql

echo "[talkivio-init] roles talkivio_owner / talkivio_app_role / talkivio_app and database \"$TALKIVIO_DB\" ready"
