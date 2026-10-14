#!/usr/bin/env bash
# docker compose for the mail stack, with mail.env:  scripts/mail.sh up -d | ps | logs -f mailserver | ...
set -euo pipefail
source "$(dirname "$0")/lib.sh"
dc "$@"
