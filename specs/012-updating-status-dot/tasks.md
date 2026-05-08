---
description: "Task list for feature 012: Yellow 'Updating' Pill State During Manual Refresh"
---

# Tasks: Yellow "Updating" Pill State During Manual Refresh

**Input**: Design documents from `/specs/012-updating-status-dot/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/header-pill-states.md, quickstart.md

**Tests**: Tests are explicitly required by FR-012 (end-to-end
test for the pill lifecycle) and by quickstart.md (extends four
existing test files plus a new browser-driven file). Test tasks
are interleaved per user story per the project's TDD discipline.

**Organization**: Tasks are grouped by user story to enable
independent implementation and testing of each story. Foundational
work (the derived `displayedFeedSyncStatus` signal and the
component wiring that reads it) is shared by all three stories and
lives in Phase 2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are absolute relative to repository root
  `/Users/nick/code/rsss`

## Path Conventions

This project uses the `src/server` / `src/client` / `src/shared`
layout (not the `backend/` / `frontend/` template default). Tests
live at the repository root under `test/`. All edits in this
feature land under `src/client/` and `test/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the working tree is clean, the right branch is
checked out, and the baseline test suite is green before any code
moves. No new dependencies, no scaffolding.

- [X] T001 Confirm current branch is `012-updating-status-dot` and
  run baseline `npm test && npm run lint` from repo root; record
  any pre-existing failures so they are not attributed to this
  feature.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Stand up the derived display signal and wire the
component to it. After Phase 2 the pill's displayed status is
sourced from `state.displayedFeedSyncStatus`; every user story
relies on this. The label rename, the `syncing` modifier class,
and the responsive CSS are intentionally deferred to Phase 3 (US1)
because they are the user-visible US1 deliverables.

**CRITICAL**: No user story work can begin until this phase
completes. T002, T003, and T004 are all small, but T004 depends
on T002 (it reads the new computed signal).

- [X] T002 Add `displayedFeedSyncStatus:ReadonlySignal<...>`
  computed signal in `src/client/state.ts`, alongside the
  existing `feedUpdateStatus` and `feedsWithUpdates` computeds.
  Definition per `data-model.md`:
  `computed(() => state.refreshInProgress.value ? 'syncing' :
  state.feedSyncStatus.value)`. Type the return as the same
  union as `feedSyncStatus`. Export it from the `State` factory
  the same way the other computeds are exported.

- [X] T003 Remove the
  `state.feedSyncStatus.value = 'syncing'` line from the
  click-setup `batch` inside `State.refreshFeeds` in
  `src/client/state.ts` (research.md Decision 5). Keep the
  `state.feedSyncError.value = null` clear in the same `batch`.
  The failure-path / 401 / settle batches that write
  `feedSyncStatus = 'error'` or restore `priorCounts` are NOT
  touched (010/011 contract preserved).

- [X] T004 Update `<FeedStatus>` in
  `src/client/components/feed-status.ts` so its dot-color and
  legend-choice branches read
  `state.displayedFeedSyncStatus.value` instead of
  `state.feedSyncStatus.value`. The `'error'` branch keeps
  reading `state.feedSyncError.value`; the `'updates'` count
  summation keeps reading `state.feedUpdateCounts.value`. Do
  NOT change the legend label text in this task (US1 owns it).
  Do NOT add the `syncing` wrapper class in this task (US1
  owns it).

**Checkpoint**: After Phase 2, the pill displays the same
information as before for all resting states, but the displayed
value now flows through the computed. Existing tests that read
`state.feedSyncStatus.value` to mean "what does the pill show"
will need to be updated within their owning user story phase.

---

## Phase 3: User Story 1 - Header dot communicates that a refresh is in progress (Priority: P1)

**Goal**: From the click frame onward, the pill is yellow with the
text `updating`, stays yellow continuously through the refresh
window, and exits yellow into the post-refresh resting state in
the same paint as the button returns to idle. Resolves
FR-001..FR-004, FR-006, FR-008, FR-009, FR-010, SC-001..SC-003.

