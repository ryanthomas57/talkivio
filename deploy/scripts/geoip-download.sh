#!/bin/sh
# Runs inside the `geoip` job container (deploy/compose.yaml). Installs the current DB-IP "IP to City Lite" and
# "IP to ASN Lite" databases (CC BY 4.0, https://db-ip.com — attribution is shown on the dashboard's Visitors page)
# into the geoip_db volume, atomically: the api reloads them within an hour. City gives country/region/city; ASN
# gives the network owner shown next to a visitor's IP address. Early in a month the new files may not be
# published yet, so last month's are the fallback.
set -eu
this_month=$(date -u +%Y-%m)
last_month=$(date -u -d "@$(($(date -u +%s) - 32 * 86400))" +%Y-%m)

install() { # install <city|asn>
  kind=$1
  dest="/geoip/dbip-$kind-lite.mmdb"
  for month in "$this_month" "$last_month"; do
    if curl -fsSL --retry 3 --max-time 600 -o "/geoip/.$kind.gz" "https://download.db-ip.com/free/dbip-$kind-lite-$month.mmdb.gz"; then
      gunzip -c "/geoip/.$kind.gz" > "/geoip/.$kind.mmdb"
      rm -f "/geoip/.$kind.gz"
      # A MaxMind-format database ends with a metadata section (≤ 128 KiB) marked "MaxMind.com". busybox grep does
      # not match inside binary data, so keep only letters and dots and match with the shell.
      case "$(tail -c 131072 "/geoip/.$kind.mmdb" | tr -dc 'A-Za-z.')" in
        *MaxMind.com*) ;;
        *)
          rm -f "/geoip/.$kind.mmdb"
          echo "the $kind download for $month is not a MaxMind-format database" >&2
          return 1
          ;;
      esac
      chmod 644 "/geoip/.$kind.mmdb"
      mv "/geoip/.$kind.mmdb" "$dest"
      echo "DB-IP $kind Lite $month installed ($(wc -c < "$dest") bytes)"
      return 0
    fi
  done
  rm -f "/geoip/.$kind.gz"
  echo "could not download DB-IP $kind Lite; the installed copy (if any) stays in use" >&2
  return 1
}

status=0
install city || status=1
install asn || status=1
exit "$status"
