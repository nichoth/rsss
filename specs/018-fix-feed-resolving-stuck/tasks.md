# Tasks: Newly Added Feeds Must Reach a Terminal State

**Input**: Design documents from `/specs/018-fix-feed-resolving-stuck/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Tests are INCLUDED. Research Decision 9 explicitly
requires Vitest specs covering the four state-machine invariants.

**Organization**: Tasks are grouped by user story. US1 and US2 are
both P1 (US1 = "new add reaches terminal state"; US2 = "retry is
subject to the same guarantees"). US3 is P2 (durable terminal state
across reload + SSE drop).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Setup, Foundational, and Polish tasks have no Story label

## Path Conventions

Repo layout per `CLAUDE.md` and plan.md: `src/client/`, `src/server/`,
`src/shared/`, `test/` at repository root. No new directories are
introduced by this feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the single shared constant and confirm the
existing test harness is reachable. There is no project-init work for
this bug-fix feature.

- [X] T001 Add `RESOLVE_WINDOW_MS = 30_000` and `RESOLVE_TIMEOUT_ERROR = 'Initial fetch did not complete'` as exported constants near the top of `src/server/durable-objects/index.ts` (research Decision 1). Mirror in `src/client/state.ts` as `RESOLVE_WINDOW_MS = 30_000` and `CLIENT_GRACE_MS = 5_000` (research Decision 1 closing paragraph). No behavior change yet — these are referenced by later tasks.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Make the *local* DB capable of representing the terminal
states the server already records. Until these run, every user story
is broken because the local row never gets `last_error` /
`last_status` from the sync payload, so `isResolving` stays true
forever (plan.md Summary, client-side primary bug).

**CRITICAL**: No user story work can begin until this phase is
complete.

- [X] T002 Add idempotent local SQLite migration in `src/client/db/local-db.ts`: on DB open, run `PRAGMA table_info(feeds)`; if `last_error` is missing, execute `ALTER TABLE feeds ADD COLUMN last_error TEXT`; if `last_status` is missing, execute `ALTER TABLE feeds ADD COLUMN last_status INTEGER`. Follow the once-per-DB `Set<Sqlite3Db>` pattern already used for `itemFullContentColumnsReady` (`src/client/db/pull-sync.ts:115-143`). Research Decision 8.
- [X] T003 [P] Fix `upsertFeed` in `src/client/db/pull-sync.ts:146-175`: add `last_error` and `last_status` to the INSERT column list, to the `excluded.*` clauses in `ON CONFLICT(url) DO UPDATE`, and to the parameter bind list. Pull the values from the server feed payload (already serialized via `FEED_SYNC_COLUMNS`, `src/server/durable-objects/index.ts:117-120`).
- [X] T004 [P] Fix `upsertFeedFromServer` in `src/client/db/push-sync.ts:131-158`: same two-column addition as T003 — column list, `excluded.*`, and bind list. The shape must mirror `upsertFeed` so retry response handling (Phase 4) writes both fields.

**Checkpoint**: Foundation ready — local DB now persists terminal-
state markers. User story implementation can begin.

---

## Phase 3: User Story 1 — A newly added feed reaches a terminal state quickly (Priority: P1) 🎯 MVP

**Goal**: Every newly added feed transitions to resolved or failed
within `RESOLVE_WINDOW_MS` (30s), regardless of how the resolve
attempt completes (success path, 304 path, no-metadata path, timeout,
crash, DO eviction).

**Independent Test**: Submit a known-good feed URL (e.g.
`https://hnrss.org/frontpage`); confirm the spinner is replaced by
the feed title within 30s. Submit a 404 URL; confirm the row reaches
"Failed to fetch" within 30s. Submit a hanging URL
(`https://httpbin.org/delay/60`); confirm the row reaches failed
with `last_status = 504` within 35s. (Quickstart Scenarios 1, 2, 4.)

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation.** Spec FR-001, FR-004, FR-005; research Decision 9 items 1–3.

