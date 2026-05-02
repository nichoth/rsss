---

description: "Tasks for fetch-full-article-body feature"
---

# Tasks: Fetch Full Article Body When Feed Provides Only a Summary

**Feature directory**: `/Users/nick/code/rsss/specs/002-full-article-fetch`
**Branch**: `002-full-article-fetch`
**Inputs**: plan.md, spec.md, research.md, data-model.md, contracts/fetch-full-article.md, quickstart.md

**Tests**: Included. The plan and research enumerate explicit test files
(`test/article-extract.ts`, `test/article-fetch.ts`,
`test/article-detect.ts`, `test/publisher-link.ts`,
`test/article-fetch-not-in-refresh.ts`, plus extensions to existing
`test/sync.ts` and `test/local-adapter.ts`). The constitution requires
local-first behaviour and refresh-cost guarantees that we want to lock
down with tests.

**Organization**: Tasks are grouped by user story. User Story 1 (P1)
delivers the on-demand full-article fetch and is the MVP. User Story 2
(P1) ships the publisher link. User Story 3 (P2) renders state notices
and the retry affordance.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on
  incomplete tasks).
- **[Story]**: `US1`, `US2`, `US3` map to user stories from spec.md.
- File paths in descriptions are absolute-from-repo-root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Constants and shared schema scaffolding that every later
phase consumes. No behaviour changes yet.

- [X] T001 [P] Add new constants block to `src/shared/schema.ts`
  exporting `MAX_FULL_CONTENT_BYTES = 256 * 1024`,
  `MAX_ARTICLE_FETCH_BYTES = 1 * 1024 * 1024`,
  `EXTRACTED_MIN_TEXT = 500`, `SUMMARY_TEXT_THRESHOLD = 1500`,
  `ARTICLE_FETCH_TIMEOUT_MS = 8_000`,
  `FETCH_FULL_MIN_INTERVAL_MS = 5_000`. Keep existing
  `MAX_ARTICLE_REDIRECTS = 5` value as the single source for redirect
  cap (reuse from spec 001).
- [X] T002 [P] Extend the `items` `CREATE TABLE` in
  `src/shared/schema.ts` `TABLES_SQL` to include three new columns:
  `full_content TEXT`, `full_content_fetched_at TEXT`,
  `full_content_status TEXT`. Update any exported `ITEM_COLUMNS`-style
  list in the same file.
- [X] T003 Add a `FullContentStatus` type to `src/shared/schema.ts`:
  `export type FullContentStatus = 'succeeded' | 'failed_network' |
  'failed_status' | 'failed_redirect' | 'failed_non_html' |
  'failed_too_large' | 'failed_no_body'`. Export an
  `ALL_FULL_CONTENT_STATUSES` array for use in tests and the
  client/server validators.

**Checkpoint**: Shared schema and constants are in place; nothing
references them yet. Repo still compiles.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Pure helpers that User Stories 1, 2, and 3 all depend on.
These are testable in isolation (no DO, no fetch).

- [X] T004 [P] Create `src/shared/article-detect.ts` exporting
  `isSummaryOnly(item:{ link?:string|null, content?:string|null,
  description?:string|null }):boolean`. Implements the R-1 heuristic:
  non-empty link AND `plainTextLength(item.content || item.description
  || '') < SUMMARY_TEXT_THRESHOLD`. Also export
  `plainTextLength(html:string):number` (strip tags, decode entities,
  collapse whitespace, count code points).
- [X] T005 [P] Create `src/shared/publisher-link.ts` exporting
  `publisherLinkLabel(link:string):string|null` and
  `publisherLinkHref(link:string):string|null`. Label is
  `"Read the full article on " + host` where `host =
  new URL(link).host` with leading `www.` stripped; both functions
  return `null` for empty, malformed, or non-`http(s):` URLs.
- [X] T006 [P] [Tests] Create `test/article-detect.ts` covering:
  empty content + empty description → not summary; long content →
  not summary; short summary, no link → not summary (link gate);
  short summary, has link → summary; CJK + emoji content count
  by code points; HTML entities and tags do not inflate length.
