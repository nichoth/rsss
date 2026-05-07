---

description: "Task list for 009-background-feed-polling implementation"
---

# Tasks: Background Feed Polling for Accurate Status Indicator

**Input**: Design documents from `/specs/009-background-feed-polling/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Test tasks ARE included. The plan explicitly lists test
files to extend (`test/alarm.ts`, `test/feed-status.ts`,
`test/do-handlers.ts`, `test/feed-fetch-security.ts`) and one new file
(`test/poll-state.ts`).

**Organization**: Tasks are grouped by user story so each story can be
implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different file, no dependency on
  another in-flight task)
- **[Story]**: User story label (US1, US2, US3); omitted in Setup,
  Foundational, and Polish phases.

## Path Conventions

This repo uses `src/server`, `src/client`, `src/shared`, and `test/`
at the repository root. All implementation for this feature lives in
`src/server/durable-objects/index.ts` and `src/server/feed-fetch.ts`.
No client or shared file is modified.

---

## Phase 1: Setup

**Purpose**: Establish a green baseline before touching code.

- [X] T001 Verify branch is `009-background-feed-polling`, run `npm
  install`, then run `npm test && npm run lint` from repo root to
  establish a clean baseline. No code changes in this task.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared poller-state primitives used by every user story.
None of US1/US2/US3 can land safely without these in place.

**WARNING**: User story phases must not begin until this phase is
complete.

- [X] T002 Add new operator-tunable constants near the existing
  `FEED_REFRESH_INTERVAL_MS` in
  `src/server/durable-objects/index.ts`: `FEED_BACKOFF_MULTIPLIER =
  2`, `FEED_BACKOFF_CEILING_MS = 24 * 60 * 60 * 1000`,
  `ACCOUNT_INACTIVITY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000`.
- [X] T003 Define the `PollerFeedState` and `AccountActivityMarker`
  TypeScript interfaces (per `data-model.md`) and the storage-key
  constants (`poll:feed:<id>`, `poll:account:last_active_at`,
  `poll:account:last_any_success_at`) inside
  `src/server/durable-objects/index.ts`.
- [X] T004 Implement DO storage helpers
  `readPollerFeedState(feedId)`, `writePollerFeedState(feedId,
  state)`, `deletePollerFeedState(feedId)` in
  `src/server/durable-objects/index.ts` using
  `this.ctx.storage.get/put/delete`. Helpers MUST clear `etag` /
  `lastModified` when the new state passes them as `undefined` (no
  stale carryover, per data-model validation rules).
- [X] T005 Implement DO storage helpers `readAccountActivity()`,
  `writeAccountActivity(now)` (with the "skip write if existing
  value is within 60 s of now" coalescing rule from data-model),
  `readLastAnySuccess()`, and `writeLastAnySuccess(now)` (using
  `Math.max(prev, now)`) in
  `src/server/durable-objects/index.ts`.
- [X] T006 Wire `deletePollerFeedState(id)` into every existing feed-
  deletion code path in `src/server/durable-objects/index.ts` so the
  `poll:feed:<id>` record is removed alongside the SQL `DELETE FROM
  feeds WHERE id = ?`. Verify `executeAccountDeletion` already wipes
  `poll:*` keys via `ctx.storage.deleteAll()`; if not, fix.
- [X] T007 [P] Create new test file `test/poll-state.ts` covering:
  read returns `undefined` when no record exists; write+read round-
  trips a `PollerFeedState`; delete removes the record; clearing
  `etag`/`lastModified` does not retain prior values; the activity-
  marker coalescing rule skips writes within 60 s; and
  `last_any_success_at` writes use `max(prev, now)` so an out-of-
  order write does not regress the value.

**Checkpoint**: Storage primitives exist and are tested. User story
work can begin.

---

## Phase 3: User Story 1 - Returning reader sees accurate "n updates" pill (Priority: P1) MVP

**Goal**: After hibernation or extended absence, the indicator shows
the correct count on the next page load instead of staying green.

**Independent Test**: Sign in, click "Refresh Feeds", wait at least
one base cadence with at least one subscribed feed publishing new
items upstream, reload the app without clicking Refresh Feeds, and
confirm the header shows "n updates" with the correct count within
2 seconds (SC-001).

- [X] T008 [US1] In the existing `fetchFeed` success path in
  `src/server/durable-objects/index.ts`, after a successful poll
  inserts items (or even when zero new items are inserted on a 200),
  call `writeLastAnySuccess(now)` so the page-load catch-up trigger
  has a recent timestamp to read.
- [X] T009 [US1] In the `GET /feed-status` handler in
  `src/server/durable-objects/index.ts`, implement the page-load
  catch-up trigger per `contracts/page-load-catchup.md`: read the
  prior `last_active_at` and `last_any_success_at`, write
  `last_active_at = now` (subject to the 60 s coalescing), and if
  `prevLastActiveAt === undefined || now - prevLastActiveAt >
  ACCOUNT_INACTIVITY_THRESHOLD_MS || lastAnySuccessAt < now -
  FEED_REFRESH_INTERVAL_MS` then call
  `this.ctx.waitUntil(this.refreshFeedBatches())`. The response body
  and timing MUST remain identical to feature 008.
- [X] T010 [US1] Extend `test/feed-status.ts` to cover the catch-up
  contract: (a) returning-after-days (seed `last_active_at` 31 days
  ago) triggers exactly one `refreshFeedBatches` call via
  `waitUntil` and the HTTP response is not blocked on it; (b)
  steady-state (recent `last_active_at` and recent
  `last_any_success_at`) triggers zero catch-up calls; (c)
  `last_active_at` advances on every call subject to the 60 s
  coalescing.
  (Implementation note: tests added in `test/do-handlers.ts` since
  that's where the existing `/feed-status` HTTP-handler tests
  live; `test/feed-status.ts` covers the client component.)
  contract: (a) returning-after-days (seed `last_active_at` 31 days
  ago) triggers exactly one `refreshFeedBatches` call via
  `waitUntil` and the HTTP response is not blocked on it; (b)
  steady-state (recent `last_active_at` and recent
  `last_any_success_at`) triggers zero catch-up calls; (c)
  `last_active_at` advances on every call subject to the 60 s
  coalescing.
- [X] T011 [P] [US1] Extend `test/do-handlers.ts` with a regression
  test for FR-013 (Implementation note: covered by the existing
  `t.equal(waitUntilPromises.length, 1, 'create schedules initial
  refresh')` assertion at do-handlers.ts:208 (POST /feeds schedules
  fetchFeed) plus the feed-cursor.ts state-machine test "fetchFeed
  success after failure run resets failures + nextDueAt to now +
  base cadence" which verifies a successful poll produces
  `nextDueAt = now + FEED_REFRESH_INTERVAL_MS`. Together these
  ensure a newly-added feed enters the standard rotation
  immediately).

