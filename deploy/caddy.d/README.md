# Extra Caddy sites

Caddy loads every `*.caddy` file in this folder after the Talkivio sites (`import /etc/caddy/sites.d/*.caddy` in
`../Caddyfile`). Use it for other services on the same server, for example webmail for the mail server in
`infra/mail/`. The `*.caddy` files are server-local and ignored by git; this folder is empty by default.

After adding or changing a file, recreate Caddy so it reads it:

```bash
cd /opt/talkivio/deploy && docker compose --env-file talkivio.env --env-file release.env up -d --force-recreate caddy
```
