# Talkivio: implementation status

_Last updated: 2026-10-14. Authority: `docs/master-prompt.txt`. Ledger: `docs/traceability.csv` (259 rows, gate
`scripts/ledger-check.mjs`). Sign-off: `docs/release-audit.md`. Code: https://github.com/ryanthomas57/talkivio (main);
every push runs the full CI pipeline in `.github/workflows/ci.yml`._

> **Working copy.** The live tree is `~/Talkivio-APFS/Live Chat` (APFS). The external exFAT volume zeroed files
> written under memory pressure on 2026-10-13; `~/Talkivio-APFS/sync-to-volume.sh` copies the tree back once it is
> repaired.

## Current phase

Go-live readiness. The product is feature complete for this release; what remains before real customers is the
production server itself (see _Go-live inputs_).

Added on 2026-10-14 (each with tests that run in CI):

- **Zendesk-style chat dock.** Chat windows along the bottom edge on every page (minimize, open in Inbox, close;
  they survive navigation and reloads). Clicking a visitor on the Visitors list opens their chat there.
- **Agents start chats with browsing visitors** (`POST /api/v1/visitors/:id/chats`). The chat starts active and owned
  by the agent; the visitor's widget picks it up live and opens on the agent's message. Idempotent, one open chat
  per visitor, refuses offline or unconsented visitors, full capacity and other workspaces; audited
  (`engage.e2e.mjs`, 21 checks; `dock.spec.ts` DOCK01).
- **Chat requests pop up with Accept on any page** (queued chats in broadcast/manual departments, plus assigned
  offers); Accept opens a docked window (`dock.spec.ts` DOCK02).
- **Visitors list simplified:** visitor with flag, IP address and network owner (DB-IP ASN Lite), page, time on site,
  visits, chat; advanced filters behind one button. IPs are shown while "Show visitor IP addresses" is on (on by
  default since 2026-10-15), are erased with the visitor and on consent withdrawal, and appear in access exports.
- **Visible visitors by default (2026-10-15):** new workspaces do not require analytics consent, so every visitor is
  listed the moment they open a page with the widget; "Require analytics consent" turns consent mode on per workspace.
- **Live visitor list fixes:** bursts of updates are no longer dropped (Socket.IO volatile frames replaced by a
  congestion room), visitors appear the moment they land, country/region/city from DB-IP City Lite, consent upgrade
  for workspaces that do not require consent.
- **No em dashes in user-facing text** (dashboard EN/AR, widget, emails, transcripts, starter content, demo shop).
- **Public website** at `/`: one-page home (hero, real product screenshots from `apps/dashboard/scripts/site-shots.mjs`,
  how it works, features, security, pricing from the shared plan catalog, FAQ), Terms of Use, Privacy Policy and Refund
  Policy for Desverso LLC, all in the axe/motion/links sweeps.
- **Light and dark mode** switchable from the top right of the dashboard, the sign-in pages and the website; the choice
  is saved to the member's preferences and applied before the first paint.
- **Subscriptions on Converge** (off until configured, `docs/operations/billing.md`): Starter/Team/Business per agent,
  monthly or yearly; 14-day trial with a card and the exact renewal wording kept as evidence; reminder 7 days before;
  automatic first charge and renewals; prorated upgrades, downgrades at renewal; retries, 7-day grace, suspension;
  cancel/resume online; receipts; plan limits enforced by the API (`billing.e2e.mjs`, 68 checks;
  `converge.gateway.spec.ts`).
- **Deployment:** `deploy/` bundle (Compose, Caddy with automatic HTTPS, env checks, deploy/rollback, backup,
  off-server object backup, restore, GeoIP job), images published to GHCR with signed SLSA provenance and SBOM
  attestations that `deploy.sh` verifies before running.

## Verified on the integrated API (all suites green on the same build; rerun by CI on every push)

