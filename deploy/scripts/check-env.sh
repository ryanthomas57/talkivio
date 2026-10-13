#!/usr/bin/env bash
# Checks deploy/talkivio.env and this server before a deploy. Errors stop the deploy; warnings do not.
#   scripts/check-env.sh [--quiet]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
quiet=0
[ "${1:-}" = --quiet ] && quiet=1
errors=0
warn() { echo "warning: $*" >&2; }
fail() {
  echo "error: $*" >&2
  errors=$((errors + 1))
}

[ -f talkivio.env ] || die "deploy/talkivio.env is missing — run scripts/init-env.sh first"
perm=$(stat -c %a talkivio.env 2> /dev/null || stat -f %Lp talkivio.env)
[ "$perm" = 600 ] || warn "talkivio.env is mode $perm; chmod 600 talkivio.env"
grep -qE '^[A-Z0-9_]+=<generated>$' talkivio.env && fail "talkivio.env still has <generated> placeholders — create it with scripts/init-env.sh"

domain=$(setting TALKIVIO_DOMAIN)
tls=$(setting TALKIVIO_TLS)
[ -n "$domain" ] || fail "TALKIVIO_DOMAIN is empty"
[[ "$domain" == *example.com ]] && fail "TALKIVIO_DOMAIN is still the example value"
[[ "$domain" =~ ^[a-z0-9.-]+$ ]] || fail "TALKIVIO_DOMAIN must be a bare host name such as chat.yourcompany.com"
if [ "$tls" != internal ]; then
  [[ "$tls" == *@* && "$tls" != *example.com ]] || fail "TALKIVIO_TLS must be your e-mail address (Let's Encrypt account)"
fi
for k in TALKIVIO_EMAIL_FROM TALKIVIO_SMTP_HOST; do
  v=$(setting "$k")
  [ -n "$v" ] || fail "$k is empty"
  [[ "$v" == *example.com* ]] && fail "$k is still the example value"
done
[ "$(setting TALKIVIO_APP_SECRET | wc -c)" -gt 32 ] || fail "TALKIVIO_APP_SECRET must be at least 32 characters"
for k in TALKIVIO_POSTGRES_PASSWORD TALKIVIO_OWNER_DB_PASSWORD TALKIVIO_APP_DB_PASSWORD TALKIVIO_REDIS_PASSWORD TALKIVIO_MINIO_ROOT_PASSWORD TALKIVIO_S3_APP_SECRET TALKIVIO_METRICS_TOKEN; do
  [ "$(setting "$k" | wc -c)" -gt 16 ] || fail "$k must be a generated secret"
  [[ "$(setting "$k")" =~ ^[A-Za-z0-9_-]+$ ]] || fail "$k may only contain letters, digits, _ and - (it is used in connection URLs)"
done

command -v docker > /dev/null || fail "docker is not installed"
if command -v docker > /dev/null; then
  docker compose version > /dev/null 2>&1 || fail "the docker compose plugin is not installed"
fi

if [ "$tls" != internal ]; then
  for host in "$domain" "files.$domain"; do
    getent hosts "$host" > /dev/null 2>&1 || warn "$host does not resolve yet — create its DNS record (A/AAAA → this server) before deploying, or certificates cannot be issued"
  done
  [ -n "$(setting TALKIVIO_BACKUP_S3_BUCKET)" ] || warn "no off-server backup bucket (TALKIVIO_BACKUP_S3_*): backups stay on this server only"
fi
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2> /dev/null || echo 0)
[ "$mem_kb" -eq 0 ] || [ "$mem_kb" -ge 6000000 ] || warn "$((mem_kb / 1024)) MB RAM; 8 GB is recommended (the virus scanner alone needs 2-3 GB)"

[ "$errors" -eq 0 ] || exit 1
[ "$quiet" = 1 ] || echo "talkivio.env looks complete."