**Checkpoint**: A returning reader's first `/feed-status` after
inactivity primes a background sweep; the existing SSE channel from
feature 008 then delivers the count update without user action.

---

## Phase 4: User Story 2 - Polling does not waste feed origin resources (Priority: P2)

**Goal**: Conditional GETs on stable feeds, exponential backoff on
failing feeds, and per-feed error isolation across a sweep.

**Independent Test**: Observe a stable feed across multiple intervals
and confirm subsequent polls send conditional headers and 304
responses do not re-parse. Observe a feed returning 5xx and confirm
poll cadence lengthens after consecutive failures.

- [X] T012 [US2] Extend `FetchFeedTextOptions` in
  `src/server/feed-fetch.ts` to accept
  `validators?:{etag?:string;lastModified?:string}` and add
  `If-None-Match: <etag>` / `If-Modified-Since: <lastModified>` to
  the outbound request headers when each is provided. Conditional
  headers MUST be added AFTER `assertFeedUrlAllowed` and DNS
  validation, and MUST be re-sent on each redirect hop.
- [X] T013 [US2] Extend `FetchFeedTextResult` in
  `src/server/feed-fetch.ts` with `notModified:boolean`,
  `etag?:string`, `lastModified?:string`. Short-circuit a 304
  response BEFORE the existing `!response.ok` check, returning
  `{ notModified:true, text:'', url, etag:undefined,
  lastModified:undefined }`. On 200, populate `etag` /
  `lastModified` from response headers (leave `undefined` if absent;
  callers MUST treat `undefined` as "clear stored validator").
