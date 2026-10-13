#!/bin/sh
# Routing test for alertmanager.yml: every alert in alert-rules.yml, with the labels it fires with, must reach
# exactly the receiver its severity names (page → page, ticket → ticket). POSIX sh + amtool, so it runs inside the
# prom/alertmanager image:
#
#   docker run --rm --entrypoint sh -v "$PWD/infra/observability:/o:ro" prom/alertmanager:v0.34.1 \
#     /o/alertmanager-routes.test.sh /o
set -eu
dir=${1:-$(dirname "$0")}
amtool check-config "$dir/alertmanager.yml"

# `- alert: Name` followed by `labels: { severity: x, runbook: RB-nn }` in alert-rules.yml.
pairs=$(awk '/- alert:/ { name = $3 } /labels: \{ severity:/ && name { gsub(/[{},]/, ""); print name, $3, $5; name = "" }' "$dir/alert-rules.yml")
count=$(printf '%s\n' "$pairs" | grep -c .)
if [ "$count" -lt 11 ]; then
  echo "expected every alert (at least 11) to be checked, found $count" >&2
  exit 1
fi
printf '%s\n' "$pairs" | while read -r name severity runbook; do
  amtool config routes test --config.file="$dir/alertmanager.yml" --verify.receivers="$severity" \
    alertname="$name" severity="$severity" runbook="$runbook" service=api > /dev/null
  echo "ok  $name ($severity, $runbook) -> $severity"
done
# Anything unlabelled falls back to the ticket receiver, never to nobody.
amtool config routes test --config.file="$dir/alertmanager.yml" --verify.receivers=ticket alertname=Unlabelled > /dev/null
echo "ok  unlabelled alert -> ticket"
echo "ALERT ROUTING PASSED ($count alerts)"