- [X] T007 [P] [Tests] Create `test/publisher-link.ts` covering:
  `https://brittanyellich.com/post` →
  label "Read the full article on brittanyellich.com", href is the
  full URL; `https://www.example.com/x` → host stripped to
  `example.com`; `https://blog.example.com/x` → keeps subdomain;
  empty/null/`mailto:`/`javascript:` → `null,null`.
- [X] T008 Create `src/server/article-extract.ts` exporting
  `extractArticleBody(html:string, baseUrl:string):
  { html:string, plainTextLength:number } | { error:'no_body' |
  'too_large' }`. Implements the R-3 pipeline: strip
  scripts/styles/noscript/iframe/form/svg/comments/header/nav/aside/
  footer and chrome class names; pick `<article>` then `<main>` then
  highest-text-density `<div>`/`<section>`; return inner HTML; pass
  through `sanitiseExtractedHtml`; cap at `MAX_FULL_CONTENT_BYTES`
  truncating at the last `</p>` or `</div>` boundary; return
  `error:'no_body'` if `plainTextLength < EXTRACTED_MIN_TEXT`;
  return `error:'too_large'` if no clean truncation point exists
  below the cap. Also export `sanitiseExtractedHtml(html:string):
  string` doing the regex pass described in R-7.
- [X] T009 [P] [Tests] Create `test/article-extract.ts` covering:
  `<article>` is preferred over `<main>`; chrome elements (header,
  nav, aside, footer, .comments) are removed; an inline `<script>`
  is stripped; an `onclick=` handler is stripped; a `javascript:`
  href is stripped; a `data:image/png;base64,...` URL survives;
  a paywall stub (under 500 chars text) returns
  `error:'no_body'`; a 500 KiB body is truncated at the last
  `</p>` under 256 KiB; an oversized blob with no `</p>` returns
  `error:'too_large'`.

**Checkpoint**: `isSummaryOnly`, the publisher-link helpers, and the
extractor are all unit-tested and green. No network calls yet.

---

## Phase 3: User Story 1 - Read full article inside the reader (P1) - MVP

**Goal**: When a reader opens an item from a summary-only feed, the
full article body is fetched on-demand from the article URL and
rendered inside the reader.

**Independent Test**: Subscribe to `https://brittanyellich.com/index.xml`,
open one of its items. Within ~3 seconds the article view shows the full
body (paragraphs, headings, inline images), without leaving the app.
Reopening the item triggers no further `fetch-full` request.
Reference: quickstart.md SC-001 / FR-002 / FR-005 / SC-003.

### Server pipeline + endpoint

- [X] T010 [US1] Create `src/server/article-fetch.ts` exporting
  `fetchFullArticle(link:string):Promise<{ status:'succeeded',
  html:string, fetchedAt:string } | { status: Exclude<FullContentStatus,
  'succeeded'> }>`. Pipeline per contracts/fetch-full-article.md
  step 5–7: call `fetchValidatedResponse(link, { maxRedirects: 5,
  redirectErrorMessage: 'Article redirected too many times', signal:
  AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS) })` from
  `src/server/feed-fetch.ts`; map errors to `failed_network` /
  `failed_status` / `failed_redirect`; check `Content-Type` →
  `failed_non_html` if not html/xhtml; cap reads at
  `MAX_ARTICLE_FETCH_BYTES` → `failed_too_large`; call
  `extractArticleBody(html, finalUrl)` → success or
  `failed_no_body` / `failed_too_large`. No `console.error` for
  routine failures (spec-001 logging style).
- [X] T011 [US1] [Tests] Create `test/article-fetch.ts` covering:
  successful 200 + readable HTML → `succeeded`; 404 → `failed_status`;
  6-redirect chain → `failed_redirect`; `Content-Type:
  application/pdf` → `failed_non_html`; 2 MiB body →
  `failed_too_large`; paywall stub (<500 chars) → `failed_no_body`;
  `AbortSignal.timeout` fires → `failed_network`; SSRF-blocked
  hostname → `failed_network`. Use the existing `mockFetch`
  pattern from spec 001 tests (no real network).
- [X] T012 [US1] In `src/server/durable-objects/index.ts`, extend
  `ITEM_COLUMNS` (or equivalent select-list constant) to include
  `full_content`, `full_content_fetched_at`, `full_content_status`.
  Make the same change to `ITEM_SYNC_COLUMNS` so the new columns are
  emitted on `/api/sync` pages (data-model.md "Wire format").
