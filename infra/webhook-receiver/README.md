# Talkivio local webhook receiver

A dependency-free Node HTTP server that implements the **receiving side** of the
Talkivio webhook contract. It is a test double for local development, Compose and the
end-to-end tests (`apps/api/test/integrations.e2e.mjs`). It is not a production component.

What it does:

- verifies `X-Talkivio-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>`
  over the **raw bytes** (any `v1=` entry may match any configured secret, so rotation
  overlaps — `v1=<new>,v1=<previous>` — verify with either secret);
- rejects `X-Talkivio-Timestamp` values more than 5 minutes from its clock;
- checks the body `id` equals `X-Talkivio-Event-Id` and de-duplicates by event id
  (a redelivery returns `200 {"duplicate": true}` and is recorded once);
- simulates failures for the first `FAIL_FIRST_N` attempts of every event id with
  `FAIL_STATUS` (e.g. 500, 429 with `RETRY_AFTER`, or a permanent 400);
- lists everything at `GET /events` (`received` = unique events, `attempts` = every request).

## Run

```bash
WEBHOOK_SECRET=whsec_... FAIL_FIRST_N=2 FAIL_STATUS=500 PORT=4196 node infra/webhook-receiver/server.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4196` / `127.0.0.1` | Listen address (`HOST=0.0.0.0` in a container) |
| `WEBHOOK_SECRET` | – | Comma-separated accepted secrets |
| `FAIL_FIRST_N` | `0` | Fail the first N attempts of each event id |
| `FAIL_STATUS` | `500` | Status for simulated failures |
| `RETRY_AFTER` | – | `Retry-After` seconds sent with simulated 429/503 |
| `TOLERANCE_SECONDS` | `300` | Timestamp window |
| `CONTROL_TOKEN` | – | Require `Authorization: Bearer <token>` for `/_control` and `DELETE /events` |

Runtime control (tests use this because the signing secret is only known after the
webhook is created): `POST /_control {"secrets":["whsec_…"],"fail_first_n":2,"fail_status":429,"retry_after":"1"}`
and `DELETE /events` to reset.

## Pointing Talkivio at it

Webhook URLs to loopback/private addresses are blocked (SSRF protection). For local
testing only, start the API **and worker** with:

```bash
TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true
TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS=127.0.0.1:4196   # host or host:port list
```

The exception is refused when `NODE_ENV=production`, only applies to loopback/private
addresses that match the allowlist, and never permits link-local or cloud metadata
addresses such as `169.254.169.254`. Then create the endpoint with
`POST /api/v1/webhooks {"url":"http://127.0.0.1:4196/hooks","event_types":[...]}` and copy
the one-time `secret` into `WEBHOOK_SECRET` (or `/_control`).

## Compose

```yaml
  webhook-receiver:
    image: node:22-alpine
    command: ["node", "/app/server.mjs"]
    volumes: ["./infra/webhook-receiver:/app:ro"]
    environment: { HOST: 0.0.0.0, PORT: "4196", CONTROL_TOKEN: change-me }
    profiles: ["test"]
```

In Compose the API reaches it by service name, which resolves to a private address, so
the API/worker need `TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS=webhook-receiver:4196` (test
profile only).
