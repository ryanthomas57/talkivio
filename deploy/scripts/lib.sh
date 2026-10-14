# shellcheck shell=bash
# Shared helpers for the deploy scripts (sourced, not executed).
# talkivio.env is read by docker compose; scripts read single values with `setting` and never `source`
# it (values such as "Talkivio <no-reply@…>" are not shell syntax).

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR" || exit 1

die() {
  echo "error: $*" >&2
  exit 1
}
note() { echo "$(date -u +%H:%M:%S) $*"; }

# deploy/backups belongs to the deploying user: dumps are streamed into it from this shell, and the backup job
# container mounts it. Create it before any container does (Docker makes a missing bind-mount source as root).
ensure_backups_dir() {
  mkdir -p backups
  [ -O backups ] || die "deploy/backups belongs to $(ls -ld backups | awk '{print $3}'), not $(id -un). Fix it with: sudo chown -R $(id -un) $DEPLOY_DIR/backups"
  chmod 700 backups
}

setting() { # setting NAME [default]
  local v
  v=$(grep -E "^$1=" talkivio.env 2> /dev/null | tail -n 1 | cut -d= -f2-) || true
  echo "${v:-${2:-}}"
}

dc() {
  [ -f talkivio.env ] || die "deploy/talkivio.env is missing — run scripts/init-env.sh first"
  local files=(--env-file talkivio.env)
  [ -f release.env ] && files+=(--env-file release.env)
  docker compose "${files[@]}" "$@"
}

container_of() { dc ps -q "$1" 2> /dev/null | head -n 1; }

# Waits until a service's health check passes (or its container runs, when it has none).
wait_healthy() { # wait_healthy SERVICE [seconds]
  local svc=$1 limit=${2:-180} st=missing id
  for _ in $(seq 1 $((limit / 2))); do
    id=$(container_of "$svc")
    if [ -n "$id" ]; then
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
      if [ "$st" = healthy ]; then return 0; fi
    fi
    sleep 2
  done
  dc logs --no-color --tail 60 "$svc" >&2 || true
  die "$svc is not healthy after ${limit}s (last state: $st)"
}

running_revision() { # the commit an app service runs (OCI revision label of its image)
  local id
  id=$(container_of "$1")
  [ -n "$id" ] || return 0
  docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(docker inspect -f '{{.Image}}' "$id")" 2> /dev/null || true
}

# Replaces the application services one at a time; each must be healthy before the next goes.
APP_SERVICES=(worker gateway api dashboard)
replace_app_services() {
  for svc in "${APP_SERVICES[@]}"; do
    dc up -d --no-deps --force-recreate "$svc"
    wait_healthy "$svc" 240
    note "$svc healthy on $(running_revision "$svc")"
  done
}

# Starts or updates Caddy. compose.yaml gives the edge network IPv6 (TALKIVIO_IPV6), and Docker never changes an
# existing network: recent Compose versions recreate it when Caddy starts, older ones keep the old one, so a
# network with the other setting is recreated here first (Caddy, its only member, stops for a few seconds).
start_caddy() {
  local net want
  want=$(setting TALKIVIO_IPV6 true)
  net=$(docker network ls -q --filter label=com.docker.compose.project=talkivio --filter label=com.docker.compose.network=edge)
  if [ -n "$net" ] && [ "$(docker network inspect -f '{{.EnableIPv6}}' "$net")" != "$want" ]; then
    note "recreating the edge network with IPv6 $want (Caddy restarts)"
    dc rm --stop --force caddy
    docker network rm "$net" > /dev/null || die "cannot remove the old edge network; docker network inspect $net shows what is still attached"
  fi
  dc up -d caddy
  wait_healthy caddy 120
}

# Checks the public endpoints through Caddy on this machine (no DNS needed).
smoke() {
  local domain tls curl_tls=()
  domain=$(setting TALKIVIO_DOMAIN)
  tls=$(setting TALKIVIO_TLS)
  [ "$tls" = internal ] && curl_tls=(--cacert "$DEPLOY_DIR/.caddy-root.crt")
  if [ "$tls" = internal ]; then
    docker cp "$(container_of caddy):/data/caddy/pki/authorities/local/root.crt" "$DEPLOY_DIR/.caddy-root.crt" > /dev/null
  fi
  local base=(curl -fsS --max-time 15 --retry 10 --retry-delay 3 --retry-all-errors "${curl_tls[@]}" --resolve "$domain:443:127.0.0.1" --resolve "files.$domain:443:127.0.0.1")
  "${base[@]}" -o /dev/null "https://$domain/health/ready" || die "https://$domain/health/ready failed"
  "${base[@]}" -o /dev/null "https://$domain/login" || die "the dashboard does not answer at https://$domain/login"
  "${base[@]}" -o /dev/null "https://$domain/widget/loader.js" || die "the widget loader is not served"
  local metrics
  metrics=$(curl -s -o /dev/null -w '%{http_code}' "${curl_tls[@]}" --resolve "$domain:443:127.0.0.1" "https://$domain/health/metrics")
  [ "$metrics" = 404 ] || die "/health/metrics must not be public (got $metrics)"
  note "smoke ok: https://$domain (health, dashboard, widget loader; metrics not exposed)"
}