- [X] T013 [US1] In `src/server/durable-objects/index.ts`, add
  `private migrateAddItemFullContent()` exactly as in data-model.md
  (idempotent `PRAGMA table_info` + `ALTER TABLE` per column). Bump
  `USER_DO_MIGRATION_VERSION` from 4 → 5 and call the new migration
  from the version-5 branch.
- [X] T014 [US1] In `src/server/durable-objects/index.ts`, register
  `POST /items/:id/fetch-full`. Implementation per
  contracts/fetch-full-article.md "Server-side flow":
  parse `:id` (→ 400 on bad), parse JSON body `{ force?:boolean }`
  (→ 400 on bad), `SELECT ... FROM items WHERE id = ?` (→ 404 if
  missing), early-return existing row when `!force &&
  full_content_status === 'succeeded' && full_content`, return 409
  `item_has_no_link` if `link` is empty, apply the
  `FETCH_FULL_MIN_INTERVAL_MS` throttle for non-forced calls
  (return 429 with `Retry-After`), call `fetchFullArticle(link)`,
  `UPDATE items SET full_content = ?, full_content_fetched_at =
  datetime('now'), full_content_status = ?` (preserving the prior
  `full_content` on `failed_*` outcomes), return the updated row in
  the documented `{ "item": ... }` shape. Validate status
  transitions against `ALL_FULL_CONTENT_STATUSES`.
- [X] T015 [US1] In `src/server/index.ts`, route the public path
  `POST /api/items/:id/fetch-full` through the existing `dataRouter`
  proxy to the user's DO at `POST /items/:id/fetch-full`, behind
  `requireAuth`. No entitlement gate (matches `/api/items` data
  endpoints).
- [X] T016 [US1] [Tests] Add an integration test
  `test/fetch-full-endpoint.ts` (or extend an existing DO route
  test if there is one) covering: 200 with `succeeded` row when the
  pipeline reports success; 200 with `failed_status` on 404; 200
  cache hit (no fetch attempted) when status is already `succeeded`
  and `force` not set; 200 forced re-fetch overwrites; 400 on
  non-integer id; 400 on invalid JSON body; 404 on unknown id; 409
  on item with empty link; 429 + `Retry-After` on rapid second
  call without `force`. Use the same fetcher mock as T011.

### Sync wiring

- [X] T017 [US1] In `src/client/db/types.ts`, extend the `Item`
  type with `full_content?:string|null`,
  `full_content_fetched_at?:string|null`,
  `full_content_status?:FullContentStatus|null` (re-export status
  type from `src/shared/schema.ts`).
- [X] T018 [US1] In `src/client/db/pull-sync.ts`, extend
  `upsertItem` to write the three new columns (mirror the
  treatment of `content` and `description`, including the
  `storeContent`/`keepContent` privacy gate — when local content
  storage is disabled, drop `full_content` on the way in too).
  Add a small idempotent `ensureItemFullContentColumns(db)` helper
  (mirrors `ensureSyncCursorColumn`) that runs `PRAGMA
  table_info(items)` and `ALTER TABLE` for any of the three columns
  that is missing on an existing OPFS DB. Call it before the first
  upsert in a sync cycle.
- [X] T019 [US1] In `src/client/db/push-sync.ts`, extend
  `upsertItemFromServer` to copy the same three columns (server →
  local mirror path).
- [X] T020 [US1] In `src/client/db/bootstrap.ts` (or wherever the
  initial `/api/sync` payload is fanned into the local DB), make
  sure the new columns are passed through to `pullSync.upsertItem`.
- [X] T021 [US1] [Tests] Extend `test/sync.ts` with a round-trip
  case: server returns an item with `full_content_status:
  'succeeded'` and a `full_content`; after `pullSync`, the local
  row has the same three columns set. Add a second case where
  `storeContent` is false: `full_content` is dropped in the local
  upsert.
- [X] T022 [US1] [Tests] Extend `test/local-adapter.ts` to verify
  `SELECT * FROM items WHERE id = ?` returns the three new columns
  (NULL by default, populated after a manual UPDATE).

