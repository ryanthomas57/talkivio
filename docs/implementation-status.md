# Talkivio — implementation status

_Last updated: 2026-10-13 (evening). Authority: `docs/master-prompt.txt`. Ledger: `docs/traceability.csv` (254 rows,
gate `scripts/ledger-check.mjs`). Sign-off: `docs/release-audit.md`._

> The working tree is not yet a git repository, so evidence below is recorded against the working tree, not
> commit SHAs. Release-audit rows stay `NOT ASSESSED` until evidence is reproduced at a commit.
>
> **Working copy.** On 2026-10-13 the external exFAT volume (`/Volumes/Khurram`) zeroed files written while the
> machine was short of memory — twice, the second time even after a full fsync. From 17:10 the work continued in an
> APFS copy at `~/Talkivio-APFS/Live Chat` (same tree, `node_modules` from the local pnpm store). Every change since
> is there; `~/Talkivio-APFS/sync-to-volume.sh` copies it back once the volume is repaired.

## Current phase
Release-audit hardening. Ledger: **234 verified · 10 partial · 6 not verified · 4 optional disabled** (254 rows, of
which 119 are component rows such as `FILE01.scan`, `ROUTE01.offer`, `AUTH01.logout`, each citing the exact
assertions that prove it). Everything still open needs something this machine does not have — see *Blocked*.

Closed in this phase (each with a test that failed first or a negative control):
- **Audit coverage (AUD-72-16):** a static gate (`apps/api/scripts/audit-coverage.mjs`) proves all 138 write
  routes audit or are exempt with a reason; `audit.e2e.mjs` drives every ch. 54 category straight through the API.
  Found and fixed: login failures, password change/reset, reset requests, MFA enable/recovery codes, session
  revocation and failed re-authentication were not audited; tag creation was not audited; two audit writes lacked
  the request id.
- **Bounded text (AUD-72-01):** 174 CHECK constraints (closed value sets, identifier shapes, length bounds) in
  migrations 25/26 (added `NOT VALID`, then validated); the drift gate fails on any unbounded text column; CHECK
  violations answer 422. Found and fixed: edge geo headers could produce a non-ISO country (breaking an existing
  CHECK) or throw on bad percent-encoding; OAuth avatar URLs were unbounded.
- **Slow consumers (WS04):** a stalled reader was never actually disconnected — engine.io's close waited for the
  stalled queue to drain, so the guard re-fired every second and the queue kept growing. Now discarded on close;
  the overload counter (never exported before) and outbound-queue gauges are exported.
- **Triggers (TRIG03):** a `visitor.page.changed` event processed after a later page view was evaluated on the later
  page. It now uses the page the event entered; cooldowns proven end to end.
- **Accessibility (A11Y04):** reduced motion and forced colors automated. Found and fixed: the widget kept
  transitions and pulsing animations under reduced motion; the selected tab was invisible in forced colors; tab
  panels hid their focus ring; date inputs lost the ring while their calendar button had focus.
- **Routing at scale (ROUTE01):** 100 concurrent requests, 10 agents × capacity 3, two API processes and two
  workers: 30 active / 70 queued, never above capacity, no double ownership.
- **History (HIST01), late events (AUD-72-08), measures (AUD-72-07), derived caches (AUD-72-12), offline mail retry
  (OFF01), malicious PDFs (SEC01), two-browser chat (CHAT01), shortcut insertion (SHORT01), log hygiene (AUD-72-11),
  failover/PITR drill (AUD-72-34):** see the ledger rows for the evidence.
- Billing and custom domains are recorded as **OPTIONAL DISABLED** (no module in this release); the docs no longer
  suggest that setting `STRIPE_*` enables anything.

