#!/usr/bin/env bash
# Archives the mailboxes and the config folder (accounts, aliases, DKIM keys, webmail key) into infra/mail/backups/
# and keeps MAIL_BACKUP_KEEP_DAYS days (default 14). Schedule it daily (README, Backups).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

keep=$(setting MAIL_BACKUP_KEEP_DAYS 14)
mkdir -p backups
chmod 700 backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="mail-$stamp.tar.gz"
# Volume names carry the Compose project name (name: talkivio-mail in compose.yaml).
docker run --rm --network none \
  -v "talkivio-mail_mail_data:/backup/mail-data:ro" \
  -v "$MAIL_DIR/config:/backup/config:ro" \
  -v "$MAIL_DIR/backups:/out" \
  alpine:3.22 tar czf "/out/$out" -C /backup mail-data config
chmod 600 "backups/$out"
find backups -name 'mail-*.tar.gz' -mtime +"$keep" -delete
echo "$(date -u +%FT%TZ) backups/$out ($(du -h "backups/$out" | cut -f1))"