**Independent Test**: With the dev server running, click Refresh
Feeds while the pill shows `up to date` or `n updates`. The pill
must transition to yellow `updating` in the same render frame as
the click, stay yellow for the full duration of the refresh, and
land on the post-refresh resting state at the same paint the
button returns to idle. Quickstart.md Scenario 1 covers this
end-to-end; quickstart.md Scenario 4 covers the zero-feeds
edge case; quickstart.md Scenario 5 covers the re-entrant click
guard (FR-010).

### Tests for User Story 1 ⚠️

> **NOTE**: Per the project's TDD discipline these tests are
> updated/added BEFORE the US1 implementation tasks. After Phase
> 2, several of them will start failing on the `'refreshing'` →
> `'updating'` label assertions and on the new yellow-during-refresh
> case; the US1 implementation tasks below restore them to green.

- [X] T005 [P] [US1] In `test/feed-status.ts`, rename the existing
  `legendFor('syncing', _)` test that asserts the label `'refreshing'`
  / aria-label `'Feed sync status: refreshing'` to assert
  `'updating'` / `'Feed sync status: updating'`. Add a new test
  case that mounts `<FeedStatus>` against a state object whose
  `refreshInProgress.value === true` and asserts the rendered dot
  is yellow and the legend reads `updating`, regardless of the
  underlying `feedSyncStatus` value (covers FR-002, FR-003 at the
  component level).

- [X] T006 [P] [US1] In `test/sidebar-footer-refresh.ts`, extend
  the click-through DOM tests so each of the three resolution paths
  (success-with-items, success-no-items, failure) also asserts the
  rendered pill text and dot-color class. Update the in-flight
  assertion text from `'refreshing'` to `'updating'`. Assert the
  pill text returns to the post-refresh resting label
  (`up to date` or `n updates`) at the same DOM tick as the
  button's busy class clears (covers FR-004, FR-006, SC-003).

- [X] T007 [US1] In `test/refresh-lifecycle.ts`, change every
  assertion that currently reads
  `state.feedSyncStatus.value === 'syncing'` to convey "pill is
  yellow during refresh" so it instead reads
  `state.displayedFeedSyncStatus.value === 'syncing'`. Add a
  positive assertion that
  `state.displayedFeedSyncStatus.value === 'syncing'` is true at
  every observable step between the click `batch` and the settle
  `batch` for the success-with-items path (covers FR-003,
  SC-002). Sequential after T006 only because both touch
  click-flow tests; T007 is in a different file from T005/T006 so
  the file-conflict reason for not marking [P] does not apply,
  but it depends on the same shared mental model so it is kept
  in-phase.

### Implementation for User Story 1

- [X] T008 [US1] In `src/client/components/feed-status.ts`, change
  `legendFor('syncing', _)` to return
  `{ label: 'updating', ariaLabel: 'Feed sync status: updating' }`
  (was `'refreshing'`). No other branch of `legendFor` is
  touched. This is the first half of the FR-001 deliverable.

- [X] T009 [US1] In `src/client/components/feed-status.ts`, give
  the `.feed-status` wrapper an additional class `syncing` when
  `state.displayedFeedSyncStatus.value === 'syncing'` (and ONLY
  then). Render path:
  `class={\`feed-status${displayed === 'syncing' ? ' syncing' : ''}\`}`
  or equivalent template form. The `role="status"` /
  `aria-live="polite"` attributes are unchanged. Sequential after
  T008 because both edit `feed-status.ts`.

- [X] T010 [P] [US1] In `src/client/components/feed-status.css`,
  extend the existing `@media (680px <= width < 1000px)` rule so
  that `.feed-status .feed-status-legend` is hidden ONLY when the
  wrapper does not also carry the `syncing` modifier. Concretely,
  change the selector from
  `.feed-status .feed-status-legend` to
  `.feed-status:not(.syncing) .feed-status-legend` (research.md
  Decision 4 / contracts §"Responsive layout contract"). No other
  selector in `feed-status.css` is touched (constitution rule:
  do not modify unrelated CSS). [P] with T008/T009 because it is
  in a different file.

