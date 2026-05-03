---
description: "Task list for 003-defer-new-feed-items"
---

# Tasks: Defer New Feed Items Until Refresh

**Input**: Design documents from `/specs/003-defer-new-feed-items/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/api-items.md, contracts/api-sync.md, quickstart.md

**Tests**: Test tasks are included. The plan calls for integration
tests covering the reading-list filter and the spec's acceptance
scenarios; the constitution also requires local browser verification
via the quickstart for any UI-touching change.

**Organization**: Tasks are grouped by user story to enable
independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- All paths are absolute from the repo root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new project scaffolding is required. This phase only
captures the prep work needed to begin implementation cleanly.

- [X] T001 Confirm working tree is clean and on branch
  `003-defer-new-feed-items` via `git status` from the repo root, so
  per-task commits stay scoped to this feature.
- [X] T002 Run `npm install` (idempotent) and then `npm test` to
  capture a baseline pass before changes; record any pre-existing
  flaky tests so they are not attributed to this feature.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Replicate `feeds.last_pulled_at` to the client SQLite
and ensure pre-existing feed rows get re-emitted to clients on the
next pull. This is the constitution's "schema and sync changes are
coupled" requirement and MUST land before any user-story work — both
the server filter (US1) and the local-adapter filter (US1) require
the column to be populated client-side.

**CRITICAL**: All three changes (T003, T004, T005) MUST be in the
same commit/PR per the constitution; they are listed as separate
tasks for traceability only.

- [X] T003 Widen `FEED_SYNC_COLUMNS` in
  `/Users/nick/code/rsss/src/server/durable-objects/index.ts` to
  include `last_pulled_at` (currently 4 columns at the constant
  declaration; new list per `contracts/api-sync.md`:
  `id, url, title, description, site_url, last_fetched,
  last_pulled_at, last_error, last_status, created_at, updated_at`).
  Verify the SELECT used by `/api/sync` uses this constant so the
  payload picks up the column without further edits.
- [X] T004 Update `upsertFeed` in
  `/Users/nick/code/rsss/src/client/db/pull-sync.ts` to include
  `last_pulled_at` in (a) the INSERT column list, (b) the bind
  vector (sourced from the wrapped row), and (c) the
  `ON CONFLICT(id) DO UPDATE SET` clause as
  `last_pulled_at = excluded.last_pulled_at`. The client MUST NOT
  write this column from any other path (it is server-authoritative
  per data-model.md).
- [X] T005 Add a one-time, idempotent migration in
  `/Users/nick/code/rsss/src/server/durable-objects/index.ts` that
  bumps `updated_at` for every feed row so existing client SQLite
  databases re-pull the row and pick up the newly-projected
  `last_pulled_at`. Implement per `contracts/api-sync.md`:
  guard with a `migration_version` storage key (or follow the
  existing migration-versioning pattern in this file), then run
  `UPDATE feeds SET updated_at = datetime('now')`. Confirm the guard
  prevents repeated execution.

**Checkpoint**: After Phase 2, the client's local SQLite contains
`last_pulled_at` for every feed row that has ever been pulled. User
stories can now begin.

---

## Phase 3: User Story 1 — Adding a feed surfaces posts in the un-synced counter, not the reading list (Priority: P1)

**Goal**: After a successful add-feed, the reading list MUST stay
visually unchanged. The new feed's posts MUST flow into the un-synced
counter via the existing SSE path, not into the reading list.

**Independent Test**: Per quickstart Step 2 — note the reading
list's top item, add a feed with N posts, verify the top item is
unchanged and the un-synced counter increases by N within ~1s of the
add completing.

### Tests for User Story 1

- [X] T006 [P] [US1] Add an integration test in
  `/Users/nick/code/rsss/test/feed-cursor.ts` (extending the existing
  file or adding sibling cases) that asserts: given a feed with
  `last_pulled_at IS NULL` and items with various `pub_date` values,
  the server query used by `GET /api/items` returns zero items for
  that feed. Cover the count(*) variant too so pagination totals
  match. Test MUST FAIL before T009 lands.
- [X] T007 [P] [US1] Add an integration test alongside
  `/Users/nick/code/rsss/test/local-adapter.ts` that asserts:
  `localAdapter.getItems()` applies the same cursor predicate as the
  server. Use a fixture local SQLite with two feeds — one with a
  populated cursor, one with `last_pulled_at IS NULL` — and assert
  only items from the first feed are returned. Test MUST FAIL before
  T010 lands.
- [X] T008 [P] [US1] Add a test in
  `/Users/nick/code/rsss/test/pull-sync.ts` (or a new sibling file
  if cleaner) that asserts the wrapped feed payload includes
  `last_pulled_at` and that `upsertFeed` writes it to the local DB
  for both INSERT and UPDATE paths. This guards the Phase 2 work
  against regression.

### Implementation for User Story 1

- [X] T009 [US1] In
  `/Users/nick/code/rsss/src/server/durable-objects/index.ts`, modify
  the `GET /items` handler (the SQL that joins `feeds` on
  `items.feed_id = feeds.id`) to add the cursor predicate exactly as
  specified in `contracts/api-items.md`:
  `AND ( items.pub_date IS NULL OR ( feeds.last_pulled_at IS NOT NULL
  AND items.pub_date <= feeds.last_pulled_at ) )`. Apply the
  identical predicate to the count(*) query that populates `total`,
  so pagination is consistent. Do NOT change `GET /feeds/:id/pending`
  or any per-feed unread-count query (FR-009).
- [X] T010 [US1] In
  `/Users/nick/code/rsss/src/client/db/local-adapter.ts`, modify
  `getItems()` to JOIN `items` with `feeds` on `feed_id` (if not
  already joined) and apply the same predicate from T009. Apply it to
  the count query as well. Do NOT change other adapter methods.
- [X] T011 [US1] In
  `/Users/nick/code/rsss/src/client/state.ts`, locate the add-feed
  success branch (search for the `addFeed` handler and the call to
  `loadItems(state)` flagged in research.md R7) and remove the
  `loadItems(...)` call. Keep `loadFeeds(...)` and `loadCounts(...)`
  in place. Wrap any sequential signal updates in `batch(() => ...)`
  per the global CLAUDE.md guidance on `@preact/signals`.
- [X] T012 [US1] Local browser verification of US1 per quickstart
  Step 2 (and the AC1, AC2, AC3, AC4 scenarios in spec.md):
  `npm start`, log in, note baseline reading list and counter, add a
  feed with ≥3 posts, confirm the reading list is unchanged, the
  sidebar gains the new feed, the counter increases by N, and the
  sync status pill shows "updates available". Watch for the
  "reading list flickers and reverts" failure mode listed in the
  quickstart and treat it as a hard fail.

**Checkpoint**: US1 is complete. The MVP behavior holds: add-feed no
longer mutates the reading list; the counter and pill reflect the
deferred posts.

---

## Phase 4: User Story 2 — "Refresh Feeds" promotes the un-synced posts into the reading list (Priority: P1)

**Goal**: Clicking "Refresh Feeds" advances the cursor for every
subscribed feed (including newly-added feeds) so deferred posts
appear in the reading list and the counter clears.

**Independent Test**: Per quickstart Step 3 — after US1's add step,
click "Refresh Feeds" and verify the new feed's posts now appear in
chronological position and the counter clears to zero within the
existing refresh latency (SC-003).

**Note**: Research R2 confirmed that the manual `POST /feeds/refresh`
already calls `advanceFeedCursor` for every feed it touches, so the
expected behavior should hold without code changes. These tasks
verify the assumption and add regression coverage; if verification
fails, treat that as a defect in this feature and fix it under T015.

### Tests for User Story 2

- [X] T013 [P] [US2] Add an integration test in
  `/Users/nick/code/rsss/test/feed-cursor.ts` that asserts: starting
  from a feed with `last_pulled_at IS NULL` and N items, calling the
  server's `POST /feeds/refresh` flow (or `advanceFeedCursor`
  directly, whichever the test harness exposes) sets
  `last_pulled_at = MAX(items.pub_date)` and the subsequent
  `GET /items` query returns those N items. Covers US2 AC1.
- [X] T014 [P] [US2] Add an integration test in
  `/Users/nick/code/rsss/test/feed-cursor.ts` for the mixed case
  (US2 AC2): M items pre-existing on a feed already at-cursor + N
  items on a freshly-added feed. After refresh, all M+N items are
  visible via `GET /items` in chronological order, and the un-synced
  counter (per `getFeedsWithUpdates` projection) is empty.

### Implementation for User Story 2

- [X] T015 [US2] No code change is expected here per research.md R2
  and R6. Verify by reading the existing `POST /feeds/refresh` and
  `POST /feeds/:id/refresh` handlers in
  `/Users/nick/code/rsss/src/server/durable-objects/index.ts` to
  confirm `advanceFeedCursor(feedId)` is called for every subscribed
  feed (including ones with `last_pulled_at IS NULL`). If the call
  is absent for the NULL-cursor case, add it so the new feed's
  cursor gets set on first refresh; otherwise, mark this task done
  with a one-line note in the PR description.
- [X] T016 [US2] Local browser verification of US2 per quickstart
  Step 3 and Step 9 (multiple feeds added in rapid succession). With
  US1 already verified, click "Refresh Feeds" and confirm the new
  feed's posts appear in correct chronological position, the counter
  clears, and the pill returns to "synced". Then add three feeds
  back-to-back and verify a single refresh surfaces all of them.

**Checkpoint**: US1 and US2 together deliver the full "deferred
posts" UX. After this checkpoint the feature is functionally
shippable; remaining stories are consistency polish and edge cases.

---

## Phase 5: User Story 3 — Sync status indicator reflects "updates available" after a feed is added (Priority: P2)

**Goal**: After add-feed contributes ≥1 post, the header sync status
pill enters the "updates available" state (unless a more dominant
state like syncing/error/offline is active).

**Independent Test**: Per quickstart Step 2 (US3 portion) — with the
pill in "synced", add a feed and verify it transitions to "updates
available". Click "Refresh Feeds" and verify it returns to "synced".

**Note**: Research R6 confirmed the existing
`feed-updates-available` SSE event already drives this transition.
These tasks verify the assumption and cover the AC2 stack-state case
(pill already showing "updates available" remains there and counter
sums correctly).

### Tests for User Story 3

- [X] T017 [P] [US3] If feasible to assert at the unit level, add a
  test alongside
  `/Users/nick/code/rsss/test/sync.ts` (or `sync-cycle.ts` /
  `sync-invariant-static.mjs`, whichever is the closest fit) that
  asserts: when the SSE handler receives a `feed-updates-available`
  event for a newly-added feed (cursor IS NULL, N pending items),
  `state.feedUpdateCounts` increases by exactly N and
  `state.feedSyncStatus` becomes the `"updates"` value. If the
  handler is too tightly coupled to the live SSE source for a unit
  test, document this in the PR and rely on T019's manual coverage.

### Implementation for User Story 3

- [X] T018 [US3] No code change is expected per research.md R6.
  Verify by reading the SSE handler in
  `/Users/nick/code/rsss/src/client/state.ts` (the
  `feed-updates-available` branch) and confirming it (a) increments
  per-feed pending counts and (b) sets the sync status to
  `"updates"` unless a dominant state is already active. Mark done
  with a one-line PR note if no change required.
- [X] T019 [US3] Local browser verification of US3 per quickstart
  Step 2's pill assertions, plus AC2: with the pill already at
  "updates available" from a prior add (post-T012), add a second
  feed and confirm the pill stays at "updates available" and the
  counter increases by the second feed's contribution.

**Checkpoint**: All three user stories are independently functional
and verified. The deferred-posts UX is consistent across counter,
pill, and reading list.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Edge-case verification, lint, and end-to-end sign-off.
None of these tasks gate the feature's correctness for the primary
stories — they catch regressions to adjacent behavior the spec
explicitly preserves (FR-007, FR-008, FR-009).

- [X] T020 [P] Local browser verification of the failure-path edge
  cases per quickstart Steps 4 (zero-item feed), 5 (duplicate feed),
  and 6 (invalid URL). Confirm the reading list, counter, and pill
  are unchanged in all three cases (FR-007, FR-008, SC-006).
- [X] T021 [P] Local browser verification of the cross-session
  persistence case per quickstart Step 8: add a feed, fully reload
  the page before clicking Refresh, confirm the reading list still
  excludes the new feed's items and the counter still reflects the
  pending count.
- [X] T022 [P] Local browser verification of local-first vs
  remote-fallback parity per quickstart Step 7: run Steps 1-3 once
  with `syncSubscriptions` on (local-first path) and once with it
  off or in a non-isolated context (remote-fallback path), and
  confirm identical user-visible behavior (Principle IV).
- [X] T023 Run `npm test && npm run lint` from the repo root and
  ensure both pass with no new failures relative to the T002
  baseline. Fix any issues introduced by this feature; do NOT mute
  unrelated pre-existing failures.
- [X] T024 Update `CLAUDE.md`'s "Recent Changes" entry for
  `003-defer-new-feed-items` if the running tally is stale, and
  confirm `specs/003-defer-new-feed-items/` is internally consistent
  (no dangling references to deleted contracts/files).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1. BLOCKS all user
  stories because the local SQLite needs `last_pulled_at` populated
  before either adapter's filter can be tested honestly.
- **User Stories (Phase 3-5)**: All depend on Phase 2. US1 and US2
  are both P1 and can technically be developed in parallel, but US2
  is a verification-heavy story that hinges on US1 being implemented
  to manually validate (the manual test for US2 starts from US1's
  end state). Recommended order: US1 → US2 → US3.
- **Polish (Phase 6)**: Depends on US1, US2, and US3 being complete.

### User Story Dependencies

- **US1 (P1)**: Depends on Phase 2 only. Once Phase 2 lands, US1 is
  the smallest self-contained increment that delivers the user-
  visible fix (deferred reading list).
- **US2 (P1)**: Depends on Phase 2. Behaviorally depends on US1 only
  for the manual verification flow. Code-wise the two are
  independent — US2's code surface is plausibly empty per R2/R6.
- **US3 (P2)**: Depends on Phase 2. Behaviorally depends on US1 for
  manual verification. Code-wise also plausibly empty per R6.

### Within Each User Story

- Tests (T006-T008, T013-T014, T017) are written FIRST and MUST FAIL
  before the corresponding implementation tasks land (this is the
  user's `superpowers:test-driven-development` policy applied to
  this feature).
- Server filter (T009) and local adapter filter (T010) can land in
  any order but MUST land together for adapter parity.
- Local browser verification tasks (T012, T016, T019) MUST be the
  last task in their respective stories — they exist to enforce the
  constitution's "type-check and unit tests are not sufficient
  evidence" rule for UI-touching changes.

### Parallel Opportunities

- T003 + T004 + T005 within Phase 2 touch different files and can
  be drafted in parallel, but per the constitution they MUST commit
  together; treat parallelism here as drafting only, not committing.
- T006 + T007 + T008 (US1 tests) touch different test files and are
  fully parallelizable.
- T009 (server) and T010 (local adapter) touch different files and
  can be implemented in parallel after their tests fail.
- T013 + T014 (US2 tests) touch the same file; serialize them to
  avoid merge churn.
- T017 (US3 test) is independent of all other test files.
- Polish tasks T020 + T021 + T022 are independent manual flows and
  can be split across testers if available.

---

## Parallel Example: User Story 1 Tests

```bash
# Launch all US1 tests in parallel (different files, no shared
# state). Each MUST fail before its implementation task lands:
Task: "Add server-side cursor filter test in test/feed-cursor.ts"
Task: "Add local-adapter parity test in test/local-adapter.ts"
Task: "Add upsertFeed last_pulled_at test in test/pull-sync.ts"
```

---

## Implementation Strategy

### MVP Scope (US1 only)

The user-visible fix lands as soon as US1 is complete and verified.
Suggested MVP cut:

1. Phase 1 (T001-T002).
2. Phase 2 (T003-T005) — single commit per the constitution.
3. Phase 3 / US1 (T006-T012) — tests first, then server + adapter
   in parallel, then state.ts cleanup, then browser verification.
4. **STOP, validate, ship.** US2 and US3 are verification-heavy and
   add coverage but do not change user-visible behavior beyond what
   US1 already delivers.

### Incremental Delivery

1. Phase 1 + Phase 2 → foundation ready, no user-visible change yet.
2. + US1 → MVP shippable; reading list no longer flickers on add.
3. + US2 → regression coverage that refresh promotes deferred posts
   for newly-added feeds.
4. + US3 → regression coverage that pill stays consistent across
   add-then-add scenarios.
5. + Polish → edge-case coverage and lint pass.

### Single-Developer Strategy (recommended for this feature)

The feature is small enough that a single developer should execute
the phases serially in the order above. The "parallel opportunities"
section is informational; for a single developer it is faster to
ship US1 end-to-end (incl. verification) before opening US2's tests.

---

## Notes

- Every implementation task above lists the absolute file path it
  touches. Tasks that touch the same file are NOT marked [P].
- Per the global CLAUDE.md rule, never modify CSS unrelated to this
  task. None of the planned changes touch CSS; flag any incidental
  CSS edit during review.
- Per CLAUDE.md, wrap sequential `@preact/signals` writes in
  `batch(...)`. The state.ts edit in T011 is the only place this is
  likely to apply.
- Commit after each task or each logical group (Phase 2's three
  tasks commit together; everything else commits independently).
- Stop at any checkpoint to validate the current story before
  starting the next one.
