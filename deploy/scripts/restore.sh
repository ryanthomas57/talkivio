#!/usr/bin/env bash
# Restores a backup into this server's stack: the disaster-recovery procedure and the restore drill
# (docs/operations/deployment.md §8.3). DESTRUCTIVE — it replaces the current database and uploaded files.
#
#   scripts/restore.sh <talkivio-YYYYmmddTHHMMSSZ.dump | latest> --yes-replace-all-data
#
# Order: stop traffic → objects back first (they carry the privacy erasure ledger) → recreate the database
# with its roles → pg_restore → migrations (a dump from an older release is brought up to this one) → RLS and
# role checks → clear Redis (queues/presence of the old state) → re-apply recorded erasures BEFORE any
# traffic (twice: the second run must change nothing) → start → smoke. Prints the achieved RPO and RTO.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

dump=${1:-}
[ "${2:-}" = --yes-replace-all-data ] || die "usage: scripts/restore.sh <dump file name | latest> --yes-replace-all-data"
ensure_backups_dir
if [ "$dump" = latest ]; then
  dump=$(find backups -maxdepth 1 -name 'talkivio-*.dump' -exec basename {} \; 2> /dev/null | sort | tail -n 1)
  [ -n "$dump" ] || die "no local dump in deploy/backups (name one that exists in the off-server bucket instead)"
fi
[[ "$dump" =~ ^talkivio-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || die "unexpected dump name: $dump"
t0=$(date +%s)

note "stopping traffic and the application"
dc stop caddy dashboard api gateway worker 2> /dev/null || true
dc up -d postgres redis minio
for svc in postgres redis minio; do wait_healthy "$svc" 180; done

note "objects (including exports/privacy-ledger) before the database"
dc --profile jobs run --rm minio-init
dc --profile jobs run --rm backup /object-backup.sh --restore "$dump"
[ -s "backups/$dump" ] || die "backups/$dump not found locally or off-server"

note "database: recreate with roles, then restore $dump"
dc exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'DROP DATABASE IF EXISTS talkivio WITH (FORCE)'
dc exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -v owner_password="$TALKIVIO_OWNER_PASSWORD" -v app_password="$TALKIVIO_APP_PASSWORD" -v db_name=talkivio -f /talkivio-sql/00-roles-and-database.sql' > /dev/null
dc exec -T postgres pg_restore -U postgres -d talkivio --exit-on-error < "backups/$dump"
dc --profile jobs run --rm migrate

note "checks: application role cannot bypass RLS; every tenant table forces it; no failed migration"
q() { dc exec -T postgres psql -X -A -t -U postgres -d talkivio -c "$1"; }
[ "$(q "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'talkivio_app'")" = f ] || die "talkivio_app can bypass RLS"
# Every table with a tenant_id forces RLS, except the ones that are not tenant-owned (docs/adr/0002): the global
# auth_tokens and outbound_emails, the billing provider's event inbox, and the erasure ledger.
unforced=$(q "SELECT string_agg(c.relname, ', ' ORDER BY c.relname) FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname NOT IN ('tenant_tombstones', 'auth_tokens', 'outbound_emails', 'billing_events') AND NOT c.relforcerowsecurity")
[ -z "$unforced" ] || die "tenant tables without forced row-level security: $unforced"
[ "$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = 0 ] || die "a migration is unfinished"
note "restored: $(q "SELECT count(*) FROM tenants") workspaces, $(q "SELECT count(*) FROM chats") chats, $(q "SELECT count(*) FROM messages") messages"

note "clearing Redis (queues and presence belong to the replaced state; durable data lives in PostgreSQL)"
dc exec -T redis redis-cli FLUSHALL > /dev/null

note "re-applying recorded privacy erasures before any traffic"
dc run --rm --no-deps -T api node scripts/replay-tombstones.mjs --json | tee "backups/replay-$dump.json"
second=$(dc run --rm --no-deps -T api node scripts/replay-tombstones.mjs --json)
echo "$second" > "backups/replay-$dump.second.json"
for field in '"visitorsChanged":0' '"offlineSubmissionsErased":0' '"tombstonesRestored":0' '"destroyed":[]'; do
  [[ "$second" == *"$field"* ]] || die "the erasure replay is not idempotent (second run: $second)"
done

note "starting the application"
dc up -d worker gateway api dashboard
for svc in "${APP_SERVICES[@]}"; do wait_healthy "$svc" 300; done
start_caddy
smoke

taken=$(echo "$dump" | sed -E 's/talkivio-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump/\1-\2-\3T\4:\5:\6Z/')
note "restore complete — recovery point $taken (RPO = time since then), RTO $(($(date +%s) - t0)) s"