**Checkpoint**: After T010, US1 is independently demoable per
quickstart.md Scenario 1 and the US1 tests pass. The button and
the pill enter and exit busy in the same paint; the pill carries
the `updating` text at every supported viewport.

---

## Phase 4: User Story 2 - Header dot reflects refresh failure rather than staying yellow (Priority: P1)

**Goal**: When a manual refresh fails (network, 5xx, 401), the
pill exits yellow into the failure state in the same `batch` that
clears `refreshInProgress`. The pill never lands on green
`up to date` as a consequence of failure and never stays stuck on
yellow. Resolves FR-005, SC-004.

**Independent Test**: Quickstart.md Scenario 2 — set DevTools to
"Offline," click Refresh Feeds, confirm the pill flips yellow on
click and lands on red `sync failed` (not green) when the POST
fails, in the same paint the button returns to idle.

### Tests for User Story 2 ⚠️

> **NOTE**: This story has NO new production code. The
> failure-path correctness comes from the foundational change
> (Phase 2): the failure `batch` in `State.refreshFeeds` already
> writes `feedSyncStatus = 'error'` and clears `refreshInProgress`
> together, so the computed `displayedFeedSyncStatus` moves
> yellow → red atomically. Tests are the deliverable.

- [X] T011 [US2] In `test/refresh-lifecycle.ts`, add a test case
  for the failure path: stub `fetch` so `POST /api/feeds/refresh`
  rejects, drive `State.refreshFeeds(state)` to completion, and
  assert the `displayedFeedSyncStatus` transition sequence is
  exactly `<resting> → 'syncing' → 'error'` with no
  intermediate `'synced'` or `'updates'` value. Assert that
  `state.feedUpdateCounts.value` is restored to its pre-click
  snapshot (010/011 contract). Assert that
  `state.refreshInProgress.value` and
  `state.displayedFeedSyncStatus.value !== 'syncing'` are both
  observed in the same microtask after the failure batch. Same
  file as T007; sequential after T007.

**Checkpoint**: After T011, US2 has regression coverage. Manual
verification per quickstart.md Scenario 2 should confirm the same
behavior in the live UI.

---

## Phase 5: User Story 3 - "Updating" state is exclusive to manual refresh, not background polling (Priority: P2)

**Goal**: Background polling (feature 009), page-load
`loadFeedStatus` (feature 008), and SSE `feed-updates-available`
/ `feed-updates-cleared` listeners never cause the pill to flash
yellow. They continue to update the underlying
`feedSyncStatus` / `feedUpdateCounts` signals; those updates are
masked from the pill while `refreshInProgress.value === true` and
surface the moment it clears. Resolves FR-007, FR-011, SC-005.

**Independent Test**: Quickstart.md Scenario 3 — leave the app
open, let the background poller run a normal cycle, observe the
pill transitioning from `up to date` (green) to `n updates`
(blue) directly with no yellow flash. Then, while a manual
refresh is in flight, observe a background tick: the pill stays
yellow throughout, and the background tick's count is folded into
the post-refresh resting state.

### Tests for User Story 3 ⚠️

> **NOTE**: Like US2, this story has NO new production code.
> The "yellow only on manual refresh" property falls out of the
> foundational computed (Phase 2) plus the absence of any writer
> of `state.refreshInProgress` outside the manual-refresh
> lifecycle. Tests are the deliverable.

