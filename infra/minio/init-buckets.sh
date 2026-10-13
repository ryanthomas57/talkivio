#!/bin/sh
# One-shot MinIO initialisation (docker-compose `minio-init`). Idempotent.
#  * private quarantine + clean buckets (never public; downloads go through the API or short
#    presigned URLs), object versioning on the clean bucket (ch. 64 durable object storage),
#  * a least-privilege application user limited to object CRUD on those two buckets, so the
#    api/worker never hold the MinIO root credentials.
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${S3_APP_ACCESS_KEY_ID:?S3_APP_ACCESS_KEY_ID is required}"
: "${S3_APP_SECRET_ACCESS_KEY:?S3_APP_SECRET_ACCESS_KEY is required}"
ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
QUARANTINE="${S3_QUARANTINE_BUCKET:-talkivio-quarantine}"
CLEAN="${S3_CLEAN_BUCKET:-talkivio-clean}"
POLICY=talkivio-app
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"

i=0
until mc alias set rd "$ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[minio-init] MinIO at $ENDPOINT not reachable after 60s" >&2
    exit 1
  fi
  sleep 1
done

for b in "$QUARANTINE" "$CLEAN"; do
  mc mb --ignore-existing "rd/$b"
  mc anonymous set none "rd/$b"
done
mc version enable "rd/$CLEAN"
# No lifecycle/expiry rules are configured here. If you add any (e.g. expiring stale quarantine
# objects or old export artifacts), EXCLUDE the exports/privacy-ledger/ prefix: the erasure ledger
# must survive for tombstone replay after a database restore (docs/operations/deployment.md §8.2).

cat > /tmp/talkivio-app-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$QUARANTINE", "arn:aws:s3:::$CLEAN"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$QUARANTINE/*", "arn:aws:s3:::$CLEAN/*"]
    }
  ]
}
EOF
mc admin policy create rd "$POLICY" /tmp/talkivio-app-policy.json
mc admin user add rd "$S3_APP_ACCESS_KEY_ID" "$S3_APP_SECRET_ACCESS_KEY"
if ! out=$(mc admin policy attach rd "$POLICY" --user "$S3_APP_ACCESS_KEY_ID" 2>&1); then
  case "$out" in
    *"already in effect"* | *"already attached"*) ;;
    *) echo "$out" >&2; exit 1 ;;
  esac
fi
rm -f /tmp/talkivio-app-policy.json

echo "[minio-init] buckets $QUARANTINE, $CLEAN and user $S3_APP_ACCESS_KEY_ID ready"