### Client trigger + render

- [X] T023 [US1] In `src/client/db/remote-adapter.ts`, add
  `fetchFullArticle(itemId:number, opts?:{ force?:boolean }):
  Promise<{ item:Item }>`. POSTs to
  `/api/items/${itemId}/fetch-full` with `{ force }`, throws on
  non-2xx, returns parsed JSON. Map 429 to a typed
  `FetchFullThrottledError` carrying `retryAfterSeconds`.
- [X] T024 [US1] In `src/client/state.ts`, add a
  `fetchFullArticle(itemId, opts?)` action that calls the remote
  adapter, then upserts the returned item into the local DB
  (`pullSync.upsertItem`-equivalent path) AND into any in-memory
  item-state map so the open article view re-renders within the
  same tick. Use `batch` from `@preact/signals` for any
  multi-signal write. Add component-local request state via
  `@substrate-system/state` (loading / error) so the route can
  render a "Fetching full article…" indicator.
- [X] T025 [US1] In `src/client/routes/item-reader.ts`, on item
  open: if `isSummaryOnly(item) && item.full_content_status == null
  && navigator.onLine`, call `state.fetchFullArticle(item.id)`. Do
  NOT auto-trigger when status is `succeeded` (cache hit) or any
  `failed_*` (retry is explicit). Render `item.full_content`
  through the existing `sanitizeHtml` (DOMPurify) when present,
  else fall back to `item.content || item.description` exactly as
  today. Keep the existing fallback chain intact.
- [X] T026 [US1] In `src/client/routes/item-reader.ts`, render a
  small "Fetching full article…" indicator while the action is in
  flight. No new global CSS — extend
  `src/client/routes/item-reader.css` with one rule for
  `.article-fetch-status` (only, no unrelated CSS).

### Lockdown test

- [X] T027 [US1] [Tests] Create
  `test/article-fetch-not-in-refresh.ts` (modelled on
  `test/state-refresh-audit.ts` / `test/sync-invariant-static.mjs`)
  asserting that `fetchFullArticle` and `extractArticleBody` are
  NOT referenced from any of: `src/server/feed-parser.ts`,
  `src/server/feed-fetch.ts`, `src/server/durable-objects/`'s
  refresh / alarm code paths, or any client refresh action. Static
  string-grep is sufficient (matches existing static-test pattern).

**Checkpoint**: User Story 1 is end-to-end functional. A summary-only
item opens, fetches, renders the full body within ~3s, caches it for
re-opens, and adds zero cost to feed-refresh. SC-001, SC-002, SC-003,
SC-007 are observable by following quickstart.md.

---

## Phase 4: User Story 2 - "Read the full article on …" link (P1)

**Goal**: A link "Read the full article on `<publisher-domain>`" is
rendered immediately below the article body whenever the item has a
non-empty article URL, in all body states.

**Independent Test**: Open any item with a `link`. Below the article
body (or summary, if that is all there is) the link is present, points
at `item.link`, opens in a new tab, and labels itself with the host
(www-stripped) of `item.link`. Items with no link render no link.
Reference: quickstart.md FR-011 / FR-012 / FR-013 / FR-015.

- [X] T028 [US2] In `src/client/routes/item-reader.ts`, render the
  publisher link below the article body using
  `publisherLinkLabel(item.link)` and `publisherLinkHref(item.link)`.
  Render nothing if either returns null. Set
  `target="_blank" rel="noopener noreferrer"` (FR-013).
- [X] T029 [US2] In `src/client/routes/item-reader.ts`, replace the
  current "Open original" button affordance with the publisher link
  (FR-014: the publisher link is the *only* explicit escape hatch
  going forward). Confirm the link appears in all body states:
  feed-supplied content, fetched full content, and
  fallback-to-summary states. Adjust
  `src/client/routes/item-reader.css` with a single new rule for
  `.article-publisher-link` (using existing colour / spacing
  variables; do not introduce new colours).
- [X] T030 [US2] [Tests] Extend `test/publisher-link.ts` (or add a
  small DOM-rendering test) verifying that the route omits the
  link when `item.link` is null/empty/malformed, and renders it
  with the right label and `target="_blank" rel="noopener
  noreferrer"` when present. If a route-rendering harness does not
  exist, assert via the helpers + a snapshot-style structural check
  in plain TS.

