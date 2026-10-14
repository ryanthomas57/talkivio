#!/usr/bin/env bash
# Mailboxes and aliases. Passwords are typed at the prompt (never on the command line or on screen).
#   scripts/mailbox.sh add support@example.com
#   scripts/mailbox.sh password support@example.com
#   scripts/mailbox.sh alias postmaster@example.com support@example.com
#   scripts/mailbox.sh list
set -euo pipefail
source "$(dirname "$0")/lib.sh"

cmd=${1:-}
case "$cmd" in
  add | password)
    addr=${2:-}
    valid_address "$addr" || die "usage: scripts/mailbox.sh $cmd <address>"
    sub=add
    [ "$cmd" = password ] && sub=update
    dc exec mailserver setup email "$sub" "$addr"
    ;;
  alias)
    valid_address "${2:-}" && valid_address "${3:-}" || die "usage: scripts/mailbox.sh alias <alias address> <delivered to>"
    dc exec -T mailserver setup alias add "$2" "$3"
    ;;
  list)
    dc exec -T mailserver setup email list
    dc exec -T mailserver setup alias list
    ;;
  *) die "usage: scripts/mailbox.sh add|password <address> | alias <alias> <target> | list" ;;
esac
