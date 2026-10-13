# Privacy inventory, retention and erasure procedures

Master prompt ch. 53. Code: `apps/api/src/features/privacy/*` (erasure `erasure.service.ts`, retention
`retention.service.ts`, tombstones `tombstones.service.ts`, access export `access-export.service.ts`), replay
script `apps/api/scripts/replay-tombstones.mjs`. Evidence: `apps/api/test/integrations.e2e.mjs` (canary erasure
across PostgreSQL, search, exports, object storage and Redis; tombstone replay after `pg_restore`).

## Personal data inventory

| Category | Where | Protection | Default retention | On subject erasure |
| --- | --- | --- | --- | --- |
| Visitor contact (name, email, phone) | `visitors` (`email_ciphertext`, `email_lookup_hash`, `phone_ciphertext`, `name`) | AES-GCM at rest for email/phone; email lookup is a keyed HMAC (`emailLookupHash`) | Life of the workspace | Fields cleared, `erased_at` set, label "Erased visitor" |
| Verified identity | `visitor_identities` (subject hash), `identity_handoffs` | Subject stored as hash; handoff nonces hashed, single use, 60 s | Until reset/erasure | Rows deleted; an erased subject is never re-bound on next login |
| Anonymous credential | `visitor_credentials` (token hash) | Only SHA-256 of the token stored; capability revocation list in Redis | 180 days | Deleted; open sessions revoked |
| Sessions & browsing | `visitor_sessions`, `page_events` (sanitized URL, referrer origin, dwell) | Query strings stripped unless allowlisted; no DOM, keystrokes or form values | `tracking.pageEventRetentionDays` (default 30) | Page events deleted; session URLs/user agent cleared |
| Consent | `consent_records` | Versioned records | Life of the workspace | Personal links (visitor/session) removed; aggregate record kept |
| Chat transcripts | `messages` (body, options), `chats` (preview, page URL), `chat_ratings` (comment) | RLS by tenant; card numbers masked (first 6 / last 4) before storage | `tenants.retention_days` for closed chats | Subject's bodies redacted (`redacted_at`, sequence kept); previews/page URL cleared; rating comments removed |
| Attachments | object store (quarantine/clean prefixes), `attachments` | Private buckets, 60 s signed grants, malware scan before availability | With the chat | Objects deleted via `FilesService.eraseChatAttachments`, rows removed |
| Exports | object store `exports/`, `exports` | Private, sha256, 24 h expiry | 24 h | Artifacts invalidated via `ExportsService.invalidateFor` |
| Offline submissions | `offline_submissions` (email ciphertext, phone in encrypted fields, message) | Encrypted email; phone shown only to staff | Life of the workspace | Personal fields cleared |
| Outbound email | `outbound_emails` (recipient, rendered bodies) | Dedupe keys; console bodies printed only outside production | Operational | Pending rows cancelled; rendered bodies of the subject scrubbed |
| Events & side effects | `outbox_events`, `webhook_deliveries`, `jobs`, `notifications`, `command_idempotency` | Webhook payloads carry ids only (no transcript text) | Outbox 24 h; webhook deliveries per retention job | Payloads replaced with `{erased: true}` |
| Caches | Redis (presence, rate limits, monitor/analytics caches) | Short TTLs | Minutes–hours | Subject keys deleted |
| Staff accounts | `users`, `memberships`, `auth_sessions`, `trusted_devices` | Argon2id passwords; session/CSRF/reset tokens hashed; TOTP secret encrypted | Life of the account | Out of scope for visitor erasure (staff lifecycle via membership removal) |
| Audit log | `audit_events` | Append-only for the app role; safe diffs never contain bodies or personal values | Life of the workspace | Not modified (holds no personal values) |
| Network data | IP hashes (`ip_hash`, ban `ip_match_hash`) | Keyed hashes; raw IP only if `tracking.retainIp` | Per setting | Hashes on the subject's sessions cleared |

Legal holds are **not modelled**; every erasure/retention report states this. Integration tokens and webhook secrets
are hashed or encrypted and are not personal data.

## Access request (export of the subject's data)
1. Staff with `privacy.manage` creates `POST /api/v1/privacy/requests {kind:"access", visitor_id, proof_reference}` →
   `pending_verification`.
2. A second step verifies identity proof: `POST …/{id}/verify {method}` → `queued` → worker job.
3. The job exports identities, sessions, chats (public messages and the subject's own data; staff notes excluded),
   ratings, custom fields and consent records as JSON, stored privately with expiry; download via
   `GET …/{id}/export`.

## Erasure procedure
1. Create `{kind:"erase"}` and verify as above. The job runs steps in order: lockout (revoke credentials/sessions) →
   attachments → messages → chats → page events → sessions → consent → links → offline → exports → idempotency →
   outbox → webhooks → jobs → notifications → emails → caches.
2. Each store reports a confirmation; the request is `completed` only when every store confirmed — a failed step
   leaves it `failed` with counts and can be resumed (`POST …/{id}/resume`).
3. A pseudonymous tombstone (keyed hash, no personal values) is appended to `subject_tombstones`; the
   `privacy.erased` webhook event (ids only) is emitted.
4. Another visitor in the same chat is never erased; their messages remain.

## Backup restore
After restoring any backup older than the latest erasure, run
`node apps/api/scripts/replay-tombstones.mjs` against the restored database **before** opening it to traffic. The
script is idempotent and re-applies every recorded erasure (verified against a `pg_restore`d pre-erasure dump in
`integrations.e2e.mjs`).

## Retention
`GET /api/v1/privacy/retention/preview` reports what the next run would remove; the maintenance job (and
`POST /api/v1/privacy/retention/run`) applies `tenants.retention_days` to closed chats/messages/attachments and
`tracking.pageEventRetentionDays` to page events in bounded batches.

## Workspace deletion
Owners can schedule destruction of a whole workspace (`POST /tenants/current/deletion-requests`, cancellation window,
transcript archive for the owner, staged destruction of rows, objects, Redis keys and jobs, a tombstone without
personal data). Retained data and the operator procedure: [`docs/operations/tenant-deletion.md`](../operations/tenant-deletion.md).
