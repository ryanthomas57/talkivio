# Talkivio backend conventions (read before adding a feature)

Authority: `docs/master-prompt.txt` (Talkivio spec). Architecture decisions: `docs/adr/`.

## Layout
- `apps/api/src/db/tenant-db.ts` — **all tenant data access** goes through `TenantDb.tx(tenantId, fn)` /
  `TenantDb.read(tenantId, fn)`, which set `app.tenant_id` for PostgreSQL RLS. `db.root` is only for global
  tables (users, auth_sessions, auth_tokens, outbound_emails …) and `rd_*` SECURITY DEFINER functions.
  Always also filter by `tenantId` in queries (defense in depth).
- `apps/api/src/common/http.ts` — `AuthContext`, `VisitorContext`, decorators (`@Auth()`, `@Visitor()`,
  `@Require('perm')`, `@Public()`, `@UserScoped()`, `@TokenAccess()`, `@RecentAuth()`), `body(zodSchema)` pipe
  (converts snake_case wire input → camelCase and validates), `AppError` + helpers (`notFound`, `denied`,
  `badRequest(msg, fieldErrors)`, `conflict(code, msg, retryable)`), error codes (ch. 76 inventory).
- `apps/api/src/common/wire.ts` — responses are wrapped `{data, meta}` and converted to snake_case
  automatically by `EnvelopeInterceptor`. Return camelCase objects from controllers. Use `page(items, nextCursor)`
  for lists (→ `{data, page:{next_cursor,has_more}, meta}`); `encodeCursor/decodeCursor` for opaque cursors.
  Values under keys `customFields/attributes/metadata/safeDiff` are passed through untouched.
- `apps/api/src/common/permissions.ts` — permission names and the role matrix. Never rely on UI hiding.
  `auth.departmentScope` is `'all'` for owner/admin/analyst, else department ids (serve ∪ monitor).
- `apps/api/src/common/idempotency.ts` — `IdempotencyService.run(...)` for create/command POSTs that accept
  `Idempotency-Key`.
- `apps/api/src/common/audit.service.ts` — `audit.inTx(tx, auth, {action, objectType, objectId, safeDiff})`
  inside the same transaction as the change. Never put secrets, message bodies or personal values in `safeDiff`.
- `apps/api/src/outbox/outbox.service.ts` — durable domain events: `outbox.append(tx, tenantId, {...scopes})`
  inside the command transaction. Scopes: `{kind:'chat'|'queue'|'visitor'|'config'|'agent'|'team', id, audience:'staff'|'public', payload?}`.
  A `tenant`/`internal` row is added automatically for internal consumers. Never emit socket frames for
  durable state directly — the worker publisher does it after commit.
- `apps/api/src/outbox/event-consumers.ts` — internal consumers (`consumers.on('chat.closed', 'my-handler', fn)`)
  registered in a provider's `onModuleInit`. Handlers run in the worker, at-least-once → must be idempotent
  (use unique keys in PostgreSQL).
- `apps/api/src/realtime/realtime.service.ts` — `realtime.ephemeral(ns, room, type, scope, payload, ttlMs)` for
  ephemeral frames (typing, presence, monitoring deltas). Rooms: `roomFor(tenantId, kind, id, audience)`.
- `apps/api/src/realtime/command-registry.ts` — socket commands: `registry.registerAgent('x.y', handler)` /
  `registerVisitor`. Handlers must call the same service methods as REST.
- `apps/api/src/worker/worker.service.ts` — `worker.onTimer((name, data) => …)` for delayed jobs added with
  `queues.add(QUEUES.timers, name, data, {delay, jobId})`; `worker.onMaintenance(id, fn)` for periodic jobs.
- `apps/api/src/core/presence.service.ts` — Redis presence; hooks `onAgentConnection`, `onVisitorConnection`.
- Chat engine: `features/chats/*` (`ChatCommandsService`, `RoutingService`, `ChatQueriesService`, `ChatStore`).
  Reuse these services; do not write chat rows directly from other features.

## Adding a feature
1. Put everything in `apps/api/src/features/<feature>/` and register providers/controllers in that folder's
   `index.ts` arrays (`<FEATURE>_PROVIDERS`, `<FEATURE>_CONTROLLERS`). Do not edit `modules.ts`/`registry.ts`.
2. Controllers: agent API under `/api/v1/...` (global prefix), public widget API under `@Controller('widget/v1/...')`
   with `@Public()` + `@UseGuards(VisitorGuard)` (`features/widget/capability.ts`).
3. Validate every input with zod (`.strict()` objects — unknown keys are rejected per ch. 40).
4. Database: the schema already contains the spec tables (`apps/api/prisma/schema.prisma`). If a column is
   missing, add a **new** SQL migration folder `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`
   (include RLS policy + tenant FK for new tenant-owned tables) and update `schema.prisma` to match; never edit
   released migrations.
5. Tests: pure logic → vitest unit tests next to the code (`*.spec.ts`), runtime behaviour → extend an
   end-to-end script in `apps/api/test/` (pattern: `test/smoke-v2.mjs`).

## Running an isolated copy (parallel development)
Use your own database, Redis DB index, port and build directory so you never disturb other work:
```bash
cd apps/api
set -a; . ../../.env; set +a
export DATABASE_OWNER_URL=postgresql://<you>@localhost:5432/talkivio_<name>?schema=public
export DATABASE_URL=postgresql://talkivio_app:talkivio_app_dev_password@localhost:5432/talkivio_<name>?schema=public
export REDIS_URL=redis://127.0.0.1:6379/<n>   # 1..15, unique per developer
export PORT=<4100+n> API_URL=http://localhost:<4100+n>
./scripts/db-reset.sh                       # creates + migrates your database (local only)
npx tsc -p tsconfig.build.json --outDir .build/<name>
node .build/<name>/main.js &  node .build/<name>/worker.js &
```
Typecheck without emitting: `npx tsc --noEmit -p tsconfig.json`. Never run `nest build` into the shared `dist/`.

The integrations + privacy suite needs its own two-API + receiver setup; `apps/api/scripts/integrations-local.sh`
builds into `.build/integrations`, resets `talkivio_integ` + Redis DB 6, starts api :4106 / :4107 / worker and runs it.
