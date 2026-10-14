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
  dc restart mailserver > /dev/null 2>&1
fi
[ -s "$record" ] || die "no DKIM record at infra/mail/$record"
echo "Add this TXT record in your DNS:"
echo "  name:  mail._domainkey.$domain"
printf '  value: '
# docker-mailserver 16 writes the bare value on one line; older versions wrote a BIND-style record split into
# quoted chunks, which are joined here into the single value DNS panels expect.
if grep -q '(' "$record"; then
  tr -d '\n' < "$record" | sed -E 's/^[^(]*\(//; s/\).*$//' | grep -o '"[^"]*"' | tr -d '"' | tr -d ' \t'
else
  tr -d '\n' < "$record"
fi
echo
