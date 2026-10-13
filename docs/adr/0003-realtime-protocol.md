# ADR 0003 — Realtime protocol on Socket.IO

Status: accepted · 2026-10-12

* Path `/realtime/v1`; namespaces `/agent` and `/visitor`.
* Authentication: client mints a single-use ticket (`POST /api/v1/socket-ticket` or
  `POST /widget/v1/socket-ticket`, 30 s TTL, stored hashed in Redis) and sends it as `auth.ticket` in the
  Socket.IO CONNECT frame — the first frame — never in the URL. The gateway validates the browser `Origin`
  (dashboard origins for agents, the site's approved origins for visitors) before accepting.
* Server frames use the envelope from chapter 47:
  `{v, event_id, type, tenant_id, scope:{kind,id}, cursor, occurred_at, aggregate_version, causation_id, payload}`
  emitted on the Socket.IO event name `event`; ephemeral frames use event name `ephemeral` with `expires_at`
  and no cursor.
* Client commands use event name `command` with `{v, command_id, type, scope, expected_version?, payload}` and a
  Socket.IO acknowledgement carrying `command.ack` / `command.error` bodies. Command handlers call the same
  services as REST controllers.
* `subscribe {scopes, last_cursor?}` replays durable events after the cursor from `outbox_events`
  (24 h retention); an expired cursor yields `snapshot.required`.
* Cursor = opaque base64url of the outbox sequence id. Delivery is at least once; clients deduplicate by
  `event_id` and ignore stale `aggregate_version`.
* Scope kinds: `chat`, `queue`, `visitor`, `config` (spec) plus `agent` (personal offers/notifications) and
  `team` (presence) — documented extensions.
