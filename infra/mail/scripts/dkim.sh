#!/usr/bin/env bash
# Creates the DKIM signing key for a domain (once) and prints the DNS TXT record to publish.
#   scripts/dkim.sh example.com
set -euo pipefail
source "$(dirname "$0")/lib.sh"

domain=${1:-}
[[ "$domain" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "usage: scripts/dkim.sh <domain>"
record=config/rspamd/dkim/rsa-2048-mail-$domain.public.dns.txt
if [ ! -s "$record" ]; then
  dc exec -T mailserver setup config dkim keysize 2048 selector mail domain "$domain" > /dev/null
  dc restart mailserver > /dev/null
fi
[ -s "$record" ] || die "no DKIM record at infra/mail/$record"
echo "Add this TXT record in your DNS:"
echo "  name:  mail._domainkey.$domain"
printf '  value: '
# The file is a BIND-style record split into quoted chunks; join them into the single value DNS panels expect.
tr -d '\n' < "$record" | sed -E 's/^[^(]*\(//; s/\).*$//' | grep -o '"[^"]*"' | tr -d '"' | tr -d ' \t'
echo