- [X] T012 [US3] In `test/feed-status-loader.ts`, extend the
  `loadFeedStatus` tests with a case that sets
  `state.refreshInProgress.value = true` before invoking
  `loadFeedStatus`, drives the loader against a stub returning
  fresh `feedSyncStatus` / `feedUpdateCounts` values, and asserts
  (a) `state.feedSyncStatus.value` and
  `state.feedUpdateCounts.value` ARE updated to the loader's
  payload (the underlying signals must keep moving — FR-011), and
  (b) `state.displayedFeedSyncStatus.value === 'syncing'`
  throughout (the pill MUST NOT exit yellow — FR-007). Then set
  `state.refreshInProgress.value = false` (simulating settle) and
  assert `displayedFeedSyncStatus.value` now reflects the loader's
  payload.

- [X] T013 [US3] In `test/refresh-lifecycle.ts`, add a case
  "background SSE `feed-updates-available` arrives during refresh":
  stand up a state in the middle of a manual refresh
  (`refreshInProgress = true`), dispatch a synthetic SSE
  `feed-updates-available` event that bumps
  `state.feedUpdateCounts` and would, in a resting state, flip
  `feedSyncStatus` to `'updates'`, and assert
  `state.displayedFeedSyncStatus.value` stays `'syncing'` until
  the synthetic settle batch clears `refreshInProgress`, at which
  point it surfaces as `'updates'` with the bumped count folded
  in (FR-011). Same file as T007/T011; sequential after T011.

**Checkpoint**: After T013, US3 has regression coverage. Manual
verification per quickstart.md Scenario 3 should confirm no yellow
flash from background work.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Add the FR-012 end-to-end browser test that exercises
the full click-to-resolution pill lifecycle for all three
resolution paths plus the background-poll-during-refresh case,
wire it into the bundled tapout run, and verify the suite plus
the quickstart manual scenarios all pass.

- [X] T014 Create new file `test/updating-pill-lifecycle.ts`
  (browser-driven, runs through tapout). The test mounts the real
  `<SidebarFooter>` and `<FeedStatus>` together against a stubbed
  `EventSource` and `fetch`, then walks the click-to-resolution
  lifecycle for each of the three resolution paths plus the
  background-poll-during-refresh case. Assertions per
  plan.md §"Source Code"
  (`test/updating-pill-lifecycle.ts` block) and contracts §FR-012:
  (a) the pill is yellow with text `updating` and
  `aria-label="Feed sync status: updating"` from the click frame
  onward; (b) it remains yellow when a background
  `feed-updates-available` event arrives mid-flight; (c) it
  transitions out of yellow inside the same paint as the button
  returns to idle (success-with-items and success-no-items); (d)
  the failure path lands on `'error'` rather than `'syncing'` or
  `'synced'`; (e) the zero-feeds-subscribed case flashes yellow
  for at least one paint before settling green.

- [X] T015 In `test/index.ts`, add
  `import './updating-pill-lifecycle.js'` so the new file is
  picked up by the bundled tapout run. Sequential after T014
  because the import target must exist.

- [X] T016 Run `npm test && npm run lint` from repo root.
  Verify the full suite passes, including the four extended
  files (`test/feed-status.ts`,
  `test/feed-status-loader.ts`,
  `test/refresh-lifecycle.ts`,
  `test/sidebar-footer-refresh.ts`) and the new
  `test/updating-pill-lifecycle.ts`. Lint must be clean. If a
  pre-existing failure recorded under T001 is still present and
  unrelated, note it; otherwise the suite must be green.

- [ ] T017 Manual verification per `quickstart.md`. Run
  `npm start`, log in with an account that has at least one
  subscribed feed, and walk Scenarios 1, 2, 3, 4, 5, plus the
  Accessibility check and the High-contrast / color-blind check.
  Each scenario's "Pass criteria" bullets must hold. Capture any
  deviation and fix before declaring the feature complete.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies. Run T001 first.
- **Phase 2 (Foundational)**: Depends on Phase 1. T002 before
  T004 (functional dep). T003 sequential to T002 (same file).
  Phase 2 BLOCKS all user stories.
- **Phase 3 (US1)**: Depends on Phase 2. Tests (T005, T006, T007)
  may be written before implementation (T008, T009, T010); under
  TDD they will fail until the implementation lands.
