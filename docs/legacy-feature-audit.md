# Talkivio — Legacy Feature-Parity Audit

- **Reference product:** classic Zendesk Chat (formerly Zopim), the "live chat" generation that predates Zendesk Messaging
- **Reference period:** January 2018 – December 2021
- **Prepared:** 2026-10-11
- **Status:** research input for product and engineering. This is not a specification. Every requirement below is written for Talkivio in our own words. Nothing here is Zendesk UI text, branding, copy or assets.

---

## 1. Purpose

Talkivio is an independent live-chat product. Its spec sets functional parity with the classic live-chat products of 2018–2021 as the launch baseline. This audit:

1. lists the behaviours classic Zendesk Chat actually had, backed by primary or archived sources;
2. keeps confirmed behaviour separate from assumed behaviour, and from modern additions our spec asks for that the reference product never had;
3. turns each behaviour into implementation requirements, UI placement, backend needs and testable acceptance criteria for our monorepo (`apps/api`, `apps/dashboard`, `apps/widget`, `packages/contracts`).

We reproduce behaviour, never presentation. Rewrite all copy, labels, icons, colours and layouts from scratch.

## 2. Period covered

- **Primary window:** help-centre articles last edited between April 2019 and October 2021. Most came from the Zendesk Chat help centre as it stood after the 2019 move to `support.zendesk.com` (article IDs `360022xxxxxx`). Archived copies date from 2019-10 to 2021-11.
- **Developer documentation:** the classic Chat REST API, Real Time Chat API, Conversations API, the `$zopim.livechat` widget API (archived 2019-10-07), the Web SDK (archived 2020-06-17) and the Web Widget (Classic) chat API. Many developer pages are still online. They describe the same classic product, and some sample payloads carry 2014–2020 timestamps.
- **Product generations in the window:** Zendesk itself documented four account "versions" in 2019: Legacy Chat (zopim.com dashboard), Legacy Chat+Support, Chat Phase 3 and Chat Phase 4 (both on `subdomain.zendesk.com/chat`) [AR36]. Where behaviour differed by generation, the entry says so.

## 3. Methodology

1. **Archive-first retrieval.** The brief preferred the Internet Archive Wayback Machine. Every `web.archive.org` request returned HTTP 429 (rate-limited) for the whole session, including after waiting and polling once a minute. Its availability API did respond and confirmed that 2019–2020 snapshots exist for several key articles (see §4.4), but no page content could be retrieved from it. We used the Portuguese national web archive (**Arquivo.pt**), which holds 2019–2021 crawls of the same Zendesk help-centre articles and of `api.zopim.com`. We read its CDX index to find captures and retrieved the raw archived HTML.
2. **Official developer documentation** on `developer.zendesk.com`, downloaded directly. These pages are current but document the classic Chat APIs.
3. **Current official help-centre articles** that still describe the classic live-chat dashboard, used where no archived copy was found. Some are behind a sign-in wall. For those we used the search engine's index summary, and the entry's confidence is lowered to match.
4. **Search-engine summaries** of community threads, used only to corroborate. They are marked as such.
5. **Classification rules**
   - **Section A (Verified):** at least one official source confirms the behaviour, either archived from the reference period or still published and describing the classic product.
   - **Section B (Needs validation):** the behaviour is plausible or partly evidenced, but no primary source in the period confirms it.
   - **Section C (Modern enhancements):** our spec wants it and the evidence shows the classic product did not have it, or had only a much weaker form.
6. **Confidence scale**
   - **High:** archived primary source from 2018–2021, or a primary developer reference with an explicit field or semantic.
   - **Medium:** current primary source that describes the classic product but carries no date, several primary sources that only partly agree, or a primary source that confirms the feature exists but not its details.
   - **Low:** search-index summary, community post, or inference.
7. Every description below is paraphrased. No Zendesk documentation text is reproduced.

**Fetch budget used:** about 120 retrievals. That covers 55 archived pages from Arquivo.pt, about 32 developer-doc pages, about 12 live help-centre fetches and about 25 web searches. A further ~80 Wayback attempts and CDX index queries were rate-limited or used only for discovery.

## 4. Sources consulted

Each feature entry cites sources by code. Arquivo.pt capture URLs follow the pattern `https://arquivo.pt/wayback/<capture-timestamp>/<original-url>`.

### 4.1 Archived help-centre articles (Arquivo.pt) — code `AR`

Original base URL: `https://support.zendesk.com/hc/en-us/articles/`

| Code | Article (original ID) | Capture timestamp | Article last edited |
|---|---|---|---|
| AR01 | Setting up chat routing (360022366213) | 20191020115823 | 2019-08-05 |
| AR02 | Inserting common phrases with shortcuts (360022367033) | 20191016053446 | 2019-04-28 |
| AR03 | Banning visitors (360022367133) | 20191016053306 | 2019-05-07 |
| AR04 | Enabling the pre-chat form on the Chat widget (360022367293) | 20191016053059 | 2019-07-26 |
| AR05 | Managing Offline Form settings (360022183734) | 20191016053027 | 2019-04-28 |
| AR06 | Customizing the appearance of the widget (360022367353) | 20191016051747 | 2019-09-06 |
| AR07 | Browsing your site's visitors (360022367833) | 20201229023002 | 2020-12-10 |
| AR08 | Browsing past chats in History (360022185794) | 20191016052455 | 2019-05-03 |
| AR09 | Overview of the Zendesk Chat dashboard (Explore) (360022185894) | 20191020120508 | 2019-09-11 |
| AR10 | Monitoring chat activity with Analytics (360022185934) | 20191016054034 | 2019-09-24 |
| AR11 | Chat Analytics CSV glossary (360022185974) | 20191016054113 | 2019-09-24 |
| AR12 | Understanding default roles in Zendesk Chat (360022182234) | 20191016053736 | 2019-04-28 |
| AR13 | Creating custom Chat roles and assigning users (360022182394) | 20191016053341 | 2019-04-28 |
| AR14 | Measuring visitor satisfaction with chat rating (360022183014) | 20191016053413 | 2019-04-28 |
| AR15 | Using IP Access Restriction to limit access to the Chat dashboard (360022184114) | 20200611184926 | 2020-05-11 |
| AR16 | Editing your chat notification settings (360022184414) | 20191016053849 | 2019-08-02 |
| AR17 | Setting your availability status (360022184674) | 20191016053924 | 2019-10-04 |
| AR18 | Automatically route chats to departments (360022186814) | 20191016053239 | 2019-09-06 |
| AR19 | Targeting key visitors with proactive chat (360022186874) | 20191016053211 | 2019-07-18 |
| AR20 | Creating agents and departments (360022365373) | 20191016053139 | 2019-04-28 |
| AR21 | Automatically send chat transcripts with email piping (360022366033) | 20191016053520 | 2019-05-01 |
| AR22 | Hiding credit card numbers in chats and chat history (360022366853) | 20200313034622 | 2019-04-28 |
| AR23 | Editing your personal settings in Zendesk Chat (360022366933) | 20191016053807 | 2019-04-28 |
| AR24 | Sending files in a chat (360022367073) | 20191016053556 | 2019-04-28 |
| AR25 | Permanently deleting chats and attachments (360022182134) | 20191016054003 | 2019-04-28 |
| AR26 | History chat details CSV glossary (360022372693) | 20191016052542 | 2019-05-01 |
| AR27 | Monitoring real-time chat metrics (360022367853) | 20200323191823 | 2019-11-19 |
| AR28 | Setting up Zendesk Support in Chat (360022365713) | 20191016051859 | 2019-04-28 |
| AR29 | Tracking goals and conversions with Google Analytics (360022192174) | 20191016054229 | 2019-09-12 |
| AR30 | Measuring business goals with conversion tracking (360022182674) | 20191016054144 | 2019-04-28 |
| AR31 | Routing chats based on agent skills (360022365513) | 20210708231955 | 2021-05-27 |
| AR32 | Using structured messages in Zendesk Chat (360022184394) | 20210329214108 | 2021-02-01 |
| AR33 | About Zendesk Chat plan types (360022177854) | 20191016053632 | 2019-05-07 |
| AR34 | How can I stop a spam attack coming from the chat widget? (360002121487) | 20191020115816 | 2019-04-29 |
| AR35 | Real-time queue updates in the Chat widget (4408831116314) | 20211116091248 | 2021-10-25 |
| AR36 | Determining your Zendesk Chat account version (360022177814) | 20191020115831 | 2019-04-28 |
| AR37 | Working with Chat triggers (360022183154) | 20191005043800 | 2019-06-07 |
| AR38 | Creating a schedule with operating hours (360022184014) | 20191005043807 | 2019-09-07 |
| AR39 | Setting up chat tags (360022183354) | 20191005043735 | 2019-04-28 |
| AR40 | Managing file sending options (360022183834) | 20191005043812 | 2019-09-09 |
| AR41 | Navigating the dashboard with keyboard shortcuts (360022184754) | 20191005043834 | 2019-04-28 |
| AR42 | Enabling authenticated visitors in the Chat widget (360022185314) | 20191005043825 | 2019-06-20 |
| AR43 | Restricting the Chat widget by country or domain (360022367453) | 20191005043816 | 2019-04-28 |
| AR44 | Customizing the Chat widget for mobile devices (360022367513) | 20191005043804 | 2019-09-24 |
| AR45 | Complying with GDPR in Zendesk Chat (360022367053) | 20191012174342 | 2019-04-28 |
| AR46 | Complying with GDPR in standalone Chat accounts (360022367113) | 20191012174346 | 2019-04-28 |
| AR47 | Conversation history & authenticated visitors in Chat widget (360022180994) | 20191020115533 | 2019-05-01 |
| AR48 | Managing Chat API clients and tokens (360022182534) | 20191005043721 | 2019-08-02 |
| AR49 | High load-related announcement banners in the Chat dashboard (360022367173) | 20191005043726 | 2019-04-28 |
| AR50 | Chat tags resources (360022365993) | 20191005043755 | 2019-04-28 |
| AR51 | Early Access: Redesigned Agent Experience (360022364273) | 20191005043742 | 2019-05-01 |
| AR52 | `$zopim.livechat` JavaScript API — `https://api.zopim.com/files/meshim/widget/controllers/LiveChatAPI-js.html` | 20191007091232 | n/a (Natural Docs page) |
| AR53 | Zendesk Chat Web SDK documentation — `https://api.zopim.com/web-sdk/` | 20200617104053 | n/a |

### 4.2 Official developer documentation (live, fetched 2026-10-11) — code `DV`

| Code | Page | URL |
|---|---|---|
| DV01 | Chat API introduction (auth, rate limits, legacy base URL) | https://developer.zendesk.com/api-reference/live-chat/introduction/ |
| DV02 | Chats | https://developer.zendesk.com/api-reference/live-chat/chat-api/chats/ |
| DV03 | Agents | https://developer.zendesk.com/api-reference/live-chat/chat-api/agents/ |
| DV04 | Visitors | https://developer.zendesk.com/api-reference/live-chat/chat-api/visitors/ |
| DV05 | Accounts | https://developer.zendesk.com/api-reference/live-chat/chat-api/accounts/ |
| DV06 | Departments | https://developer.zendesk.com/api-reference/live-chat/chat-api/departments/ |
| DV07 | Chat Triggers | https://developer.zendesk.com/api-reference/live-chat/chat-api/triggers/ |
| DV08 | Shortcuts | https://developer.zendesk.com/api-reference/live-chat/chat-api/shortcuts/ |
| DV09 | Bans | https://developer.zendesk.com/api-reference/live-chat/chat-api/bans/ |
| DV10 | Goals | https://developer.zendesk.com/api-reference/live-chat/chat-api/goals/ |
| DV11 | Skills | https://developer.zendesk.com/api-reference/live-chat/chat-api/skills/ |
| DV12 | Roles | https://developer.zendesk.com/api-reference/live-chat/chat-api/roles/ |
| DV13 | Routing Settings | https://developer.zendesk.com/api-reference/live-chat/chat-api/routing_settings/ |
| DV14 | Incremental Exports | https://developer.zendesk.com/api-reference/live-chat/chat-api/incremental_export/ |
| DV15 | Agent Events (limited availability) | https://developer.zendesk.com/api-reference/live-chat/chat-api/incremental_agent_events_api/ |
| DV16 | Real Time Chat API (intro, metrics, streaming, REST) | https://developer.zendesk.com/api-reference/live-chat/real-time-chat-api/introduction/ (and `/metrics/`, `/streaming/`, `/rest/`) |
| DV17 | Chat Conversations API | https://developer.zendesk.com/api-reference/live-chat/chat-conversations-api/conversations-api/ |
| DV18 | Web Widget (Classic) — chat API | https://developer.zendesk.com/api-reference/widget/chat-api/ |
| DV19 | Web Widget (Classic) — settings | https://developer.zendesk.com/api-reference/widget/settings/ |
| DV20 | Migrating from the Chat widget syntax (`$zopim` → `zE` mapping) | https://developer.zendesk.com/documentation/classic-web-widget-sdks/web-widget/getting-started/chat_api_migration/ |
| DV21 | Chat Widget (classic) API overview and customization guides | https://developer.zendesk.com/documentation/classic-web-widget-sdks/chat-widget/getting-started/chat-widget-api-overview/ (and sibling pages under `/chat-widget/customising-the-widget/`) |

### 4.3 Official help-centre articles (live) — code `HC`

| Code | Article | URL | How retrieved |
|---|---|---|---|
| HC01 | Zendesk Chat triggers conditions and actions reference | https://support.zendesk.com/hc/en-us/articles/4408842880282 | Fetched, full text |
| HC02 | Triggers reference for developers (JSON definition format) | https://support.zendesk.com/hc/en-us/articles/4408886111130 | Fetched, full text |
| HC03 | About the Chat default triggers | https://support.zendesk.com/hc/en-us/articles/4408834380442 | Fetched, full text |
| HC04 | Serving chats in the Chat dashboard | https://support.zendesk.com/hc/en-us/articles/4408824240026 | Fetched, full text |
| HC05 | Inserting common phrases with shortcuts (current) | https://support.zendesk.com/hc/en-us/articles/4408832184346 | Fetched, full text |
| HC06 | How can I send chat transcripts manually or automatically | https://support.zendesk.com/hc/en-us/articles/4408833687450 | Fetched, full text |
| HC07 | How does the Chat mobile app work | https://support.zendesk.com/hc/en-us/articles/4408833835674 | Fetched, full text |
| HC08 | Browsing past chats in History (current) | https://support.zendesk.com/hc/en-us/articles/4408893866778 | Fetched, full text |
| HC09 | When do chats time out | https://support.zendesk.com/hc/en-us/articles/4408836091034 | Search-index summary only (direct fetch returned 404) |
| HC10 | How can I offer Zendesk Chat on multiple websites | https://support.zendesk.com/hc/en-us/articles/4408820591770 | Search-index summary only |
| HC11 | Understanding different types of tags in Chat | https://support.zendesk.com/hc/en-us/articles/360022366013 | Search-index summary only |
| HC12 | Can I create a shortcut in chat for only a visitor's first name | https://support.zendesk.com/hc/en-us/articles/5565091603482 | Search-index summary only |
| HC13 | Community thread: preview text as customer is typing | https://support.zendesk.com/hc/en-us/community/posts/4409217443866 | Search-index summary only (community) |
| HC14 | Enabling automatic ticket creation in Zendesk Chat (post-period) | https://support.zendesk.com/hc/en-us/articles/8357772371482 | Search-index summary only |

### 4.4 Wayback Machine (snapshot existence only)

The availability API confirmed these snapshots. Their content could not be retrieved because of HTTP 429.

- Triggers conditions and actions reference, period copy: `http://web.archive.org/web/20190826065921/https://support.zendesk.com/hc/en-us/articles/360022365873`
- Triggers reference for developers: `http://web.archive.org/web/20201129201748/https://support.zendesk.com/hc/en-us/articles/360022182874`
- Using structured messages: `http://web.archive.org/web/20191023012107/https://support.zendesk.com/hc/en-us/articles/360022184394`

**Recommended follow-up:** once Wayback access is available, diff the 2019 triggers reference against HC01. See Open Questions.

## 5. Limitations

- **No Wayback content.** The brief's preferred archive was unreachable. Arquivo.pt covers about 55 of the core articles. It does not hold the 2019 copies of the triggers reference, the default-triggers article, "Serving chats", the ticket-creation article, the visitor-list settings or the per-namespace `$zopim` sub-pages (`window`, `button`, `badge`, etc.). For those topics we relied on current official pages, which may include behaviour added after 2021, and we lowered confidence to match.
- **Generation drift.** Behaviour differed across Legacy, Phase 3 and Phase 4 accounts, and between the standalone Chat widget and the Web Widget (Classic). Where a source names a generation, the entry records it.
- **UI specifics.** Exact screen layouts, column orders and sound names were rarely documented. We specify behaviour, and leave layout to our own design.
- **Plan gating.** Many features were tied to plans: Lite, Team (formerly Basic), Professional (formerly Advanced) and Enterprise (formerly Premium) [AR33]. We record gating as a note only. Plan packaging for Talkivio is a separate decision.
- **No hands-on verification.** The reference product could not be exercised. Everything here comes from documentation.

## 6. Key findings at a glance

**Coverage:** Section A has 65 verified features, Section B has 23 that need validation, and Section C has 18 modern enhancements.

**Five surprises against our brief**

1. **Shortcuts use `/`, not `#`.** Agents typed `/` (which lists the first 10) or the start of a shortcut's name. No source supports `#` (B-01).
2. **JWT visitor authentication already existed in 2018–2019.** It used HS256, an immutable `external_id`, a token lifetime of at most 7 minutes and 2 minutes of clock skew (A-16). Only asymmetric keys and graceful rotation are modern (C-05).
3. **Triggers did not fire at all** when no agent was online or every agent was invisible (A-41). Proactive engagement stopped off-hours.
4. **Day-of-week numbering is inconsistent.** Trigger conditions counted 0 = Monday, while the Web SDK's operating-hours schedule counted 0 = Sunday (A-41, A-44).
5. **Agents could not truly end a chat.** They could only leave it. The chat ended when the visitor ended it, went idle for about 20 minutes, or disconnected (A-08, A-31).

**Other notable reference behaviour**

- Satisfaction ratings were not reportable in Analytics in 2019. They were available only through History and exports (A-11, A-54).
- The reference product had no outbound webhooks, no audit log and no Chat-native MFA (C-01, C-03, C-06).

## 7. Entry format and UI area names

Each feature entry has:

- **Historical behavior**
- **Source**
- **Confidence** (with reason)
- **Required implementation**
- **UI**: one or more of *Inbox, Live Visitors, Chat History, Triggers, Shortcuts, Departments, Operating Hours, Agents, Analytics, Chat Widget settings, Websites, Settings, Widget runtime, Public API*
- **Backend**
- **Acceptance criteria**

Module names in the parity checklist refer to our monorepo:

- `api:<module>`: a NestJS module in `apps/api`
- `web:<page>`: a dashboard page in `apps/dashboard`
- `widget:<area>`: `apps/widget`
- `shared`: `packages/contracts`, for protocol, schemas and settings

---

# Section A — Verified historical features

## A.1 Widget runtime (visitor-facing)

### A-01 · Embeddable widget, one account usable on many sites
- **Historical behavior:** An account had one widget configuration, installed by pasting a script snippet into each page. Plugins existed for WordPress, Shopify, Wix, Squarespace, PrestaShop and Magento. The same snippet could go on several websites, and every site's chats arrived in one dashboard. Recommended practice was to organise agents into one department per site or brand, then route with a trigger on page URL or a required department picker. The visitor cookie belonged to the registrable domain, so a session carried across subdomains but not across separate domains, unless the visitor was authenticated (A-16).
- **Source:** AR36 (account versions); HC10 (multiple websites, search summary); Arquivo listing of 2019–2020 plugin articles, e.g. "Installing Zendesk Chat for WordPress" (360022186574), "Setting up Chat for Shopify" (360022368513).
- **Confidence:** Medium. The single-widget-across-sites rule comes from a current article seen only as a search summary. The plugin articles exist in archive listings but were not read.
- **Required implementation:** Provide one embed snippet per *website*. Our spec models websites explicitly. Each website gets a public `siteKey`. Several websites can share one workspace inbox. Store which website a chat came from on the chat record.
- **UI:** Websites, Chat Widget settings.
- **Backend:** `Website` entity with `siteKey`, allowed domains and widget-config reference. Visitor identity cookie scoped to the registrable domain.
- **Acceptance criteria:**
  - Installing the same snippet on two domains delivers chats from both into one Inbox, each labelled with its originating website and URL.
  - A visitor who moves between `a.example.com` and `b.example.com` keeps the same visitor ID.
  - A visitor who moves to a different registrable domain gets a new anonymous visitor ID unless authenticated.

### A-02 · Widget appearance customization
- **Historical behavior:** Admins edited appearance with a live preview:
  - **Chat window:** the title text in the window header, a theme colour (hex or picker), and position (bottom-right or bottom-left).
  - **Concierge:** the identity shown before any agent joins, made of a display title, a byline, and on paid plans an uploaded avatar.
  - **Message style** (paid plans): speech bubbles or plain lines, with an option to show sender avatars.
  - **Chat badge** (paid plans, "Simple" window only): on or off; layout of image-right, image-left, text-only or image-only; default or custom image; background colour, optionally matching the theme; a short message.
  - **Mobile:** the chat opened either as an overlay in the same tab or as a pop-out in a new tab. Badge and minimized-button settings did not apply on mobile.
  - **JavaScript API:** colour, position (including top and middle positions on the classic widget), offsets (desktop and mobile), window title, badge text, image and layout, concierge name, title and avatar, theme colours, and the agent profile card (avatar, title, rating) [DV20].
