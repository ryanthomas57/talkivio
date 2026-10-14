#!/usr/bin/env bash
# Sets one value in talkivio.env without it appearing on screen, in the shell history or in the process list:
#   ./scripts/set-secret.sh TALKIVIO_SMTP_PASSWORD
# Then restart the stack (./scripts/deploy.sh <commit>) so the services read it.
set -euo pipefail
cd "$(dirname "$0")/.."
name=${1:-}
[[ "$name" =~ ^TALKIVIO_[A-Z0-9_]+$ ]] || { echo "usage: $0 TALKIVIO_SETTING_NAME" >&2; exit 2; }
[ -f talkivio.env ] || { echo "talkivio.env not found (run scripts/init-env.sh first)" >&2; exit 1; }
read -r -s -p "Value for $name: " value
echo
[ -n "$value" ] || { echo "empty value, nothing changed" >&2; exit 1; }
[[ "$value" != *$'\n'* ]] || { echo "the value cannot contain a line break" >&2; exit 1; }
# Written single-quoted, which docker compose reads literally (no $-expansion); so no single quotes inside.
[[ "$value" != *"'"* ]] || { echo "the value cannot contain a single quote (') - choose another password" >&2; exit 1; }
umask 077
tmp=$(mktemp talkivio.env.XXXXXX)
found=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" == "$name="* ]]; then
    printf "%s='%s'\n" "$name" "$value"
    found=1
  else
    printf '%s\n' "$line"
  fi
done < talkivio.env > "$tmp"
[ "$found" = 1 ] || printf "%s='%s'\n" "$name" "$value" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" talkivio.env
echo "$name saved in talkivio.env."
