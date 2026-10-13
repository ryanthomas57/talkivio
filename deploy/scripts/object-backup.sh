#!/bin/sh
# Runs inside the `backup` job container (MinIO client). Called by backup.sh and restore.sh.
#   object-backup.sh <dump file name>        copy the dump + mirror the clean bucket off-server (or locally)
#   object-backup.sh --restore <dump name>   fetch the dump (if missing locally) and mirror the bucket back
set -eu
mc alias set local http://minio:9000 talkivio-minio-root "$MINIO_ROOT_PASSWORD" > /dev/null
offsite=0
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  mc alias set offsite "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" > /dev/null
  mc ls "offsite/$BACKUP_S3_BUCKET" > /dev/null || {
    echo "cannot reach the backup bucket $BACKUP_S3_BUCKET at $BACKUP_S3_ENDPOINT (create it and check the key)" >&2
    exit 1
  }
  offsite=1
fi

if [ "${1:-}" = --restore ]; then
  dump=$2
  if [ "$offsite" = 1 ]; then
    [ -f "/backups/$dump" ] || mc cp "offsite/$BACKUP_S3_BUCKET/db/$dump" "/backups/$dump"
    mc mirror --overwrite "offsite/$BACKUP_S3_BUCKET/objects/talkivio-clean" local/talkivio-clean
  else
    mc mirror --overwrite /backups/objects/talkivio-clean local/talkivio-clean
  fi
  echo "objects restored into talkivio-clean"
  exit 0
fi

dump=$1
if [ "$offsite" = 1 ]; then
  mc cp "/backups/$dump" "offsite/$BACKUP_S3_BUCKET/db/$dump"
  mc mirror --overwrite --remove local/talkivio-clean "offsite/$BACKUP_S3_BUCKET/objects/talkivio-clean"
  echo "copied $dump and mirrored talkivio-clean to $BACKUP_S3_BUCKET"
else
  mkdir -p /backups/objects
  mc mirror --overwrite --remove local/talkivio-clean /backups/objects/talkivio-clean
  echo "mirrored talkivio-clean to deploy/backups/objects (no off-server bucket configured)"
fi