| Suite                     | Checks                                             | Scope                                                                                                                          |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `smoke-v2.mjs`            | 40                                                 | tenancy/RLS, auth + CSRF, widget session, sockets, accept race, seq + idempotent sends, notes privacy, close/rating, FTS       |
| `protocol.e2e.mjs`        | 23                                                 | socket protocol: capability expiry, acks, presence, subscribe/unsubscribe, redaction                                           |
| `receipts.e2e.mjs`        | 53                                                 | delivered vs read, typing expiry, note privacy, seq gaps, snapshot.required                                                    |
| `auth.e2e.mjs`            | 89                                                 | reset, sessions, MFA, single-use TOTP/recovery codes, brute-force caps, recent auth                                            |
| `team.e2e.mjs`            | 34                                                 | roster presence, versions, re-scope, suspension, widget drafts                                                                 |
| `routing.e2e.mjs`         | 61                                                 | capacity across departments, 30 concurrent requests, queue order, offers                                                       |
| `routing-scale.e2e.mjs`   | 15                                                 | 100 requests, 10 agents, two API processes + two workers (ROUTE01)                                                             |
| `transfers.e2e.mjs`       | 93                                                 | offers, declines, expiry, forced and department transfers, close races                                                         |
| `offline.e2e.mjs`         | 81                                                 | schedules (DST), emergency closures, offline submissions, queue → offline                                                      |
| `triggers.e2e.mjs`        | 70                                                 | DSL engine, invitations, effect dedupe, simulator parity, cooldowns                                                            |
| `shortcuts.e2e.mjs`       | 42                                                 | personal reply privacy, placeholders, CSV import/export                                                                        |
| `analytics.e2e.mjs`       | 90                                                 | Fixture A, CSAT revisions, raw reconciliation, late/duplicate/out-of-order events, every measure's population/unit/null rule/n |
| `files.e2e.mjs`           | 96                                                 | upload lifecycle, magic bytes, malicious PDF, grants, exports, CSV injection; local and S3 (MinIO) storage, real ClamAV in CI  |
| `visitors.e2e.mjs`        | 143                                                | live monitoring, consent, identity, bans, high-load mode                                                                       |
| `engage.e2e.mjs`          | 21                                                 | agent-started chats: ownership, visitor tab notified, idempotency, refusals, audit                                             |
| `contracts.e2e.mjs`       | all hold                                           | strict OpenAPI/AsyncAPI validation of REST responses, socket frames and outbox rows                                            |
| `security.e2e.mjs`        | 424                                                | IDOR, roles, CSRF, sessions, XSS/CSV/SQLi/SSRF, socket boundaries, headers                                                     |
| `roles.e2e.mjs`           | 31                                                 | permission matrix incl. in-handler checks                                                                                      |
| `faults.e2e.mjs`          | 14                                                 | injected serialization failures/deadlocks during accept                                                                        |
| `tenant-deletion.e2e.mjs` | 77                                                 | staged destruction, job status, crash recovery (`TENANT_DELETION_GRACE_SECONDS=15`)                                            |
| `lifecycle.e2e.mjs`       | 49                                                 | key rotation, consent scope, notes, collaborators, ratings, reconnect grace, silent connections                                |
| `audit.e2e.mjs`           | 235                                                | every ch. 54 audit category via the API, request-id correlation, secrets masked                                                |
| `history.e2e.mjs`         | 23                                                 | 23/25-hour DST days, list + full-text, department scope, raw-row reconciliation                                                |
| `backpressure.e2e.mjs`    | 15                                                 | stalled reader cut off once, others unaffected, queue released, lossless resume                                                |
| `drain.e2e.mjs`           | 11                                                 | SIGTERM drain                                                                                                                  |
| `chaos.e2e.mjs`           | 21                                                 | SIGKILL api/worker, Redis restart and flush (isolated stack)                                                                   |
| `smtp.e2e.mjs`            | 12                                                 | real SMTP: 451 retry, 550 final failure                                                                                        |
| `outage.e2e.mjs`          | 45                                                 | database, storage, scanner and SMTP outages: honest 503s, recovery, burn-rate alerts, offline mail retry                       |
| `tracing.e2e.mjs`         | 11                                                 | one trace api → outbox → worker → socket, no content in spans                                                                  |
| `integrations.e2e.mjs`    | 126                                                | tokens, webhooks, privacy, retention incl. derived caches, tombstone replay (isolated harness)                                 |
| Unit tests                | api 164 · dashboard 107 · widget 47 · contracts 55 |                                                                                                                                |

Release gates (wired into `.github/workflows/ci.yml`):

- `pnpm db:drift` — 26 migrations from empty (63 tables, 54 forced-RLS, 54 policies, 124 FKs, 0 unbounded text
  columns); dev DB identical incl. 219 CHECK constraints, policies, functions and grants.
- `apps/api/scripts/audit-coverage.mjs` — every write route audits or is exempt with a reason.
- `scripts/ledger-check.mjs` — every cited file exists and every quoted assertion is still in its test.
- `apps/api/scripts/log-scan.mjs` — log hygiene (≈20k lines today, ≈40k earlier).
- Contracts regenerate without drift (OpenAPI, AsyncAPI, `@talkivio/client`).
- Dashboard: typecheck, dead controls (550), unhandled writes (147), i18n scan (0); widget loader globals.