## Verified on the integrated API (2026-10-13, all suites green on the same build)
| Suite | Checks | Scope |
| --- | --- | --- |
| `smoke-v2.mjs` | 40 | tenancy/RLS, auth + CSRF, widget session, sockets, accept race, seq + idempotent sends, notes privacy, close/rating, FTS |
| `protocol.e2e.mjs` | 23 | socket protocol: capability expiry, acks, presence, subscribe/unsubscribe, redaction |
| `receipts.e2e.mjs` | 53 | delivered vs read, typing expiry, note privacy, seq gaps, snapshot.required |
| `auth.e2e.mjs` | 89 | reset, sessions, MFA, single-use TOTP/recovery codes, brute-force caps, recent auth |
| `team.e2e.mjs` | 34 | roster presence, versions, re-scope, suspension, widget drafts |
| `routing.e2e.mjs` | 61 | capacity across departments, 30 concurrent requests, queue order, offers |
| `routing-scale.e2e.mjs` | 15 | 100 requests, 10 agents, two API processes + two workers (ROUTE01) |
| `transfers.e2e.mjs` | 93 | offers, declines, expiry, forced and department transfers, close races |
| `offline.e2e.mjs` | 81 | schedules (DST), emergency closures, offline submissions, queue → offline |
| `triggers.e2e.mjs` | 70 | DSL engine, invitations, effect dedupe, simulator parity, cooldowns |
| `shortcuts.e2e.mjs` | 42 | personal reply privacy, placeholders, CSV import/export |
| `analytics.e2e.mjs` | 90 | Fixture A, CSAT revisions, raw reconciliation, late/duplicate/out-of-order events, every measure's population/unit/null rule/n |
| `files.e2e.mjs` | 95 | upload lifecycle, magic bytes, malicious PDF, grants, exports, CSV injection (scan mode `dev_unscanned`) |
| `visitors.e2e.mjs` | 139 | live monitoring, consent, identity, bans, high-load mode |
| `contracts.e2e.mjs` | all hold | strict OpenAPI/AsyncAPI validation of REST responses, socket frames and outbox rows |
| `security.e2e.mjs` | 424 | IDOR, roles, CSRF, sessions, XSS/CSV/SQLi/SSRF, socket boundaries, headers |
| `roles.e2e.mjs` | 31 | permission matrix incl. in-handler checks |
| `faults.e2e.mjs` | 14 | injected serialization failures/deadlocks during accept |
| `tenant-deletion.e2e.mjs` | 77 | staged destruction, job status, crash recovery (`TENANT_DELETION_GRACE_SECONDS=15`) |
| `lifecycle.e2e.mjs` | 49 | key rotation, consent scope, notes, collaborators, ratings, reconnect grace, silent connections |
| `audit.e2e.mjs` | 235 | every ch. 54 audit category via the API, request-id correlation, secrets masked |
| `history.e2e.mjs` | 23 | 23/25-hour DST days, list + full-text, department scope, raw-row reconciliation |
| `backpressure.e2e.mjs` | 15 | stalled reader cut off once, others unaffected, queue released, lossless resume |
| `drain.e2e.mjs` | 11 | SIGTERM drain |
| `chaos.e2e.mjs` | 21 | SIGKILL api/worker, Redis restart and flush (isolated stack) |
| `smtp.e2e.mjs` | 12 | real SMTP: 451 retry, 550 final failure |
| `outage.e2e.mjs` | 45 | database, storage, scanner and SMTP outages: honest 503s, recovery, burn-rate alerts, offline mail retry |
| `tracing.e2e.mjs` | 11 | one trace api → outbox → worker → socket, no content in spans |
| `integrations.e2e.mjs` | 126 | tokens, webhooks, privacy, retention incl. derived caches, tombstone replay (isolated harness) |
| Unit tests | api 164 · dashboard 107 · widget 47 · contracts 55 | |

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
**165 passed, 0 failed** (2 opt-in scale tests skipped) against the production dashboard build, the live API and the widget demo; report: `docs/accessibility/accessibility-report.md`.
- Accessibility: axe WCAG 2.1 A/AA on 26 routes × light/dark + Arabic RTL (77 scans, 0 violations of any impact);
  reduced motion on 26 routes + the widget frame (no motion > 0.01 ms); forced colors: a focus outline at all 764 Tab
  stops of 26 routes and switch/checkbox/tab state still visible with system colours; keyboard-only agent and visitor
  journeys; live-region announcements (agent and visitor); 320–1440 px and 200 % zoom; Arabic sweeps.
- Product journeys: two-browser chat with Unicode/multiline text, delivery state, safe rendering and reload
  (`chat-roundtrip.spec.ts`); shortcut insertion and placeholder blocking (`shortcuts-composer.spec.ts`); widget SDK
  signatures, loader isolation and unapproved origins; every widget state; realtime ordering, duplicates, lost acks;
  outage retry; two-tab leadership; every link on the dashboard and public pages leads to a real page.

## Blocked (needs access or a person, named precisely)
- **Docker / Compose / staging:** DEPLOY01, DEPLOY02, AUD-72-29, AUD-72-32, AUD-72-33 — Docker is not installed and
  there is no staging environment.
- **Real ClamAV:** FILE01 / AUD-71-28 — verified with a protocol-faithful clamd stub; the CI job runs real ClamAV.
- **Screen reader session:** A11Y02 / AUD-72-23 — live regions are asserted automatically; a VoiceOver/NVDA
  walkthrough needs a person.
- **Reference scale:** PERF01 — budgets pass at laptop scale; 1 000 agents / 10 000 visitors needs staging hardware.
- **Previous release:** AUD-72-03 — migrations replay from empty; an upgrade from a previous release needs one.
- **GitHub / registry:** AUD-72-30 (CI never run on GitHub — no git yet), AUD-72-31 (provenance attestations need
  an image registry), AUD-72-28 (alert rules not evaluated by a running Prometheus — promtool not installed).

## Known gaps / decisions recorded
- Server-generated text that stays English: anonymous visitor labels, notification titles/bodies, attachment scan
  messages and field-level validation details (error codes are localized).
- IP bans apply at the next ticket/admission (visitor-id bans cut live sockets immediately).
- Legal holds are not modelled; merge requests have no approve/execute step; `APP_SECRET`-derived key rotation is not
  implemented (key-version columns exist).
- PDF export: Arabic is shaped but not bidi-reordered; emoji/CJK render as replacement glyphs.
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