**Checkpoint**: User Story 2 is independently functional. SC-004
holds (link present iff `item.link` exists, label = host w/o www).

---

## Phase 5: User Story 3 - Tell summary vs fetched at a glance (P2)

**Goal**: The article view makes it visually clear whether the
displayed body is a fetched full article, an in-feed full article, a
summary, or a fallback after a failed fetch — and the user can retry a
failure.

**Independent Test**: Open three items: one full-from-feed, one
summary-with-successful-fetch, one summary-with-failed-fetch. The
failure case shows a small notice and a Retry button; the success and
full-from-feed cases show no notice; the failure can be retried with a
single click and lands on the success state when the underlying issue
is fixed.
Reference: quickstart.md FR-009 / SC-005 / SC-006.

- [X] T031 [US3] In `src/client/routes/item-reader.ts`, when
  `item.full_content_status` starts with `'failed_'`, render a
  small notice "Couldn't load the full article." with a `Retry`
  button immediately above the publisher link. The summary
  (`item.content || item.description`) MUST remain visible —
  failure does not blank the article view (FR-008 / SC-005).
- [X] T032 [US3] Wire the Retry button to call
  `state.fetchFullArticle(item.id, { force: true })`. While the
  retry is in flight, swap the notice for the same "Fetching full
  article…" indicator from T026; on success, replace the
  summary with the full body; on failure, restore the notice with
  whatever new `failed_*` status came back.
- [X] T033 [US3] In `src/client/routes/item-reader.css`, add one
  rule for `.article-fetch-status.failed` (and an `.article-fetch-
  retry` rule if the button needs spacing). Reuse existing colour
  variables — do not introduce new ones. No CSS unrelated to this
  feature is modified.
- [X] T034 [US3] [Tests] Add a small render-state test (extend the
  existing item-reader test file if one exists, otherwise inline in
  `test/article-detect.ts` is acceptable) verifying: (a) status
  `null` + content present → no notice; (b) status `succeeded` →
  no notice, body = `full_content`; (c) status `failed_network` →
  notice + Retry visible, summary still rendered; (d) clicking
  Retry calls `state.fetchFullArticle(id, { force: true })`. If a
  DOM-style test harness is not available, assert via the action
  spy + the structural booleans the route exposes.

**Checkpoint**: All three user stories work. SC-005 (no empty article
view on failure) and SC-006 (visual distinction in 100% of cases) are
observable.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T035 [P] Run `npm run lint` and `npm test`; fix any
  surfaced issues. Confirm the new tests
  (`test/article-detect.ts`, `test/publisher-link.ts`,
  `test/article-extract.ts`, `test/article-fetch.ts`,
  `test/fetch-full-endpoint.ts`,
  `test/article-fetch-not-in-refresh.ts`) appear in the test
  runner's discovery (`script/run-all-tests.mjs` or equivalent).
- [X] T036 [P] Walk through `specs/002-full-article-fetch/quickstart.md`
  end-to-end against `npm start` in a real browser. Verify each
  section's pass criteria. Capture any observed deviations and
  open follow-up tasks if they are out of spec scope.
- [X] T037 [P] Manually inspect the local OPFS DB after a few
  brittanyellich opens (per quickstart "Inspect the local DB")
  and confirm `length(full_content) <= MAX_FULL_CONTENT_BYTES`,
  `full_content_status` is one of the documented enum values, and
  `full_content_fetched_at` parses as a valid timestamp (SC-008).
- [X] T038 Update `CLAUDE.md` "Active Technologies" section if the
  /speckit.plan agent-context update did not already cover the
  002 entry.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: no upstream dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1 (uses constants and
  shared schema). MUST complete before any user story.
- **Phase 3 (US1)**: depends on Phase 2.
- **Phase 4 (US2)**: depends on Phase 2 only — does NOT depend on US1.
  Can start in parallel with US1 once Phase 2 is done.
- **Phase 5 (US3)**: depends on Phase 3 (uses
  `state.fetchFullArticle` + the route states US1 introduces) and
  Phase 4 (renders next to the publisher link). Effectively last.
