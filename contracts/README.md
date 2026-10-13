# Talkivio API contracts

Generated, machine-checked contracts for the Talkivio HTTP API and realtime gateway
(spec ch. 40, 45–48, 73 "OpenAPI and AsyncAPI plus typed clients").

| File | What | Generator |
| --- | --- | --- |
| `openapi.yaml` | OpenAPI 3.1 — every HTTP route of the API (`/api/v1/*`, `/widget/v1/*`, `/widget/frame/*`, `/health/*`) | `apps/api/scripts/contracts/openapi.mjs` |
| `asyncapi.yaml` | AsyncAPI 3.0 — Socket.IO gateway (`/realtime/v1`, namespaces `/agent`, `/visitor`), plus every outbox event under `x-talkivio-outbox` | `apps/api/scripts/contracts/asyncapi.mjs` |
| `coverage.json` | Static coverage of `openapi.yaml` (typed / no-content / untyped media) | `openapi.mjs` |
| `../packages/client` | `@talkivio/client`: generated `paths` types (openapi-typescript), `createClient()` typed fetch wrapper, zod resource / event / command schemas | `openapi-typescript` + `tsc` |

Do not edit the generated files by hand.

## Regenerate

```bash
pnpm --filter @talkivio/api build        # the generators read the built API (apps/api/dist); skip if dist is current
pnpm --filter @talkivio/api contracts    # openapi.yaml + asyncapi.yaml → client types → client build
```

The generators never start the API: routes, guards, permissions (`@Require` / `@AuditedRequire`),
`@RecentAuth`, `@TokenAccess`, path/query parameters, `Idempotency-Key` / `If-Match` headers and the
zod schemas held by the `body()` / `verbatimBody()` pipes are read from Nest decorator metadata of
`apps/api/dist` (`routes.mjs`). Request schemas are converted to JSON Schema with property names in
snake_case (values under `custom_fields`, `fields`, `attributes`, `metadata`, `safe_diff`,
`field_errors` and verbatim keys keep their keys, exactly like `common/wire.ts`). Response shapes come
from the camelCase zod schemas in `packages/client/src/schemas`, mapped per operation in
`apps/api/scripts/contracts/responses.mjs`; event payloads from `packages/client/src/events`.
Output is deterministic (running twice yields byte-identical files) and is validated with
`@readme/openapi-parser` and `@asyncapi/parser`; any error fails the run.

Drift guards (the generators exit non-zero):

- a route without an entry in `responses.mjs`, or a `responses.mjs` entry without a route;
- an `eventType` passed to `outbox.append(...)` (or the `stage()` / `emitExport()` helpers), an
  ephemeral type passed to `realtime.ephemeral(...)` or a `registerAgent` / `registerVisitor` command
  without a schema — or a schema for something the code no longer emits;
- a socket command whose real handler (invoked with `{}` in-process) requires different fields than
  its schema declares; `RESCOPE_REASONS` differing from the server;
- a ch. 76 error code missing from the server's `ErrorCode` union.

## Prove

```bash
API_URL=http://localhost:4000 pnpm --filter @talkivio/api test:contracts   # = node apps/api/test/contracts.e2e.mjs
```

Needs the API + worker running, `psql`, and `DATABASE_OWNER_URL` (env or repo `.env`). Each run signs up
one tenant (`contracts-<timestamp>@talkivio.test`) and creates a second through `POST /api/v1/tenants`;
REST calls carry a run-unique private `X-Forwarded-For` (signup is limited to 10/hour per address).
The scenario covers auth (signup, verify, login, MFA enroll/confirm/recovery/disable), tenant, team,
departments, tags, custom fields, sites and widget config (etag conflicts), schedules, closures,
shortcuts, triggers, an invitation campaign, the widget (bootstrap, identity JWT, consent, events,
handoff/redeem, admission, messages, uploads, rating, exports, transcript mail, offline form, reset),
agent chat work (accept, notes, socket commands, typing, receipts, collaborators, transfer, decline,
close), visitors, bans, history, analytics + CSV export, monitor, notifications, integration tokens
(used as `Bearer rdt_…`), webhooks (private / loopback / metadata hosts must be rejected with 422),
audit, privacy access requests, retention, tenant switch, logout. It validates with Ajv (JSON Schema
2020-12) in **strict mode** — every documented object rejects undeclared properties:

- every REST response body against the operation + status in `openapi.yaml` (success and error envelopes);
- every socket frame (`auth.ok`, `event`, `ephemeral`, `control`) and every acknowledgement
  (`subscription.ok`, `heartbeat`, `command.ack` per command type, `command.error`) against `asyncapi.yaml`;
- every `outbox_events` row of the test tenant against the per-audience payload schema and allowed scope kinds;
- the built `@talkivio/client` against the live API (camelCase data, paging, CSRF POST, `TalkivioError`).

## Coverage (2026-10-13, API build of 03:14)

| | |
| --- | --- |
| HTTP operations | **218** — 187 typed JSON, 21 no-content (204/302), **10 untyped media** marked `x-talkivio-untyped: true` (CSV exports, file/export bytes, widget frame HTML, Prometheus metrics, privacy export JSON) |
| Typed success contracts proven live | **184 / 188** (incl. `/health/ready`); ~280 responses validated per run, 23 of them error envelopes |
| Not exercised live | `POST /webhooks/{id}/test`, `POST /webhook-deliveries/{id}/retry` (would send traffic to a third-party host — the dev API refuses private webhook targets), `POST /integrations/connectors/{key}/health-check` and `POST /privacy/requests/{id}/resume` (only their documented 409s occur without provider credentials / a failed job); `GET /webhooks/{id}/deliveries` only returned an empty list |
| Durable event types | **36** (27 socket-delivered, 9 internal-only); 29 observed and validated per run (~300 frames, ~250 outbox rows). Not observed: `transfer.declined`, `transfer.expired`, `export.failed`, `privacy.erased`, durable `notification.created`, `invitation.dismissed`, `trigger.webhook` |
| Ephemeral types | **10**; all but `queue.wait_exceeded` observed |
| Socket commands | 7 agent + 8 visitor (required fields probed against the real handlers); live: all except agent `offer.accept` and visitor `invitation.ack` / `invitation.dismiss` |

## Known differences between code and spec (not reconciled here)

- `DELETE /auth/mfa` is `POST /api/v1/auth/mfa/disable`; `POST /tenants/current/deletion-requests` and `GET /jobs/{id}` are not implemented.
- `assignment.accepted` has no public scope; ch. 48 asks for a visitor `chat.started` projection (visitors get `chat.updated` + `participant.joined`).
- `message.redacted` and `queue.updated` (ch. 48) are never emitted; `message.delivered`, `typing.changed`, `availability.changed` are ephemeral with payloads that differ from ch. 48 (`actor`/`actor_type` instead of `actor_public_id`/`participant_id`; no `config_version`).
- Public `participant.joined` omits `joined_at`.
- `command.ack.result` is the full resource, not `{resource_id, seq?, version?}`; `auth.ok.capability_expiry` is always `null`; the visitor namespace has no `unsubscribe`, and its `subscribe` has no error acknowledgement; `unsubscribe` takes `{scopes}` (ch. 77: `{scope_ids}`); `presence.set` (ch. 77) is not registered.
- `/health/ready` returns `{data}` without `meta`.
