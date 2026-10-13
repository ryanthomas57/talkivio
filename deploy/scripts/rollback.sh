#!/usr/bin/env bash
# Puts the previous release's application images back (release.previous.env), one service at a time.
# The database is not touched: migrations are expand-only, so the previous release runs on the new schema
# (rehearsed in CI on every push to main: upgrade-rehearsal job). To undo data changes, restore a backup.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ -f release.previous.env ] || die "no release.previous.env — nothing to roll back to"
prev=$(grep -E '^TALKIVIO_RELEASE_SHA=' release.previous.env | cut -d= -f2)
cur=$(grep -E '^TALKIVIO_RELEASE_SHA=' release.env | cut -d= -f2)
note "rolling back $cur → $prev"
cp release.env release.rolled-back.env
cp release.previous.env release.env
echo "$(date -u +%FT%TZ) rollback $cur -> $prev" >> releases.log
replace_app_services
smoke
note "now serving $prev (the rolled-back release is kept in release.rolled-back.env)"
