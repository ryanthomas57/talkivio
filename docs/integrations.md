# Integrations: tokens, webhooks and connectors

Master prompt ch. 55–56. Code: `apps/api/src/features/integrations/*`; local receiver: `infra/webhook-receiver/`.

## Integration tokens
- Created by staff with `integrations.manage` (recent re-authentication required): `POST /api/v1/integration-tokens
  {name, scopes, expires_at?}`. The secret `rdt_<8 hex>_<secret>` is returned **once**; only its SHA-256 is stored.
  Default expiry 90 days, maximum 365. Revoke (`DELETE`) and rotate (`POST …/rotate`) take effect on the next
  request.
- Use: `Authorization: Bearer rdt_…` against `/api/v1` routes that allow tokens. Scopes:

  | Scope | Grants |
  | --- | --- |
  | `chats:read` | history, notes, departments, agents (read) |
  | `chats:write` | serve/monitor chats, forced transfer, create tags |
  | `visitors:read` / `visitors:write` | visitor records (read / edit, tags) |
  | `analytics:read` | analytics, agent analytics, monitor |
  | `webhooks:manage` | webhook endpoint management |

  A token can never hold more than its creator's permissions, nor more than an admin's.

## Webhooks
- Manage at `/api/v1/webhooks` (`GET /webhooks/event-types` lists subscribable types): `chat.requested`,
  `chat.started`, `chat.closed`, `rating.updated`, `offline.submitted`, `privacy.erased`, `trigger.webhook`.
- Body (stable across retries): `{id, type, version, occurred_at, tenant_id, data}`. `data` carries identifiers only —
  never transcript text, names, emails or rating comments. Fetch details with a token if you need them.
- Headers: `X-Talkivio-Event-Id`, `X-Talkivio-Timestamp` (unix seconds) and
  `X-Talkivio-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>`. During a secret rotation overlap
  (default 60 min, `TALKIVIO_WEBHOOK_ROTATION_OVERLAP_MINUTES`) the header carries both: `v1=<new>,v1=<old>`.
- Verify on your side: recompute over the **raw** body, compare in constant time against any `v1=` value, reject
  timestamps older than 5 minutes, and de-duplicate by event id.

  ```js
  import { createHmac, timingSafeEqual } from 'node:crypto';
  export function verify(rawBody, headers, secret) {
    const ts = headers['x-talkivio-timestamp'];
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
    return String(headers['x-talkivio-signature'] ?? '')
      .split(',')
      .map((p) => p.trim().replace(/^v1=/, ''))
      .some((sig) => /^[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig, 'hex'), expected));
  }
  ```
- Delivery: attempts at ≈ 0, 10 s, 1 m, 5 m, 30 m, 2 h, 8 h, 24 h (with jitter), then dead letter. 408/429/5xx are
  retried (a bounded `Retry-After` is honoured); other 4xx fail permanently. 10 s timeout, redirects not followed,
  response stored as a sanitized excerpt ≤ 1000 characters. Admins can redeliver (`POST
  /api/v1/webhook-deliveries/{id}/retry`) with the same event id.
- SSRF protection: URLs must be `http(s)`; hosts are resolved at save time **and** at every dispatch, and loopback,
  private, link-local and cloud metadata addresses are refused. `TALKIVIO_WEBHOOK_ALLOW_PRIVATE=true` (with
  `TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS`) exists only for local tests and is ignored when `NODE_ENV=production`;
  metadata/link-local targets are never allowed.

## Local webhook receiver
`node infra/webhook-receiver/server.mjs` verifies signatures (secret from env), rejects stale timestamps, de-duplicates
event ids, can simulate failures (`FAIL_FIRST_N`, `FAIL_STATUS`) and lists received events at `GET /events`. See its
README.

## Connectors (CRM, ticketing, email)
`GET /api/v1/integrations/connectors` lists the adapter catalog. Every adapter implements `authenticate`,
`healthCheck`, `createTicket`, `exportChat` and `eraseSubject`. In this build no provider credentials are configured,
so every connector reports **disabled (no credentials)** and `POST …/{key}/health-check` returns
`409 INTEGRATION_UNAVAILABLE`. The adapters are contract-tested only against an in-process mock provider used by tests; no
external provider has been exercised.