- [X] T014 [P] [US2] Extend `test/feed-fetch-security.ts` (or add a
  sibling file `test/feed-fetch-conditional.ts` if the security
  file's scope must remain pure) covering: 200 with `ETag` captures
  it; 304 with prior validator returns `{notModified:true, text:''}`
  and does NOT throw; 200 without `ETag`/`Last-Modified` returns
  `etag:undefined`/`lastModified:undefined` so the caller can clear
  stale validators; conditional headers are re-sent across redirect
  hops.
- [X] T015 [US2] In the existing `fetchFeed` / per-feed poll path in
  `src/server/durable-objects/index.ts`, read prior validators from
  `PollerFeedState`, pass them to `fetchFeedText`, and on
  `notModified === true` short-circuit before parsing: do NOT parse,
  do NOT insert items, do NOT broadcast `feed-updates-available`
  (FR-005, FR-010). Then write back `PollerFeedState` with
  `consecutiveFailures = 0`, `lastSuccessfulAt = now`, `nextDueAt =
  now + FEED_REFRESH_INTERVAL_MS`, and call `writeLastAnySuccess(now)`.
  On 200 also write back updated `etag` / `lastModified` from the
  response (clearing them when the response omits the header).
- [X] T016 [US2] In the same per-feed poll path in
  `src/server/durable-objects/index.ts`, on error (network failure,
  non-2xx non-304 response, parse error), increment
  `consecutiveFailures`, compute `nextDueAt = lastAttemptAt +
  min(FEED_REFRESH_INTERVAL_MS *
  FEED_BACKOFF_MULTIPLIER ** consecutiveFailures,
  FEED_BACKOFF_CEILING_MS)`, write back `PollerFeedState`, and catch
  the error so it does NOT propagate out of the per-feed loop
  (FR-006). The existing `last_status` / `last_error` writes on the
  `feeds` row remain unchanged.
- [X] T017 [US2] In `refreshFeedBatches` (the alarm sweep machinery)
  in `src/server/durable-objects/index.ts`, filter each batch so
  only feeds with `PollerFeedState.nextDueAt <= now` are polled
  (treat a missing record as due). Also dedupe against
  `manualRefreshClaims`: if a manual refresh for the feed is in
  flight, skip it this sweep and let the manual refresh win
  (research.md §8).
- [X] T018 [P] [US2] Extend `test/alarm.ts` to verify: (a) feeds
  with future `nextDueAt` are skipped during a sweep and not
  fetched; (b) feeds with no `PollerFeedState` record are polled; (c)
  a feed currently in `manualRefreshClaims` is skipped this sweep
  and re-evaluated next tick.
- [X] T019 [P] [US2] Extend `test/do-handlers.ts` to verify the
  per-feed state machine (Implementation note: tests added in
  `test/feed-cursor.ts` because that's where the real-fetchFeed
  harness lives; `test/do-handlers.ts` stubs `fetchFeed`
  entirely and cannot exercise the state machine).
  per-feed state machine: (a) 304 path returns zero new items, emits
  no SSE event, resets `consecutiveFailures` to 0, advances
  `nextDueAt` by `FEED_REFRESH_INTERVAL_MS`, leaves
  `feeds.last_pulled_at` untouched; (b) failure path increments
  `consecutiveFailures` and stretches `nextDueAt` exponentially,
  capped at `FEED_BACKOFF_CEILING_MS`; (c) successful poll after a
  failure run resets `consecutiveFailures` to 0 and `nextDueAt` to
  `now + FEED_REFRESH_INTERVAL_MS`.

**Checkpoint**: Stable feeds get 304s and skip parsing; failing
feeds back off exponentially; a transient error on one feed does not
poison the sweep for healthy feeds.

---

## Phase 5: User Story 3 - Inactive accounts do not consume polling budget (Priority: P3)

**Goal**: Accounts inactive past the 30-day threshold incur zero
polling work; polling resumes on next sign-in / page load.

**Independent Test**: Seed `poll:account:last_active_at` 31 days in
the past, trigger an alarm tick, observe zero `fetchFeedText` calls
and a normal next-alarm re-arm. Sign in to that account; the next
page load triggers the catch-up sweep (already implemented in
Phase 3) and the indicator becomes accurate within one cadence.

- [X] T020 [US3] In the `alarm()` method in
  `src/server/durable-objects/index.ts`, after the existing
  account-deletion housekeeping and `scheduleNextFeedRefresh()`
  re-arm and BEFORE walking `alarm_refresh_cursor`, call
  `readAccountActivity()` and short-circuit with an immediate return
  if `now - lastActiveAt > ACCOUNT_INACTIVITY_THRESHOLD_MS` (FR-008,
  SC-005). The next alarm MUST already be re-armed before this gate
  so the sweep continues to fire on cadence once the account becomes
  active again.
- [X] T021 [P] [US3] Extend `test/alarm.ts` to verify: (a) seeding
  `last_active_at` to 31 days ago causes the alarm tick to perform
  zero outbound `fetchFeedText` calls and re-arm the next alarm
  normally; (b) advancing `last_active_at` to `now` (e.g. via a
  simulated `/feed-status` hit) lets the next alarm tick poll feeds
  again.

**Checkpoint**: All three user stories deliver the spec's success
criteria independently. The system is correct (US1), polite (US2),
and economical at scale (US3).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story validation and final guardrails.

- [X] T022 Run every scenario in
  `specs/009-background-feed-polling/quickstart.md` against
  `wrangler dev` (or the existing test harness equivalent) and
  confirm SC-001 through SC-006 pass.
- [X] T023 [P] Run `npm test && npm run lint` from repo root and
  confirm no regressions vs. the T001 baseline.
- [X] T024 [P] Verify constitution-check assumptions still hold in
  the final diff: no SQLite schema migration shipped, no
  `src/shared/schema.ts` change, no `/api/sync` payload change, no
  `src/client/**` change, and the `/feed-status` HTTP and
  `feed-updates-available` SSE contracts are byte-identical to
  feature 008.
- [X] T025 [P] Code review pass on the diff in
  `src/server/durable-objects/index.ts` and
  `src/server/feed-fetch.ts` for: per-feed error isolation (FR-006),
  SSE broadcast guard (`newItems.length > 0`, FR-010), validator
  clearing when origin omits headers (data-model validation rule),
  no write to `feeds.last_pulled_at` from any background-poll path
  (contract invariant), and `executeAccountDeletion` correctly
  cleaning up all `poll:*` keys (FR-008 cleanup parity).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user
  stories.
- **US1 (Phase 3)**: Depends on Foundational.
- **US2 (Phase 4)**: Depends on Foundational. Independent of US1
  (different concerns: page-load catch-up vs. per-feed protocol),
  can be developed in parallel by a second engineer.
- **US3 (Phase 5)**: Depends on Foundational. Reuses the
  `AccountActivityMarker` from Phase 2 and the catch-up wiring from
  US1, but the inactivity gate itself is independent.
- **Polish (Phase 6)**: Depends on every desired user story.

### Within Each User Story

- Within US2, tasks T012/T013 (the `feed-fetch.ts` extension) must
  precede T015 (which calls into them). T015/T016 modify the same
  per-feed write block in `index.ts`, so they should be done by the
  same author back-to-back. T017 (sweep filter) and T015/T016
  (per-feed write) touch related code in `index.ts` and should not
  be parallelized in the same branch.
- Tests marked [P] (T011, T014, T018, T019, T021) live in different
  test files from each other and from any open implementation file,
  so they can be authored in parallel with the corresponding
  implementation task or batched together at the end of the story.

### Parallel Opportunities

- T007 (Phase 2 test file) is fully independent of T002–T006.
- Across user stories, US1 and US2 touch different code paths
  (`/feed-status` handler vs. `feed-fetch.ts` + per-feed poll write
  block). Two engineers can work on them concurrently after Phase 2.
- All Polish tasks (T023, T024, T025) read-only; trivially parallel.

---

## Parallel Example: After Foundational

```bash
# Engineer A picks up US1:
Task T008  # writeLastAnySuccess in fetchFeed success path
Task T009  # /feed-status catch-up trigger
Task T010  # test/feed-status.ts extension
Task T011  # test/do-handlers.ts FR-013 regression

# Engineer B picks up US2 in parallel:
Task T012  # FetchFeedTextOptions.validators
Task T013  # FetchFeedTextResult.notModified
Task T014  # test/feed-fetch-security.ts (or sibling) cases
Task T015  # per-feed poll: 304 short-circuit + write-back
Task T016  # per-feed poll: error backoff
Task T017  # refreshFeedBatches nextDueAt filter
Task T018  # test/alarm.ts sweep filter cases
Task T019  # test/do-handlers.ts state-machine cases

# US3 can start once Phase 2 is in:
Task T020  # alarm() inactivity gate
Task T021  # test/alarm.ts inactivity cases
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1: T001 (baseline).
2. Phase 2: T002–T007 (storage primitives + their test).
3. Phase 3: T008–T011 (page-load catch-up + activity marker).
4. STOP and validate the user-reported bug: returning after a day
   shows correct counts. This is the entire reason the feature
   exists. If this works, the MVP is shippable as a strict superset
   of feature 008.

### Incremental delivery

1. Setup + Foundational ready.
2. Add US1 → ship MVP fix for the user-reported bug (SC-001, SC-006).
3. Add US2 → ship politeness and resilience (SC-002, SC-003, SC-004,
   FR-006/007/010/011).
4. Add US3 → ship cost discipline at scale (SC-005, FR-008).
5. Phase 6 polish closes the loop.

### Parallel team strategy

Two engineers post-foundational: A on US1, B on US2. US3 is small
enough that whichever engineer finishes first picks it up. Polish is
done by whoever owns the merge.

---

## Notes

- [P] tasks live in different files and have no in-flight
  dependency on another open task.
- [Story] label maps each task to a spec user story (US1/US2/US3)
  for traceability against acceptance scenarios.
- Each user story can be validated against its quickstart.md hooks
  independently; do not skip the checkpoints.
- No SQLite schema change, no `/api/sync` payload change, no
  `src/client/**` change is permitted by this feature.
- Verify tests fail before implementing the corresponding behavior.
- Commit after each task or logical group.
