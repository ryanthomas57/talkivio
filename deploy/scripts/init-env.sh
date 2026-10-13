#!/usr/bin/env bash
# Creates deploy/talkivio.env from talkivio.env.example (once) with every <generated> secret replaced by a
# fresh random value. Refuses to overwrite an existing talkivio.env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -e talkivio.env ]; then
  echo "talkivio.env already exists — not touching it." >&2
  exit 1
fi
command -v openssl > /dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
while IFS= read -r line; do
  if [[ "$line" == *'=<generated>' ]]; then
    # 48 hex characters: URL-safe for database/Redis connection strings, ≥ 32 for APP_SECRET.
    echo "${line%%=*}=$(openssl rand -hex 24)"
  else
    echo "$line"
  fi
done < talkivio.env.example > talkivio.env
chmod 600 talkivio.env

echo "Created deploy/talkivio.env with generated secrets."
echo "Next: edit the domain, TLS e-mail, SMTP and backup settings, then run scripts/check-env.sh."
echo "Keep a copy of talkivio.env in your password manager — the secrets cannot be recovered from the server."