Drills: `docs/operations/backup-drill-report.md` (logical backup → restore, RTO 17 s) and
`docs/operations/failover-drill-report.md` (standby promotion ~0.3–0.6 s with 0 lost writes; PITR exact to a
restore point; RPO ≈ 1.3 s to the end of the WAL archive).

## Verified in a browser (Playwright, production build)

**167 passed, 0 failed** (2 opt-in scale tests skipped; includes the chat dock, `dock.spec.ts`) against the production dashboard build, the live API and the widget demo; report: `docs/accessibility/accessibility-report.md`.

- Accessibility: axe WCAG 2.1 A/AA on 26 routes × light/dark + Arabic RTL (77 scans, 0 violations of any impact);
  reduced motion on 26 routes + the widget frame (no motion > 0.01 ms); forced colors: a focus outline at all 764 Tab
  stops of 26 routes and switch/checkbox/tab state still visible with system colours; keyboard-only agent and visitor
  journeys; live-region announcements (agent and visitor); 320–1440 px and 200 % zoom; Arabic sweeps.
- Product journeys: two-browser chat with Unicode/multiline text, delivery state, safe rendering and reload
  (`chat-roundtrip.spec.ts`); shortcut insertion and placeholder blocking (`shortcuts-composer.spec.ts`); widget SDK
  signatures, loader isolation and unapproved origins; every widget state; realtime ordering, duplicates, lost acks;
  outage retry; two-tab leadership; every link on the dashboard and public pages leads to a real page.

## Go-live inputs (only the owner can provide these)

- **A server:** Ubuntu 24.04 with Docker, 8 GB RAM, 2+ vCPU, 80 GB disk (`deploy/README.md`, section 1).
- **A domain:** DNS records for `chat.<your domain>` and `files.chat.<your domain>` pointing at the server.
- **SMTP:** any provider with the sending domain verified (SPF, DKIM, DMARC); sign-up, invitations and password
  resets depend on it.
- **An off-server backup bucket:** any S3-compatible bucket at another provider, with a key limited to it.
- **Converge (Elavon) merchant account** with tokenization and recurring payments enabled, an API user and PIN, the
  server IP and dashboard domain allow-listed; test on a Converge demo account first (`docs/operations/billing.md`).
- **Mailboxes** support@, billing@, privacy@ and legal@talkivio.com (quoted on the website and in the legal pages from
  `apps/dashboard/src/components/site/site-config.ts`). The legal pages were approved by counsel on 2026-10-15.

## Descoped by the owner

- Screen reader walkthrough (A11Y02 / AUD-72-23): the automated live-region contract stays as the evidence.
- Reference-scale load test (PERF01): budgets pass at laptop scale.

## Known gaps / decisions recorded

- Server-generated text that stays English: anonymous visitor labels, notification titles/bodies, attachment scan
  messages and field-level validation details (error codes are localized).
- IP bans apply at the next ticket/admission (visitor-id bans cut live sockets immediately).
- Legal holds are not modelled; merge requests have no approve/execute step; `APP_SECRET`-derived key rotation is not
  implemented (key-version columns exist).
- PDF export: Arabic is shaped but not bidi-reordered; emoji/CJK render as replacement glyphs.
- Billing: the Converge request fields are proven against the test gateway only; confirm them on a Converge demo
  account before switching `BILLING_PROVIDER=converge`. A charge with an unknown outcome waits for a manual review.
- Tech debt: `packages/contracts/src/enums.ts` holds early enumerations (e.g. roles OWNER/ADMIN/AGENT) used only by
  the legacy DTO layer; the live wire contracts are the OpenAPI/AsyncAPI documents and the database CHECKs.

## How to resume

1. Work in `~/Talkivio-APFS/Live Chat` (or in the volume copy once synced and verified). `pnpm install --offline`.
2. Postgres (service) + `redis-server --port 6379 --save "" --appendonly no`.
3. `cd apps/api && npx nest build`, then with the repo `.env` sourced: `node dist/main.js` and `node dist/worker.js`
   (add `TENANT_DELETION_GRACE_SECONDS=15` for the tenant-deletion suite).
4. `pnpm db:drift`; `~/Talkivio-APFS/regress.sh` runs every API suite; dashboard: `next build` (with
   `ENABLE_DESIGN_SYSTEM=1`, without `NODE_ENV` from `.env`) + `next start -p 3000`, widget demo on :5173,
   `npx playwright test`, then `node scripts/a11y-report.mjs`.
