# Widget embed and JavaScript SDK

The visitor widget is added to a website with one snippet. The loader is small, dependency-free and asynchronous;
the widget itself runs in an iframe served by the API origin, so the host page and the widget never share CSS,
JavaScript globals or storage. Everything a host page can do goes through the `Talkivio(command, ...args)` function.

Verified by `apps/dashboard/e2e/widget-sdk.spec.ts` (loader behaviour, approved and unapproved origins, every command
below and the event payloads) and `apps/dashboard/e2e/widget-states.spec.ts` (visitor states), against the demo
storefront in `apps/widget/demo`.

## Embed

```html
<script>
  window.Talkivio =
    window.Talkivio ||
    function () {
      (window.Talkivio.q = window.Talkivio.q || []).push(arguments);
    };
</script>
<script async src="https://API_HOST/widget/loader.js" data-site-key="wk_…"></script>
```

- **Asynchronous.** The loader never blocks parsing or the host page's `DOMContentLoaded` (like any `async` script
  it is part of the `load` event); calls made before it arrives are queued by the stub above and replayed in order
  once it runs.
- **Isolated.** The widget is one `div[data-talkivio]` (fixed position, explicit inline styles) holding one
  `iframe[title="Chat"]`. Its layout properties are inline `!important`, so host CSS cannot move, resize or hide it
  (opacity and transform stay animatable and are left to the host). The widget adds no stylesheets to the host page,
  and the only global it defines is `window.Talkivio` (plus the internal `__talkivioLoaded` guard); the build fails
  if the loader bundle would declare any other (`apps/widget/scripts/check-loader.mjs`).
- **Idempotent.** Including the loader twice, or calling `init` twice, never creates a second widget (`init` rejects
  with `ALREADY_INITIALIZED`).
- **Removable.** `Talkivio('destroy')` removes the container and iframe, the host listeners, the `history`
  patches used to follow single-page navigation, and pending timers. After `destroy`, commands reject with
  `DESTROYED` until `init` is called again.
- **Approved origins only.** The frame is served with `Content-Security-Policy: frame-ancestors <the site's origins>`,
  so on a page whose origin the site does not list the browser refuses to load it: the widget stays hidden and no
  visitor session is created.
- `window.TalkivioSettings = { locale, identityToken, hideLauncher, position, handoffCode }` (optional) is read once
  when the loader runs. `data-site-key` may also be written `data-widget-id`.

## Commands

Signatures follow the master prompt (ch. 29). Asynchronous commands return a Promise; rejections are `Error`
objects with a string `code`. Commands issued before the widget is ready are queued in order and run once it is;
if the widget can never load on the page (the frame is refused or unreachable), pending and later commands reject
with `WIDGET_UNAVAILABLE` and the page receives an `error` event.

