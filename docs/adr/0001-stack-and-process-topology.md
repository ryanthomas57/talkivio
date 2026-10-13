# ADR 0001 — Stack and process topology

Status: accepted · 2026-10-12

## Context
The master prompt (`docs/master-prompt.txt`, chapter 03) names a reference stack (React + Vite dashboard,
Fastify REST/WS gateway, separate `apps/gateway` and `apps/worker`) and allows an alternative stack with a
recorded equivalent design and complete contract coverage. The first product brief named Next.js + NestJS,
and a working NestJS API, Socket.IO realtime layer, BullMQ worker and Prisma schema already existed when the
Talkivio specification arrived.

## Decision
| Spec component | Talkivio implementation | Equivalence notes |
|---|---|---|
| apps/dashboard (React + Vite) | `apps/dashboard` — React 19 on Next.js 15 (App Router, client-rendered workspace) | Same React component model; Next only adds routing/bundling. Static-exportable; no server components hold secrets. |
| apps/widget + loader | `apps/widget` — Preact iframe app + dependency-free loader (Vite builds) | Preact is React-compatible and keeps the widget bundle small (budget ch. 60). |
| apps/api (Fastify) | `apps/api` — NestJS 11 on Express, process role `api` | Nest modules give centralized guards/pipes; Express adapter chosen for ecosystem maturity. |
| apps/gateway | Process role `gateway` built from `apps/api` (`dist/gateway.js`), Socket.IO transport at `/realtime/v1` | Independently deployable/scalable entrypoint; shares contracts and command services so socket commands reuse REST business logic (ch. 77). |
| apps/worker | Process role `worker` (`dist/worker.js`) — outbox publisher, BullMQ jobs, schedulers | Independently scalable; durable state lives in PostgreSQL. |
| packages/contracts | `packages/contracts` (zod schemas, enums, DTOs, protocol) | Runtime validators shared by API, dashboard and widget. |
| packages/routing, packages/triggers | Pure modules inside `packages/contracts/src/logic` (`routing.ts`, `dsl.ts`, `hours.ts`, `shortcuts.ts`), exported from `@talkivio/contracts` | One package keeps the dependency graph flat; API, worker and the trigger simulator import the same interpreter, so simulation and production cannot diverge. |
| packages/ui | Tokens in `apps/dashboard/src/app/globals.css` + primitives in `apps/dashboard/src/components/ui` (stories at `/design-system`); the widget mirrors the ch. 05 palette in its own CSS | The widget renders in an isolated iframe with its own small stylesheet, so a shared runtime UI package would only add bundle weight. |
| PostgreSQL + RLS | PostgreSQL 16+, Prisma client, hand-written SQL migrations with RLS policies | Prisma cannot express optional composite FKs or RLS, so migrations are authored as SQL (ADR 0002). |
| Durable outbox + worker queues | `outbox_events` table + leased publisher; BullMQ (Redis) for scheduled/retry work, with durable `jobs` rows for exports/privacy | Redis loss never loses messages, offers or trigger effects (they are in PostgreSQL). |
| Raw WebSocket envelope (ch. 47) | Socket.IO frames carrying the specified envelope | Socket.IO adds reconnection/ack plumbing; the auth ticket is sent in the CONNECT frame (first frame, never the URL). ADR 0003. |

## Consequences
* One TypeScript codebase per app, three deployable process roles for the backend.
* All business commands are implemented once in services and invoked by REST controllers and socket command handlers.
