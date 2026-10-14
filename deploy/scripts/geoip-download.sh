#!/bin/sh
# Runs inside the `geoip` job container (deploy/compose.yaml). Installs the current DB-IP "IP to City Lite"
# database (CC BY 4.0, https://db-ip.com — attribution is shown on the dashboard's Visitors page) into the
# geoip_db volume, atomically: the api reloads it within an hour. Early in a month the new file may not be
# published yet, so last month's is the fallback.
set -eu
dest=/geoip/dbip-city-lite.mmdb
this_month=$(date -u +%Y-%m)
last_month=$(date -u -d "@$(($(date -u +%s) - 32 * 86400))" +%Y-%m)
for month in "$this_month" "$last_month"; do
  if curl -fsSL --retry 3 --max-time 600 -o /geoip/.download.gz "https://download.db-ip.com/free/dbip-city-lite-$month.mmdb.gz"; then
    gunzip -c /geoip/.download.gz > /geoip/.download.mmdb
    rm -f /geoip/.download.gz
    # A MaxMind-format database ends with a metadata section (≤ 128 KiB) marked "MaxMind.com". busybox grep does not
    # match inside binary data, so keep only letters and dots and match with the shell.
    case "$(tail -c 131072 /geoip/.download.mmdb | tr -dc 'A-Za-z.')" in
      *MaxMind.com*) ;;
      *)
        rm -f /geoip/.download.mmdb
        echo "the download for $month is not a MaxMind-format database" >&2
        exit 1
        ;;
    esac
    chmod 644 /geoip/.download.mmdb
    mv /geoip/.download.mmdb "$dest"
    echo "DB-IP City Lite $month installed ($(wc -c < "$dest") bytes)"
    exit 0
  fi
done
rm -f /geoip/.download.gz
echo "could not download DB-IP City Lite; visitor locations keep using the installed copy (if any)" >&2
exit 1
