# Enabled features manifest

Master prompt ch. 01–03 (core vs optional scope) and ch. 72 ("enabled features manifest"). States are what this
build actually ships; "verified" refers to the evidence listed in `docs/implementation-status.md`.

## Core (always on)
| Module | State | Evidence |
| --- | --- | --- |
| Tenancy, RLS, roles/permissions | Enabled, verified | `smoke-v2.mjs`, manual RLS probe |
| Accounts: signup, verification, login, reset, MFA, sessions | Enabled; signup/verify/invite verified, MFA/reset implemented | `smoke-v2.mjs` |
| Sites, origins, widget config revisions, installation check | Enabled, verified | `smoke-v2.mjs`, browser onboarding run |
| Embeddable widget (loader + frame, SDK, i18n incl. Arabic/RTL) | Enabled; being re-wired to finished endpoints | widget unit tests 37/37, browser run |
| Chat engine: routing (manual/broadcast/assigned), offers, transfers, collaborators, notes, close, ratings | Enabled, verified | `smoke-v2.mjs`, browser run |
| Operating hours, holidays, emergency closures, offline forms, overflow | Enabled, verified | `offline.e2e.mjs` |
| Visitors: live monitoring, profiles, custom fields, bans, identity, consent, handoff | Enabled, verified | `visitors.e2e.mjs` |
| Triggers DSL v1, proactive invitations, canned replies | Enabled, verified | `triggers.e2e.mjs`, `shortcuts.e2e.mjs` |
| Files (upload, scan, download grants), transcript exports/email | Enabled; verified with `SCAN_MODE=dev_unscanned` locally, ClamAV in Compose/CI | `files.e2e.mjs` |
| Analytics, monitor, in-app notifications | Enabled, verified | `analytics.e2e.mjs` |
| Integration tokens, webhooks, audit log, privacy access/erasure/retention | Enabled, verified (isolated harness) | `integrations.e2e.mjs` |
| Metrics + health endpoints | Enabled (`/health/live`, `/health/ready`, `/health/metrics`; worker on `WORKER_HEALTH_PORT`) | — |

## Optional (disabled in this build)
| Module | State | What is needed to enable |
| --- | --- | --- |
| Billing (hosted checkout, portal, webhooks) | Not included in this release — no billing endpoints or provider adapter (the `billing_accounts`/`billing_events` tables are reserved, and the `STRIPE_*` variables are read by nothing); the agent-seat limit is read from `tenants.settings.entitlements.agentSeats` (default 10) | Payment provider account + webhook secret (ch. 57) |
| SAML / OIDC single sign-on | Disabled | Identity provider metadata per tenant (optional extension, ch. 01/07) |
| Google / GitHub OAuth sign-in | Disabled unless `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are set (`GET /api/v1/auth/providers` lists what is enabled) | OAuth app credentials |
| White-label branding beyond widget config, custom domains | Not included in this release — every tenant is served on the default domain | DNS + TLS automation, brand assets (ch. 58) |
| CRM / ticketing / email connectors | Catalog shows "disabled (no credentials)"; contract-tested against an in-process mock only | Provider credentials (ch. 56) |
| Legal holds | Not modelled | Data model + UI (ch. 53) |

No optional module is presented as working without its credentials.