- [X] T005 [P] [US1] Add `test/feed-resolve-state.test.ts` with a test "successful fetchFeed writes last_fetched and clears last_error/last_status, even when title/description/link are all empty" — exercises the parsed-but-no-metadata path against the DO `fetchFeed` (FR-004, research Decision 7).
- [X] T006 [P] [US1] In the same file, add "304 Not Modified on first fetch writes last_fetched and clears last_error/last_status" — mocks `feed-fetch` to return `notModified: true` and asserts the row reaches resolved (FR-005, research Decision 6).
- [X] T007 [P] [US1] In the same file, add "alarm sweep marks a stuck-resolving row failed with last_status=504 once created_at is older than RESOLVE_WINDOW_MS" — inserts a row with `last_fetched IS NULL AND last_error IS NULL AND created_at < now - RESOLVE_WINDOW_MS`, calls `alarm()`, asserts the row now has `last_error = 'Initial fetch did not complete'` and `last_status = 504` (FR-001, FR-003, research Decision 3).

### Implementation for User Story 1

- [X] T008 [US1] In `src/server/durable-objects/index.ts` `fetchFeed` 304-Not-Modified branch (around lines 1525-1542), before the `return`, execute `UPDATE feeds SET last_fetched = datetime('now'), last_error = NULL, last_status = NULL WHERE id = ?`. Do not parse, do not insert items, do not broadcast `feed-updates-available` — only mark the row resolved (research Decision 6).
- [X] T009 [US1] In `src/server/durable-objects/index.ts` `fetchFeed` parsed-success branch (around line 1557), drop the `if (parsedFeed.title || parsedFeed.description || parsedFeed.link)` guard so the `UPDATE feeds SET ... last_fetched = ..., last_error = NULL, last_status = NULL` runs on every parsed response. The existing `COALESCE(?, title)` etc. preserves sticky metadata when fields are null (research Decision 7).
- [X] T010 [US1] In the DO `alarm()` handler at `src/server/durable-objects/index.ts:2450-2477`, before the existing periodic-refresh logic, add a "sweep stuck-resolving feeds" pass: `UPDATE feeds SET last_error = 'Initial fetch did not complete', last_status = 504 WHERE last_fetched IS NULL AND last_error IS NULL AND created_at < datetime('now', '-30 seconds')`; then `SELECT id FROM feeds WHERE last_status = 504 AND last_error = 'Initial fetch did not complete' AND updated_at >= datetime('now', '-2 seconds')` to find the rows just swept and `broadcast('feed-updated', { feedId })` for each (research Decision 3).
- [X] T011 [US1] In `src/server/durable-objects/index.ts` `POST /api/feeds` handler, after the successful INSERT but before `this.ctx.waitUntil(this.fetchFeed(feed))`, schedule the alarm: read `await this.ctx.storage.getAlarm()`; compute `targetAt = Date.now() + RESOLVE_WINDOW_MS`; call `this.ctx.storage.setAlarm(existing == null ? targetAt : Math.min(existing, targetAt))` (research Decision 4). Preserve existing 10-minute periodic cadence — the alarm() handler already reschedules.

**Checkpoint**: User Story 1 fully functional. Verify quickstart
Scenarios 1, 2, and 4 manually before proceeding.

---

## Phase 4: User Story 2 — The retry control reliably re-attempts a stuck or failed resolve (Priority: P1)

**Goal**: Clicking retry on a failed row triggers a fresh resolve
attempt subject to the same FR-001 bounded-window guarantee. The
client learns the post-retry terminal state immediately from the
response body, not from waiting on SSE.

**Independent Test**: From a failed row, click retry against a still-
broken URL: row returns to failed within 30s with retry still
available. Then point at a good URL via retry on a different row:
row reaches resolved with the title in the same tick the retry
button was clicked. (Quickstart Scenario 5.)

### Tests for User Story 2

- [X] T012 [P] [US2] In `test/feed-resolve-state.test.ts`, add "POST /api/feeds/:id/refresh returns `{ feed: <row> }` with the post-fetch state" — mocks fetchFeed success, asserts the response body shape matches `contracts/refresh-response.md` and `feed.last_fetched != null` (FR-007, research Decision 5).
- [X] T013 [P] [US2] In the same file, add "upsertFeedFromServer persists last_error and last_status from a server payload that includes both" (research Decision 9 item 4; complements T004 implementation).

### Implementation for User Story 2

