# Mail server on the Talkivio host (optional)

Mailboxes for your domain (for example `support@`, `billing@`) and the address Talkivio sends from, on the same
server as the Talkivio stack in `deploy/`. Use this instead of an outside mail provider when you want everything on
one server. It runs [docker-mailserver](https://docker-mailserver.github.io/docker-mailserver/v16.0/) (Postfix,
Dovecot, Rspamd for spam filtering and DKIM signing, fail2ban) and Roundcube webmail.

| Piece                 | Where                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Incoming mail (MX)    | port 25 on `MAIL_HOSTNAME`                                                                         |
| Mail apps             | IMAP 993 (SSL/TLS), SMTP 465 (SSL/TLS) or 587 (STARTTLS); user name = full address                 |
| Webmail               | `https://MAIL_HOSTNAME`, served by the Talkivio Caddy through `deploy/caddy.d/mail.caddy`          |
| Talkivio's own e-mail | SMTP 465 on `MAIL_HOSTNAME` with a dedicated mailbox (`scripts/app-sender.sh`)                     |
| TLS certificate       | the one Caddy obtains for `MAIL_HOSTNAME`, mounted read-only; renewals are picked up automatically |

Memory: about 0.5 to 1 GB next to the Talkivio stack (ClamAV is off here; Talkivio already runs one for uploads).

## 1. Before you start

- Talkivio is deployed from `deploy/` on this server (the mail stack joins its `talkivio_edge` network and reads
  certificates from its `talkivio_caddy_data` volume).
- The provider allows outgoing port 25: `nc -z -w5 gmail-smtp-in.l.google.com 25 && echo open`.
- Open the mail ports: `ufw allow 25/tcp && ufw allow 465/tcp && ufw allow 587/tcp && ufw allow 993/tcp`.

## 2. DNS (at your DNS host) and reverse DNS (at your server provider)

With `example.com`, mail host `mail.example.com` and server address `203.0.113.10`:

| Type | Name                      | Value                                                       |
| ---- | ------------------------- | ----------------------------------------------------------- |
| A    | `mail`                    | `203.0.113.10` (no AAAA record, see below)                  |
| MX   | `@`                       | `mail.example.com`, priority 10                             |
| TXT  | `@`                       | `v=spf1 ip4:203.0.113.10 mx ~all`                           |
| TXT  | `_dmarc`                  | `v=DMARC1; p=none; adkim=r; aspf=r` (tighten after a month) |
| TXT  | `mail._domainkey`         | printed by `scripts/dkim.sh example.com` (step 5)           |
| PTR  | `203.0.113.10` (provider) | `mail.example.com`                                          |

The reverse DNS (PTR) of the server's address must be the mail host name; Gmail and Outlook refuse or junk mail from
addresses without it. Set it in your server provider's panel (Hostinger: VPS, Settings, IP address, PTR record).

No AAAA record for the mail host: without IPv6 on the Docker network, IPv6 connections arrive through docker-proxy
with an internal source address, which would defeat the SPF, DMARC and spam checks. The server sends and receives
over IPv4 only (`POSTFIX_INET_PROTOCOLS=ipv4`).

## 3. Certificate and webmail site

```bash
cd /opt/talkivio/infra/mail
./scripts/init.sh mail.example.com postmaster@example.com      # mail.env, webmail key, config/ (once)
sed -e 's/mail.example.com/MAIL_HOST/' -e 's/you@example.com/YOUR_EMAIL/' \
  webmail.caddy.example > ../../deploy/caddy.d/mail.caddy      # with your mail host name and e-mail
cd ../../deploy && docker compose --env-file talkivio.env --env-file release.env up -d --force-recreate caddy
```

Caddy then gets the certificate as soon as `mail.example.com` resolves to this server. Check that it exists before
starting the mail server (the mount needs the folder):

```bash
docker run --rm -v talkivio_caddy_data:/d:ro alpine ls /d/caddy/certificates/acme-v02.api.letsencrypt.org-directory/
```

## 4. Start

```bash
cd /opt/talkivio/infra/mail
./scripts/mail.sh up -d
./scripts/mail.sh ps            # mailserver becomes healthy within a minute
```

## 5. Mailboxes, DKIM and Talkivio's sender

```bash
./scripts/mailbox.sh add support@example.com                     # asks for the password (typed, not shown)
./scripts/mailbox.sh alias postmaster@example.com support@example.com
./scripts/mailbox.sh alias abuse@example.com support@example.com
./scripts/dkim.sh example.com                                     # prints the DKIM TXT record for step 2
./scripts/app-sender.sh no-reply@example.com                      # random password, written to deploy/talkivio.env
cd ../../deploy && ./scripts/deploy.sh "$(sed -n 's/^TALKIVIO_RELEASE_SHA=//p' release.env)"   # Talkivio reads it
```

`app-sender.sh` sets `TALKIVIO_SMTP_HOST=MAIL_HOSTNAME`, port 465 with TLS and the new mailbox as the login; the
password is generated and never shown. Run it again to rotate the password.

Check delivery: send a message from webmail to a Gmail address and open "Show original": SPF, DKIM and DMARC should
all say PASS. A new server address has no sending reputation yet, so the first messages can land in spam; replies
and "Not spam" clicks build it up.

## Day to day

- Change a password: `./scripts/mailbox.sh password support@example.com` (users can also change it in webmail).
- List mailboxes and aliases: `./scripts/mailbox.sh list`.
- Logs: `./scripts/mail.sh logs -f mailserver`. Queue: `./scripts/mail.sh exec mailserver postqueue -p`.
- Upgrade: change the image tags in `compose.yaml` after reading the release notes, then `./scripts/mail.sh up -d`.

## Backups

`./scripts/backup.sh` archives the mailboxes and `config/` (accounts, aliases, DKIM key, webmail key) into
`backups/`, keeping 14 days. Schedule it daily, next to the Talkivio backup:

```bash
crontab -e
30 3 * * * cd /opt/talkivio/infra/mail && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Copy `backups/` off the server too (or rely on your provider's server snapshots): a lost server loses the mail
otherwise. Restore: stop the stack, unpack `config/` into `infra/mail/config/` and `mail-data/` into the
`talkivio-mail_mail_data` volume, start it again.
