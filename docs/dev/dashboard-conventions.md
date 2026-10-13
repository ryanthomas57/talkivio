# Talkivio dashboard conventions (read before adding a page)

Authority: `docs/master-prompt.txt` (ch. 05 tokens, ch. 06 shell, feature chapters). Backend contracts:
`docs/dev/backend-conventions.md` and the controllers under `apps/api/src/features/*`.

## Stack and layout
- Next.js 15 App Router in `apps/dashboard` (package `@talkivio/dashboard`, rename pending). All pages are client components
  (`'use client'`) rendered inside `src/app/(app)/layout.tsx` → `SessionGate` + `AppShell` (sidebar, topbar,
  connection banner, offer center, inbox sync). Auth pages live in `src/app/(auth)/`.
- Use `Page`, `PageHeader`, `Card`, `CardHeader`, `CardBody` from `@/components/ui` for page structure
  (24 px desktop / 16 px compact padding, 12 px card radius). Max content width 1280 px.
- Breakpoints (ch. 06): mobile < 640, compact 640–1023, desktop 1024–1439, wide ≥ 1440. Every page must work at
  320, 375, 768, 1024, 1440 px and 200 % zoom without horizontal page overflow (tables scroll inside `TableScroll`).

## UI kit (`@/components/ui`)
Button (variants primary/secondary/ghost/danger/danger-ghost/link; `loading` keeps width), Field (label,
description, error with icon + `aria-describedby` wiring — put the control inside), Input, Textarea,
PasswordInput, Select (native), Combobox / MultiCombobox (cmdk), TimezonePicker, Checkbox / CheckboxField,
Switch / SwitchField, RadioGroup (native), Badge / CountBadge, Avatar, StatusIcon / StatusLabel, Tabs, Menu
(Radix dropdown), Tooltip (500 ms, never the only label), Dialog / DialogContent, DrawerContent, ConfirmDialog,
Banner, EmptyState, PanelError, Skeleton, Spinner, Table/THead/TR/TH/TD/TableScroll. Do not build clickable
divs — use native buttons/links. Do not edit files in `src/components/ui/` or other shared foundation files; if
you need a new primitive, put it in your own area folder (`src/components/<area>/`) and mention it in your report.

## Data
- REST: `api.get/post/put/patch/delete/page` from `@/lib/api`. Bodies and queries are camelCase in code and
  converted to snake_case on the wire automatically; responses come back camelCase. Values under
  `customFields/fields/attributes/metadata/safeDiff` keep their keys. Errors are `ApiError` with
  `code`, `status`, `retryable`, `fieldErrors` (`err.field('snake_name')`) — map field errors onto `Field error`.
  `errorMessage(e)` gives a safe message. Mutations that accept `Idempotency-Key` pass `{ idempotencyKey }`.
- Lists: `api.page<T>(path, query)` → `{items, nextCursor, hasMore}`; paginate with `cursor`.
- Caching: TanStack Query. Shared keys and hooks in `@/lib/queries` (`useDepartments`, `useAgents`, `useTags`,
  `useSites`, `qk`). Invalidate those keys after mutations that change them.
- Versioned writes: send `expectedVersion` (or `ifMatch`). On `VERSION_CONFLICT` show a Banner with "Reload" —
  never silently overwrite another editor.
- Realtime: `useScopes([{kind,id}])`, `useRealtimeEvent(type, handler)`, `useEphemeralEvent(type, handler)`,
  `useResync(handler)` from `@/hooks/use-realtime`. Refetch over REST on resync. Never trust frame data for
  authorization — it only refreshes views.
- Session: `useSession` (`me`, `tenant`, `agent` with `permissions` and `preferences`), `useCan('perm')`.
  Hide controls the caller cannot use, but the API remains the authority; handle 403 gracefully.

## States (ch. 06)
- Initial load → skeletons shaped like the final layout. Partial failure → `PanelError` with Retry inside that
  panel. Empty → `EmptyState` explaining the current filter with a meaningful action.
- Failed writes must stay visible (Banner/inline) — toasts (`sonner`) are only for confirmations.
- Dangerous actions → `ConfirmDialog` naming the object and consequence. Never `window.confirm/alert`.
- Dirty forms → `useDirtyGuard(dirty, { onSave, what })` from `@/hooks/use-dirty-guard` (render the returned node).
- Filters, tabs and selected rows live in the URL query (`useSearchParams` + `router.replace(..., {scroll:false})`)
  so back/forward and refresh restore them. Wrap components using `useSearchParams` in `<Suspense>`.

## Accessibility
Every control has a visible label (or `aria-label` for icon buttons). Status uses icon + text + color. Tables use
`<th scope="col">`. Live regions (`role="status"`/`aria-live`) for async results. Focus returns to the opener when
dialogs close (Radix does this). Touch targets ≥ 44 px on mobile.

## No fake data
Never render constants, sample numbers or placeholder buttons. If an API is missing, show an honest
"not available" state and report it — do not invent endpoints. Read the controller to confirm a shape.

## Verify
- `cd apps/dashboard && npx tsc --noEmit -p tsconfig.json` must be clean.
- The dev server runs on http://localhost:3000 (do not start another `next dev` in this folder). The API runs on
  :4000 with the dev database. Local test owner: see `apps/dashboard/e2e/fixtures.ts` (local development only).
- In the browser pane, open your own tab (`tabs_create`) for visual checks; never close or navigate other tabs.
