#!/usr/bin/env bash
# Backs up the database (pg_dump, custom format) and the object store's clean bucket — uploaded files, export
# artifacts and the privacy erasure ledger (exports/privacy-ledger/, needed to re-apply erasures after a
# restore). With TALKIVIO_BACKUP_S3_* set, both go to that off-server bucket:
#   <bucket>/db/talkivio-<UTC timestamp>.dump      one file per run (expire old ones with a bucket lifecycle rule)
#   <bucket>/objects/talkivio-clean/…               mirror of the current bucket (deletions are mirrored too)
# Local dumps older than TALKIVIO_BACKUP_KEEP_DAYS are removed. Schedule it, e.g. hourly (README: Backups).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

ts=$(date -u +%Y%m%dT%H%M%SZ)
ensure_backups_dir
dump="talkivio-$ts.dump"
note "database dump"
# Streamed through stdout/stdin, so the file belongs to this host user (postgres runs as uid 999 in its container).
dc exec -T postgres pg_dump -U postgres -d talkivio -Fc -Z 6 > "backups/$dump.partial"
dc exec -T postgres pg_restore --list < "backups/$dump.partial" > /dev/null || die "the dump is not readable"
mv "backups/$dump.partial" "backups/$dump"
note "objects"
dc --profile jobs run --rm backup /object-backup.sh "$dump"
keep=$(setting TALKIVIO_BACKUP_KEEP_DAYS 7)
find backups -maxdepth 1 -name 'talkivio-*.dump' -mtime +"$keep" -delete
note "backup $dump done ($(du -h "backups/$dump" | cut -f1))"
