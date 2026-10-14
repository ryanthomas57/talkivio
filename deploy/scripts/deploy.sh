#!/usr/bin/env bash
# Install or upgrade Talkivio to the images CI published for one commit of main.
#
#   scripts/deploy.sh <40-character commit SHA>
#
# 1. Resolves ghcr.io/<owner>/talkivio-{api,dashboard,migrate}:<sha> to digests and checks each image was built
#    from that commit (OCI revision label). With the GitHub CLI installed and signed in, it also verifies the
#    signed build provenance (`gh attestation verify`); TALKIVIO_REQUIRE_ATTESTATIONS=1 makes that mandatory.
# 2. Pins the digests in release.env (the previous release is kept in release.previous.env for rollback.sh).
# 3. Starts the data services, runs the bucket and database migrations (expand-only, safe while the previous
#    release serves), then replaces worker → gateway → api → dashboard one at a time, each healthy before the
#    next, and smoke-tests the public endpoints.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

sha=${1:-}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "usage: scripts/deploy.sh <full 40-character commit SHA of main>"
scripts/check-env.sh --quiet

repo=$(setting TALKIVIO_IMAGE_REPO ghcr.io/ryanthomas57/talkivio)
source_repo=$(setting TALKIVIO_SOURCE_REPO ryanthomas57/talkivio)
verify=auto
if ! command -v gh > /dev/null || ! gh auth status > /dev/null 2>&1; then verify=unavailable; fi
if [ "$verify" = unavailable ] && [ "${TALKIVIO_REQUIRE_ATTESTATIONS:-0}" = 1 ]; then
  die "TALKIVIO_REQUIRE_ATTESTATIONS=1 but the GitHub CLI is not installed or not signed in (gh auth login)"
fi

declare -A pinned
for name in api dashboard migrate; do
  ref="$repo-$name:$sha"
  note "pulling $ref"
  docker pull -q "$ref" > /dev/null || die "cannot pull $ref — did CI publish this commit? (images job on main)"
  digest=$(docker image inspect "$ref" --format '{{ range .RepoDigests }}{{ println . }}{{ end }}' | grep "^$repo-$name@sha256:" | head -n 1)
  [ -n "$digest" ] || die "no registry digest for $ref"
  rev=$(docker image inspect "$ref" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
  [ "$rev" = "$sha" ] || die "$ref was built from $rev, not $sha"
  if [ "$verify" = auto ]; then
    gh attestation verify "oci://$digest" --repo "$source_repo" --signer-workflow "$source_repo/.github/workflows/ci.yml" > /dev/null ||
      die "signed provenance for $digest does not verify against $source_repo"
    note "$name: $digest (provenance verified)"
  else
    note "$name: $digest (provenance NOT verified: install the GitHub CLI and run gh auth login)"
  fi
  pinned[$name]=$digest
done

[ -f release.env ] && cp release.env release.previous.env
umask 077
cat > release.env << EOF
# Written by scripts/deploy.sh — the exact images this server runs.
TALKIVIO_RELEASE_SHA=$sha
TALKIVIO_API_IMAGE=${pinned[api]}
TALKIVIO_DASHBOARD_IMAGE=${pinned[dashboard]}
TALKIVIO_MIGRATE_IMAGE=${pinned[migrate]}
EOF
echo "$(date -u +%FT%TZ) deploy $sha api=${pinned[api]##*@} dashboard=${pinned[dashboard]##*@} migrate=${pinned[migrate]##*@}" >> releases.log

note "data services"
dc up -d postgres redis minio
for svc in postgres redis minio; do wait_healthy "$svc" 180; done
# First start downloads ~300 MB of signatures; uploads wait in "scanning" until clamd answers.
dc up -d clamav

note "buckets and database migrations"
dc --profile jobs run --rm minio-init
dc --profile jobs run --rm migrate
# Visitor locations: a failed download is not fatal (locations stay empty until scripts/update-geoip.sh succeeds).
dc --profile jobs run --rm geoip || note "warning: the visitor-location database could not be downloaded; run scripts/update-geoip.sh later"

first_install=0
[ -z "$(container_of api)" ] && first_install=1
if [ "$first_install" = 1 ]; then
  note "first install: starting the application"
  dc up -d worker gateway api dashboard
  for svc in "${APP_SERVICES[@]}"; do wait_healthy "$svc" 300; done
else
  note "rolling replacement"
  replace_app_services
fi
dc up -d caddy
wait_healthy caddy 120
smoke
note "Talkivio $sha is live at https://$(setting TALKIVIO_DOMAIN)"