- **Phase 4 (US2)**: Depends on Phase 2 and on T007 being in
  place (T011 extends `test/refresh-lifecycle.ts` after T007's
  switch to `displayedFeedSyncStatus`). No production code.
- **Phase 5 (US3)**: Depends on Phase 2. T012 is independent of
  US1/US2 work. T013 follows T011 because both edit
  `test/refresh-lifecycle.ts`. No production code.
- **Phase 6 (Polish)**: Depends on Phases 2-5 and on T015's wire
  point in `test/index.ts`. T016 (suite verification) gates T017
  (manual verification).

### User Story Dependencies

- **US1 (P1)**: Depends only on Phase 2.
- **US2 (P1)**: Depends only on Phase 2 and on T007 (shared file).
- **US3 (P2)**: Depends only on Phase 2 and on T011 (shared file).

### Within Each User Story

- Tests are added/updated first (TDD).
- Implementation follows; tests should turn green.
- Run `npm test` after each task or logical group; commit on green.

### Parallel Opportunities

- T005 and T006 are in different files
  (`test/feed-status.ts`, `test/sidebar-footer-refresh.ts`)
  with no shared imports beyond the public state surface; they
  can be written in parallel by separate sub-agents.
- T010 (CSS) is in a different file from T008/T009 (TS) so it
  can be authored in parallel with the US1 implementation tasks
  once T004 has wired the component to the computed.
- US2 (T011) and US3 (T012) tests can be written in parallel
  with each other if file conflicts are managed: T012 is in
  `test/feed-status-loader.ts` (no conflict), T011 and T013 both
  edit `test/refresh-lifecycle.ts` (sequential).
- T014 (new file `test/updating-pill-lifecycle.ts`) can be
  drafted in parallel with US2/US3 test work; T015 must wait
  for T014.

---

## Parallel Example: User Story 1 Tests

```bash
# After Phase 2 lands, launch US1 test updates in parallel:
Task: "T005 — Update test/feed-status.ts for 'updating' label and \
       refreshInProgress=true case"
Task: "T006 — Extend test/sidebar-footer-refresh.ts for pill text/color \
       across the three resolution paths"
# T007 follows in test/refresh-lifecycle.ts (sequential with T011/T013).

# Then in parallel for implementation:
Task: "T008/T009 — feed-status.ts label + syncing class"
Task: "T010 — feed-status.css medium-viewport carve-out for .syncing"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 (Setup baseline).
2. T002, T003, T004 (Foundational — computed, drop redundant
   write, component reads computed).
3. T005, T006, T007 (US1 tests).
4. T008, T009, T010 (US1 implementation).
5. **STOP and VALIDATE**: walk quickstart.md Scenario 1; the
   pill is yellow with `updating` from click to resolution.
6. The MVP for the user-reported gap is shippable here.

### Incremental Delivery

1. MVP above → ship US1 (the user-reported fix).
2. Add T011 → US2 regression coverage; ship.
3. Add T012, T013 → US3 regression coverage; ship.
4. Add T014, T015 → end-to-end FR-012 test wired into the bundle.
5. T016, T017 → final verification before merge.

### Parallel Team Strategy

This is a single-developer-sized feature; the parallel
opportunities listed above are useful only when sub-agent
delegation is appropriate. For a solo run, follow the MVP order
above sequentially.

---

## Notes

- [P] tasks = different files, no functional dependencies.
- [Story] label maps each task to the user story it serves
  (US1, US2, US3); foundational and polish tasks carry no
  story label.
- The feature is server-stable. There are no DO, route, SSE
  wire, schema, or `/api/sync` payload changes. Anyone reviewing
  this branch should see no diffs under `src/server/` or
  `src/shared/`.
- Constitution rule: do not modify CSS unrelated to this feature
  (T010 is the only CSS change and is scoped to the
  `.feed-status` selector).
- Constitution rule: no emoji in source files or commit messages
  authored by the assistant.
- Each commit should land at a logical green-tests checkpoint
  per the checkpoints called out above.