- [X] T014 [US2] In `src/server/durable-objects/index.ts` `POST /api/feeds/:id/refresh` handler, change the response shape: after `await this.fetchFeed(feed)`, run `SELECT * FROM feeds WHERE id = ?`, serialize with the same column projection used by `/api/sync` (`FEED_SYNC_COLUMNS`), and return `{ feed }` instead of `{ success: true }`. Keep 404 / 401 paths unchanged (contracts/refresh-response.md).
- [X] T015 [US2] In `src/client/state.ts` `retryResolveFeed`, after the successful `POST /api/feeds/:id/refresh`, parse `body.feed`, call `upsertFeedFromServer(db, body.feed)` (now safe per T004), then `loadFeeds()` so the sidebar reflects the post-refresh terminal state immediately (contracts/refresh-response.md "Client handling"). No SSE wait required.

**Checkpoint**: User Stories 1 AND 2 both work independently. Retry
path inherits FR-001 because the underlying `fetchFeed` paths (T008,
T009) and the alarm sweep (T010) cover the retry just like the
initial fetch.

---

## Phase 5: User Story 3 — Terminal state survives reload, navigation, and SSE interruption (Priority: P2)

**Goal**: Even when the live-update channel is dropped or never
delivers an event, the client converges on the correct server-side
terminal state within `RESOLVE_WINDOW_MS + CLIENT_GRACE_MS`.

**Independent Test**: Add a feed; before the row reaches terminal
state, interrupt the network or SSE channel; restore. Without manual
refresh, the row reaches its correct terminal state within ~35s. Then
reload — terminal state persists. (Quickstart Scenarios 3 + 4 tail.)

### Tests for User Story 3

- [X] T016 [P] [US3] In `test/feed-resolve-state.test.ts`, add "after add, the client schedules a one-shot runSync at RESOLVE_WINDOW_MS + CLIENT_GRACE_MS, and only fires when the row is still in the resolving state" — uses `vi.useFakeTimers()` to advance time and asserts `runSync` was/was not called per the row's terminal state (FR-006).

### Implementation for User Story 3

- [X] T017 [US3] In `src/client/state.ts` `addFeed`, after the successful POST response and the optimistic `upsertFeedFromServer`, arm a one-shot `setTimeout(() => { if (rowStillResolving(feedId)) runSync() }, RESOLVE_WINDOW_MS + CLIENT_GRACE_MS)`. `rowStillResolving` reads from the feeds signal using the same predicate as `sidebar.ts:166-167` (`last_fetched === null && !last_error`). Track the timer id on the state so a second add does not stack timers per row, and clear it if the row reaches terminal state before the timer fires (research Decision 2 paragraph 3; contracts/feed-row-state.md "Client guarantees" item 2).

**Checkpoint**: All three user stories independently functional.
Manual reload tests (Quickstart Scenario 3) should pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validation, lint, and manual browser verification per
constitution Development Workflow.

- [X] T018 Run `npm test` and confirm `test/feed-resolve-state.test.ts` passes alongside the existing suite. Fix any regressions in adjacent tests caused by the column-list changes in T003/T004.
- [X] T019 Run `npm run lint`. Resolve any new violations introduced by T001–T017. Do NOT change eslint settings (global rule).
- [ ] T020 Manual browser verification: run through `quickstart.md` Scenarios 1, 2, 3, 5, and 7 in a local `npm start` session signed in with Bluesky. Document any deviation (none expected). Constitution Development Workflow: "UI changes MUST be exercised in a browser before being claimed complete."
- [X] T021 Verify no CSS changes were introduced (global rule: do not change CSS unrelated to the task). `git diff --stat` should show no `.css` files.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001 introduces constants used by every later phase. Start immediately.
- **Foundational (Phase 2)**: Depends on T001 only for the constant import in T002. BLOCKS all user stories because the local DB cannot represent terminal states until T003/T004 land.
- **User Story 1 (Phase 3)**: Depends on Phase 2. Sweep test (T007) depends on T010 implementation conceptually but should be written first per TDD.
- **User Story 2 (Phase 4)**: Depends on Phase 2 (specifically T004 — `upsertFeedFromServer` must accept `last_error`/`last_status` before T015 can write them).
- **User Story 3 (Phase 5)**: Depends on Phase 2 + T001 (`RESOLVE_WINDOW_MS`, `CLIENT_GRACE_MS`).
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Independent of US2 and US3. Can ship as MVP on its own.
- **US2 (P1)**: Logically independent — retry just rides the existing fetchFeed/sweep machinery. T015 (client write-back) is functionally separable from US1 but the response-shape change in T014 is what makes US2 reliable.
- **US3 (P2)**: Independent of US1 and US2 for code, but only meaningful once US1 exists (without US1, the one-shot runSync would converge on a stuck-resolving row).

