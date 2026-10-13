#!/bin/bash
# Isolated integrations + privacy e2e harness (local only; destructive for the talkivio_integ database and Redis DB 6).
# Mirrors the CI integration job: API on :4106 with the test-only private-webhook exception for the local receiver,
# a second API on :4107 without it, and a worker with the same environment. Usage: apps/api/scripts/integrations-local.sh
set -u
cd "$(dirname "$0")/.."
set -a; . ../../.env; set +a
OWNER_BASE="${DATABASE_OWNER_URL%%\?*}"; OWNER_BASE="${OWNER_BASE%/*}"
APP_BASE="${DATABASE_URL%%\?*}"; APP_BASE="${APP_BASE%/*}"
export DATABASE_OWNER_URL="$OWNER_BASE/talkivio_integ?schema=public"
export DATABASE_URL="$APP_BASE/talkivio_integ?schema=public"
export REDIS_URL=redis://127.0.0.1:6379/6
export STORAGE_LOCAL_DIR=./storage-integ
export WORKER_HEALTH_PORT=4016
export TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS=127.0.0.1:4196 TALKIVIO_WEBHOOK_RETRY_SCHEDULE_MS=0,1000,2000,500,500,500,500,500
export BUILD_DIR=.build/integrations RECEIVER_PORT=4196 API_URL_NO_PRIVATE=http://localhost:4107
redis-cli -n 6 flushdb >/dev/null
./scripts/db-reset.sh > "$TMPDIR/integ-dbreset.log" 2>&1 || { echo "db-reset failed"; tail -20 "$TMPDIR/integ-dbreset.log"; exit 1; }
rm -rf .build/integrations && npx tsc -p tsconfig.build.json --outDir .build/integrations --tsBuildInfoFile .build/integrations/.tsbuildinfo || exit 1
PORT=4106 API_URL=http://localhost:4106 node --enable-source-maps .build/integrations/main.js > "$TMPDIR/integ-api.log" 2>&1 &
A1=$!
TALKIVIO_WEBHOOK_ALLOW_PRIVATE=false PORT=4107 API_URL=http://localhost:4107 node --enable-source-maps .build/integrations/main.js > "$TMPDIR/integ-api2.log" 2>&1 &
A2=$!
node --enable-source-maps .build/integrations/worker.js > "$TMPDIR/integ-worker.log" 2>&1 &
for p in 4106 4107; do for i in $(seq 1 120); do curl -sf http://localhost:$p/health/ready >/dev/null && break; sleep 0.5; done; done
API_URL=http://localhost:4106 node test/integrations.e2e.mjs > "$TMPDIR/integ-e2e.log" 2>&1
CODE=$?
kill -TERM $A1 $A2 2>/dev/null; pkill -TERM -f ".build/integrations/worker.js" 2>/dev/null
sleep 3
echo "integrations exit=$CODE"; tail -5 "$TMPDIR/integ-e2e.log"
exit $CODE
