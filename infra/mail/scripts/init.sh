#!/usr/bin/env bash
# Creates infra/mail/mail.env and the server-local config folder (once).
#   scripts/init.sh mail.example.com postmaster@example.com
set -euo pipefail
source "$(dirname "$0")/lib.sh"

host=${1:-}
postmaster=${2:-}
[[ "$host" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "usage: scripts/init.sh <mail host name> <postmaster address>"
valid_address "$postmaster" || die "usage: scripts/init.sh <mail host name> <postmaster address>"
[ -e mail.env ] && die "mail.env already exists: not touching it"
command -v openssl > /dev/null || die "openssl is required"

umask 077
mkdir -p config backups
sed -e "s|^MAIL_HOSTNAME=.*|MAIL_HOSTNAME=$host|" -e "s|^MAIL_POSTMASTER=.*|MAIL_POSTMASTER=$postmaster|" \
  mail.env.example > mail.env
chmod 600 mail.env
# Roundcube encrypts the IMAP password in its session with this key (24 characters, no newline).
[ -s config/roundcube_des_key ] || printf '%s' "$(openssl rand -hex 12)" > config/roundcube_des_key
# The webmail container runs as www-data (uid 33) and reads the key through a Compose secret.
chown 33:33 config/roundcube_des_key 2> /dev/null || true
chmod 400 config/roundcube_des_key

echo "Created infra/mail/mail.env for $host."
echo "Next: README steps 2-4 (DNS, the Caddy site, then scripts/mail.sh up -d)."