| Command                 | Arguments                                                                             | Result                                                                                                                                                                                       | Rejects with (`error.code`)                                     |
| ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `init`                  | `{ siteKey, locale?, position?: 'bottom-right' \| 'bottom-left', handoffCode? }`      | `Promise<void>`                                                                                                                                                                              | `ALREADY_INITIALIZED`, `INVALID_SITE_KEY`                       |
| `open`                  | —                                                                                     | `Promise<void>`                                                                                                                                                                              | `DESTROYED`, `WIDGET_UNAVAILABLE`                               |
| `close`, `show`, `hide` | —                                                                                     | `void` (applied once ready)                                                                                                                                                                  | —                                                               |
| `destroy`               | —                                                                                     | `void`                                                                                                                                                                                       | —                                                               |
| `identify`              | `{ name?, email?, externalIdToken? }`                                                 | `Promise<IdentityResult>` = `{ visitorId, verified }`                                                                                                                                        | `INVALID_ARGUMENT`, `INVALID_EMAIL`, API codes                  |
| `resetIdentity`         | —                                                                                     | `Promise<void>` (a new anonymous visitor)                                                                                                                                                    | —                                                               |
| `setDepartment`         | `departmentId \| null`                                                                | `Promise<void>` (applies to the next chat)                                                                                                                                                   | `INVALID_ARGUMENT`                                              |
| `setTags`               | `string[]` of existing tag slugs (≤ 20)                                               | `Promise<void>`                                                                                                                                                                              | `INVALID_ARGUMENT`, `VALIDATION_FAILED` (unknown tag)           |
| `setCustomFields`       | `{ [key]: string \| number \| boolean \| null }` — `public_writable` definitions only | `Promise<void>`                                                                                                                                                                              | `INVALID_ARGUMENT`, `VALIDATION_FAILED`                         |
| `setLocale`             | `string \| null`                                                                      | `Promise<void>`                                                                                                                                                                              | `INVALID_ARGUMENT`                                              |
| `updateSettings`        | `{ appearance?, content? }` (presentation only; unknown keys ignored)                 | `Promise<Config>` — the published configuration with the overrides applied                                                                                                                   | —                                                               |
| `trackPage`             | `{ url: 'http(s)://…', title? }`                                                      | `Promise<void>`                                                                                                                                                                              | `INVALID_ARGUMENT`                                              |
| `setConsent`            | `{ analytics: boolean, policyVersion: string, service?: boolean }`                    | `Promise<void>`                                                                                                                                                                              | `INVALID_ARGUMENT`                                              |
| `startChat`             | `{ message?, departmentId? }`                                                         | `Promise<Chat \| null>` — `Chat` = `{ id, status }` as in `getState().chat`; without a message nothing is created (agents never receive empty chats) and the open chat or `null` is returned | `INVALID_ARGUMENT`, send errors (e.g. `DEPARTMENT_UNAVAILABLE`) |
| `endChat`               | —                                                                                     | `Promise<void>` (no-op when no chat is open)                                                                                                                                                 | `END_CHAT_DISABLED`, API codes                                  |
| `on`                    | `(event, handler)`                                                                    | an unsubscribe function                                                                                                                                                                      | —                                                               |
| `getState`              | —                                                                                     | the frozen snapshot below                                                                                                                                                                    | —                                                               |
| any other name          | —                                                                                     | —                                                                                                                                                                                            | `UNKNOWN_COMMAND`                                               |

Snapshot: `{ ready, open, visible, view, connection, availability, unreadCount, locale, chat: { id, status } | null,
visitor: { id, verified } | null, configVersion }`.

Additional commands (beyond the master prompt, kept for convenience): `toggle()` → `Promise<boolean>` (open
afterwards), `sendMessage(text)` → `Promise<{ chatId }>`, `addTags`/`removeTags(string[])` → `Promise<void>`,
`setAttributes` (alias of `setCustomFields`), `off(event, handler)`, `isOpen()` → `boolean`,
`getUnreadCount()` → `number`.

## Events

`Talkivio('on', name, handler)`. Handlers run with the payload below; an exception thrown by a handler is logged and
never affects the widget. A late `ready` subscriber is called right away. **Payloads carry identifiers, states and
counts only — never message text, visitor names, email addresses or tokens.**

| Event                            | Payload                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ready`                          | `{ siteId, configVersion }`                                                                            |
| `opened`, `closed`               | `{ source: 'launcher' \| 'invitation' \| 'api' \| 'agent' \| 'trigger' \| 'restore' \| 'standalone' }` |
| `connection.changed`             | `{ state: 'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected' \| 'failed', reason? }`      |
| `availability.changed`           | `{ state: 'online' \| 'offline', departmentId, nextOpenAt }`                                           |
| `unread.changed`                 | `{ count }`                                                                                            |
| `chat.requested`, `chat.started` | `{ chatId }`                                                                                           |
| `chat.ended`                     | `{ chatId, reason }`                                                                                   |
| `message.received`               | `{ chatId, messageId, type: 'agent' \| 'automated' \| 'system' }`                                      |
| `rating.changed`                 | `{ chatId, rating }`                                                                                   |
| `offline.submitted`              | `{ reference }`                                                                                        |
| `identity.changed`               | `{ verified, visitorId }`                                                                              |
| `invitation.displayed`           | `{ invitationId }`                                                                                     |
| `invitation.accepted`            | `{ invitationId, chatId }`                                                                             |
| `error`                          | `{ code, message, retryable }` (fixed, non-personal text)                                              |
