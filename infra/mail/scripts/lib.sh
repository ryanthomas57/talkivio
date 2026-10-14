# shellcheck shell=bash
# Shared helpers for the mail scripts (sourced, not executed).
MAIL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MAIL_DIR" || exit 1

die() {
  echo "error: $*" >&2
  exit 1
}

setting() { # setting NAME [default]: one value from mail.env (never sourced)
  local v
  v=$(grep -E "^$1=" mail.env 2> /dev/null | tail -n 1 | cut -d= -f2-) || true
  echo "${v:-${2:-}}"
}

dc() {
  [ -f mail.env ] || die "infra/mail/mail.env is missing: run scripts/init.sh first"
  docker compose --env-file mail.env "$@"
}

valid_address() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