- **Phase 6 (Polish)**: depends on Phases 3–5.

### Within User Story 1

- T010 (server fetch pipeline) → T011 (its tests).
- T010, T012, T013 → T014 (DO route uses ITEM_COLUMNS, migration,
  pipeline) → T015 (Worker route proxies to DO) → T016 (endpoint
  tests).
- T017 (types) → T018, T019, T020 (sync wiring).
- T018, T019 → T021, T022 (sync round-trip tests).
- T023 (remote adapter) → T024 (state action) → T025, T026 (route
  trigger + indicator).
- T027 (lockdown test) is independent of the rest of US1 once
  T010 exists.

### Within User Story 2

- T028 → T029 → T030 (rendering before tests in this case is a
  judgement call; T030 can be written first if you prefer TDD).

### Within User Story 3

- T031 → T032 → T033 → T034 (each builds on the prior render state).

### Parallel Opportunities

- Phase 1: T001, T002 are in the same file (`schema.ts`) and must be
  serialised. T003 is in the same file, also serialised.
- Phase 2: T004, T005, T006, T007 are in different files and all
  parallelisable. T008 must precede T009.
- Phase 3 server (T010) and Phase 3 sync (T017–T020) and Phase 3
  client (T023–T026) can each be worked in parallel by different
  developers once their immediate prerequisites (Phase 2) are done.
- Phases 3 and 4 can run in parallel after Phase 2.
- Phase 6 polish tasks (T035, T036, T037) are independent and
  parallelisable.

---

## Parallel Example: Phase 2

```bash
# All four tasks touch different files and depend only on Phase 1:
Task: "Create src/shared/article-detect.ts (T004)"
Task: "Create src/shared/publisher-link.ts (T005)"
Task: "Create test/article-detect.ts (T006)"
Task: "Create test/publisher-link.ts (T007)"
# T008/T009 must follow because the extractor itself is one larger
# unit; T009's tests assert T008's behaviour.
```

## Parallel Example: User Story 1 sync wiring

```bash
# After T017 (types) lands, these can be split across two devs:
Task: "Extend pull-sync upsertItem (T018)"
Task: "Extend push-sync upsertItemFromServer (T019)"
# Then converge on:
Task: "Bootstrap fan-out passthrough (T020)"
Task: "Sync round-trip test (T021)"
Task: "Local-adapter test (T022)"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 → Phase 2 → Phase 3.
2. Walk quickstart.md sections SC-001, FR-003, FR-005/SC-003,
   SC-007. If they all pass, the MVP is shippable behind nothing —
   the feature is additive (US-144 lockdown is preserved by T027).

### Incremental delivery

1. MVP (US1) → Demo full-body rendering on brittanyellich.
2. Add US2 → publisher link replaces the generic "Open original"
   affordance everywhere.
3. Add US3 → failure notice + Retry button → cover the offline /
   paywall edge cases.

### Parallel team strategy

- Dev A: Phase 1 (T001–T003), then Phase 3 server (T010–T016).
- Dev B: Phase 2 (T004–T009) and Phase 3 sync (T017–T022) in series.
- Dev C: Phase 3 client (T023–T026), Phase 4 (T028–T030), Phase 5
  (T031–T034) once Dev A's T024 lands.
- Whoever is free: T027 (lockdown test) and Phase 6 polish.

---

## Independent Test Criteria (per user story)

| Story | Pass criteria (no dependence on other stories) |
|---|---|
| US1 | Open a brittanyellich item: full body renders within ~3s on a typical broadband; reopening triggers no `fetch-full` request; opening a `404media` (full-content) item issues zero `fetch-full` requests. |
| US2 | Any item with a `link` shows the publisher link below the body, label = `link`'s host with `www.` stripped, target = `_blank`. Items without a `link` render no link. The legacy "Open original" button is gone. |
| US3 | Three test items (full-from-feed, fetched-OK, fetch-failed) are visually distinguishable in the UI. The failed item shows a Retry button that, when clicked, fires `POST /api/items/<id>/fetch-full` with `force: true`. |

## Format validation

All 38 tasks above match the required `- [ ] T### [P?] [US?]
description with file path` checklist format. Setup, Foundational, and
Polish tasks intentionally carry no `[US]` label.