- **Source:** AR06; AR44; DV20; DV19 (`badge.layout` values `image_right|image_left|image_only|text_only`; `position`; `offset`; `color`; `concierge`; `profileCard`).
- **Confidence:** High. Archived 2019 article plus an API mapping table that lists the legacy methods.
- **Required implementation:** A widget appearance editor with live preview covering:
  - header title
  - primary colour
  - position: corner (4 corners) plus vertical and horizontal offsets, with separate mobile offsets
  - concierge (name, byline, avatar upload)
  - bubble or line message style
  - avatar visibility
  - launcher badge (layout, image, colour, label)
  - mobile mode (overlay or new tab)
  - agent profile card toggles (avatar, title, rating)
  
  Also expose the same settings through the widget runtime API (A-13).
- **UI:** Chat Widget settings → Appearance.
- **Backend:** Versioned widget config JSON in `packages/contracts` (`widget-config.ts`), served from a CDN-cacheable endpoint keyed by `siteKey`. Avatar uploads stored as validated images.
- **Acceptance criteria:**
  - Every setting change appears in the preview within 1 s and on live sites within 60 s of saving, or immediately if cache invalidation is implemented.
  - The badge renders correctly in all four layouts. An invalid layout value falls back to image-right.
  - Mobile overlay keeps the visitor on the page. Pop-out opens a new tab with the conversation intact.
  - Concierge identity shows until the first agent joins, then the joining agent's display name, byline and avatar replace it.

### A-03 · Widget visibility controls
- **Historical behavior:**
  - Admins could turn the widget off by default, so it stayed hidden until a trigger or the JS API revealed it. This was also used to blunt spam floods.
  - The API could hide everything (`hideAll`), show, hide or toggle the window, show or hide the button and badge, and pop the chat out into a new window. The pop-out worked only while chat was online and only from a user gesture.
  - A hide-when-offline option hid the launcher whenever the account was offline.
  - Developer guides covered hiding the widget on mobile devices (method not extracted) and opening it automatically after N seconds by calling `window.show` on a timer.
- **Source:** AR34; AR52 (`hideAll`); DV20 (`window.show/hide/toggle/popout/getDisplay`, `button.show/hide`, `badge.show/hide`, `button.setHideWhenOffline` → `hideWhenOffline`); DV18 (`popout`); DV21 (show/hide window, pop-up after time, hide on mobile guides).
- **Confidence:** High.
- **Required implementation:**
  - A dashboard toggle that starts the widget hidden.
  - A hide-when-offline toggle.
  - A hide-on-mobile toggle. In the reference this was done with integrator code, so a first-class setting is an improvement.
  - Runtime API calls for show, hide, open, close, toggle, pop-out and get display state.
  - A trigger action that can reveal or open the widget. See B-08: this is our addition, because the reference used `sendMessageToVisitor` to auto-open the window.
- **UI:** Chat Widget settings → Behaviour; Widget runtime.
- **Backend:** Config flags only. Pop-out is a hosted route `/w/:siteKey/popout`.
- **Acceptance criteria:**
  - With "start hidden" on, no launcher appears until `show()` is called or a proactive message arrives.
  - With hide-when-offline on and every agent offline or invisible, the launcher disappears within 5 s, and reappears within 5 s when an agent comes online.
  - Calling `popout()` from a click handler opens a standalone window bound to the same conversation. Calling it while offline does nothing.

### A-04 · Widget language and localization
- **Historical behavior:** The widget picked its language automatically and could be overridden by the API with a language code. Documented codes included `en`, `pt`, `sv`, `zh_CN` and `zh_TW`, among others. The mobile widget rendered in the visitor's supported language. In the Web Widget (Classic), most customizable strings accepted per-locale values with a `*` wildcard fallback.
- **Source:** AR52 (`setLanguage`); AR44; DV21 (changing the widget language); DV19 (per-locale string objects with `*` fallback); DV20 (`setLanguage` → `setLocale`).
- **Confidence:** High for the API override; Medium for the detection logic, which is undocumented beyond "auto".
- **Required implementation:**
  - Detect locale from the page `lang` attribute, then from browser languages. Allow an override via the runtime API and per-website settings.
  - Ship translations for all widget system strings.
  - Let every admin-customizable string (title, greetings, form labels, offline message) take per-locale values with a wildcard fallback.
- **UI:** Chat Widget settings → Language; Widget runtime.
- **Backend:** Locale bundles in `packages/contracts`. Per-locale overrides in the widget config.
- **Acceptance criteria:**
  - `setLocale('sv')` switches all system strings without a reload.
  - A custom greeting with `{ "*": "Hi", "fr": "Salut" }` shows "Salut" for French browsers and "Hi" for everyone else.
  - An unknown locale code falls back to the workspace default language.

### A-05 · Widget sounds and visitor notifications
- **Historical behavior:** The widget played sounds for incoming messages. The API could disable them, and in the later Web Widget an admin setting replaced the API call. Mobile notifications could be disabled. Safari autoplay rules could block widget sounds.
- **Source:** AR52 (`setDisableSound`); DV20 (sound API deprecated in favour of an admin setting; `mobileNotifications.setDisabled`); AR16 (Safari autoplay note).
- **Confidence:** High.
- **Required implementation:**
  - A per-website sound on/off setting and a runtime override.
  - Unread-count badge on the launcher, plus a document-title flash when the page is not focused. Title flashing is not documented in the reference, so treat it as optional polish.
  - Respect browser autoplay policy: never throw, degrade silently.
- **UI:** Chat Widget settings → Behaviour; Widget runtime.
- **Backend:** None beyond config.
- **Acceptance criteria:**
  - With sound disabled, no audio element plays on incoming messages.
  - The unread count shown equals the number of agent messages since the visitor last viewed the chat.
  - The `unreadMessages` event fires with the new count on every change (A-13).

### A-06 · Pre-chat form
- **Historical behavior:** An admin toggle required visitors to give details before chatting. Configurable fields were name, email, phone, department and question, and each could be marked required.
  - The phone option appeared only after a separate "allow phone number" visitor-profile setting was enabled.
  - The department option needed departments to exist.
  - A proactive trigger message bypassed the pre-chat form, so a visitor who replied to one started a chat with no contact details.
  - A trigger set to run on widget load also overrode the pre-chat form [HC01].
  - Greeting text and department label were customizable. The visitor's department list could be filtered or preselected by API.
- **Source:** AR04; AR19; HC01; DV19 (`prechatForm.greeting`, `departmentLabel`; `departments.enabled/select`); DV20.
- **Confidence:** High.
- **Required implementation:**
  - A form builder with fixed fields (name, email, phone, department, message), each optional or required.
  - Department picker filtered to enabled departments, showing each department's online or offline status.
  - Greeting text.
  - Prefill and read-only values from the runtime API.
  - Reproduce the bypass rule: when an agent or trigger started the conversation, do not show the form. Optionally ask for missing email later (see C-15).
- **UI:** Chat Widget settings → Forms; Widget runtime.
- **Backend:** Validate submitted fields server-side: email format, phone ≤ 25 characters, name ≤ 255 characters [AR53]. Persist to the visitor profile and the chat.
- **Acceptance criteria:**
  - With name and email required, the visitor cannot send a first message until both pass validation.
  - The selected department is stored on the chat and routes the chat (A-22).
  - A conversation that opened with a proactive message accepts a visitor reply without showing the form.
  - Prefilled read-only fields cannot be edited by the visitor.

### A-07 · Offline form and offline messages
- **Historical behavior:**
  - When the account, or the selected department, was offline, the widget showed an offline form instead of chat. It was on by default with an editable greeting, and paid plans could disable it.
  - Submitted fields were name and email (required), optional phone, the message, and an optional department.
  - Offline messages were stored as a separate chat type (`offline_msg`) with an unread flag. By default they were emailed to every agent, and each agent could opt out in personal settings.
  - The offline view could link out to Facebook Messenger and Twitter DM accounts.
  - Operating hours could be displayed on the offline form (A-44).
  - In integrated accounts the Support contact form could replace the offline form, and turning one on disabled the other.
- **Source:** AR05; AR16; AR53 (`sendOfflineMsg` fields and limits); DV02 (offline message object, `type: offline_msg`, `unread`); AR38.
- **Confidence:** High.
- **Required implementation:**
  - An offline form with configurable greeting and fields (name and email required, phone optional, department, message).
  - Show it automatically when the account or department has no eligible online agent.
  - Persist submissions as `offline_message` conversations with read/unread state.
  - Email notifications to agents, with per-agent opt-out and department targeting.
  - Optional social-channel links.
  - Optional display of operating hours.
- **UI:** Chat Widget settings → Forms; Inbox (offline messages view); Chat History; Settings → Personal → Notifications.
- **Backend:** `Conversation.type = offline_message`. Notification worker with an email queue. Rate limiting per IP (see C-11).
- **Acceptance criteria:**
  - With every agent offline, opening the widget shows the offline form within 1 s.
  - A submission creates an unread offline message visible in History and in the offline-message view, and emails every opted-in agent, or only the department's agents when a department was chosen.
  - An agent who opted out receives no email.
  - Marking the message read clears the unread flag for all agents.

### A-08 · Visitor-side chat lifecycle
- **Historical behavior:**
  - **Start:** a chat began when the visitor or an agent sent the first message. An agent-initiated chat added the visitor as a participant automatically.
  - **Participants:** each had a "nick". The visitor was `visitor`, an agent was `agent:<id>`, and trigger-sent messages appeared as `agent:trigger`. Join and leave events marked membership.
  - **Typing:** indicators worked in both directions.
  - **Read state:** the visitor's last-read timestamp was sent to agents, and unread counts were synchronized across the visitor's tabs.
  - **End:** a chat ended when the visitor ended it, closed the session, or went idle. An agent leaving did not end the visitor's session. The widget's chat-end callback fired only for visitor-ended or idle-ended chats.
  - **Idle timing:** after 20 minutes without visitor input the visitor was disconnected and the chat ended. Trigger conditions treated a visitor as "idle" after 10 minutes without mouse or keyboard input.
- **Source:** AR53 (Chat Participants, Starting/Ending a Chat, typing, `last_read`, 20-minute inactivity rule); AR52 (`setOnChatEnd` semantics); HC01 (10-minute idle definition); HC09 (timeouts, search summary).
- **Confidence:** High.
- **Required implementation:** Implement the conversation state machine `idle → requesting → queued → assigned → active → ended`. Specifically:
  - System participants for triggers and system messages.
  - Bidirectional typing events, throttled.
  - Visitor last-read markers shown to agents.
  - Cross-tab unread sync.
  - End conditions: visitor ends, visitor idle ≥ 20 min (configurable, default 20), or all browser contexts closed for a grace period. Agent "leave" removes the agent but does not end the visitor session.
- **UI:** Widget runtime; Inbox.
- **Backend:** WebSocket gateway (`packages/contracts/realtime.ts`). Presence tracking per visitor across tabs. Session-timeout worker.
- **Acceptance criteria:**
  - Sending the first message emits `chat.start` exactly once.
  - Agent typing shows in the widget within 500 ms and clears within 3 s of the agent stopping.
  - With no visitor input for 20 min, the chat ends and moves to History.
  - When an agent leaves, the visitor can keep typing and the conversation re-enters the queue.

### A-09 · Queue position for waiting visitors
- **Historical behavior:** Waiting visitors were told their queue position.
  - Before October 2021 the widget showed how many visitors were ahead, did not update live, and lost the message on page change.
  - From October 2021 it showed the current position (1 means next), updated in real time, and survived refreshes and department transfers. The position counted the department's queue plus the account-level queue of chats with no department.
  - The Web SDK exposed `getQueuePosition()` and a `chat.queue_position` event, where 0 means not queued.
  - Under heavy load the platform could stop updating queue positions to save resources.
  - A trigger condition "queue size (account)" was added in October 2021.
- **Source:** AR35; AR53 (`getQueuePosition`, `chat.queue_position`, deprecated `chat.wait_queue`); AR49.
- **Confidence:** High.
- **Required implementation:**
  - Compute the position for each queued conversation: department queue plus the unassigned no-department queue, ordered by request time, with transferred chats placed at the back (A-29).
  - Push changes to the widget in real time and restore the position on reconnect.
  - Expose the position via the runtime API and as a trigger condition variable.
- **UI:** Widget runtime; Triggers (condition).
- **Backend:** Queue service on Redis sorted sets keyed by department, plus an event fan-out.
- **Acceptance criteria:**
  - Three visitors waiting in the same department see positions 1, 2 and 3. When #1 is served, the others update to 1 and 2 within 2 s.
  - A page refresh shows the same position.
  - A transfer to a department with a queue shows the new position.
  - A visitor not in a queue reports position 0.

### A-10 · File sending
- **Historical behavior:** Agents and visitors could send files by drag-and-drop or a picker, on Team plans and above.
  - Default allowed types were PDF, PNG, JPEG, GIF and TXT. Admins could switch file sending off entirely, or allowlist more extensions after acknowledging the risk.
  - The limit was 20 MB per file. Older Web SDK versions allowed 5 MB.
  - Files appeared in the transcript and in History with a link and thumbnail. Agents and admins could delete individual attachments, though the link could stay live for up to 24 hours.
  - The SDK returned typed errors: not supported, not allowed, connection error, invalid extension, size exceeded, internal error, unknown.
  - Agents could not share files in agent-to-agent chats.
- **Source:** AR24; AR40; AR25; AR53 (`sendFile` errors and 20 MB limit); HC04.
- **Confidence:** High.
- **Required implementation:**
  - File upload in both widget and Inbox.
  - Per-workspace on/off switch and extension allowlist, with defaults matching the reference and explicit risk acknowledgement.
  - 20 MB limit, configurable downward.
  - Server-side MIME sniffing and malware-scan hook.
  - Thumbnails for images.
  - Deletion of attachments from History.
  - Signed, expiring download URLs, so a deleted file is unreachable immediately. This is an improvement over the reference's 24-hour window.
- **UI:** Settings → File sending; Inbox; Widget runtime; Chat History.
- **Backend:** Object storage, upload service with typed errors that mirror the reference list, and a deletion job.
- **Acceptance criteria:**
  - A 21 MB upload is rejected with a size error, and an `.exe` with an extension error, unless allowlisted.
  - With file sending off, the attach control is hidden on both sides and the API returns "not allowed".
  - A deleted attachment's URL returns 404/410 within 60 s.

### A-11 · Chat satisfaction rating
- **Historical behavior:**
  - **Enabling:** one widget setting turned on a good/bad (thumbs) rating for all visitors. Icons and text could not be customized.
  - **Rating and comment:** visitors could rate at any time during or after the chat and were then invited to comment. They could change or remove the rating. Every change was recorded in the transcript, and only the last rating and comment counted.
  - **Prompting:** when the agent or visitor left, visitors who had not rated or commented were prompted. Agents could also request a rating mid-chat, which showed the visitor a rate-this-chat link.
  - **Where ratings appeared:** live in the chat panel and in the History list. History could be searched by rating and exported. In 2019 ratings were not yet reportable in Analytics.
  - **Support CSAT:** a ticket created from a rated chat carried the chat rating into Support CSAT.
  - **Engagements:** per-engagement ratings existed in the export API.
- **Source:** AR14; AR53 (`sendChatRating` with `good|bad|null`, `sendChatComment`, `chat.request.rating`, `chat.rating` with `rating`/`new_rating`); DV02 (`rating`, `comment`); DV14 (engagement `rating`/`comment`).
- **Confidence:** High.
- **Required implementation:**
  - Binary rating with an optional comment. Both are mutable and the last value counts.
  - A system event in the transcript for each change.
  - End-of-chat prompt when the rating or comment is missing.
  - Agent "request rating" action.
  - Searchable and exportable rating fields.
  - Attribution of the rating to each engagement (agent) as well as the whole chat.
- **UI:** Chat Widget settings → Behaviour (enable); Widget runtime; Inbox (live rating badge and request button); Chat History (filter); Analytics (satisfaction).
- **Backend:** `rating` and `ratingComment` on the conversation and the engagement. Rating events in the message log.
- **Acceptance criteria:**
  - Rating good, then bad, leaves `bad` as the chat rating, with two rating events in the transcript.
  - Removing the rating sets it to null.
  - The agent's request inserts a rating prompt in the widget.
  - History filtered by `rating:bad` returns only bad-rated chats.

### A-12 · Transcripts: visitor email, agent export, email piping
- **Historical behavior:** Transcripts could leave the system in four ways:
  - **Visitor request:** from the widget's options menu the visitor entered an email address and the transcript was sent when the chat ended. Integrators could hide this menu item.
  - **Agent export:** an agent could choose an export-transcript action in the chat and email it to a typed address, also sent at chat end.
  - **Email piping:** an account-level setting sent every finished chat's transcript to one or more fixed addresses.
  - **History export:** transcripts could be exported from History as .txt files, by agents one at a time and by admins in bulk.
  - The SDK said to allow transcript requests only while a chat is active. Authenticated visitors could request the most recent past chat.
- **Source:** AR21; HC06; HC08; AR53 (`sendEmailTranscript`); DV19 (`menuOptions.emailTranscript`).
- **Confidence:** High.
- **Required implementation:**
  - Widget "email me this transcript" with email validation, queued for send at chat end.
  - Agent "send transcript" action.
  - Workspace-level transcript forwarding to N addresses.
  - TXT and PDF export from History.
  - A setting to hide the visitor option.
  - Rewrite all email copy from scratch.
- **UI:** Widget runtime; Inbox (actions menu); Settings → Transcripts; Chat History.
- **Backend:** Transcript renderer (text and HTML), outbound email queue, per-chat pending-transcript recipients list, idempotent send on chat end.
- **Acceptance criteria:**
  - A visitor requests a transcript mid-chat. Exactly one email arrives after the chat ends and contains every visitor-visible message, but no internal agent-only content.
  - With forwarding configured to 2 addresses, both get each transcript within 2 min of chat end.
  - With the visitor option disabled, the menu item is absent and the API rejects the request.

