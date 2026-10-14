#!/usr/bin/env bash
# Creates (or resets) the mailbox Talkivio sends from, with a long random password that is never shown, and points
# deploy/talkivio.env at this mail server. Redeploy Talkivio afterwards so the API and worker read it.
#   scripts/app-sender.sh no-reply@example.com
set -euo pipefail
source "$(dirname "$0")/lib.sh"

addr=${1:-}
valid_address "$addr" || die "usage: scripts/app-sender.sh <sender address>"
envfile="$MAIL_DIR/../../deploy/talkivio.env"
[ -f "$envfile" ] || die "deploy/talkivio.env not found (run deploy/scripts/init-env.sh first)"
host=$(setting MAIL_HOSTNAME)

pw=$(openssl rand -hex 24)
if dc exec -T mailserver setup email list 2> /dev/null | grep -q -- "$addr"; then
  printf '%s\n%s\n' "$pw" "$pw" | dc exec -T mailserver setup email update "$addr" > /dev/null
else
  printf '%s\n%s\n' "$pw" "$pw" | dc exec -T mailserver setup email add "$addr" > /dev/null
fi

umask 077
tmp=$(mktemp "$envfile.XXXXXX")
declare -A want=(
  [TALKIVIO_SMTP_HOST]="$host"
  [TALKIVIO_SMTP_PORT]=465
  [TALKIVIO_SMTP_SECURE]=true
  [TALKIVIO_SMTP_USER]="$addr"
  [TALKIVIO_SMTP_PASSWORD]="'$pw'"
)
declare -A seen=()
while IFS= read -r line || [ -n "$line" ]; do
  key=${line%%=*}
  if [ -n "${want[$key]+x}" ] && [[ "$line" == *=* ]]; then
    printf '%s=%s\n' "$key" "${want[$key]}"
    seen[$key]=1
  else
    printf '%s\n' "$line"
  fi
done < "$envfile" > "$tmp"
for key in "${!want[@]}"; do
  [ -n "${seen[$key]+x}" ] || printf '%s=%s\n' "$key" "${want[$key]}" >> "$tmp"
done
chmod 600 "$tmp"
mv "$tmp" "$envfile"
unset pw
echo "$addr is ready and deploy/talkivio.env sends through $host:465. Redeploy Talkivio to apply."