### Within Each User Story

- Tests (T005–T007, T012–T013, T016) MUST be written and FAIL before the corresponding implementation.
- Server-side implementation (T008, T009, T010, T011, T014) before client-side consumption (T015, T017).
- Story complete before moving to next priority.

### Parallel Opportunities

- **Phase 2**: T003 and T004 are in different files (`pull-sync.ts` vs `push-sync.ts`) and can run in parallel after T002.
- **Phase 3 tests**: T005, T006, T007 are independent test cases in the same file but cover different code paths — write together.
- **Phase 4 tests**: T012, T013 are independent test cases.
- **Phase 5 tests**: T016 stands alone.
- US1 and US2 server-side tasks (T008/T009/T010/T011 vs T014) are all in `src/server/durable-objects/index.ts` — same file, NOT parallelizable across that boundary. Order them.
- US1 client (none) and US3 client (T017) — no overlap.

---

## Parallel Example: Phase 2 Foundational

```bash
# After T002 (local migration) lands, run T003 and T004 in parallel:
Task: "Fix upsertFeed column list and binds in src/client/db/pull-sync.ts"
Task: "Fix upsertFeedFromServer column list and binds in src/client/db/push-sync.ts"
```

## Parallel Example: User Story 1 Tests

```bash
# All three tests in test/feed-resolve-state.test.ts can be drafted together:
Task: "Test parsed-but-no-metadata fetchFeed path writes last_fetched"
Task: "Test 304 Not Modified fetchFeed path writes last_fetched"
Task: "Test alarm sweep marks stuck-resolving rows failed with status 504"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. T001 — constants.
2. T002, T003, T004 — local DB foundation (Phase 2).
3. T005–T007 — write tests for US1 first.
4. T008–T011 — implement server fetchFeed fixes and alarm sweep.
5. **STOP and VALIDATE**: Quickstart Scenarios 1, 2, 4. Confirm
   `npm test` is green for new specs. This is the minimum shippable
   fix for the literal user complaint.

### Incremental Delivery

1. MVP (above) — newly added feeds always reach a terminal state.
2. Add US2 (T012–T015) — retry response carries the post-fetch row.
3. Add US3 (T016–T017) — client convergence on SSE drop.
4. Polish (T018–T021) — full suite + manual + lint + CSS-diff check.

### Parallel Team Strategy

With multiple developers:

1. Together: T001, T002 (sequential).
2. Once T002 lands:
   - Dev A: T003 (pull-sync.ts) and US1 server tasks (T008–T011).
   - Dev B: T004 (push-sync.ts) and US2 (T014, T015).
   - Dev C: US3 (T017) — but pause until T011 lands so the alarm
     scheduling exists and the one-shot timer is the *defense in
     depth* it is meant to be, not the primary mechanism.
3. Tests (T005–T007, T012–T013, T016) authored by whoever owns the
   corresponding implementation, written first.

---

## Notes

- All five touched files (`src/client/db/local-db.ts`,
  `src/client/db/pull-sync.ts`, `src/client/db/push-sync.ts`,
  `src/client/state.ts`, `src/server/durable-objects/index.ts`) are
  pre-existing. No new files except `test/feed-resolve-state.test.ts`.
- No CSS changes. No server DO SQLite schema changes. Local SQLite
  gains two columns via idempotent ALTER TABLE only (research
  Decision 8).
- Constitution gates: I (Local-First), II (Idempotent Outbox), III
  (Edge-Native), IV (Progressive Enhancement), V (Bluesky Identity)
  all pass per plan.md Constitution Check.
- The `[P]` markers reflect *file-level* independence. Same-file
  tasks in `durable-objects/index.ts` are sequential even when they
  touch different handlers, to avoid merge conflicts.
- Verify each task by running `npm test && npm run lint` before
  marking complete.