### A-13 · Widget JavaScript API, first generation (`$zopim.livechat`)
- **Historical behavior:** Calls were wrapped in a ready callback after the embed snippet. Some calls were unavailable on the Lite plan. The archived reference lists the following.
  - **Visitor data:** get and set name (≤ 255 characters), email and phone (≤ 25 characters), and a bulk setter. Name and email setters did nothing for authenticated visitors.
  - **Tags and path:** add and remove session tags (converted to lowercase), and push a virtual page view with URL and title. A page view re-fired "widget loaded" triggers.
  - **Settings:** sound on/off, Google Analytics events on/off, language, button greetings for online and offline, a status override (online or offline).
  - **Session:** clear all visitor data (also logs out an authenticated visitor), hide all, send a message as the visitor (starting a chat if needed), end the chat.
  - **Notes:** set and append visitor notes (dashboard-only).
  - **Authentication:** JWT authentication through a token-fetching function.
  - **Callbacks:** connected, chat start, chat end, status change (account or department; fires immediately once), unread count (fires immediately once).
  - **Sub-namespaces:** `window`, `button`, `badge`, `bubble`, `concierge`, `theme`, `departments` (filter list, set or clear the visitor's department, get one or all departments), `prechatForm`, `offlineForm`, `mobileNotifications` and `cookieLaw` (consent).
- **Source:** AR52 (full method list, archived 2019-10-07); DV20 (complete legacy method inventory, including sub-namespaces and deprecations); DV21.
- **Confidence:** High for the top-level methods (archived reference). Medium for the exact signatures of sub-namespace methods, whose per-page docs were not retrieved.
- **Required implementation:** A runtime API for our widget, `window.Talkivio` or similar with our own naming. It needs a command-queue stub so calls before load are buffered, and must cover the same capabilities:
  - identity setters and getters
  - tags add and remove
  - virtual page view
  - locale
  - sound
  - analytics-forwarding toggle
  - launcher label per status
  - show, hide, open, close, toggle and pop-out
  - send message as visitor
  - end chat
  - department filter, preselect, get and list
  - prechat and offline greeting
  - colours and position
  - consent gating
  - event subscriptions: ready/connected, chat start, chat end, status, department status, unread count, open/close, popout
  
  Do not offer visitor-note writes from the client. The reference later removed them for security (DV20); notes are agent and trigger only.
- **UI:** Widget runtime; Public API docs.
- **Backend:** All client-supplied identity is untrusted unless JWT-verified (A-16). Tags from the client are namespaced as "visitor tags" (A-34).
- **Acceptance criteria:**
  - Calls queued before the script loads run in order after load.
  - `setName` is ignored with a console warning when the visitor is authenticated.
  - Status callbacks fire once immediately with the current status and again on every change.
  - A virtual page view appends to the visitor path and re-evaluates page-load triggers.

### A-14 · Widget JavaScript API, second generation (Web Widget Classic `zE`)
- **Historical behavior:** In the integrated Web Widget most legacy calls were aliased. New calls covered:
  - send message, is-chatting, get one department or all departments, end chat, update path
  - connected, start, end, status, department status, unread messages, pop-out, popout event
  - add and remove tags, reauthenticate
  - prefill of name, email and phone with a read-only flag
  
  Settings covered:
  - authentication (`jwtFn`), badge, concierge
  - lazy connect (`connectOnPageLoad`, which disables proactive chat and some analytics when off)
  - departments (`enabled` filter, `select` default)
  - `hideWhenOffline`, `menuOptions.emailTranscript`, `navigation.popoutButton`
  - prechat and offline greetings, mobile `notifications`, `profileCard`
  - `suppress`, title, colour, position, offset and zIndex
- **Source:** DV18; DV19; DV20.
- **Confidence:** Medium. These are current docs for a product in use from about 2018 to 2021, but exact introduction dates were not verified.
- **Required implementation:** The same capabilities as A-13, plus prefill-with-read-only and a settings object read at boot. Add a "connect on interaction" performance mode that documents which features it disables: proactive messages and live visitor tracking.
- **UI:** Widget runtime; Public API docs.
- **Backend:** Same as A-13.
- **Acceptance criteria:**
  - With lazy connect on, no WebSocket opens until the launcher is clicked, and the visitor does not appear in Live Visitors until then.
  - `prefill({email:{value, readOnly:true}})` locks the email field in the pre-chat form.

### A-15 · Web SDK for fully custom widgets
- **Historical behavior:** On Enterprise and Premium plans, a headless JavaScript SDK (`zChat`) let customers build their own UI. It provided:
  - **Session and identity:** init with account key (optionally with JWT), account and connection status, get and set visitor info. An empty name produced an auto-generated "Visitor ######" name.
  - **Departments:** list, get, set and clear the default department.
  - **Messaging:** send message, file, offline message, typing state, mark as read.
  - **Tags and path:** add and remove tags (single and batch), send visitor path.
  - **Rating:** rating and comment get and set.
  - **Chat data:** chat log, serving-agent info, queue position.
  - **Hours:** operating hours, as a schedule object per weekday with minute-of-day periods and the account timezone.
  - **Other:** email transcript, fetch past chat history (authenticated visitors only), reconnect, end chat (optionally clearing the department), logout.
  - **Events:** `account_status`, `connection_update` (connecting, connected, closed — for example when banned), `department_update`, `visitor_update`, `agent_update` (nick, name, avatar, title) and `chat`, with types `chat.msg` (with shortcut `options` and `structured_msg`), `chat.file`, `chat.queue_position`, `chat.memberjoin`, `chat.memberleave`, `chat.request.rating`, `chat.rating`, `chat.comment`, `typing` and `last_read`.
- **Source:** AR53 (archived 2020-06-17).
- **Confidence:** High.
- **Required implementation:** Publish a typed headless client SDK, `@talkivio/client`, generated from `packages/contracts/protocol.ts`, with equivalent methods and events. Our own widget should use the same SDK, so the two stay at parity.
- **UI:** Public API docs.
- **Backend:** The SDK uses the same WebSocket protocol and REST endpoints as the widget.
- **Acceptance criteria:**
  - A sample app built only on the SDK can request, chat, upload, rate, receive queue updates and leave an offline message.
  - Every SDK event in the parity list has a typed payload and a contract test.

### A-16 · Authenticated visitors (JWT) and cross-device history
- **Historical behavior:** Visitors could be authenticated from 2018 onward. This was not a later addition.
  - **Secret:** an admin generated a shared secret under the widget security settings. It was shown in full once and could be regenerated, which revoked the old secret and could disconnect visitors for about 5 minutes.
  - **Token:** the site's server signed an HS256 JWT containing name, email, `external_id`, `iat` and `exp`. The `external_id` was unique per customer and could not be changed once set. Clock skew of up to 2 minutes was allowed on `iat`, and `exp` could be at most 7 minutes after `iat`. RS256 and ES256 were not supported.
  - **Widget flow:** the widget called a page-supplied function that fetched a fresh token, and could call it again during a session. Clearing visitor data logged the visitor out. In the standalone widget, a single-page app could not re-authenticate after logout without a reload. The later Web Widget added a reauthenticate call.
  - **Benefits:** a verified identity, one visitor across domains and devices, continuing a chat on another device, and scrolling back through past conversations in the widget. The Web SDK fetched history in pages.
  - **Restrictions:** API calls that change the verified name or email were refused for authenticated visitors.
  - **Availability:** all paid plans. Not available on the mobile SDKs at the time.
- **Source:** AR42; AR47; AR52 (`authenticate`, `clearAll`); AR53 (`fetchChatHistory`, `logout`); DV18 (`chat:reauthenticate`).
- **Confidence:** High.
- **Required implementation:**
  - A per-website identity-verification secret with generate, rotate and revoke.
  - HS256 JWT verification with claims `name`, `email`, `external_id`, `iat` and `exp`, a 2-minute skew allowance and a maximum lifetime of 7 minutes, both configurable.
  - Token refresh through a page-supplied fetch function.
  - Logout and reauthenticate without reload, which improves on the standalone reference.
  - Merge into one visitor identity keyed by `external_id` across devices.
  - Past-conversation history in the widget.
  - Server-side lock on verified name and email.
  - **Rotation overlap window (improvement):** during rotation, accept the old and new secrets for N minutes so visitors are not disconnected.
- **UI:** Websites → Identity verification; Widget runtime.
- **Backend:** JWT verifier, `Visitor.externalId` unique per workspace, paginated history endpoint scoped to the authenticated visitor, and a dual-secret grace window.
- **Acceptance criteria:**
  - A token with `exp - iat` greater than 7 min, a bad signature, an algorithm other than HS256, or `iat` more than 2 min in the future is rejected and the visitor stays anonymous.
  - Two devices authenticated with the same `external_id` show one visitor and share the active chat.
  - After rotation with a 10-minute grace window, tokens signed with the old secret are accepted for 10 min, then rejected.
  - Client `setName` calls are ignored for verified visitors.

### A-17 · Widget security: domain allowlist and country blocklist
- **Historical behavior:** In the widget security settings, admins could:
  - block whole countries from loading the widget;
  - restrict the domains where the widget loads, to stop the snippet working on other people's sites. Domains matched exactly, so a subdomain entry covered only that host, and a leading wildcard covered all subdomains. There was no limit on the number of entries.
  
  In integrated accounts these settings affected only chat, not help-centre or contact-form content. Spam guidance also suggested IP bans and country blocking.
- **Source:** AR43; AR34.
- **Confidence:** High.
- **Required implementation:**
  - A per-website domain allowlist with exact and `*.` wildcard matching, enforced on both widget config fetch and WebSocket handshake by checking `Origin`.
  - A country blocklist from GeoIP.
  - An admin warning when the allowlist would exclude the domain they are configuring from.
- **UI:** Websites → Security.
- **Backend:** Origin check middleware, GeoIP lookup at connect time, and a cached allowlist.
- **Acceptance criteria:**
  - With the allowlist `shop.example.com`, the widget loads on `shop.example.com`, does not load on `www.example.com`, and the handshake is refused for other origins.
  - With `*.example.com`, any subdomain loads.
  - A visitor from a blocked country gets no widget and appears in no Live Visitors list.

### A-18 · Visitor identity, auto-naming, sessions and visitor data
- **Historical behavior:**
  - **Naming:** anonymous visitors received generated names of the form "Visitor" followed by digits. Clearing the display name regenerated one. A default trigger template distinguished named visitors by checking the name does not contain "Visitor".
  - **Visitor IDs and sessions:** visitor IDs were account-scoped strings (example format `1.12345`). Each browsing session had its own ID and captured browser, platform (OS), user agent, IP, city, region, country code and name, and start and end times.
  - **Notes:** visitor profiles had notes, visible only to agents.
  - **Per-chat context:** chats stored the visitor's web path (from, to, title, timestamp) during the chat.
  - **Session timing:** a session started when the visitor first landed on a page with the widget and ended when they ended the chat or left the site.
- **Source:** AR53 (auto-generated display name rule); HC03 (default trigger "Proactive Greeting by Name"); DV02 (`session` and `webpath` fields); DV04 (visitor fields); AR26 (session semantics).
- **Confidence:** High.
- **Required implementation:**
  - Anonymous visitor naming as a localized prefix plus a short unique number. This is a display convention. Use our own wording, and make the prefix configurable.
  - A visitor model with profile (name, email, phone, notes, tags, externalId, banned).
  - Sessions with device and geo metadata.
  - A page-view path recorded per session and attached to chats.
- **UI:** Live Visitors; Inbox (visitor panel); Chat History.
- **Backend:** `Visitor`, `VisitorSession` and `PageView` tables. GeoIP and user-agent parsing at session start. IP storage subject to the privacy settings in C-07.
- **Acceptance criteria:**
  - A new anonymous visitor shows a generated name that is unique within the workspace.
  - Setting the name via the pre-chat form or API replaces it.
  - Each chat exposes the session's city, region, country, browser, OS, IP and page path.

## A.2 Agent availability and routing

### A-19 · Agent availability statuses
- **Historical behavior:** A logged-in agent was Online, Away or Invisible. Offline meant not logged in, or forced by schedule or idle rules.
  - **Online:** available for chats.
  - **Away:** an internal signal that the agent was away from the desk. They could still serve chats, and the classic widget showed Away to visitors.
  - **Invisible:** logged in but not shown as online. Under broadcast routing an invisible agent could still see and accept requests. Under assigned routing they received no assignments.
  - **Account rollup:** the account counted as Online if any agent was online, Away if none was online but one was away, and Offline otherwise. If every agent was invisible the widget appeared offline and **triggers did not fire**.
  - **Team list:** showed logged-in agents by department, with an admin flag and their current chat count.
- **Source:** AR17; HC01 (account status rollup); AR37 (triggers do not fire when no agents are online or all are invisible); DV16 (agents online, away and invisible metrics).
- **Confidence:** High.
- **Required implementation:**
  - Agent presence with states `online | away | invisible | offline`.
  - Account and department status rollup using the same rule.
  - Status rules applied in routing (A-22).
  - The rule that triggers which send visitor messages are suppressed when no agent is online or away. See Open Questions: decide whether to keep this.
- **UI:** Inbox header status switcher; Team panel (Agents online list).
- **Backend:** Presence service (Redis) with heartbeats. An agent with several tabs or devices counts once.
- **Acceptance criteria:**
  - With one agent Away and the rest offline, the widget shows away, or online if we choose not to show away; record the decision.
  - With all agents Invisible, the widget shows offline and proactive triggers do not send.
  - Under broadcast an invisible agent sees incoming requests; under assigned they receive none.

### A-20 · Personal idle timeout (auto-away)
- **Historical behavior:**
  - Each agent could enable an idle timeout that switched their status after N minutes of inactivity (default 15). The target status was Away or Offline/Invisible; the docs mention both.
  - An "ignore if chatting" option suppressed the switch while the agent had open chats.
  - A dialog told the agent when their status changed.
  - Operating-hours schedules overrode idle settings.
- **Source:** AR17.
- **Confidence:** High.
- **Required implementation:** Per-agent idle detection from dashboard activity, with configurable minutes (default 15), a target status (away or invisible), an ignore-while-chatting option and an in-app notice. Schedule rules take precedence.
- **UI:** Settings → Personal → Availability.
- **Backend:** Client activity pings plus a server-side timer, so a closed laptop still triggers the change.
- **Acceptance criteria:**
  - With a 15-min timeout and no activity, the status switches at 15 min ± 30 s.
  - With ignore-while-chatting on and one active chat, no switch happens.
  - During off-hours under a schedule, the schedule's forced status wins.

### A-21 · Incoming-chat notifications for agents
- **Historical behavior:**
  - Incoming requests appeared at the bottom of the dashboard with a count, and the agent clicked to serve.
  - Each agent had personal settings for desktop notifications, shown only when the dashboard was not visible and the browser allowed it, and for sound alerts. They could pick a sound for each type of event or turn it off.
  - Safari autoplay could block sounds.
  - Agents also received offline-message emails and could opt out.
- **Source:** AR16; HC04 (serve-request control); AR01 (assigned chats appear as animated tabs).
- **Confidence:** High for the feature set. Medium for the exact list of event types, which is not documented; see B-05.
- **Required implementation:**
  - Per-agent notification preferences: desktop on/off per event type and sound choice per event type.
  - Events covered: new incoming request, chat assigned to me, new visitor message in my chat, transfer or invite to me, visitor left, plus "visitor arrived" or "visitor requesting" in a quiet mode.
  - Browser notifications only when the tab is hidden.
  - An autoplay-unlock gesture.
- **UI:** Settings → Personal → Notifications; Inbox.
- **Backend:** Event fan-out to agent sockets. Web-push fallback is optional and modern.
- **Acceptance criteria:**
  - With the tab hidden and desktop notifications on, a new request shows an OS notification within 2 s.
  - With the tab focused, no OS notification appears, and sound plays only if enabled for that event.

### A-22 · Chat routing modes: broadcast vs assigned
- **Historical behavior:**
  - **Broadcast** (the default): every relevant agent was notified of every chat and had to click serve to take it. "Relevant" meant agents in the chat's department. That chats without a department went to all agents is our inference; no source states it.
  - **Assigned:** each chat went to exactly one online agent at a time. The pick order was:
    1. the online agent who had been available (not serving a chat) the longest;
    2. if every agent was busy, the agent with the fewest current chats;
    3. ties broken round-robin.
  - Assigned chats appeared as animated tabs.
  - Department routing limited both modes to department members.
  - Transferred chats re-entered the queue at the back.
  - Team plans could only enable routing; Professional and Enterprise could configure it.
- **Source:** AR01; AR18; HC04; DV13 (`routing_mode` broadcast, assigned or hybrid).
- **Confidence:** High.
- **Required implementation:** A routing engine with two modes.
  - **Broadcast:** notify every eligible agent (online, or invisible under broadcast, below their chat limit, and in the department). The first to accept wins; this is an atomic claim.
  - **Assigned:** choose the agent with the longest time since they last became idle, then the lowest active chat count, then round-robin among ties.
  
  Department membership filters eligibility. Every assignment, acceptance and skip is logged as an engagement record (A-58).
- **UI:** Settings → Routing; Inbox.
- **Backend:** Routing service with per-department queues and an agent load index. Idempotent claim via compare-and-set. Engagement log.
- **Acceptance criteria:**
  - **Broadcast:** two agents click accept at the same time. Exactly one becomes the server and the other sees "already served" within 1 s.
  - **Assigned with 3 idle agents:** the chat goes to the one idle longest.
  - **Assigned with everyone busy at 1, 2 and 2 chats:** the chat goes to the agent with 1.
  - **Ties:** six chats in a row distribute round-robin among tied agents.

### A-23 · Chat limits (concurrency caps)
- **Historical behavior:**
  - A cap on simultaneous chats was set either account-wide or per agent (0–20).
  - Under per-agent limits, admins could let agents set their own limit, and custom roles could grant permission to set limits.
  - **Broadcast:** an agent at their limit stopped receiving notifications and could not serve.
  - **Assigned:** routing stopped at the limit unless hybrid mode was on.
  - Limits did not change the widget's online status. Visitors could still start chats, which queued.
  - The workload measure later documented counts a chat as active if it had a response within the last 10 minutes (current docs).
- **Source:** AR01; DV13 (`chat_limit.enabled/limit 0–20/limit_type account|agent/allow_agent_override`; agent `routing.chat_limit`); AR23 (agent view of their own limit); AR13 (permission to set agent limits). The 10-minute activity rule comes from a current Zendesk article (search summary in the routing search) and is Low confidence for the period.
- **Confidence:** High, except the active-chat definition, which is Low.
- **Required implementation:**
  - Account and agent limit modes (0–20, 0 meaning no new chats) and an agent self-service override toggle.
  - Enforce limits in both routing modes.
  - Keep the widget online while queueing.
  - **Open decision:** whether "active" excludes chats where the visitor has been silent for more than X minutes. See Open Questions.
- **UI:** Settings → Routing; Agents (per-agent limit); Settings → Personal.
- **Backend:** Load index per agent, updated on chat join, leave and end.
- **Acceptance criteria:**
  - With limit 2 and 2 active chats, a broadcast agent sees new requests disabled and an assigned-mode agent receives none.
  - With `allow_agent_override`, an agent can change their own limit; otherwise the field is read-only with an explanatory message.

### A-24 · Hybrid assignment mode
- **Historical behavior:** Under assigned routing with limits on, hybrid mode let agents who had reached their limit still pick up extra queued chats manually with serve. Without it they could see requests but not take them.
- **Source:** AR01; DV13 (`routing_mode` hybrid).
- **Confidence:** High.
- **Required implementation:** A toggle in assigned mode that allows manual claims above the limit, while auto-assignment still respects it.
- **UI:** Settings → Routing.
- **Backend:** Routing claim path checks the hybrid flag.
- **Acceptance criteria:**
  - With hybrid on, an agent at their limit can claim a queued chat.
  - With hybrid off, the claim button is disabled and the API returns 409.

### A-25 · Reassignment on non-response and automatic idle
- **Historical behavior:**
  - Under assigned routing, an optional reassignment moved a chat to another agent if the assignee had not responded within a timeout (UI example 15 s; API range 10–120 s). Without it, assignment was permanent.
  - Automatic idle, which required reassignment, switched an agent to Away or Invisible after N chats were reassigned away from them (1–20). The agent was notified.
  - Auto-accept existed only with Agent Workspace (post-2019) and was incompatible with broadcast, reassignment and auto-idle.
- **Source:** AR01; DV13 (`reassignment.timeout 10–120`, `auto_idle.reassignments_before_idle 1–20`, `new_status away|invisible`, `auto_accept` constraints).
- **Confidence:** High.
- **Required implementation:**
  - Reassignment timeout (10–120 s).
  - An auto-idle threshold (1–20) with a target status.
  - An auto-accept option. Our improvement: make it a routing mode option that is mutually exclusive with reassignment, matching the reference constraint.
  - Record each reassignment on the engagement log, with `assigned=true, accepted=false`.
- **UI:** Settings → Routing.
- **Backend:** Assignment timers (delayed jobs). Counter of consecutive misses per agent.
- **Acceptance criteria:**
  - With a 15 s timeout and no agent action, the chat moves to the next eligible agent at 15 s ± 1 s.
  - After 3 reassignments with threshold 3, the agent's status becomes the configured idle status and they see a notice.
  - Enabling auto-accept with reassignment on is rejected by validation.

### A-26 · Skills-based routing
- **Historical behavior:** Enterprise only, and assigned routing only.
  - Admins created and enabled skills, and assigned up to 5 to each agent, singly, in bulk or by self-assignment.
  - Visitors received up to 5 skill tags through triggers or the JS API. Country-code tags had to be uppercase.
  - A chat went only to an agent holding **all** of the visitor's skills.
  - After a maximum wait (5–300 s) the chat fell back to any agent in the department, based on concurrent load.
  - Agents who were Away, Invisible or Offline were excluded.
  - Exports recorded the skills requested and whether they were fulfilled.
- **Source:** AR31; DV11; DV13 (`skill_routing.max_wait_time 5–300`); DV14 (`skills_requested`, `skills_fulfilled`); AR26 (`skills`, `skill_match`).
- **Confidence:** High.
- **Required implementation:** Skills CRUD; agent skill assignment (max 5); visitor skill assignment via triggers and API (max 5); superset matching; fallback after max wait; reporting fields for requested and fulfilled skills.
- **UI:** Settings → Routing → Skills; Agents; Triggers (action).
- **Backend:** Matching filter in the routing engine and a fallback timer.
- **Acceptance criteria:**
  - A visitor with skills {es, billing} is not routed to an agent with only {es}.
  - After max wait (for example 30 s) with no fully skilled agent free, the chat goes to the least-loaded department agent and is marked `skills_fulfilled=false`.

## A.3 Agent workspace (Inbox)

### A-27 · Chat panel: serving, composing, visitor context
- **Historical behavior:**
  - **Picking up chats:** clicking serve opened a window showing the visitor's first message, any automated messages, and a joined notice. Agents could also open a queued chat from the visitor list and read it, then reply directly, which served it.
  - **Composer:** shortcut suggestions appeared as the agent typed. Typing was visible to visitors. There were controls for emoji, attachments and requesting a rating, and Enter sent the message.
  - **Visitor context:** contact info (editable, with role permission), past chats with full transcripts, notes, tags, visit and chat counts, browsing path, location, browser, device and IP.
  - **Multiple chats:** handled as tabs or windows. A 2018 redesign (early access) added a list of ongoing chats showing visitor name, status, message preview, read status and time since the last reply.
- **Source:** HC04; HC08 (user info contents); AR51; AR13 (permissions to edit visitor info and notes); AR53 (`last_read`).
- **Confidence:** High for capabilities. Medium for exact layout, which comes from current docs plus the 2018 announcement.
- **Required implementation:** An Inbox with:
  - **Conversation list** (my chats, queued, offline messages) showing preview, unread state, time since last visitor message and read receipts.
  - **Conversation pane** with composer (shortcuts autocomplete, emoji, attachments, rating request), typing indicators and system events.
  - **Visitor side panel:** editable identity, notes, tags, past chats, current page with path history, geo, device, IP, visits and chats counts, referrer and search terms, and the current department.
  
  Permission checks apply to edits.
- **UI:** Inbox.
- **Backend:** Conversation queries, a visitor-context endpoint and a role-permission guard.
- **Acceptance criteria:**
  - Opening a chat shows the visitor panel with every listed field populated where data exists.
  - An agent without edit-visitor permission sees read-only fields and the API returns 403.
  - The list orders chats by longest waiting visitor message by default.

### A-28 · Proactive (agent-initiated) chat
- **Historical behavior:** An agent picked any active visitor in the visitor list, typed a message and pressed Enter to start a chat. The pre-chat form was bypassed. Custom roles could allow or deny proactive chatting ("initiate and view", "view only" or "personal only"). Analytics tracked agent-initiated chats separately, including those the visitor never answered ("unresponsive").
- **Source:** HC04; AR13; DV12 (`proactive_chatting` listen-join, listen or own); AR11 (agent-initiated and unresponsive metrics); DV14 (`proactive`).
- **Confidence:** High.
- **Required implementation:** A "start chat" action on any live visitor (subject to role). It creates a conversation with `startedBy=agent` and `proactive=true` and opens the widget with the agent's message.
- **UI:** Live Visitors; Inbox.
- **Backend:** Conversation-create path for agent initiation and a widget push to open.
- **Acceptance criteria:**
  - An agent with the permission sends a message to a browsing visitor. The widget opens with that message and no pre-chat form.
  - If the visitor never replies, the chat is classed as unresponsive in reports.
  - An agent without the permission gets 403.

### A-29 · Transfer, invite and agent-to-agent chat
- **Historical behavior:**
  - From the chat's actions menu an agent could invite another agent (staying in the chat), transfer and leave, or transfer to a department.
  - A transferred chat went to the back of the routing queue.
  - An agent could not transfer to a department where they were the only online agent, and a transfer to their own department would not route back to them.
  - Departments with nobody online appeared greyed out, and forcing a transfer to one warned that it would end the session.
  - A "Team" panel let agents chat privately with each other, without file sharing.
  - Engagements recorded `started_by=transfer` for department transfers.
- **Source:** HC04 (current text); DV14 (engagement `started_by` includes transfer); AR17 (Team panel).
- **Confidence:** Medium. The flows come from current docs, with the export field corroborating that they existed in the period.
- **Required implementation:** Invite agent, transfer to agent, transfer to department (re-queued at the back), and internal agent-to-agent DMs. Validate that the target department has an eligible agent other than the requester, and warn otherwise. Record each hop as an engagement.
- **UI:** Inbox (actions), Team panel.
- **Backend:** Routing re-queue with a reason; engagement records; internal-message channel kept separate from visitor transcripts.
- **Acceptance criteria:**
  - Transfer to a department with one other online agent queues the chat behind existing waiting chats and removes the sender when the new agent accepts.
  - Transfer to a department with no one online shows a warning and needs explicit confirmation.
  - Agent-to-agent messages never appear in visitor transcripts or exports.

### A-30 · Listening and joining (supervision)
- **Historical behavior:** Role permissions controlled supervision:
  - **"listen":** view any chat the agent could see.
  - **"listen-join":** view any chat and proactively join it.
  - **"own":** neither.
  
  Keyboard docs distinguish closing a chat being served (which ends it) from closing one being listened to (which just closes the window), so listening was a distinct mode.
- **Source:** DV12; AR13; AR41.
- **Confidence:** Medium. The permission semantics are explicit, but the listen UI details (for example whether the visitor sees anything) are not documented; see B-16.
- **Required implementation:**
  - A supervisor can watch any visible chat silently, read-only, and the visitor gets no indication.
  - A supervisor can join a chat. The visitor sees an agent-joined event and the join creates an engagement.
  - Both are permission-gated.
- **UI:** Inbox; Live Visitors.
- **Backend:** Read-only subscription to conversation events; join path creates the engagement.
- **Acceptance criteria:**
  - A listening supervisor receives live messages, produces no visitor-visible event, and cannot send until they join.
  - An agent with `own` cannot open other agents' active chats (403).

### A-31 · Ending, leaving and re-opening chats
- **Historical behavior:**
  - An agent closed a chat from the window (with an end-chat confirmation where tags could be added), or by keyboard shortcut. For the agent this ended their participation.
  - Officially, a chat truly ended only when the visitor ended it or idled out. Agents (and triggers) could only leave.
  - If the visitor ended first, the agent could close the window or continue the chat.
  - Chats reached History only after ending or timing out.
- **Source:** HC04; AR52 and DV18 (chat-end semantics); HC09 (search summary: agents cannot end, only leave); AR08.
- **Confidence:** Medium. Current and archived sources agree on the semantics, but the UI labels differ between them.
- **Required implementation:**
  - An agent "leave or close" action with an optional tag prompt.
  - An optional workspace policy that lets the agent end the chat for the visitor, as a modern option that is off by default for parity.
  - Visitor "end chat".
  - Agent "continue" after the visitor ends, which reopens within a grace window.
  - Archive to History on end.
- **UI:** Inbox; Widget runtime.
- **Backend:** State machine (A-08); archive job.
- **Acceptance criteria:**
  - When an agent closes and leaves, the visitor can keep sending, and the chat re-queues.
  - When the visitor ends, the chat appears in History within 10 s and the widget shows the ended state plus the rating prompt (A-11).

### A-32 · Dashboard keyboard shortcuts
- **Historical behavior:**
  - A help overlay listed the shortcuts. Shortcuts could be disabled in personal settings, and were not available inside the Support-embedded dashboard.
  - The documented combinations were:
    - Ctrl+number: open chat N
    - Ctrl+, or Ctrl+Esc: minimize
    - Ctrl+.: close (ends a served chat; closes a listened one)
    - Ctrl+~: serve a request
    - Ctrl+Alt+;: focus tags
    - Ctrl+Alt+': focus composer
    - Ctrl+Alt+\: toggle current and past chats
    - Ctrl+Alt+/: open actions
    - Ctrl+Alt+[ and ]: previous and next chat
- **Source:** AR41.
- **Confidence:** High.
- **Required implementation:** Equivalent keyboard actions (our own key bindings, avoiding browser conflicts): open chat N, next/previous chat, accept next request, focus composer, focus tags, open actions, minimize, close/leave, toggle visitor history. Add an overlay listing them and a per-agent disable toggle.
- **UI:** Inbox; Settings → Personal.
- **Backend:** None.
- **Acceptance criteria:**
  - Every action is reachable by keyboard only.
  - The overlay lists the current bindings.
  - Disabling stops all handlers except the overlay toggle.

## A.4 Productivity content: shortcuts, tags, notes

### A-33 · Shortcuts (canned responses)
- **Historical behavior:**
  - **Fields:** each shortcut had a short name and a full message. The name could not contain `/`, `\` or `$`, and was also the shortcut's ID in the API.
  - **Placeholders:** the message could include placeholders from an insert-placeholder picker. `{{visitor_name}}` was confirmed and inserted the full name. There was no first-name-only placeholder.
  - **Options:** a shortcut could carry answer options. When sent, the visitor saw them as radio buttons, and the Web SDK `options` array came through on the message.
  - **Tags:** a shortcut could add tags to the chat when used.
  - **Scope:**
    - personal ("me only"): Team plan and above, created by agents or admins
    - department (one or more departments): Professional and above, admin-created
    - global: all plans, admin-created
  - **Management:** shortcuts could be edited, cloned, deleted and reassigned to another scope in bulk.
  - **Permissions (Enterprise roles):** all, department, personal or none.
  - **Using a shortcut:** the agent typed the start of the name, or typed `/` on its own to list the first 10. Typing more narrowed the list. Personal and department shortcuts were labelled. Arrow keys and Enter, or a click, inserted the full text.
  - **Limit:** 15,000 shortcuts per account.
- **Source:** AR02 (2019); HC05; DV08 (fields, 15,000 limit, `scope`, `departments`, `agents`, `tags`, `options`); DV12 (`manage_shortcuts`); HC12 (placeholder, search summary); AR53 (`options` on `chat.msg`).
- **Confidence:** High for model and invocation. Low for the full placeholder list (see B-02). The **`#hashtag` invocation in our brief is not supported by evidence**: the reference used a bare `/` or the name prefix (see B-01).
- **Required implementation:**
  - Shortcut CRUD with name validation (no `/`, `\` or `$`; unique per scope), message, placeholders, options (ordered list) and tags.
  - Scopes: personal, department(s) and global.
  - Clone, bulk reassign and CSV import/export (CSV is our addition).
  - Composer autocomplete triggered by `/` (shows the first 10) and by a prefix match at the start of input. If our spec requires `#`, support it in addition, as a configurable trigger character.
  - Server-side placeholder rendering at send time, with fallback values for missing data.
  - Options render as quick-reply choices in the widget; the visitor's choice is sent back as their message.
- **UI:** Shortcuts page; Inbox composer.
- **Backend:** `Shortcut` entity (scope, departmentIds, ownerAgentId, tags, options), with a per-agent visibility query (personal + their departments + global). Placeholder engine in `packages/contracts/logic`.
- **Acceptance criteria:**
  - Typing `/` alone lists 10 shortcuts the agent can see. Typing `/ref` filters to names starting with "ref".
  - Personal and department shortcuts carry scope labels.
  - Sending a shortcut with `{{visitor_name}}` to visitor "Ana Lima" delivers "… Ana Lima …".
  - A shortcut with options shows choices in the widget, and choosing one posts it as a visitor message.
  - A shortcut with tag `refund` adds `refund` to the chat's tags.
  - Creating a 15,001st shortcut is rejected.

### A-34 · Chat tags vs visitor tags
- **Historical behavior:** There were two kinds of tag.
  - **Chat tags** described a conversation's content.
    - Only admins could create them, in a predefined list. With an allow-creation setting on (the default), admins could also create them inline in shortcuts, the chat panel and History.
    - Agents picked tags from the list. Removing a tag from the list did not strip it from past chats.
    - Up to 140 characters, with no spaces or special characters.
    - Admins could edit tags on past chats in History; agents could not, unless a custom role allowed it.
  - **Visitor tags (API and trigger tags)** described the visitor.
    - Applied by the JS API or by triggers. Free-form, with spaces allowed.
    - Not added to the predefined list.
    - API tags were lowercased.
  - **Search:** History searched both kinds.
  - **Automatic tags:** the system added some tags itself, for example a credit-card-redaction tag (A-48).
- **Source:** AR39; AR50; HC11 (search summary for types and limits); AR52 (lowercasing); DV12 (`edit_chat_tags`); AR22.
- **Confidence:** High, except the 140-character and no-spaces rules, which are Medium (search summary).
- **Required implementation:**
  - Two tag namespaces: `conversation` tags, curated with an optional strict allowlist, and `visitor` tags, free-form and set by API or triggers.
  - A predefined tag list with an allow-inline-creation toggle.
  - Normalization rules (lowercase; length ≤ 140; charset per namespace).
  - Tag editing in History governed by role.
  - System tags carry a reserved prefix.
- **UI:** Settings → Tags; Inbox (tag input); Chat History.
- **Backend:** Tag tables with namespace; GIN index for search.
- **Acceptance criteria:**
  - With allow-creation off, an agent cannot add a tag outside the predefined list (UI hides it; API returns 422).
  - A visitor tag added by trigger appears on the visitor and is searchable in History, but not in the predefined list.
  - Removing a predefined tag leaves historical chats unchanged.

### A-35 · Visitor notes
- **Historical behavior:** Each visitor had a free-text notes field. Only agents and the dashboard could see it, and role permission controlled editing. Triggers could replace or append to notes. The classic JS API could set and append notes, but these calls were later removed for security reasons. Notes also appeared in History, the CSV export and the Visitors API.
- **Source:** AR52 (`setNotes`/`appendNotes`); DV20 (deprecated for security); HC01 (trigger actions replace note and append note); DV12 (`edit_visitor_notes`); DV04 (`notes`); AR26 (`visitor_notes`).
- **Confidence:** High.
- **Required implementation:**
  - Visitor notes editable by permitted agents.
  - Trigger actions that set or append.
  - Notes never exposed to the widget or any client-side API.
  - Note history (audit) as a modern improvement.
- **UI:** Inbox visitor panel; Chat History.
- **Backend:** `Visitor.notes` plus a `VisitorNoteRevision` table.
- **Acceptance criteria:**
  - No widget or SDK call can read or write notes.
  - Trigger "append note" adds a line with a timestamp.
  - An agent lacking permission gets 403 on edit.

## A.5 Live visitors

### A-36 · Live visitor list (real-time visitors activity)
- **Historical behavior:** A real-time list of everyone currently on pages carrying the widget, with browser, OS, location, pages and referrer.
  - **Categories:**
    - incoming chats (only those in the viewing agent's departments)
    - assigned
    - chat button clicked but not started
    - trigger activated (incoming took precedence)
    - currently served
    - active website visitors
    - idle website visitors
    - offline visitors (visual view only)
  - **Columns:**
    - visitor
    - time online
    - latest message
    - viewing (number of widget pages viewed this session)
    - visits in the past year
    - chats
    - referrer
    - served by
  - **Grouping:** by activity (default), page title, page URL, country (from IP), serving agent, department, browser, search engine or search term.
  - **Views:** a list view and a heat-map-style visual view.
  - **Role limits:** the visitors an agent could see were limited by role to all, department or ones they were serving.
- **Source:** AR07 (archived 2020-12, article dated 2020-12-10, first published 2018-08-13); DV12 (`visitors_seen`).
- **Confidence:** High.
- **Required implementation:**
  - A Live Visitors page fed by presence events, with the categories, columns and groupings above.
  - Row actions: start chat (A-28), view details, ban (A-38).
  - Role-based visibility.
  - Sorting by any column. Sorting is not documented for the reference (see B-04), so it is our addition.
  - The visual or map view is optional (P2).
- **UI:** Live Visitors.
- **Backend:** Presence store keyed by workspace (Redis). Page-view events. Search-engine and search-term extraction from referrer parameters where present.
- **Acceptance criteria:**
  - A new tab with the widget appears in the list within 3 s.
  - It moves to "idle" after 10 min without input.
  - It disappears within 2 min of closing the tab.
  - Grouping by Page URL buckets visitors by current URL.
  - An agent with `visitors_seen=department` sees only visitors on chats in their departments, plus unassigned browsing visitors if the policy says so; record the decision in the Open Questions.

### A-37 · High-load visitor dashboard and load shedding
- **Historical behavior:**
  - For sites with 5,000 or more concurrent visitors, paid plans could switch to a high-load dashboard. It showed only incoming and currently served chats, not browsing visitors.
  - Under extreme load the platform could step down automatically, showing a banner each time:
    - stop updating queue positions;
    - auto-enable the high-load dashboard;
    - force the offline form for new visitors while serving existing chats;
    - pause page-view events and new chats.
- **Source:** AR07; AR49.
- **Confidence:** High.
- **Required implementation:**
  - A "high-load mode" toggle that hides browsing visitors.
  - Automatic degradation tiers with dashboard banners and a recovery hysteresis. Thresholds are configurable by ops, not by customers.
- **UI:** Settings → Live Visitors; Inbox banner.
- **Backend:** Load metrics; feature flags per workspace; circuit breakers on presence fan-out.
- **Acceptance criteria:**
  - In high-load mode Live Visitors shows only incoming and served chats.
  - When the tier-3 flag is set, new visitors see the offline form while ongoing chats keep working, and a banner explains the state.

### A-38 · Banning visitors
- **Historical behavior:**
  - **Ban from a chat:** the agent chose ban from the chat's actions, optionally gave a reason, and optionally also banned the IP. The chat-based ban used a browser cookie: it survived proxies and VPNs but not a different browser.
  - **IP ban:** admins could add IP bans with a reason in a banned-visitors list. These survived a browser change but not a proxy.
  - **List limits:** the dashboard list showed only the first 1,000 bans; the API returned the rest.
  - **Effect:** banned visitors could not use the widget, and an SDK connection closed with the banned status.
  - **API:** listed bans by type (visitor or IP) with `created_at`, `reason` and visitor name, and supported creating and deleting them.
  - **Permissions:** role permission covered both temporary cookie bans and permanent IP bans.
  - **Triggers:** a trigger action could also ban a visitor.
- **Source:** AR03; DV09; DV12 (`manage_bans`); AR53 (`connection_update` closed); HC02 (`banVisitor`, `banIp`).
- **Confidence:** High.
- **Required implementation:**
  - Ban by visitor (device cookie plus visitor ID, and `externalId` when authenticated).
  - Ban by IP or CIDR (CIDR is our extension).
  - Reason, creator and timestamp on every ban. Optional expiry (modern).
  - A paginated list with no 1,000 cap.
  - Unban.
  - A trigger action.
  - The banned widget shows nothing, or a neutral unavailable state, and refuses connection.
- **UI:** Inbox (ban action); Live Visitors; Settings → Bans.
- **Backend:** Ban table with an indexed IP range lookup; enforced at WebSocket handshake and REST.
- **Acceptance criteria:**
  - After banning from a chat with "also ban IP" on, the visitor's socket closes. Reconnect attempts from the same browser and from another browser on the same IP are refused.
  - Deleting the ban restores access within 60 s.

### A-39 · Agent profile and personal settings
- **Historical behavior:** Each agent controlled:
  - display name (shown to visitors)
  - tagline or byline
  - avatar (50×50 recommended, 100 KB max)
  - dashboard language (about 30 languages)
  - viewing, and if permitted editing, their chat limit
  - skills (self-assignment)
  - keyboard shortcut toggle
  - idle timeout (A-20)
  - notification and sound preferences (A-21)
  - email preferences
  - password (in later generations managed centrally)
  
  The agent's display name, byline and avatar appeared in the widget, and the profile card could show the agent's rating.
- **Source:** AR23; AR20; AR31; AR41; DV19 (`profileCard`); AR53 (`agent_update` with `display_name`, `title`, `avatar_path`).
- **Confidence:** High.
- **Required implementation:** A personal settings area with all the items above. Use a validated, resized avatar upload (accept larger source images and resize to 128 px). Visitor-facing identity is separate from login identity.
- **UI:** Settings → Personal.
- **Backend:** `AgentProfile` (displayName, byline, avatarUrl, locale, prefs JSON).
- **Acceptance criteria:**
  - Changing display name or avatar updates the widget for chats the agent joins next, and for active chats within 10 s.
  - The UI rejects an avatar over the size limit before upload.

### A-40 · Agent mobile apps
- **Historical behavior:** iOS and Android agent apps with near-identical features:
  - serve chats and use shortcuts
  - agent-to-agent chat and transfer
  - live visitor list with proactive chat
  - past chats and visitor page paths
  - emailing transcripts
  - in-app and background alerts with the dashboard's sounds
  - push notifications that kept the agent reachable even when the app was closed
  - sync between app and dashboard
  
  The 2018 redesigned web agent experience was not available in the mobile apps.
- **Source:** HC07 (current); AR51 (2018 note on mobile apps).
- **Confidence:** Medium. Current documentation, though the apps existed throughout the period.
- **Required implementation:** P2. A responsive or PWA agent Inbox with web push first. Native apps later.
- **UI:** Inbox (mobile).
- **Backend:** Web Push (VAPID) and APNs/FCM later. The presence model must count a backgrounded mobile agent as reachable only while push is registered.
- **Acceptance criteria:**
  - On a phone browser an agent can accept, chat, use shortcuts and transfer.
  - With the PWA backgrounded, a new assigned chat produces a push notification within 5 s.

## A.6 Automation

### A-41 · Triggers (event → conditions → actions)
- **Historical behavior:** Admins created named triggers with a description and an enabled/disabled state, and could delete them permanently. Triggers did **not fire when no agents were online or all were invisible** [AR37].
  - **Events (one per trigger):**
    - *widget loaded* (`page_enter`): the visitor loaded a page with the widget but has not interacted. Overrides the pre-chat form. Re-fired by a virtual page-view API call.
    - *chat requested* (`chat_requested`).
    - *visitor message sent* (`chat_message`).
  - **Run-once option:** "each visitor receives this only once". When unchecked, the trigger fires every time the conditions match [AR37].
  - **Condition logic:** "all" or "any". The two cannot be mixed in one trigger.
  - **Condition variables and their limits:**
    - Hour of day (UTC, 0–23) and day of week (**0 = Monday … 6 = Sunday**).
    - "Still on site" and "still on page" checks in seconds (max 3,600). These act as delays before the next condition is evaluated.
    - Visitor IP, hostname, city, region (ISO-3166-2 for US/CA, FIPS elsewhere), country code (uppercase) and country name.
    - Previous visits (0 = first visit) and previous chats.
    - Page URL, page title, page count (1 = first page), previous page URL and referrer.
    - Visitor name, email, referrer, search engine (google, yahoo, bing, yandex) and search terms.
    - Visitor tags, "visitor triggered" flag and visitor department.
    - User agent, browser and platform.
    - Account status (online, away, offline), department status, and visitor status (online, idle after 10 minutes, offline).
    - Visitor is chatting, visitor requesting chat, visitor served.
    - Sender, sender type (visitor or agent), message text, and department chosen in the pre-chat form.
    - Account queue size (added October 2021).
  - **Operators:** =, ≠, <, >, ≤, ≥, contains and not-contains (case-sensitive and case-insensitive forms), and regex (Python-style, full match; case-sensitive and insensitive variants in the JSON) [HC01, HC02].
  - **Actions (ordered):**
    - Send a message to the visitor, as a named sender. Not sent if the account is offline. Opens the widget, which is the "proactive chat".
    - Set the "triggered" flag.
    - Wait N seconds.
    - Add tag and remove tag (visitor tags).
    - Set the visitor's name.
    - Set the visitor's department (works only on the widget-loaded event).
    - Replace note and append note.
    - Ban the visitor or ban the IP.
    - Request the visitor's email (continuous conversations). Its availability in the period is unclear; see B-11.
  - **Placeholders:** typed with `@` in action text, for example visitor name, city, page URL, time on page and site, tags, account status, hour and day, and referrer. Literal `@` in email addresses had to be doubled.
  - **Execution order:** triggers do not run in a guaranteed order, so a wait of at least 1 s was the advice for sequencing.
  - **Exceeding limits:** a trigger that broke a condition limit was disabled, with an error on re-enable.
  - **JSON definition:** event, condition as a prefix-notation tree such as `["and", [op, var, value], …]`, and an ordered actions array such as `[["wait", 5], ["sendMessageToVisitor", "Name", "text"]]`.
  - **Plan limits:** basic and advanced trigger caps (for example 2 each on Team in the sample account). Basic plans were limited to two proactive triggers [AR19].
  - **Reporting:** chats a trigger started counted as "trigger initiated" in reports.
  - **Typical uses** (documented recipes): auto-route by page URL, greet returning visitors, cart-abandonment nudges, pricing-page offers, add skill tags.
- **Source:** AR37 (2019 UI semantics, run-once, non-firing rule); HC01 (conditions, operators and actions, current); HC02 (JSON definition format, current); AR18; AR19; AR31; AR35 (queue-size condition, October 2021); DV05 (`max_basic_triggers`, `max_advanced_triggers`); AR11 (trigger-initiated metrics); AR52 (virtual page view re-fires triggers).
- **Confidence:** High for the events, run-once, all/any logic, core conditions and actions, and the non-firing rule. Medium for the full condition list: the current reference was used because the 2019 copy could not be retrieved, and some conditions (queue size, request email) postdate 2019.
- **Required implementation:** A trigger engine in `api:triggers` with:
  1. **Events:**
     - `widget_loaded`, fired on each page view, including virtual ones
     - `chat_requested`
     - `visitor_message`
     - our additions, flagged as modern: `chat_ended`, `agent_message`, `offline_message_submitted`, `visitor_idle`
  2. **Conditions:** the condition tree with the variables above, all/any at the top level (nested groups are an optional modern extension), and the operators =, ≠, <, >, ≤, ≥, contains, not-contains (case-sensitive and insensitive) and regex (full-match, with timeout protection).
  3. **Delays:** "still on site/page N seconds" implemented as delayed re-evaluation. The visitor must still be present and on the same page.
  4. **Actions:** an ordered list with `wait` and the same action set, including send message as a named agent persona, set department, tags, name, notes, ban, set triggered and request email.
  5. **Run-once:** a per-visitor-per-trigger fired-ledger.
  6. **Non-firing rule:** suppress message-sending actions when no agent is online or away (configurable; see Open Questions).
  7. **Placeholders:** use our own syntax (for example `{{visitor.name}}`) and accept the legacy `@visitor_name` form on import.
  8. **Safety:** loop protection (max actions and runs per visitor per minute), and validation of limits on save.
  9. **API and import:** a JSON import/export format equivalent to the reference definition, so migrations are possible.
- **UI:** Triggers page (list with enable toggles; editor with event, run-once checkbox, all/any, condition rows, action rows, placeholder picker); Analytics (trigger-initiated chats).
- **Backend:** Event bus from the realtime gateway; delayed-job scheduler (BullMQ) for wait and still-on-page; trigger audit log (fires, actions taken).
- **Acceptance criteria:**
  - **Proactive greeting:** event `widget_loaded`; conditions `still_on_site 30` AND `previous_visits = 0` AND `requesting_chat = false` AND `served = false`; action send message. A new visitor receives exactly one message about 30 s after landing. A returning visitor receives none.
  - **Run-once:** with the option checked, reloading the page 5 times sends the message once. With it unchecked, it sends 5 times.
  - **No agents:** with all agents invisible or offline, the trigger sends nothing.
  - **Auto-route:** `widget_loaded` with `page_url contains "pricing"`, action set department Sales. A chat started on `/pricing` is routed to Sales. The same action on `chat_requested` is rejected by validation.
  - **Ordering:** `wait 5` then `send` delivers the message 5 s (±1 s) after the event.
  - **Day of week:** a day-of-week condition uses 0 = Monday. Document this explicitly, because the Web SDK schedule uses 0 = Sunday (see A-44).
  - **Regex:** a regex condition that would run longer than 50 ms is aborted and the trigger is marked errored.

### A-42 · Default trigger templates
- **Historical behavior:** Accounts shipped with a set of example triggers, all **disabled** by default, which admins could customize and enable:
  - **chat rescuer:** on chat requested, if the account is not offline, the visitor has been on site 60 s and is not yet served, set triggered and send an apology asking for an email address.
  - **proactive greeting:** on widget loaded, after 30 s on site, for a first visit, if not requesting and not served, send a welcome.
  - **checkout page:** cart URL, 60 s.
  - **first reply:** on request, wait 5 s, then say an agent will be with you.
  - **languages:** country FR, send a French greeting.
  - **message tagged visitors:** tag contains `5times`.
  - **pricing page:** URL contains "pricing", 30 s.
  - **proactive greeting by name:** at least 1 previous visit, and name does not contain "Visitor".
  - **product discounts.**
  - **request contact details:** account Away, add a tag and ask for an email address.
  - **tag repeat visitors:** at least 5 previous visits, add tag `5times`.
- **Source:** HC03 (current). The 2019 version could not be retrieved.
- **Confidence:** Medium. The list is current and may differ from the 2018–2021 set.
- **Required implementation:**
  - Seed each new workspace with our own template triggers covering the same use cases, all disabled, written in our own copy: wait-time rescue, first-visit greeting, returning-visitor greeting by name, page-specific offers (cart, pricing), locale greeting, tag repeat visitors, away-mode contact capture, first-reply acknowledgement.
  - A template gallery to add more.
- **UI:** Triggers (templates).
- **Backend:** Seed data in `apps/api/prisma` seed.
- **Acceptance criteria:**
  - A new workspace has ≥ 8 template triggers, all disabled.
  - Enabling "first-visit greeting" works without edits.

## A.7 Organization

### A-43 · Departments
- **Historical behavior:**
  - **Definition:** admins created departments with a name, description, enabled flag and member agents. Agents could belong to several.
  - **Plan limits:** Team plans allowed 2 departments; Lite had none.
  - **Assigning a chat:** by the visitor's pre-chat choice, by a trigger's set-department action (on page load only), by the JS API (filter the visible list, preselect a default, clear it), or by an agent transfer.
  - **Routing effect:** a departmental request appeared only to that department's members, who still had to serve it under broadcast.
  - **Department status:** online, away or offline, derived from its members. Exposed to the widget, with change events, and to triggers.
  - **Other uses:** department-specific operating hours, department shortcuts, department-scoped role permissions (visitors seen, past chats), department filters in Analytics and Monitor, and department queue events in exports.
  - **API:** CRUD by ID or by name.
- **Source:** AR20; AR18; AR04; DV06; DV18/DV20 (department APIs); AR53 (department status); HC01 (department status condition); AR38; AR02; AR10; AR27; DV14 (`department_events` queue sizes); DV12.
- **Confidence:** High.
- **Required implementation:** Department CRUD with name, description, enabled and members. Assignment paths: pre-chat, trigger, API and transfer. Department-scoped routing, status rollup, schedules, shortcuts, permissions and reporting filters.
- **UI:** Departments page; Chat Widget settings → Forms (department picker); Analytics filters.
- **Backend:** `Department`, `DepartmentMember`; status computed from presence.
- **Acceptance criteria:**
  - A chat assigned to Billing is visible only to Billing members (and supervisors per role).
  - Disabling a department removes it from the widget picker within 60 s.
  - Department status changes emit a widget event.

### A-44 · Operating hours (schedules)
- **Historical behavior:** On Professional and Enterprise plans an admin enabled operating hours.
  - **Schedule type:** one account schedule, or department schedules (one schedule could cover several departments, and each department schedule needed at least one department).
  - **Pattern:** daily (per weekday) or weekday/weekend, with slider ranges of at least 1 hour in 15-minute steps.
  - **Outside hours:** agents were forced to Invisible and could not switch to Online, so the widget could be online only within hours. The schedule overrode idle settings.
  - **Offline form:** could display the hours.
  - **Rollout:** agents had to log out and back in for changes to apply.
  - **Separation from Support:** Support schedules did not carry over.
  - **SDK format:** the Web SDK exposed hours as enabled flag, type (account or department), timezone (tz database) and per-day arrays of start–end minutes since midnight. **Here day 0 = Sunday**, unlike trigger conditions.
  - **Known gap:** custom JavaScript could let visitors message invisible agents outside hours.
- **Source:** AR38; AR17; AR53 (`getOperatingHours` schema); DV05 (`operating_hours` plan flag).
- **Confidence:** High.
- **Required implementation:**
  - Schedules (account-level or per department) in an IANA timezone, with multiple periods per day at 15-minute granularity, a 1-hour minimum period, and a holidays list (holidays are our addition, flagged modern).
  - Enforcement: outside hours, the agent or department is effectively unavailable (forced invisible for routing) and the widget shows offline with the hours displayed.
  - Apply changes live without re-login (improvement).
  - Close the server-side gap: reject chat requests to a department that is closed.
- **UI:** Operating Hours page; Departments (schedule section); Chat Widget settings → Offline form ("show hours").
- **Backend:** Schedule evaluator in `packages/contracts/logic` (pure function: schedule, time, timezone → open or closed) used by routing, presence and the widget. A minute-tick job to flip states.
- **Acceptance criteria:**
  - Schedule Mon–Fri 09:00–17:00 Europe/London: at 17:00 London time the widget goes offline, online agents in scope are shown as invisible, and a manual switch to Online is refused.
  - At 09:00 they revert to their prior status.
  - A department schedule closes only that department's picker option and routing.
  - The SDK `getOperatingHours()` equivalent returns schedules with an explicit `weekStartsOn`, so the 0 = Sunday vs 0 = Monday ambiguity is never implicit.

### A-45 · Roles and permissions
- **Historical behavior:**
  - **Default roles:**
    - *Owner*: everything, plus plan, billing and cancellation. Not editable.
    - *Administrator*: everything an agent can do, plus widget and account settings, agents, triggers, departments, deleting chats, and Analytics on higher plans. Not editable.
    - *Agent*: editable permissions, applied to all agents.
  - **Custom roles (Enterprise):** custom roles had these permissions:
    - visitors seen: all, department or own
    - proactive chatting: listen and join, listen, or own
    - edit visitor info (name, email, phone)
    - edit visitor notes
    - view past chats: all, department, own or none
    - edit chat tags in History
    - manage bans
    - access Analytics and email reports
    - view Monitor
    - edit department membership
    - set agent chat limits
    - manage shortcuts (account, or the four levels all, department, personal, none)
  - **Assignment:** roles were assigned singly or in bulk, and custom roles counted against agent seats.
  - **Support integration:** in integrated accounts, Chat admin and Support admin had to match unless the account was on Enterprise.
- **Source:** AR12; AR13; DV12 (permission keys and values).
- **Confidence:** High.
- **Required implementation:**
  - Built-in roles (Owner, Admin, Agent) and custom roles with the same permission keys and scopes. Express them as a permission matrix in `packages/contracts` so API guards and UI both read it.
  - Admin-level scopes as modern extensions: billing, settings, triggers, agents.
  - Bulk role assignment.
- **UI:** Agents → Roles; Agents list.
- **Backend:** RBAC guard (NestJS), with department-scoped data filters for history, visitors and chats.
- **Acceptance criteria:**
  - A custom role with `view_past_chats=department` returns only that department's chats from History and the API.
  - Owner and Admin roles cannot be edited (409).
  - A role without the Monitor permission gets 403 on real-time endpoints.

### A-46 · Agent management
- **Historical behavior:**
  - **Adding agents:** admins added agents with name, email and role, and could configure them immediately or later.
  - **Per-agent settings:** enabled or disabled status, display name, chat limit, skills and role. Bulk actions included set role and assign skills.
  - **Deletion:** in standalone accounts, deleting an agent soft-deleted them; their name stayed in past transcripts until those chats were deleted. In Phase 4 accounts, permanently deleting a staff member scrubbed their identifiable data.
  - **Generation differences:** Phase 3 managed agents in Support; Phase 4 managed identity in Admin Center.
  - **Plan limits:** Lite allowed 1 agent.
  - **API:** listing agents used cursor pagination (`since_id`, `max_id`, `limit`).
- **Source:** AR20; AR46; DV03.
- **Confidence:** High.
- **Required implementation:**
  - Invite agents by email (a signed invite link with expiry).
  - Enable or disable instead of deleting by default; disabled agents can't log in and are excluded from routing.
  - Hard delete with transcript pseudonymization.
  - Per-agent routing settings, bulk actions, and cursor-paginated APIs.
- **UI:** Agents page.
- **Backend:** `Agent` with status; invite tokens; a pseudonymization job.
- **Acceptance criteria:**
  - A disabled agent's sessions are revoked within 60 s and they receive no chats.
  - A hard-deleted agent appears as "Former agent" in transcripts, with the original name absent from all API responses.

### A-47 · Goals and conversion tracking
- **Historical behavior:**
  - **Goals:** up to 5 URL goals, each with a name, description, enabled flag, attribution model (first touch or last touch), attribution window (1–30 days) and URL conditions (equals a full URL or contains a substring; any match counts). The goal page had to carry the widget.
  - **Attribution:** a conversion was credited to a chat, agent and department within the window.
  - **Where conversions showed:** as a notice in the chat, in the History conversions tab and goal filter, in Analytics (chat reports, plus agent-attributed conversions on higher plans) and in an incremental export.
  - **Google Analytics:** a separate integration (A-62) supported goal analysis in GA.
- **Source:** AR30; DV10; DV14 (conversions export); DV02 (`conversions` on chats, last 20); AR11 (conversion metrics).
- **Confidence:** High.
- **Required implementation:** P2. Goal CRUD (URL equals or contains, first or last touch, window 1–30 days), attribution at page view, a chat notice, a History filter, Analytics metrics and an export.
- **UI:** Settings → Goals; Chat History; Analytics.
- **Backend:** Goal matcher on page-view ingestion; `Conversion` table with attribution.
- **Acceptance criteria:**
  - A visitor who chats with agent A and reaches `/thank-you` within 30 days produces one conversion attributed to that chat and agent A under last-touch. With two prior chats under first-touch, the first chat is credited.

## A.8 Security and compliance

### A-48 · Automatic credit-card number redaction
- **Historical behavior:** An account security setting masked card numbers in live chats and in History.
  - **Detection:** a Luhn check, skipping phone-like numbers (such as those starting with +) and URL patterns. It was not guaranteed to catch everything.
  - **Masking:** only the first 6 and last 4 digits stayed visible.
  - **Tagging:** a system tag was added to the chat.
- **Source:** AR22.
- **Confidence:** High.
- **Required implementation:** Server-side redaction before persistence and before fan-out to agents: Luhn plus BIN-length checks, with phone and URL exclusions. Keep the first 6 and last 4 (configurable to last 4 only). Add a system tag. Also redact in uploaded text where feasible (modern). Redacted originals must never be stored.
- **UI:** Settings → Security.
- **Backend:** Redaction function in `packages/contracts/logic`, applied in the message pipeline.
- **Acceptance criteria:**
  - "4111 1111 1111 1111" is stored and shown as `411111******1111`, the chat gets the system tag, and the raw number appears in no DB row or log.
  - "+1 415 555 0100 2222" is not redacted.

### A-49 · Dashboard IP access restriction
- **Historical behavior:** On Enterprise, admins could limit access to the dashboard and account pages to listed IP addresses or wildcard ranges (for example `123.123.123.*`). The UI warned when the admin's own IP was not included.
- **Source:** AR15 (archived 2020-06, edited 2020-05-11, first published 2019-10-22).
- **Confidence:** High.
- **Required implementation:** A workspace IP allowlist (CIDR plus wildcard notation) enforced on agent login, session refresh, dashboard API and agent WebSocket. Never enforced on the visitor widget. Self-lockout protection, and a break-glass path for the owner via email verification.
- **UI:** Settings → Security.
- **Backend:** Middleware on agent-authenticated routes; an audit event on denial.
- **Acceptance criteria:**
  - With the allowlist `203.0.113.0/24`, an agent from 198.51.100.7 cannot log in or call agent APIs (403), and visitors on any IP still chat.
  - Saving a list that excludes the current admin IP needs explicit confirmation.

### A-50 · API clients and OAuth tokens
- **Historical behavior:**
  - **Clients:** admins could see and delete all API clients; users saw only the ones they created. Client secrets could be regenerated.
  - **Tokens:** OAuth tokens were issued per client, with scopes including read, write and chat. A token could be revoked only by the user who created it.
  - **Legacy auth:** legacy Chat-only accounts also allowed basic auth. Phase 3 and 4 accounts were OAuth-only.
  - **Transport and limits:** the REST API was SSL-only, with a limit of 200 requests per minute per endpoint, rate-limit headers and HTTP 429 on excess.
  - **Base URL:** the legacy base URL (`www.zopim.com/api/v2`) was being phased out in favour of `{subdomain}.zendesk.com/api/v2/chat`.
- **Source:** AR48; DV01; DV17 (scopes `read`, `write`, `chat`).
- **Confidence:** High.
- **Required implementation:**
  - OAuth2 (authorization code with PKCE, and client credentials) with scoped tokens.
  - Personal API tokens.
  - Client management UI.
  - Per-token and per-workspace rate limits with standard headers (`RateLimit-*`) and 429.
  - Token revocation by the creator or an admin. Admin revocation is our improvement.
- **UI:** Settings → API & SDKs.
- **Backend:** `api:auth` OAuth server; token hashing; rate limiter (Redis).
- **Acceptance criteria:**
  - A token with scope `read` gets 403 on POST.
  - The 201st request in a minute returns 429 with a reset header.
  - Deleting a client invalidates its tokens immediately.

## A.9 Chat history and data lifecycle

### A-51 · Chat History (archive): browse, search, inspect, export
- **Historical behavior:**
  - **Contents:** History listed ended chats and offline messages. A chat appeared only after it ended or timed out. Unread offline messages and missed chats were flagged.
  - **Retention:** Lite plans kept 30 days of history (a CSV glossary says 14; see Open Questions). Other plans kept history unlimited until deleted.
  - **Search:** free text plus advanced criteria. The API's searchable fields were agent names, visitor name, visitor email, start and end timestamps (closed or open-ended ranges), chat type (chat or offline message) and rating (good or bad), joined with AND. History also filtered by tags (both types) and goal completed. Search returned at most 10,000 results (250 pages × 40).
  - **Detail view:**
    - transcript with timestamps, rating, comment, department, linked ticket and tags
    - user info: name, email, phone, notes, past visits and chats, visitor path, location, browser, device, IP
    - conversions
  - **Export:** chat-details CSV (45 columns, see A-56) emailed only to agents of the account, with case-sensitive address matching and download links that expired after 24 h. Transcripts exported as TXT.
  - **Tag editing:** admins could edit tags in History.
  - **Visibility:** what an agent could see depended on role (all, department, own or none).
- **Source:** AR08; HC08; DV02 (search syntax and limit); AR26; AR39; AR30; DV12.
- **Confidence:** High.
- **Required implementation:**
  - A History page with full-text search over messages, visitor and agent fields, plus filters: date range, agent, department, visitor name and email, type (chat, offline, missed), rating, tags, goal, started-by and website.
  - A detail drawer with transcript, visitor info, path, conversions and engagements.
  - Bulk select (page, or the whole result set up to a cap).
  - Exports: CSV of details, TXT or PDF transcripts, delivered by download link or email to internal users only.
  - Tag edit governed by role. Unread state for offline and missed.
  - Public API search with the same fields and a documented result cap.
- **UI:** Chat History.
- **Backend:** Search index (Postgres full-text or OpenSearch); export worker; signed expiring download URLs (24 h).
- **Acceptance criteria:**
  - Searching `visitor_email:x@y.com` with a date range returns only matching chats.
  - Results never include chats outside the agent's role scope.
  - A CSV export of 1,000 chats reaches the requester within 5 min.
  - An active chat does not appear in History until it ends.

### A-52 · Chat deletion and GDPR workflows
- **Historical behavior:**
  - **Deleting chats:** admins could delete chats (with all attachments) from History. Admins and agents could delete individual attachments, though links could linger up to 24 h.
  - **Soft vs permanent delete:** in integrated accounts an ordinary delete was a soft delete, with purge on cancellation. A separate permanent-delete path removed the data immediately.
  - **GDPR guidance:**
    - access and portability: export through the API (visitor, chats, agents)
    - correction: edit visitor info per chat
    - erasure: delete chats first, then the user. The order mattered because user data was needed to find chats.
  - **Deleted agents:** names persisted in transcripts until those chats were deleted.
  - **API:** single and bulk chat delete endpoints.
- **Source:** AR25; AR45; AR46; DV02 (Delete and Bulk Delete Chats).
- **Confidence:** High.
- **Required implementation:**
  - Hard delete of chats and attachments (immediate purge from DB, search index and object storage, with only a minimal tombstone ID kept).
  - Per-attachment delete.
  - A "forget visitor" job that deletes all chats, sessions, notes and tags for a visitor or `externalId` and anonymizes analytics aggregates.
  - A per-visitor data export (JSON).
  - An audit trail of deletions.
- **UI:** Chat History (delete); Live Visitors and visitor profile (export or forget); Settings → Privacy.
- **Backend:** Deletion orchestrator job (DB, search, storage, caches); DSAR export job.
- **Acceptance criteria:**
  - After "forget visitor", searching by their email returns nothing, attachments return 404, and the REST API returns 404 for their chats within 5 min.
  - The deletion is recorded in the audit log with actor and timestamp.

### A-53 · Chat outcome definitions and timing metrics
- **Historical behavior:** These definitions apply consistently across Analytics, CSV and the API.
  - **Outcome classes:**
    - *Completed*: the chat ended with an agent's reply.
    - *Dropped*: the chat ended with an unanswered visitor message after an agent had engaged.
    - *Missed*: the agent did not answer the incoming request and the visitor left. Chat-level `missed=true` meant no agent served the chat before the visitor left.
    - *Unresponsive*: an agent- or trigger-started chat that the visitor never answered.
    - Explore also had a *not engaged* class.
  - **Started by:** visitor, agent or trigger. Offline messages had none.
  - **Assigned and accepted:** *Assigned* counted system-assigned chats only. *Accepted* counted assignments the agent took. *Chats served* counted any chat the agent responded to.
  - **Wait time (served):** time to the first agent response. Equal to first response time.
  - **Wait time (missed):** the visitor's last comment to leaving without a reply.
  - **First response time:** the agent's pick-up to first message.
  - **Response time:** per chat, the average of agent reply delays measured from the visitor message. The real-time Monitor measures from the first of several consecutive unanswered visitor messages.
  - **Chat duration:** first to last message for analytics. For the Monitor, first message to chat end.
  - **Wait time in Monitor:** the first visitor message to the first agent message, and 0 for agent- or trigger-initiated chats.
  - **Missed (real-time):** counted over the past 30 or 60 minutes.
  - **Abandon time:** the seconds a visitor waited before leaving, on missed and dropped chats.
  - **Acceptance:** served assigned chats ÷ chats routed to the agent.
- **Source:** AR11; AR26; AR27; AR09; DV02 (`missed`, `response_time`, `duration`, `started_by`); DV14 (`dropped`, `abandon_time`, `proactive`, engagement `assigned`/`accepted`); DV16 (metric definitions).
- **Confidence:** High.
- **Required implementation:**
  - Compute and store per-chat outcome fields at chat end: `outcome ∈ {completed, dropped, missed, unresponsive, offline}`, `startedBy`, first response, average and max response, wait time, abandon time and duration.
  - Store per-engagement fields too: assigned, accepted, response times, counts and rating.
  - Use one shared definitions module (`packages/contracts/logic/metrics.ts`) across Analytics, exports and the Monitor, and document both duration definitions explicitly.
- **UI:** Analytics; Chat History (outcome filter); Monitor.
- **Backend:** Metric computation at chat end, plus streaming partials for real time. Unit tests for every definition.
- **Acceptance criteria:**
  - **Missed:** a chat where the visitor writes and leaves after 40 s with no agent reply is `missed`, with abandon time 40 s.
  - **Completed:** a chat where the agent replies and then the visitor ends it is `completed`.
  - **Dropped:** a chat where the agent replies, the visitor writes again and then leaves is `dropped`.
  - **Unresponsive:** an agent-initiated chat with no visitor reply is `unresponsive`, and its wait time is 0.
  - **Response time:** visitor messages at t=0 and t=10 with an agent reply at t=30 give a Monitor response time of 30 s, measured from the first unanswered message.

## A.10 Analytics and monitoring

### A-54 · Analytics dashboard
- **Historical behavior:** Analytics was available on Professional and Enterprise, to admins and to roles granted access. It had two areas.
  - **Chat Reports:**
    - a chat-volume graph by hour, day or week comparing served and missed chats, with wait time, response time, satisfaction and acceptance, and up/down deltas against the previous period
    - satisfaction good vs bad, clickable through to History
    - chat timings: response, duration, wait before first response, and the gap between the visitor's last message and leaving
    - conversions
  - **Agent Reports:**
    - *All Agents*: agents logged in vs chat metrics, an activity breakdown, and a leaderboard sorted by chats served with sortable columns
    - schedules of agents logged in, online and serving, to the nearest hour
    - *Individual Profile*: time serving and logged in, last seen, chats served, acceptance, satisfaction, a performance comparison with the account average, status breakdown (online, away, invisible) and satisfaction comments
  - **Filters:** presets for last 24 h, 1, 7, 14 and 30 days, plus a custom range. Hourly data was limited to 24 h, daily to 31 days and weekly to 90 days. Data covered complete days. Enterprise could filter by department.
  - **Exports:** CSV of several reports, at a chosen interval, to registered agent emails. Enterprise could split by department.
  - **Email reports:** weekly or monthly, plus daily on Enterprise, opted into per user.
  - **Capacity (beta):** estimated servable chats from logged-in agents, average duration and chat limits.
  - **Integrated accounts:** an Explore dashboard with Chats, Efficiency, Satisfaction and Agent activity tabs covered similar KPIs, including completion rate, outbound rate, offline messages, wait, reply and no-reply times, satisfaction score and engagements.
  - **2019 gap:** ratings were not yet reportable in Analytics, only in History.
- **Source:** AR10; AR11; AR09; AR14; AR01 (acceptance and capacity); DV12 (`access_analytics`).
- **Confidence:** High.
- **Required implementation:**
  - An Analytics module with Chats, Agents and Satisfaction tabs:
    - KPIs with previous-period deltas: total, served, missed, dropped, offline messages, completion rate, agent-initiated rate, wait, response and duration (average and max), satisfaction %, acceptance %
    - time series by hour, day and week; distribution by hour of day and day of week
    - a sortable agent leaderboard
    - an agent drill-down with status timeline (online, away, invisible), chats served, acceptance and satisfaction comments
    - department and website filters
    - preset and custom ranges in the workspace timezone
    - CSV export
    - scheduled email reports (weekly and monthly, plus daily)
    - an optional capacity estimate
  - Include satisfaction from day 1, closing the reference's 2019 gap.
- **UI:** Analytics.
- **Backend:** Aggregation tables (hourly rollups by workspace, department, agent and website), an agent status timeline (A-58), and a report scheduler.
- **Acceptance criteria:**
  - For a seeded dataset, every KPI equals the value computed from raw chats using the A-53 definitions.
  - The previous-period delta uses an equal-length window.
  - The department filter restricts all widgets.
  - A weekly email report arrives on schedule with the same numbers as the UI.

### A-55 · Real-time Monitor (wallboard)
- **Historical behavior:** A single-screen live view with four groups:
  - **Queue:** queue size (incoming plus assigned-but-unserved), longest and average wait, missed chats in the last 30 min.
  - **Chat activity:** currently served chats, chats per logged-in and per online agent, longest and average response time, longest and average chat duration.
  - **Agents:** logged-in agents by status (online, away, invisible).
  - **Satisfaction:** % good and counts of good and bad over the last 30 min, shown only when ratings were enabled.
  
  Admins chose which statistics were visible for the whole account. Viewers could filter by department, including all departments and no department. Access was by role permission.
- **Source:** AR27; DV16 (metric keys); DV12 (`view_monitor`).
- **Confidence:** High.
- **Required implementation:** A Monitor page that streams the same metric set, with department and website filters, admin-configurable tiles, and 30- and 60-minute windows for the windowed metrics. TV mode is optional.
- **UI:** Analytics → Live monitor.
- **Backend:** Real-time metric service (incremental counters in Redis) published over WebSocket; shared definitions (A-53).
- **Acceptance criteria:**
  - Creating a waiting chat increments the queue within 2 s, and serving it decrements the queue.
  - Missed (30 min) drops an event exactly 30 min after it happened.
  - A role without the permission cannot open the page or subscribe.

### A-56 · Chat-details CSV export schema
- **Historical behavior:** The History CSV had 45 columns. The groups below show the main fields:
  - chat and visitor IDs
  - start timestamp, type (chat or offline) and duration
  - started-by (agent, visitor, trigger, none)
  - visitor name, email, phone and notes
  - session city, region, country, IP, OS, user agent, browser, session ID, and session start and end
  - visitor, agent and total message counts
  - triggered, missed and unread flags
  - landing page and referral
  - tags
  - department
  - agent names and IDs
  - rating score and comment
  - max, average and first response times
  - linked ticket ID
  - skills and skill match
  - last conversion goal name, ID, date and attribution
- **Source:** AR26.
- **Confidence:** High.
- **Required implementation:** A CSV export with an equivalent column set, using our own header names, plus a documented, stable schema version. Add website, outcome, abandon time and engagements count.
- **UI:** Chat History → Export.
- **Backend:** Export worker; schema definition in `packages/contracts`.
- **Acceptance criteria:**
  - The export contains every listed field (mapped), and each column is documented.
  - Opening it in a spreadsheet shows UTF-8 names correctly (BOM).

## A.11 Public APIs and SDKs

### A-57 · REST API (resources)
- **Historical behavior:** An OAuth-authenticated REST API covered these resources:
  - **Chats:** list, list by IDs (up to 50), search, show, create (offline messages only), update (tags, rating, comment, unread), delete, bulk delete.
    - Chat objects carried participants, history entries (member join and leave, messages with options, conversion events), counts, duration, response times, missed, triggered, started-by, webpath, session, visitor, department, tags, rating and comment, conversions and ticket ID.
  - **Visitors:** create, show, update. Fields: name, email, phone, notes, banned, external ID.
  - **Agents:** list with cursor pagination, show by ID or email, me, create, update, delete.
  - **Departments:** CRUD by ID or name.
  - **Triggers:** CRUD by name. The definition could not be updated via the API.
  - **Shortcuts:** CRUD, max 15,000.
  - **Bans:** list by type, list IPs, create by visitor or IP, delete.
  - **Goals:** CRUD.
  - **Skills:** CRUD by ID or name.
  - **Roles:** CRUD with the permission matrix.
  - **Routing settings:** account and per agent, including batch.
  - **Account:** show; owner-only update of billing.
  - **OAuth:** clients and tokens.
  - **Limits:** 200 requests per minute.
- **Source:** DV01–DV13; HC02.
- **Confidence:** High.
- **Required implementation:** A versioned public REST API (`/api/v1/...`) with equivalent resources and operations, OpenAPI spec, cursor pagination everywhere, consistent error model, idempotency keys on POST, and webhooks (C-03) instead of polling.
- **UI:** Public API docs; Settings → API & SDKs.
- **Backend:** `apps/api` controllers per module; OpenAPI generation; contract tests.
- **Acceptance criteria:**
  - Each listed resource has list, get, create, update and delete, unless the reference omitted one; any omission is documented.
  - The OpenAPI document validates.
  - Pagination is stable under concurrent inserts.

### A-58 · Incremental exports and agent event streams
- **Historical behavior:** Cursor-based incremental exports took a start time (seconds, or microseconds for the agent timeline), a `start_id` and a limit of up to 1,000, with expandable fields such as `fields=chats(*)`. Each response carried `next_page`, `end_time` and `end_id`. When `count` was below the limit, more items were available immediately; otherwise the caller polled later. The start time had to be at least 5 minutes in the past.
  - **Chats:** included updated chats, `engagements` and the extra fields `update_timestamp`, `skills_requested`, `skills_fulfilled`, `abandon_time`, `dropped`, `proactive` and `deleted`. Each engagement recorded ID, started-by (visitor, agent or transfer), agent, department, assigned, accepted, rating, comment, timestamps, duration, response times and counts.
  - **Agent timeline:** status spans (online, away, invisible) with engagement counts.
  - **Conversions.**
  - **Department events:** queue sizes (incoming and assigned).
  - **Agent events** (limited availability, 2018): status and engagement-count changes with previous and new values.
- **Source:** DV14; DV15.
- **Confidence:** High.
- **Required implementation:** Incremental export endpoints for conversations (with engagements), agent status timeline, conversions and queue-size events, using opaque cursors. Our webhooks (C-03) and an event-log endpoint replace the agent-events beta.
- **UI:** Public API docs.
- **Backend:** Append-only event tables (agent status spans, queue snapshots), `updatedAt` indexes and a cursor encoder.
- **Acceptance criteria:**
  - A full export followed by incremental polling returns every chat exactly once per update, including updates to ended chats such as added tags.
  - Agent timeline spans have no gaps or overlaps for each agent.

### A-59 · Real Time Chat API (metrics REST and WebSocket streaming)
- **Historical behavior:** An Enterprise-only, server-side API.
  - **Chat metrics:** incoming, assigned, active, missed (30 or 60 min window), wait time average and max, chat duration average and max, response time average and max, satisfaction good and bad (windowed).
  - **Agent metrics:** online, away, invisible.
  - **Department filter:** optional on every metric.
  - **Delivery:** a REST pull, or a WebSocket subscription by topic (`chats.<metric>` or `agents.<metric>`) with window and department parameters.
  - **Limits:** connections counted toward the 200 requests per minute limit. Up to 1,000 concurrent connections per account and 10 per agent.
  - **Behaviour:** metrics could be null when not computed or not applicable.
- **Source:** DV16.
- **Confidence:** High.
- **Required implementation:** A real-time metrics API (REST and WebSocket) mirroring the Monitor's metric set and filters, with connection limits and OAuth scopes. Explicitly not for browser use.
- **UI:** Public API docs.
- **Backend:** Same metric service as A-55.
- **Acceptance criteria:**
  - Subscribing to `chats.missed` with window 30 and department 5 yields updates only for department 5, with the window key present.

### A-60 · Agent-side programmatic API (Conversations API) and structured messages
- **Historical behavior:** An Enterprise and Premium GraphQL API let an application act as an agent, mainly for bots.
  - **Sessions:** an app started an agent session, set its status, subscribed to chats and messages, and sent messages.
  - **Transport:** WebSocket with ping/pong and resume, plus HTTP for authentication.
  - **Limits:** 100 requests per second; 1 session start per second and 50 per hour; 10 subscriptions per session; query depth 11.
  - **Structured messages:** sent only through this API.
    - quick replies (up to 11 buttons)
    - button templates (1–3 buttons, reply or URL)
    - panel templates (image, title, subtitle, buttons)
    - panel carousels (2–10)
    - list templates (2–4 items, at most one button)
  - **Status:** maintenance mode from January 2022.
- **Source:** DV17; AR32; AR53 (`structured_msg` in `chat.msg`).
- **Confidence:** High.
- **Required implementation:**
  - A bot and agent-app API (REST and WebSocket, GraphQL optional) that can register as a "bot agent", receive routed chats, send messages, and hand off to humans.
  - A structured-message schema in `packages/contracts/protocol.ts`: quick replies, buttons, card, carousel, list.
  - Widget rendering for each structured type.
  - Our addition: agents can send these from the dashboard too (C-09).
- **UI:** Public API docs; Widget runtime.
- **Backend:** Bot-agent principal type; routing support for bots; message schema validation.
- **Acceptance criteria:**
  - A bot client can start a session, be assigned a chat, send a quick-reply message with 3 options, receive the visitor's choice as a message, and transfer to a department.
  - Messages that break structure limits (for example 12 quick replies) are rejected with 422.

## A.12 Integrations

### A-61 · Help-desk ticket integration (Zendesk Support link)
- **Historical behavior:** Chat accounts could be linked to Zendesk Support. Phase 4 accounts set this up from the product tray.
  - **Ticket creation:** chats and offline messages could become tickets, automatically or manually. Settings covered automatic creation, transcript visibility (private or public) and ticket assignment (for example, the last agent).
  - **What tickets carried:** the visitor's session details and the transcript. Tags from triggers and the API were included.
  - **Ratings:** a chat rating updated the ticket's CSAT.
  - **Agents:** each chat agent could pick which Support agent tickets from their chats were assigned to.
  - **Chat records:** stored the ticket ID.
- **Source:** AR28; AR14; HC04; DV02 (`zendesk_ticket_id`); AR45; HC14 (post-period confirmation of the settings, search summary); HC11 (tags on tickets).
- **Confidence:** Medium. The integration existed (High), but the exact 2018–2021 setting names were not retrieved.
- **Required implementation:** A generic "ticketing/CRM connector" framework:
  - Create a ticket or record on chat end or offline submission, with a mode of off, automatic or manual.
  - Transcript visibility.
  - Assignee mapping.
  - Tags and fields mapping.
  - Rating sync.
  - Store the external reference on the conversation.
  
  First connectors are generic webhook (C-03) and email-to-helpdesk. Native connectors (Zendesk, Freshdesk, HubSpot) come later.
- **UI:** Settings → Integrations.
- **Backend:** Connector interface; outbox pattern; retry with backoff.
- **Acceptance criteria:**
  - In automatic mode, ending a chat creates exactly one external record (idempotent on retries) whose reference appears on the chat.
  - In manual mode, an agent action creates it.

### A-62 · Google Analytics event integration
- **Historical behavior:** The widget sent chat events to the site's Google Analytics. A documented event action was a "served by operator" event, used to segment converters who chatted. A JS API switch disabled the events, later replaced by a widget analytics setting.
- **Source:** AR29; AR52 (`setDisableGoogleAnalytics`); DV20 (mapped to `zESettings.analytics`).
- **Confidence:** High for existence and the toggle. Low for the full event list, which is not retrieved; see B-12.
- **Required implementation:** Optional forwarding of widget lifecycle events (widget opened, chat requested, chat served, message sent, offline message sent, rating given) to the host page's analytics layer (GA4 `gtag`, `dataLayer` push, or a generic callback). Off by default, with a per-website toggle and a runtime override.
- **UI:** Websites → Analytics forwarding.
- **Backend:** None (client-side).
- **Acceptance criteria:**
  - With forwarding on and `dataLayer` present, serving a chat pushes one `chat_served` event.
  - With it off, nothing is pushed.

### A-63 · Platform plugins and installable chat apps
- **Historical behavior:** Official install guides existed for WordPress, Shopify, Wix, Squarespace, PrestaShop and Magento. Admins could install Chat "apps", and a My Apps page managed them.
- **Source:** Arquivo index listings, title evidence only: 360022186574 (WordPress), 360022368513 (Shopify), 360022372773 (Wix), 360022368473 (Squarespace), 360022186614 (PrestaShop), 360022182794 ("Managing your installed apps in Zendesk Chat", captured 2019-10-16).
- **Confidence:** Medium. Their existence is shown by archived article titles, but the content was not read.
- **Required implementation:** P2. A WordPress plugin and a Shopify app embed first. An app or extension framework is out of scope for launch.
- **UI:** Websites → Install.
- **Backend:** None for plugins (snippet injection).
- **Acceptance criteria:**
  - Installing the WordPress plugin with a site key renders the widget on all front-end pages.

## A.13 Platform behaviour and limits

### A-64 · Session and chat timeout rules
- **Historical behavior:**
  - **Idle visitors:** after 10 minutes without input a visitor counted as idle for triggers and the visitor list. After 20 minutes the visitor was disconnected and any chat ended; per HC09 the timing could vary by about 5 minutes.
  - **Closed browser:** with no widget window open, the session ended within about 20 seconds to 2 minutes.
  - **Mobile SDK:** 1 hour of inactivity or disconnection ended the chat; 5 minutes after an agent ended it; 30 minutes in the background without push.
  - **Configuration:** timeouts were not configurable (community statements, 2017).
- **Source:** AR53 (20-min rule, 2020); HC01 (10-min idle); HC09 (search summary for browser-close and SDK values).
- **Confidence:** Medium. The 20- and 10-minute values are High; the others come from a search summary only.
- **Required implementation:** Configurable timeouts in workspace settings:
  - visitor idle threshold (default 10 min)
  - chat inactivity end (default 20 min)
  - disconnected-session grace (default 2 min)
  - mobile background timeout (default 30 min)
  
  Emit `visitor_idle` and `chat_ended(reason)` events.
- **UI:** Settings → Chat behaviour.
- **Backend:** Timeout scheduler; reason codes on the chat-end event (`visitor_ended`, `idle_timeout`, `disconnected`, `agent_ended` when the policy allows).
- **Acceptance criteria:**
  - With defaults, a chat with no visitor activity for 20 min ends with reason `idle_timeout`.
  - Closing the only tab ends the chat within 2 min with reason `disconnected`.

### A-65 · Plan and entitlement limits
- **Historical behavior:** Plan objects exposed entitlements:
  - maximum agents, departments, basic and advanced triggers, concurrent chats, and history search days
  - file upload, operating hours, widget customization level, analytics, integrations and weekly reports
  
  Examples of gating: Lite had 1 agent and 30-day history; Team had 2 departments; Basic had 2 proactive triggers; skills routing and custom roles were Enterprise only; the Real Time API and Conversations API were Enterprise only. Legacy plan names mapped Lite→Lite, Basic→Team, Advanced→Professional and Premium→Enterprise.
- **Source:** DV05; AR33; AR20; AR19; AR31; AR13; DV16; DV17.
- **Confidence:** High.
- **Required implementation:** An entitlements service with the same kinds of limits (even if packaging differs), checked by API guards and reflected in the UI as disabled states with upgrade hints.
- **UI:** Settings → Billing / Plan.
- **Backend:** `Entitlements` resolved per workspace; enforcement middleware.
- **Acceptance criteria:**
  - On a plan with max departments = 2, creating a third returns 402 or 403 with a clear error code, and the UI disables the button.

---

# Section B — Probable historical features requiring validation

The entries below are plausible or partly evidenced, but no retrieved primary source confirms them for 2018–2021. Do not cite them as reference behaviour until validated. Each still carries an implementation note, so the work is not blocked.

### B-01 · Shortcut invocation with a `#` prefix
- **Historical behavior (claimed by our brief):** agents typed `#name` to insert a shortcut.
- **Evidence:** the 2019 archived article and the current article both describe typing the name prefix or a bare `/`, which lists the first 10. No source mentions `#`. `#` does appear in chat *channel* names in API payloads (`#supportchat:<id>`), which may be the origin of the assumption.
- **Source:** AR02; HC05; DV02.
- **Confidence:** Low that `#` existed. High that `/` and prefix matching existed.
- **Required implementation:** Make the trigger character configurable, default `/`. Optionally allow `#`, but never let a `#` in ordinary text (for example "order #123") open the picker unless it is at the start of input or after whitespace and followed by a match.
- **UI:** Inbox composer; Settings → Personal.
- **Backend:** None.
- **Acceptance criteria:**
  - Default config: `/` opens the picker and `#` does not.
  - With `#` enabled: typing `#ref` at the start of input opens the picker, and "order #123" does not.

### B-02 · Complete list of shortcut placeholders
- **Historical behavior:** a picker inserted visitor and chat placeholders. `{{visitor_name}}` (full name) is confirmed. `{{agent_name}}` is reported by a community thread. Others, such as visitor email, page URL or department, are unknown.
- **Source:** AR02 (placeholder picker exists); HC12 (search summary); community thread via search summary.
- **Confidence:** Low for anything beyond `{{visitor_name}}`.
- **Required implementation:** Define our own placeholder set:
  - `visitor.name`, `visitor.first_name` (fixes the reference's gap), `visitor.email`
  - `agent.display_name`, `agent.first_name`
  - `department.name`, `website.name`, `page.url`
  
  Render with fallbacks.
- **UI:** Shortcuts editor; Inbox.
- **Backend:** Placeholder engine.
- **Acceptance criteria:**
  - Every documented placeholder renders, or falls back to its default, in a unit test matrix.

### B-03 · Wire format of shortcut options
- **Historical behavior:** the REST field `options` is a string, while the Web SDK exposes `options` as an array on messages. The separator (possibly `/`) is undocumented.
- **Source:** DV08; DV02 (`"options": ""`); AR53.
- **Confidence:** Low.
- **Required implementation:** Store options as an ordered string array. If we offer legacy-import compatibility, accept a `/`-separated string.
- **UI:** Shortcuts editor.
- **Backend:** Schema in `packages/contracts`.
- **Acceptance criteria:**
  - Importing `"Yes/No/Maybe"` yields three options in order.

### B-04 · Visitor list sorting, column configuration and settings tab
- **Historical behavior:** a "Visitor List" tab under account settings existed (it held the high-load toggle). Whether it held other options (for example hiding idle visitors, or a cap on visitors shown) and whether columns could be sorted is not documented in retrieved sources.
- **Source:** AR07 (settings tab path); none for sorting.
- **Confidence:** Low.
- **Required implementation:** Sortable columns, column show/hide, a "hide idle" toggle and saved views (our design).
- **UI:** Live Visitors.
- **Backend:** None special.
- **Acceptance criteria:**
  - Sorting by "Online" orders by session duration.
  - Column choices persist per agent.

### B-05 · Dashboard notification event types and per-event sounds
- **Historical behavior:** agents chose a sound "for each type of event". The list of event types (for example visitor arrives, chat request, new message, agent message) is not in the retrieved text.
- **Source:** AR16.
- **Confidence:** Medium that per-event sounds existed; Low for the exact event list.
- **Required implementation:** See A-21 for our event list.
- **UI:** Settings → Personal → Notifications.
- **Backend:** None.
- **Acceptance criteria:**
  - Each event type in our list has an independent sound selector, including "none".

### B-06 · Widget window size presets
- **Historical behavior:** the legacy widget API had a window-size call, later deprecated. Presets such as small, medium and large are assumed, not confirmed. The Web Widget had one fixed size (2021 community statement).
- **Source:** DV20 (`setSize` listed as deprecated); search summary of a community thread.
- **Confidence:** Low for presets; Medium that some size control existed.
- **Required implementation:** P2. Offer compact and standard sizes and a responsive max-height. Do not promise arbitrary sizing.
- **UI:** Chat Widget settings → Appearance.
- **Backend:** None.
- **Acceptance criteria:**
  - Both presets render without clipping at a 360 px width.

### B-07 · Legacy themes, fonts, chat "bubble" and extended positions
- **Historical behavior:** the legacy widget API had:
  - theme selection and font configuration (later deprecated because chat themes were removed)
  - a "bubble" element with title, text and colour (deprecated)
  - position codes including top-middle and bottom-middle (not supported later)
  - a "Classic" vs "Simple" window style in the dashboard
  
  The exact theme catalogue, fonts and bubble behaviour were not retrieved.
- **Source:** DV20 (deprecated list: `theme.setTheme`, `theme.setFontConfig`, `bubble.*`, positions `tm`/`bm`); AR06 and AR44 ("Simple"/"Classic" references).
- **Confidence:** Medium that these existed; Low for details.
- **Required implementation:** Not needed for parity beyond A-02. Optionally add a "callout" bubble next to the launcher that shows a proactive teaser line. That is our design; see also C-09.
- **UI:** Chat Widget settings.
- **Backend:** None.
- **Acceptance criteria:** n/a (design decision).

### B-08 · Trigger messages opening or revealing a hidden widget
- **Historical behavior:** guidance said a widget hidden by the "turn off" setting stays hidden until a trigger or the API shows it, which implies trigger messages could reveal the widget. Whether a trigger message auto-expands the window or only shows a notification badge is not documented.
- **Source:** AR34 (hidden until trigger or API); AR19 (proactive trigger chats).
- **Confidence:** Medium.
- **Required implementation:**
  - A per-website setting for what a proactive message does: a teaser bubble only, auto-open on desktop, or auto-open everywhere.
  - A hidden widget becomes visible when a proactive message arrives.
- **UI:** Chat Widget settings → Behaviour.
- **Backend:** None.
- **Acceptance criteria:**
  - With "start hidden" on and auto-open on desktop, a trigger message shows and opens the widget on desktop, and shows only the launcher with a badge on mobile.

### B-09 · Cookie-consent API semantics
- **Historical behavior:** the legacy API had a cookie-law namespace (a "comply" call) and a default implicit consent setter. The later Web Widget mapped this to a cookies setting, with a note that the format was changing. Exact behaviour, such as which cookies were withheld before consent, was not retrieved. The archived CookieLaw page was captured only in 2022.
- **Source:** DV20; Arquivo listing (`CookieLawAPI-js.html`, captured 2022-05-27; content not used).
- **Confidence:** Low.
- **Required implementation:** Consent mode: until consent is given, use no persistent identifier (in-memory session only) and send no analytics forwarding. Provide a runtime `setConsent(true|false)` call and a dashboard default.
- **UI:** Websites → Privacy.
- **Backend:** None.
- **Acceptance criteria:**
  - Before consent no cookie or localStorage key is written.
  - After `setConsent(true)` the visitor ID persists across reloads.

### B-10 · Visual (map) view of visitors
- **Historical behavior:** a heat-map-style visual view with colour-coded dots, including recently departed visitors, existed alongside the list. Interaction details are not documented.
- **Source:** AR07.
- **Confidence:** Medium that it existed; Low for details.
- **Required implementation:** P2. An optional geographic or activity visualization.
- **UI:** Live Visitors.
- **Backend:** Geo aggregation.
- **Acceptance criteria:** n/a (P2).

### B-11 · "Request email" trigger action (continuous conversations)
- **Historical behavior:** the current trigger reference lists an action that asks the visitor for an email address so the conversation can continue. When it was introduced is unknown; it may be after 2021.
- **Source:** HC01 (current).
- **Confidence:** Low for the reference period.
- **Required implementation:** See C-15.
- **UI:** Triggers.
- **Backend:** See C-15.
- **Acceptance criteria:** See C-15.

### B-12 · Google Analytics event catalogue
- **Historical behavior:** chat events were sent to GA. Only the "served by operator" action is confirmed. The full list (for example chat started, offline message sent, rating) was not retrieved.
- **Source:** AR29.
- **Confidence:** Low beyond the confirmed event.
- **Required implementation:** Our event catalogue from A-62, documented.
- **UI:** Websites → Analytics forwarding.
- **Backend:** None.
- **Acceptance criteria:** See A-62.

### B-13 · Native desktop agent apps
- **Historical behavior:** native desktop clients may have existed in the Zopim era. No 2018–2021 source was found.
- **Source:** none retrieved.
- **Confidence:** Low.
- **Required implementation:** Not required. A PWA install covers this.
- **UI:** n/a.
- **Backend:** n/a.
- **Acceptance criteria:** n/a.

### B-14 · Handling offline messages in the dashboard
- **Historical behavior:** offline messages were stored with an unread flag, appeared in History, and were emailed to agents. Whether agents could reply from the dashboard (for example by email) or assign them is not documented. The usual path was email or Support tickets.
- **Source:** AR16; DV02; AR05.
- **Confidence:** Low for any in-dashboard workflow.
- **Required implementation:** An offline-messages view in the Inbox with read/unread, assignment, and "reply by email" (an outbound email with a threaded reply-to). The reply is our addition.
- **UI:** Inbox.
- **Backend:** Email sending and inbound reply parsing (later).
- **Acceptance criteria:**
  - An agent can mark an offline message read and reply. The visitor receives the email, and the reply is logged on the conversation.

### B-15 · Search-engine and search-term capture
- **Historical behavior:** the visitor list grouped by search engine and search term, triggers had search-engine and search-term conditions, and exports carried both fields. By 2018–2021 most engines no longer passed keywords, so the term was often empty. How the reference handled this is not documented.
- **Source:** AR07; HC01; DV14 (`referrer_search_engine`, `referrer_search_terms`).
- **Confidence:** High that the fields existed; Low on how well they were populated.
- **Required implementation:** Parse the referrer host for a known engine list, and take terms from query parameters when present (including UTM `utm_term`). Expose UTM fields as visitor attributes (modern).
- **UI:** Live Visitors; Triggers.
- **Backend:** Referrer parser.
- **Acceptance criteria:**
  - A referrer of `https://www.bing.com/search?q=widgets` gives engine `bing` and term `widgets`.
  - A Google referrer with no `q` gives engine `google` and an empty term.

### B-16 · Listen-mode user experience
- **Historical behavior:** the listen and join permissions existed, but whether visitors saw any sign of a listening agent, and how "join" appeared, is not described.
- **Source:** DV12; AR41.
- **Confidence:** Low for UX specifics.
- **Required implementation:** Listening is invisible to visitors. Joining shows an agent-joined system event (A-30).
- **UI:** Inbox.
- **Backend:** —
- **Acceptance criteria:** See A-30.

### B-17 · Lite-plan history retention (30 vs 14 days)
- **Historical behavior:** one 2019 article says Lite kept 30 days of history. The CSV glossary from the same year says 14 days.
- **Source:** AR08; AR26.
- **Confidence:** Low (conflicting).
- **Required implementation:** Retention is our product decision (see C-07).
- **UI:** —
- **Backend:** —
- **Acceptance criteria:** n/a.

### B-18 · Away status shown to visitors
- **Historical behavior:** the classic widget showed Away to visitors (AR17). Whether the integrated Web Widget distinguished Away from Online is unclear: its status callback reports online, away and offline, but rendering is undocumented.
- **Source:** AR17; DV18.
- **Confidence:** Medium.
- **Required implementation:** A per-website choice: treat Away as online (accept chats) or show an "away" state (accept chats with an adjusted greeting).
- **UI:** Chat Widget settings.
- **Backend:** —
- **Acceptance criteria:**
  - With "Away = online", a workspace whose agents are all Away still accepts chats and shows the online state.

### B-19 · Widget accessibility enforcement and lazy connect (timing)
- **Historical behavior:** the Web Widget (Classic) enforced a minimum WCAG AA colour contrast and supported a connect-on-interaction mode. When these appeared relative to 2021 is unknown.
- **Source:** DV19.
- **Confidence:** Low for the period.
- **Required implementation:** See C-14 (accessibility) and A-14 (lazy connect).
- **UI:** —
- **Backend:** —
- **Acceptance criteria:** See C-14.

### B-20 · Department status values
- **Historical behavior:** trigger conditions treat department status as online, away or offline. The Web SDK's department object reports only online or offline. How "away" applied to departments is unclear.
- **Source:** HC01; AR53.
- **Confidence:** Low.
- **Required implementation:** Use the same rollup rule as the account (A-19), applied to department members. Expose all three values.
- **UI:** —
- **Backend:** Presence rollup.
- **Acceptance criteria:**
  - A department whose only online member switches to Away reports `away`.

### B-21 · "Active chat" definition for chat limits
- **Historical behavior:** a current article (search summary) says a chat counts toward an agent's load if it received a response in the last 10 minutes. Whether this applied in 2018–2021 is unknown.
- **Source:** search summary (routing search, current docs).
- **Confidence:** Low.
- **Required implementation:** A configurable "stale chat" threshold excludes chats with no messages for X minutes from the load count. Default off for strict parity. See Open Questions.
- **UI:** Settings → Routing.
- **Backend:** Load index.
- **Acceptance criteria:**
  - With the threshold at 10 min, a chat silent for 11 min no longer counts toward the limit.

### B-22 · Dashboard "Home" overview
- **Historical behavior:** the conversion-tracking article tells users to look at a Home tab for total visitor counts, which suggests an overview page with traffic totals. Contents are not documented.
- **Source:** AR30.
- **Confidence:** Low.
- **Required implementation:** A dashboard home with today's visitors, chats, missed, average wait and satisfaction, plus who's online. This is our design.
- **UI:** Inbox / Home.
- **Backend:** Rollups (A-54).
- **Acceptance criteria:**
  - Home KPIs match Analytics for "today".

### B-23 · 2019 trigger condition list vs today's
- **Historical behavior:** we used the current trigger reference (HC01, HC02). The 2019 copy exists in Wayback (§4.4) but could not be fetched. Conditions added after 2019 (queue size, Oct 2021) and actions possibly added later (request email) need date confirmation.
- **Source:** HC01; HC02; AR35.
- **Confidence:** Medium.
- **Required implementation:** None until validated. We implement the superset.
- **UI:** —
- **Backend:** —
- **Acceptance criteria:** n/a.

---

# Section C — Modern enhancements not present in the reference period

> **MODERN — not legacy parity.** Our spec asks for these, but classic Zendesk Chat did not have them, or had only a weaker form. Each entry states what the reference had instead, so reviewers can see the gap. Signed-JWT visitor identity verification is **not** in this section: it existed from 2018 (A-16). Only the asymmetric-key and rotation improvements are modern (C-05).

### C-01 · Native multi-factor authentication for agents [MODERN]
- **Reference had:** legacy Chat-only accounts signed in at the Zopim account site with a password, and the Chat API allowed basic auth for those accounts [AR48]. Integrated (Phase 3/4) accounts inherited Zendesk account sign-in and its 2FA. No Chat-native MFA was found for the standalone dashboard.
- **Source:** AR48; AR36; search summary of Zendesk 2FA documentation (Support-level).
- **Confidence:** Medium that standalone Chat lacked native MFA.
- **Required implementation:**
  - TOTP and WebAuthn/passkeys for all agents, with an optional workspace-wide requirement.
  - Recovery codes and admin reset.
  - Enforcement at login and on sensitive actions (step-up).
- **UI:** Settings → Security; Settings → Personal → Security.
- **Backend:** `api:auth` MFA factors; step-up tokens.
- **Acceptance criteria:**
  - With MFA required, an agent without a factor is forced to enrol at the next login.
  - Login fails without a valid second factor.
  - Recovery codes are single-use.

### C-02 · SSO (SAML/OIDC) and SCIM provisioning [MODERN]
- **Reference had:** Phase 4 managed identity in Admin Center, tied to the wider Zendesk account. Standalone Chat had no documented SSO or SCIM.
- **Source:** AR20; AR36.
- **Confidence:** Low–Medium.
- **Required implementation:** SAML 2.0 and OIDC sign-in, with just-in-time provisioning and SCIM 2.0 user and group sync mapped to agents and departments.
- **UI:** Settings → Security → SSO.
- **Backend:** `api:auth` SSO.
- **Acceptance criteria:**
  - Deprovisioning a user in the IdP disables the agent within 5 min via SCIM.

### C-03 · Signed outbound webhooks for chat events [MODERN]
- **Reference had:** no outbound webhooks for live chat. Integrators used email piping (A-12), Support ticket triggers, polling the incremental exports, the Real Time streaming API (metrics only) or the Conversations API (agent-side session).
- **Source:** AR21; DV14; DV16; DV17. A search found no Chat webhook feature.
- **Confidence:** Medium.
- **Required implementation:**
  - Webhook subscriptions per workspace for these events: `conversation.started`, `conversation.assigned`, `conversation.transferred`, `message.created`, `conversation.ended` (with outcome), `conversation.rated`, `offline_message.created`, `visitor.banned`, `agent.status_changed`.
  - HMAC-SHA256 signatures with timestamps, retries with exponential backoff, delivery logs, replay, and secret rotation.
- **UI:** Settings → Integrations → Webhooks.
- **Backend:** Outbox table → webhook dispatcher worker.
- **Acceptance criteria:**
  - Ending a chat delivers one signed `conversation.ended` event within 10 s, and the receiver can verify the signature.
  - A 500 response is retried with backoff, up to 24 h.

### C-04 · Shadow-DOM-isolated, CSP-friendly widget [MODERN]
- **Reference had:** a third-party script that injected its own UI. Isolation technique and CSP behaviour were not documented in the retrieved sources. The later Web Widget added a `zIndex` setting and a connect-on-interaction mode for performance.
- **Source:** DV19 (`zIndex`, `connectOnPageLoad`); no source on DOM isolation.
- **Confidence:** Low on how the reference was built; we treat isolation as a modern requirement regardless.
- **Required implementation:**
  - Render the launcher and window inside a Shadow DOM root, with an iframe only where we need strict isolation (for example file previews).
  - No global CSS leakage in either direction.
  - Support a strict CSP: no `eval`, nonce-able loader, documented domains for `connect-src`, `img-src` and `frame-src`.
  - Keep the loader script small (≤ 15 KB gzipped) and lazy-load the rest.
- **UI:** Widget runtime.
- **Backend:** CDN with versioned assets and SRI hashes.
- **Acceptance criteria:**
  - A host page with aggressive global CSS (`* { all: unset }`) does not change widget rendering, and widget styles do not affect the host page.
  - With CSP `script-src 'self' cdn.talkivio…; connect-src …`, the widget works with no console CSP violations.

### C-05 · Asymmetric JWT identity verification and zero-downtime rotation [MODERN]
- **Reference had:** HS256 shared secrets only, with RS256 and ES256 explicitly unsupported. Regenerating the secret revoked the old one and could disconnect visitors for about 5 minutes.
- **Source:** AR42.
- **Confidence:** High.
- **Required implementation:**
  - Accept RS256 and ES256 with customer-registered public keys or a JWKS URL, in addition to HS256.
  - Key IDs (`kid`), overlapping validity during rotation, and clock-skew settings.
- **UI:** Websites → Identity verification.
- **Backend:** JWKS cache with refresh.
- **Acceptance criteria:**
  - Rotating keys with overlap disconnects no visitors.
  - A token signed with an unregistered `kid` is rejected.

### C-06 · Audit log [MODERN]
- **Reference had:** no documented audit log in Chat. Deletion guidance had no audit trail.
- **Source:** AR25; AR45; AR46 (absence).
- **Confidence:** Medium.
- **Required implementation:** An immutable audit log of security- and data-relevant actions: logins, MFA changes, role and permission changes, settings changes, trigger edits, exports, deletions, bans, API client changes and impersonation. Searchable, exportable, with retention.
- **UI:** Settings → Audit log.
- **Backend:** Append-only table; write-through from guards and services.
- **Acceptance criteria:**
  - Changing a role permission creates an entry with actor, before and after values, IP and timestamp.
  - Admins cannot delete entries.

### C-07 · Configurable data retention, IP minimization and DSAR APIs [MODERN]
- **Reference had:** unlimited history on paid plans and 30 (or 14) days on Lite. Deletion was manual (single or bulk). GDPR handling was a manual workflow (A-52). IP addresses were always stored.
- **Source:** AR08; AR26; AR45; AR46.
- **Confidence:** High.
- **Required implementation:**
  - Per-workspace retention policies (for example, delete conversations after N days and attachments after M days).
  - An option to truncate or hash visitor IPs.
  - API endpoints to export or forget a visitor by email, `externalId` or visitor ID.
  - A scheduled purge with an audit entry for each run.
- **UI:** Settings → Privacy.
- **Backend:** Retention worker; DSAR jobs (A-52).
- **Acceptance criteria:**
  - With a 90-day retention policy, conversations older than 90 days are gone (DB, search, storage) within 24 h.
  - With IP minimization on, stored IPs are truncated to /24 (IPv4) or /48 (IPv6).

### C-08 · Visitor typing preview ("sneak peek") [MODERN, optional]
- **Reference had:** typing indicators only. Zendesk staff said in a community thread that previewing unsent visitor text was not planned, citing visitor privacy.
- **Source:** HC13 (search summary, community); AR53 (typing indicators only).
- **Confidence:** Low–Medium (community source).
- **Required implementation:** If our spec requires it: off by default, enabled per workspace, shown only to the serving agent, never stored, with a disclosure line in the widget whenever it is enabled.
- **UI:** Settings → Chat behaviour; Inbox.
- **Backend:** Ephemeral throttled stream (not persisted).
- **Acceptance criteria:**
  - With the feature off, no draft text leaves the visitor's browser.
  - With it on, the widget shows the disclosure, and drafts never appear in transcripts, exports or logs.

### C-09 · Rich messages composed by agents in the dashboard [MODERN]
- **Reference had:** shortcut "options", rendered as radio choices, for human agents. Quick replies, buttons, cards, carousels and lists were sent only through the Conversations API, typically by bots.
- **Source:** AR02; AR32; DV17.
- **Confidence:** High.
- **Required implementation:** A composer UI for quick replies, buttons (reply or URL), a single card and a carousel, using the same schema as A-60. Shortcuts can also store rich payloads.
- **UI:** Inbox composer; Shortcuts.
- **Backend:** Message schema validation.
- **Acceptance criteria:**
  - An agent sends a card with an image and two buttons, and the visitor's button click posts the configured reply.

### C-10 · Multiple independently configured widgets per workspace [MODERN]
- **Reference had:** one widget configuration per Chat account, reused across sites, with per-site routing done through departments and triggers [HC10]. Per-brand widgets existed only through Support's multibrand Web Widget.
- **Source:** HC10 (search summary).
- **Confidence:** Medium.
- **Required implementation:**
  - A `Website` entity (A-01), each with its own appearance, forms, language, hours mapping, security and default department, inheriting from workspace defaults.
  - Website as a first-class filter in Inbox, History, Analytics and Triggers (condition `website`).
- **UI:** Websites; all list pages (filter).
- **Backend:** Config inheritance resolver.
- **Acceptance criteria:**
  - Two websites in one workspace show different colours and greetings.
  - A trigger with the condition `website = shop` fires only there.

### C-11 · Abuse and spam protection [MODERN]
- **Reference had:** manual IP and cookie bans, a country blocklist, a domain allowlist, temporarily turning off the offline form or widget during attacks, and platform load shedding.
- **Source:** AR34; AR03; AR43; AR49.
- **Confidence:** High.
- **Required implementation:**
  - Per-IP and per-visitor rate limits on chat requests, messages and offline submissions.
  - Optional invisible bot challenge on the offline form and the first message.
  - Link and attachment throttling for new visitors.
  - Automatic temporary bans with admin review.
  - An "under attack" switch that forces a challenge for all new visitors.
- **UI:** Settings → Security → Abuse protection.
- **Backend:** Rate limiter (Redis); challenge provider abstraction.
- **Acceptance criteria:**
  - 20 offline submissions per minute from one IP trigger throttling after the configured threshold (default 3 per 10 min), and the visitor sees a neutral retry message.

### C-12 · Holiday calendars and exceptions in operating hours [MODERN]
- **Reference had:** weekly schedules only, with no holiday or exception dates documented [AR38]. Zendesk Support's schedules with holidays did not carry over.
- **Source:** AR38.
- **Confidence:** Medium.
- **Required implementation:** Date-based exceptions (closed all day, or special hours) per schedule, plus importable holiday lists.
- **UI:** Operating Hours.
- **Backend:** Schedule evaluator (A-44).
- **Acceptance criteria:**
  - On a configured holiday the widget is offline all day, even on a weekday.

### C-13 · General PII redaction and message deletion [MODERN]
- **Reference had:** automatic credit-card redaction only (A-48), and deletion of whole chats or attachments (A-52).
- **Source:** AR22; AR25.
- **Confidence:** High.
- **Required implementation:**
  - Configurable redaction rules for additional patterns (for example national IDs, IBAN and custom regex).
  - Agent-initiated redaction of a single message (replaced with a "redacted" marker, audited).
  - Redaction applied to search indexes and exports.
- **UI:** Settings → Security; Inbox / History (message action).
- **Backend:** Redaction pipeline; reindex job.
- **Acceptance criteria:**
  - Redacting a message removes its text from the DB, the search index and future exports. Visitor and agent views show a placeholder, and the audit log records it.

### C-14 · Accessibility conformance (WCAG 2.2 AA) [MODERN]
- **Reference had:** a contrast floor in the Web Widget (Classic) (period uncertain, B-19). No full conformance claim was found.
- **Source:** DV19.
- **Confidence:** Low.
- **Required implementation:**
  - The widget and dashboard meet WCAG 2.2 AA: keyboard operability, focus management, screen-reader announcements for new messages (polite live regions), reduced motion, and contrast enforcement on custom colours.
  - Publish a VPAT.
- **UI:** Widget runtime; all dashboard pages.
- **Backend:** —
- **Acceptance criteria:**
  - Automated axe checks pass on the widget and core pages.
  - A screen-reader user can start a chat, read replies and rate the chat using the keyboard only.

### C-15 · Continuous conversations (follow-up after the visitor leaves) [MODERN]
- **Reference had:** offline messages, plus a "request email" trigger action whose introduction date is unknown (B-11). Chats ended on visitor idle or leave. There was no documented reply-by-email continuation within the period.
- **Source:** HC01; AR53.
- **Confidence:** Low–Medium.
- **Required implementation:**
  - If a visitor leaves with unanswered agent messages and an email is known, send those messages by email after a delay. The visitor's email reply threads back into the conversation.
  - A trigger action and an automatic policy to ask for an email when the queue is long.
- **UI:** Settings → Chat behaviour; Triggers.
- **Backend:** Outbound email with reply-to threading; inbound email parser.
- **Acceptance criteria:**
  - A visitor leaves before the agent replies. The agent's reply reaches them by email within 5 min, and the visitor's email response appears in the same conversation.

### C-16 · Web push and PWA for agents [MODERN]
- **Reference had:** native mobile apps with push (A-40), and browser desktop notifications only while the dashboard tab was open.
- **Source:** HC07; AR16.
- **Confidence:** Medium.
- **Required implementation:** An installable PWA with Web Push for assigned chats and mentions, which works when the tab is closed.
- **UI:** Settings → Personal → Notifications.
- **Backend:** VAPID push service.
- **Acceptance criteria:**
  - With the dashboard closed, a newly assigned chat produces a push within 5 s.

### C-17 · Extended trigger model [MODERN]
- **Reference had:** three events, a flat all/any condition list and no nesting [HC01, AR37].
- **Source:** HC01; AR37.
- **Confidence:** High.
- **Required implementation:**
  - Additional events: `chat_ended`, `agent_message`, `offline_message_submitted`, `visitor_idle`, `queue_wait_exceeded`.
  - Nested condition groups.
  - A test or simulate mode.
  - Per-trigger execution stats.
  - Versioning with rollback.
- **UI:** Triggers.
- **Backend:** Trigger engine (A-41).
- **Acceptance criteria:**
  - The simulator, given a visitor context, shows which conditions pass and which actions would run, without side effects.

### C-18 · Bulk import and export of configuration [MODERN]
- **Reference had:** per-item CRUD in the UI and API. No CSV import/export for shortcuts or triggers was documented.
- **Source:** AR02; DV07; DV08.
- **Confidence:** Medium.
- **Required implementation:** CSV and JSON import/export for shortcuts, triggers, tags, departments and bans, with a dry-run diff.
- **UI:** Shortcuts; Triggers; Settings.
- **Backend:** Import validator; transactional apply.
- **Acceptance criteria:**
  - Importing 500 shortcuts with 3 invalid rows reports the 3 errors in the dry run and imports none until confirmed.

---

# Parity checklist

Priority key:

- **P0:** must-have for launch.
- **P1:** soon after launch.
- **P2:** later.

Module key:

- `api:*`: NestJS module in `apps/api`
- `web:*`: dashboard page in `apps/dashboard`
- `widget:*`: `apps/widget`
- `shared`: `packages/contracts`

| ID | Feature | Cat. | Confidence | Our module | Priority |
|---|---|---|---|---|---|
| A-01 | Embeddable widget; one account across many sites | A | Medium | api:websites · web:Websites · widget:loader | P0 |
| A-02 | Widget appearance (colour, position, title, concierge, message style, badge, mobile mode, profile card) | A | High | web:Chat Widget settings · widget:ui · shared:widget-config | P0 |
| A-03 | Widget visibility controls (start hidden, hide-when-offline, show/hide/toggle, pop-out) | A | High | widget:api · web:Chat Widget settings | P0 |
| A-04 | Widget language detection, override, per-locale strings | A | High/Med | widget:i18n · shared | P1 |
| A-05 | Widget sounds, unread count | A | High | widget:ui | P1 |
| A-06 | Pre-chat form (name, email, phone, department, message; required flags; proactive bypass) | A | High | widget:forms · api:conversations · web:Chat Widget settings | P0 |
| A-07 | Offline form and offline messages (unread, agent emails) | A | High | widget:forms · api:offline-messages · api:notifications | P0 |
| A-08 | Visitor-side chat lifecycle (participants, typing, read, end rules) | A | High | widget:core · api:realtime · shared:protocol | P0 |
| A-09 | Queue position for waiting visitors (live) | A | High | api:routing · widget:core | P1 |
| A-10 | File sending (types, 20 MB, allowlist, delete) | A | High | api:files · widget:core · web:Inbox | P1 |
| A-11 | Satisfaction rating (good/bad + comment, request, prompt) | A | High | api:conversations · widget:core · web:Inbox | P1 |
| A-12 | Transcripts (visitor email, agent send, forwarding, TXT export) | A | High | api:transcripts · api:mail · widget:menu | P1 |
| A-13 | Widget JS API, first generation equivalent (identity, tags, path, show/hide, events, departments) | A | High/Med | widget:api · shared:protocol | P0 core / P1 rest |
| A-14 | Widget JS API, second generation equivalent (prefill read-only, settings object, lazy connect) | A | Medium | widget:api | P1 |
| A-15 | Headless client SDK | A | High | packages:chat-sdk (new) · shared:protocol | P2 |
| A-16 | Authenticated visitors (HS256 JWT), cross-device history | A | High | api:identity · widget:auth | P1 |
| A-17 | Domain allowlist and country blocklist | A | High | api:websites · api:realtime (handshake) | P0 / P1 |
| A-18 | Visitor identity, auto-naming, sessions, path | A | High | api:visitors · api:sessions | P0 |
| A-19 | Agent statuses and account/department rollup | A | High | api:presence · web:Inbox | P0 |
| A-20 | Personal idle timeout (auto-away) | A | High | api:presence · web:Settings | P1 |
| A-21 | Agent notifications (desktop, per-event sounds, offline emails) | A | High/Med | web:Inbox · api:notifications | P0 |
| A-22 | Routing modes: broadcast and assigned (pick algorithm) | A | High | api:routing | P0 |
| A-23 | Chat limits (account/agent, override) | A | High | api:routing · web:Settings | P0 |
| A-24 | Hybrid assignment mode | A | High | api:routing | P2 |
| A-25 | Reassignment timeout and automatic idle | A | High | api:routing | P1 |
| A-26 | Skills-based routing | A | High | api:routing · api:skills | P2 |
| A-27 | Chat panel (composer, visitor context, conversation list) | A | High/Med | web:Inbox · api:conversations | P0 |
| A-28 | Proactive (agent-initiated) chat | A | High | web:Live Visitors · api:conversations | P0 |
| A-29 | Transfer to agent/department, invite, agent-to-agent chat | A | Medium | api:routing · web:Inbox · api:team-chat | P0 / P1 (agent DM) |
| A-30 | Listen and join (supervision) | A | Medium | api:conversations · web:Inbox | P1 |
| A-31 | End, leave and continue semantics | A | Medium | api:conversations · widget:core | P0 |
| A-32 | Dashboard keyboard shortcuts | A | High | web:Inbox | P2 |
| A-33 | Shortcuts (scopes, `/` picker, placeholders, options, tags) | A | High | api:shortcuts · web:Shortcuts · web:Inbox | P0 |
| A-34 | Chat tags (curated) vs visitor tags (free-form) | A | High/Med | api:tags · web:Settings | P1 |
| A-35 | Visitor notes (agent/trigger only) | A | High | api:visitors | P1 |
| A-36 | Live visitor list (categories, columns, grouping) | A | High | web:Live Visitors · api:presence | P0 |
| A-37 | High-load mode and load-shedding tiers | A | High | api:presence · ops flags | P2 |
| A-38 | Banning (visitor cookie/ID, IP), list, API | A | High | api:bans · web:Settings | P0 |
| A-39 | Agent profile and personal settings | A | High | web:Settings · api:agents | P1 |
| A-40 | Agent mobile experience | A | Medium | web (responsive/PWA) | P2 |
| A-41 | Triggers (3 events, all/any, conditions, ordered actions, run-once, non-firing rule) | A | High/Med | api:triggers · web:Triggers · shared:logic | P0 |
| A-42 | Default trigger templates (disabled) | A | Medium | api:seed · web:Triggers | P1 |
| A-43 | Departments (membership, routing, status, scoping) | A | High | api:departments · web:Departments | P0 |
| A-44 | Operating hours (account/department, 15-min, forced invisible) | A | High | api:schedules · web:Operating Hours · shared:logic | P1 |
| A-45 | Roles and permissions (built-in + custom matrix) | A | High | api:auth (RBAC) · web:Agents | P0 built-in / P1 custom |
| A-46 | Agent management (invite, enable/disable, delete) | A | High | api:agents · web:Agents | P0 |
| A-47 | Goals and conversion attribution | A | High | api:goals · web:Settings · web:Analytics | P2 |
| A-48 | Credit-card number redaction | A | High | api:messages (pipeline) · shared:logic | P1 |
| A-49 | Dashboard IP access restriction | A | High | api:auth | P2 |
| A-50 | API clients, OAuth, rate limits | A | High | api:auth · web:Settings | P1 |
| A-51 | Chat History (search, filters, detail, exports) | A | High | web:Chat History · api:search · api:exports | P0 |
| A-52 | Deletion and GDPR workflows | A | High | api:privacy · web:Chat History | P0 |
| A-53 | Outcome and timing metric definitions (missed, dropped, completed, unresponsive) | A | High | shared:logic/metrics · api:analytics | P0 |
| A-54 | Analytics dashboard (chats, agents, satisfaction, CSV, email reports) | A | High | web:Analytics · api:analytics | P1 |
| A-55 | Real-time Monitor | A | High | web:Analytics · api:realtime-metrics | P1 |
| A-56 | Chat-details CSV schema | A | High | api:exports · shared | P1 |
| A-57 | Public REST API (resource parity) | A | High | apps/api (all) · Public API | P1 |
| A-58 | Incremental exports (chats + engagements, agent timeline, queue events) | A | High | api:exports | P2 |
| A-59 | Real-time metrics API (REST + WebSocket) | A | High | api:realtime-metrics | P2 |
| A-60 | Bot/agent API and structured messages | A | High | api:bots · shared:protocol · widget:messages | P2 |
| A-61 | Help-desk ticket integration (generic connector) | A | Medium | api:integrations | P2 |
| A-62 | Analytics event forwarding (GA/dataLayer) | A | High/Low | widget:analytics | P2 |
| A-63 | CMS/e-commerce plugins | A | Medium | separate repos | P2 |
| A-64 | Session and chat timeout rules | A | Medium | api:conversations (timeouts) | P0 |
| A-65 | Plan entitlements and limits | A | High | api:entitlements | P2 |
| B-01 | Shortcut `#` prefix (unconfirmed; `/` is verified) | B | Low | web:Inbox | P0 (decision) |
| B-02 | Full placeholder list | B | Low | shared:logic | P1 |
| B-03 | Shortcut options wire format | B | Low | shared | P2 |
| B-04 | Visitor list sorting/config | B | Low | web:Live Visitors | P1 |
| B-05 | Notification event types | B | Low/Med | web:Settings | P1 |
| B-06 | Widget size presets | B | Low | widget:ui | P2 |
| B-07 | Legacy themes, fonts, bubble, extra positions | B | Low/Med | widget:ui | P2 |
| B-08 | Trigger message reveals/opens hidden widget | B | Medium | widget:core · api:triggers | P1 |
| B-09 | Cookie-consent API semantics | B | Low | widget:privacy | P1 |
| B-10 | Visual (map) visitor view | B | Low/Med | web:Live Visitors | P2 |
| B-11 | "Request email" trigger action timing | B | Low | api:triggers | P2 |
| B-12 | GA event catalogue | B | Low | widget:analytics | P2 |
| B-13 | Native desktop agent apps | B | Low | — | not planned |
| B-14 | Offline-message workflow in dashboard (reply/assign) | B | Low | web:Inbox · api:mail | P1 |
| B-15 | Search-engine/term capture reliability | B | Low | api:sessions | P2 |
| B-16 | Listen-mode UX | B | Low | web:Inbox | P1 |
| B-17 | Lite retention 30 vs 14 days | B | Low | — | n/a |
| B-18 | Away status display to visitors | B | Medium | widget:core · web:Chat Widget settings | P1 |
| B-19 | Accessibility floor and lazy connect (timing) | B | Low | widget | n/a (see C-14/A-14) |
| B-20 | Department status values (away) | B | Low | api:presence | P1 |
| B-21 | "Active chat" staleness for limits | B | Low | api:routing | P1 |
| B-22 | Dashboard Home overview | B | Low | web:Home | P2 |
| B-23 | 2019 vs current trigger condition list | B | Medium | api:triggers | n/a (validation) |
| C-01 | Agent MFA (TOTP/WebAuthn) | C | Medium | api:auth · web:Settings | P0 |
| C-02 | SSO (SAML/OIDC) and SCIM | C | Low/Med | api:auth | P2 |
| C-03 | Signed outbound webhooks | C | Medium | api:webhooks | P1 |
| C-04 | Shadow-DOM, CSP-friendly widget | C | Low | widget:core | P0 |
| C-05 | Asymmetric JWT + zero-downtime rotation | C | High | api:identity | P2 |
| C-06 | Audit log | C | Medium | api:audit · web:Settings | P1 |
| C-07 | Retention policies, IP minimization, DSAR API | C | High | api:privacy | P1 |
| C-08 | Visitor typing preview (optional) | C | Low/Med | widget:core · web:Inbox | P2 |
| C-09 | Agent-composed rich messages | C | High | web:Inbox · shared:protocol | P2 |
| C-10 | Multiple configured widgets per workspace | C | Medium | api:websites · web:Websites | P1 |
| C-11 | Abuse and spam protection | C | High | api:security · widget | P0 |
| C-12 | Holiday and exception dates in schedules | C | Medium | api:schedules | P2 |
| C-13 | General PII redaction, message redaction | C | High | api:messages | P2 |
| C-14 | WCAG 2.2 AA conformance | C | Low | widget · web | P1 |
| C-15 | Continuous conversations by email | C | Low/Med | api:mail · api:conversations | P2 |
| C-16 | Agent web push and PWA | C | Medium | web · api:notifications | P2 |
| C-17 | Extended trigger model (events, nesting, simulator, versions) | C | High | api:triggers · web:Triggers | P2 |
| C-18 | Bulk import/export of configuration | C | Medium | api:import · web | P2 |

---

# Open questions for validation

**Archive validation (blocked by Wayback 429)**

1. Retrieve the Wayback copies listed in §4.4 and diff them against HC01 and HC02. In particular:
   - Did the 2019 trigger reference already include "previous page URL", "visitor status = idle", "queue size", "request email" and the regex operator?
   - Did "Proactive Greeting by Name" and the other templates ship in 2019, or later?
2. Retrieve the 2019 copies of these articles to confirm the UI-level semantics we took from current pages:
   - "Serving chats" (transfer rules, continue chat)
   - "When do chats time out" (browser-close and mobile values)
   - the ticket-creation options article
   - the `$zopim.livechat.window`, `.button`, `.badge`, `.concierge`, `.theme` and `.departments` sub-pages (exact signatures, position codes, size presets)

**Product decisions on reference behaviours**

3. **Triggers with no agents online.** The reference suppressed triggers entirely when no agent was online, or all were invisible (AR37). Do we keep this for message-sending actions only, or for all actions? Tagging, routing and notes arguably should still run.
4. **Invisible under broadcast.** In the reference, invisible agents could still see and serve broadcast requests (AR17). Keep, or make invisible strictly passive?
5. **Away and routing.**
   - Should Away agents receive *assigned* chats? The reference assigned to "online" agents. Skills routing explicitly excluded Away and Invisible agents (AR01, AR31), but plain assigned routing is not explicit.
   - Should the widget show an "away" state (B-18)?
6. **Agent "end chat".** The reference let agents only *leave*; the visitor's session persisted. Do we add an agent-can-end policy (A-31) and default it on or off?
7. **Day-of-week indexing.** Trigger conditions used 0 = Monday (HC01), while the Web SDK schedule used 0 = Sunday (AR53). Standardize on ISO-8601 (1 = Monday … 7 = Sunday) internally, and map explicitly on legacy import and export.
8. **Chat-limit load.** Do chats with no recent messages count toward an agent's limit (B-21)? This affects routing fairness.
9. **Department-scoped visitor visibility.** With `visitors_seen=department`, should agents see browsing visitors who have no department yet?
10. **Shortcut trigger character.** Default `/` (verified) with optional `#` (from the brief)? See B-01.
11. **JWT lifetime limits.** Replicate the 7-minute max `exp − iat` and 2-minute skew exactly, or make them configurable with these as defaults?
12. **Proactive bypass of the pre-chat form.** Keep the bypass (parity), or ask for missing required fields after the visitor's first reply (better data capture)?
13. **Queue position copy.** Adopt the post-October-2021 semantics (current position, live updates) rather than "N visitors ahead"? We recommend yes.
14. **Transfers to departments with no one online.** The reference warned that the session would close. Should we instead convert the chat to an offline message, or keep it queued?

**Scope and packaging**

15. **Offline form vs department status.** When the account is online but the visitor's chosen department is offline, does the widget switch to the offline form for that department? The SDK implies department-level offline messaging. Confirm the desired UX.
16. **Rating scale.** The reference was binary (good/bad). Is a 5-point CSAT scale also needed?
17. **Plan gating.** Which reference plan gates, if any, should Talkivio mirror? Candidates: skills routing, custom roles, real-time API, IP restriction, operating hours.
18. **Legacy import.** Should we offer a migration importer for Zendesk Chat REST exports (chats, shortcuts, triggers JSON, bans, departments)? If yes, schemas in `packages/contracts` should keep the lossless mappings described in A-41, A-33 and B-03.
