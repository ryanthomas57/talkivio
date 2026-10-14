# Running Talkivio in production (one server)

This folder takes one Linux server to a running Talkivio on your own domain over HTTPS: the dashboard, the
REST API, the realtime gateway, the background worker, PostgreSQL, Redis, file storage (MinIO) and the virus
scanner (ClamAV), with automatic certificates, signed images, rolling upgrades, rollback and backups.

Every push to `main` rehearses exactly this bundle in CI (`staging-rehearsal` job): it deploys the images just
published for that commit with these scripts, runs the end-to-end suites over HTTPS, then backs up, destroys the
whole server, reinstalls and restores, and requires the same data byte for byte.

## 1. What you need

| Item                 | Notes                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server             | Ubuntu 24.04 (any Linux with Docker works), **8 GB RAM**, 2+ vCPU, 80 GB disk. The virus scanner alone needs 2–3 GB.                                                    |
| A domain             | Two DNS records pointing at the server: `chat.yourcompany.com` and `files.chat.yourcompany.com` (A, and AAAA if the server has IPv6).                                   |
| An e-mail provider   | Any SMTP service (Postmark, Amazon SES, Resend, Mailgun …) with your sending domain verified (SPF, DKIM, DMARC). Sign-up, invitations and password resets depend on it. |
| An off-server bucket | Any S3-compatible bucket at another provider (AWS S3, Cloudflare R2, Backblaze B2 …) and a key limited to it, for backups.                                              |
| Optional: GitHub CLI | `gh` signed in lets `deploy.sh` verify each image's signed build provenance before running it.                                                                          |

## 2. Prepare the server (once)

```bash
# Docker Engine + the compose plugin (https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sh
# Firewall: SSH, HTTP (certificate challenges and the HTTPS redirect) and HTTPS only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable
# The deploy bundle
git clone https://github.com/ryanthomas57/talkivio.git /opt/talkivio
cd /opt/talkivio/deploy
./scripts/init-env.sh        # creates talkivio.env (mode 600) with generated secrets
nano talkivio.env            # domain, TLS e-mail, SMTP, backup bucket (not the passwords)
./scripts/set-secret.sh TALKIVIO_SMTP_PASSWORD   # typed, never shown or kept in the shell history
./scripts/check-env.sh
```

To serve the bare domain (for example `talkivio.com`, with the public website at `/`), set `TALKIVIO_DOMAIN=talkivio.com`
and `TALKIVIO_WWW_SITE=www.talkivio.com`, and point `talkivio.com`, `www.talkivio.com` and `files.talkivio.com` at the
server: `www` then redirects to the bare domain with its own certificate.

Save a copy of `talkivio.env` in your password manager. It holds the only copy of the secrets; `TALKIVIO_APP_SECRET`
in particular cannot be changed without invalidating stored credentials and tokens.

The images are published at `ghcr.io/ryanthomas57/talkivio-{api,dashboard,migrate}`. If those packages are private,
sign the server in once with a GitHub token that has only `read:packages`:
`echo <token> | docker login ghcr.io -u <github user> --password-stdin`.

## 3. Install / upgrade

Pick the commit to run: the latest commit on `main` whose CI run is green (GitHub → Actions). Then:

```bash
./scripts/deploy.sh <full 40-character commit SHA>
```

`deploy.sh` pulls that commit's images, checks they were built from it, verifies their signed provenance (when
`gh` is signed in; `TALKIVIO_REQUIRE_ATTESTATIONS=1` makes it mandatory), pins their digests in `release.env`,
runs the database migrations, replaces worker → gateway → api → dashboard one at a time (each healthy before the
next), and checks the public endpoints. The first run also obtains the HTTPS certificates; the first start of
the virus scanner downloads its signatures for a few minutes (uploads wait in "scanning" until then).

Then open `https://chat.yourcompany.com/signup`, create your workspace, confirm your e-mail, and copy the widget
snippet from **Settings → Sites** into your website.

**Rollback:** `./scripts/rollback.sh` puts the previous release's images back, one service at a time. The schema
stays (migrations are expand-only, and this exact step is rehearsed in CI on every push to `main`).

## 4. Backups

```bash
./scripts/backup.sh          # database dump + uploaded files, export artifacts and the privacy erasure ledger
crontab -e                   # hourly:
0 * * * * cd /opt/talkivio/deploy && ./scripts/backup.sh >> backups/backup.log 2>&1
```

With `TALKIVIO_BACKUP_S3_*` set, every dump goes to `<bucket>/db/` and the files are mirrored to
`<bucket>/objects/`. Add a lifecycle rule on the bucket that expires `db/` after 35 days. Hourly backups mean
up to one hour of data can be lost if the server is lost (RPO ≤ 1 h); for minutes, use a managed PostgreSQL with
point-in-time recovery (docs/operations/deployment.md §8).

**Restore** (a lost server, or the quarterly drill on a spare one): prepare the server as in §2 with the **same
`talkivio.env`**, run `./scripts/deploy.sh <sha>`, then

```bash
./scripts/restore.sh talkivio-<UTC timestamp>.dump --yes-replace-all-data    # or `latest`
```

It brings the files back first (they carry the privacy erasure ledger), recreates and restores the database,
checks row-level security, re-applies recorded erasures before any traffic, starts everything and prints the
recovery point and recovery time.

## 5. Visitor locations

Country and city on the Visitors page come from the free DB-IP "IP to City Lite" database (CC BY 4.0; the
dashboard shows the required credit). `deploy.sh` installs it; refresh it monthly:

```bash
crontab -e
0 4 3 * * cd /opt/talkivio/deploy && ./scripts/update-geoip.sh >> backups/geoip.log 2>&1
```

The API picks up the new file within an hour. If the site sits behind Cloudflare (or Vercel / Fastly) with
location headers, set `TALKIVIO_GEO_TRUSTED_HEADERS=cloudflare` in `talkivio.env`; leave it `none` otherwise,
so visitors cannot fake their country (it drives triggers).

## 6. Keep an eye on it

- An external uptime check on `https://chat.yourcompany.com/health/ready` (any uptime service) is the minimum.
- Metrics for Prometheus are served on the private network only (`/health/metrics`, bearer `TALKIVIO_METRICS_TOKEN`);
  alert rules and routing are in `infra/observability/` (see its README).
- Logs: `docker compose --env-file talkivio.env --env-file release.env logs -f api worker`.
- Keep the server patched (`unattended-upgrades`), SSH by key only.

## 7. What this single-server setup does not give you

One server is one failure domain: a hardware or provider outage takes the service down until it is restored
from backup. When you outgrow it, move PostgreSQL and object storage to managed services (set the connection
variables) and run several api/gateway/worker replicas behind a load balancer — the procedure is in
docs/operations/deployment.md.
