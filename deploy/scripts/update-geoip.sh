#!/usr/bin/env bash
# Refreshes the visitor-location database (DB-IP City Lite, published monthly). The api picks up the new file
# within an hour without a restart. Schedule monthly, e.g.:  0 4 3 * * cd /opt/talkivio/deploy && ./scripts/update-geoip.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"
dc --profile jobs run --rm geoip
