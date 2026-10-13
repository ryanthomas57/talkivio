# Tenant deletion and job status

Spec: ch. 41 `POST /tenants/current/deletion-requests`, ch. 45 `GET /jobs/{id}`, ch. 34 ("tenant cascade through
owned data only in approved destruction job"), ch. 53/54. Code: `apps/api/src/features/tenant-deletion/`,
`apps/api/src/features/jobs/`. End-to-end test: `apps/api/test/tenant-deletion.e2e.mjs`.

## Endpoints

| Route | Authority | Result |
| --- | --- | --- |
| `POST /api/v1/tenants/current/deletion-requests` `{confirm_slug}` | owner + recent auth (15 min) | 202 request (`state: scheduled`) |
| `GET /api/v1/tenants/current/deletion-requests` | any member | the scheduled (or failed) request, or `data: null` |
| `DELETE /api/v1/tenants/current/deletion-requests/{id}` | owner + recent auth | 200 request (`state: cancelled`) |
| `GET /api/v1/jobs/{id}` | the job's requester, or an admin/owner | 200 job status |

- `confirm_slug` must equal the workspace slug exactly; otherwise 422 `VALIDATION_FAILED` with a `confirm_slug` field error.
- **Duplicates: 409.** While a request is scheduled, another `POST` returns 409 `CONFLICT` with
  `details.request_id` and `details.destroy_after`; it never resets the window. Retries are made safe with
  `Idempotency-Key` (same key + same body replays the original 202 for 24 h). One active request per tenant is
  enforced by `jobs` `UNIQUE(tenant_id, kind, dedupe_key)` with `kind = tenant_deletion`, `dedupe_key = active`;
  cancelling renames the key to `cancelled:<id>`, so the owner can request again later.
- **Cancellation** is accepted while the request is still `scheduled`: guaranteed until `cancel_before`
  (= `destroy_after`) and afterwards until the worker claims the job. Once destruction has started the request is
  `running` and `DELETE` returns 409. Cancelling an already-cancelled request returns it again (200). Cancel and the
  worker's claim lock the same `tenants` row, so they cannot interleave.
- The `GET` banner shows the request to every member; the `export` block is only filled for owners and admins.
- Owners and admins get an email when a request is scheduled and when it is cancelled (`tenant_deletion_scheduled`,
  `tenant_deletion_cancelled` in `core/mail.service.ts`). No email is sent when destruction completes (there is no
  workspace left to send from; the owner was told the date).
- Audit: `tenant.deletion_requested` and `tenant.deletion_cancelled` are written to `audit_events`. The workspace's
  audit trail is tenant-owned and is destroyed with it, so **`tenant.deleted` is recorded in the
  `tenant_tombstones` row** and as a structured worker log line `audit tenant.deleted {...}` (counts only).

## Cancellation window

`TENANT_DELETION_GRACE_DAYS` (integer 1–30, default 14) sets the window. `TENANT_DELETION_GRACE_SECONDS` is a
test-only override (end-to-end tests use ~15 s); it is ignored and refused at start-up when `NODE_ENV=production`
(`productionRefusals` in `config/env.ts`). During the window the workspace keeps working normally.

## Transcript archive (export)

At request time an export is created through the existing export machinery (`ExportsService.createWorkspaceArchive`,
`jobs` kind `export`, rendered by the export worker, downloaded with `GET /api/v1/exports/{id}/download` →
60-second grant). What it is — and is not — is stated in the response (`export.contents`, `export.excludes`,
`export.chat_limit`, `export.truncated`):

- **Contents:** JSON transcripts (`talkivio.transcript` v1) of the **newest 5 000 chats** (the owner's bulk export
  ceiling): public messages, internal notes, system events, participants, rating, attachment names and sizes.
  `truncated: true` and `total_chats` tell the owner when older chats are not included.
- **Not included:** attachment file contents, visitor profiles/sessions/page history, offline messages, analytics,
  settings/sites/departments/triggers/shortcuts, team members and the audit log. This is not a full workspace backup.
- Only the requesting owner can download it (normal export rules: re-authorised grant, scope re-check). Like every
  export it stops being downloadable if any included chat is later removed by retention (403) or erased by a
  privacy request (410); the owner can cancel and request again to get a fresh archive.
- The artifact is kept until `destroy_after` instead of the usual 24 h, and is destroyed with the workspace.
  Cancelling the request does not delete it early; it expires at the original `destroy_after`.
- Rendering is in memory (existing renderer); very large workspaces are bounded by the 5 000-chat cap.

## Destruction (worker)

`TenantDestroyer` runs from a delayed BullMQ timer (`tenant-deletion.run` at `run_after`); the maintenance job
`tenant-deletion-sweep` (every 60 s) re-schedules due requests whose timer was lost and resumes crashed runs.
Steps, each idempotent:

1. **Claim** (one transaction, tenant row locked): job `queued → running` with a 15-minute lease, tenant
   `status = deleting` (API, widget site key and integration tokens stop working immediately; `rd_active_tenants()`
   excludes it from maintenance), and a `tenant_tombstones` row is opened. The tombstone is the index used to
   resume a disabled tenant.
2. **Inventory:** row counts of every `tenant_id` table, recorded once on the tombstone.
3. **Access:** sessions whose active workspace is this tenant are revoked; `RealtimeService.revokeTenant` closes
   all agent and visitor sockets (`access.revoked`, `tenant_unavailable`). Users with other workspaces sign in again.
4. **Queued work:** pending BullMQ jobs whose data carries the tenant id (`events`, `timers`, `webhooks`, `scans`,
   `jobs`, `exports`) and queued emails of the tenant are removed. Jobs already active finish against a disabled
   tenant / missing rows and are no-ops.
5. **Object storage:** every object under `t/<tenant>/` in `quarantine`, `clean` and `exports`, and privacy access
   exports under `privacy/<tenant>/`, is deleted and the prefix is re-listed to confirm it is empty.
6. **Redis:** every key containing the tenant id (presence `pa:*`/`pv:*`, live monitor `vm:*`, availability
   fingerprints, rate-limit counters) except BullMQ internals, and the tenant's entry in the registry sets
   `pa:tenants`, `pv:tenants`, `vm:dirty:tenants`, `vm:sig:tenants`.
7. **High-volume tables** (messages, page events, outbox, trigger runs, webhook deliveries, chats, sessions,
   visitors, …) are deleted in batches of 2 000 rows, one short transaction each. A table referenced by a
   `RESTRICT` FK (today departments, schedules, sites, tags) is never batched — deleting it in its own transaction
   before its referencing rows would fail — so it is left to the cascade.
8. **Final transaction:** tables that carry `tenant_id` **without** a cascading FK (found from the catalog; today
   `outbound_emails`, `auth_tokens`, `billing_events`) are deleted explicitly, and `auth_sessions.active_tenant_id`
   is cleared. Then `DELETE FROM tenants` removes everything else through the `ON DELETE CASCADE` tenant FKs
   (including `audit_events`, which the application role cannot delete directly). The `RESTRICT` FKs between
   tenant tables (chats/sites → departments, departments/sites → schedules, chat/visitor tags → tags, …) do not
   block it: every tenant-owned table has its own cascading tenant FK, so all of them are emptied before the
   `RESTRICT` checks run. This was verified against the migrated schema with every `RESTRICT` relation populated.
   The transaction re-counts every `tenant_id` table and only commits when all are zero, together with
   `tenant_tombstones.deleted_at`. The deletion job row itself goes with the tenant.
9. **Finalize:** a second queue, object and Redis pass (catches work queued by in-flight requests during the run),
   then `completed_at` on the tombstone.

Failures retry with backoff (30 s doubling, max 30 min, 6 attempts) while the tenant stays disabled; a destruction
that started is never silently abandoned. After the last attempt the job is `failed` with `last_error_code`
(`object_storage`, `rows_remaining` or `worker_error`) and the worker logs an error. Operator procedure: fix the
cause, then `UPDATE jobs SET state = 'queued', run_after = now(), attempts = 0 WHERE id = '<deletion_job_id>'`
(the id is on the tombstone); the sweep resumes it.

### What is retained, and why

- **User accounts** (`users`, their sessions in other workspaces, OAuth links, trusted devices). Users are global
  identities (ch. 35: "User is global, tenant access only through membership"); only memberships are removed. The
  spec's privacy chapter does not require deleting accounts left without a membership, and doing so would remove a
  person's sign-in (and their ability to accept future invitations or create a workspace) without their request.
  Account deletion is a separate, user-initiated action. The tombstone counts the member users kept
  (`rows.memberships`).
- **Tombstone** `tenant_tombstones`: tenant id, HMAC of the slug (keyed with `APP_SECRET`), deletion job id,
  started/deleted/completed timestamps and counts (`rows` per table at start, `objects_deleted`,
  `redis_keys_deleted`, `queued_jobs_removed`, `sessions_revoked`). No names, emails, user ids or content. Not
  tenant-owned (no tenant FK, no RLS); the application role cannot `DELETE` or `TRUNCATE` it.
- **Privacy erasure ledger** objects (`exports` area, `privacy-ledger/<tenant>/…`, pseudonymous HMAC hashes only),
  so subject erasures can still be replayed if an older backup containing the tenant is restored.

### Known limits

- Restoring a database backup taken before the deletion resurrects the workspace: `tenant_tombstones` lives in the
  database, and `scripts/replay-tombstones.mjs` replays subject erasures, not tenant deletions. Operators must
  re-run deletion for tombstoned tenant ids after a restore.
- No billing-provider call (subscription cancellation) is made; the billing module is disabled in this release.
- Trigger once-per-session markers `rd:trg:ss:<session>` are keyed by session, not tenant, and expire within 24 h.
- Connected integrations/webhook targets are not notified of the deletion.

## `GET /jobs/{id}`

Returns `{id, kind, state, progress, attempts, run_after, completed_at, created_at, last_error_code}` — never
`payload` or `result`. Allowed for the job's requester or an admin/owner (`tenant.manage`). `requested_by` holds a
membership id for most kinds and a user id for some (`visitor_merge`, privacy requests); either identity of the
caller matches. Unknown ids, other tenants' jobs and other members' jobs all return 404, so existence does not leak.
Integration tokens cannot call it.
