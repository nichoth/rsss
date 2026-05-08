# Tasks: Faithful Visual Feedback During Refresh Feeds

**Input**: Design documents from `/specs/010-fix-refresh-feedback/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/refresh-lifecycle.md, quickstart.md

**Tests**: Tests are explicitly requested. The spec names existing test files to update (`test/state-auth-storage.ts`, `test/feed-status-loader.ts`) and a new file to add (`test/refresh-lifecycle.ts`); see `quickstart.md` "Automated verification" and `plan.md` "Project Structure" → `test/`.

**Organization**: Tasks are grouped by user story so US1 (happy-path continuous busy) and US2 (failure path) can be implemented and verified independently. The user-facing change (button binding + aria-busy) and the new signal itself are foundational — both stories need them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story this task belongs to (US1, US2)
- All file paths are absolute under repo root `/Users/nick/code/rsss`

## Path Conventions

This repo uses `src/client`, `src/server`, `src/shared` (not the template's `backend/`/`frontend/` split). Tests live under `test/`. Per `plan.md`, this feature touches **only** `src/client/state.ts`, `src/client/components/sidebar-footer.ts`, `src/client/components/button.ts`, and the named test files. No server file is modified.

---

## Phase 1: Setup

**Purpose**: Confirm the working tree is clean before edits so test/lint regressions surface against this feature, not pre-existing state.

- [X] T001 Run `npm test && npm run lint` from `/Users/nick/code/rsss` on the `010-fix-refresh-feedback` branch and confirm a clean baseline before making any code changes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the new `refreshInProgress` signal and rewire the UI surfaces (button binding, aria-busy). Both user stories depend on these existing.

**CRITICAL**: User-story phases (US1, US2) cannot start until Phase 2 completes — the new signal must exist and be wired to the button.

- [X] T002 [P] Add `refreshInProgress:Signal<boolean>` (default `false`) to the `AppState` type/interface and the `State()` factory in `src/client/state.ts`. Document the signal next to the existing `feedsLoading` declaration (separate concerns per `research.md` "Track manual-refresh visual state in a new signal").
- [X] T003 [P] Add `aria-busy=${isSpinning}` to the rendered `<button>` in `src/client/components/button.ts` so screen readers announce the busy state during refresh (FR-012, see `contracts/refresh-lifecycle.md` "UI contract" → Button).
- [X] T004 Switch the "Refresh Feeds" `Button`'s `isSpinning` prop in `src/client/components/sidebar-footer.ts` to bind to `state.refreshInProgress` instead of `state.feedsLoading`. Leave `src/client/components/sidebar.ts` line 152 untouched — the "Loading feeds…" empty-state still uses `feedsLoading` (per `data-model.md` "feedsLoading UNCHANGED"). Depends on T002.

**Checkpoint**: `refreshInProgress` exists, the button reads it, and the button announces `aria-busy`. No lifecycle behavior has changed yet — clicking refresh still uses the old POST-acknowledged completion path; that's rewritten in US1.

---

## Phase 3: User Story 1 — Reader sees continuous progress until new items are on screen (Priority: P1) — MVP

**Goal**: The Refresh Feeds button enters a busy state on click and stays busy until the items list and indicator reflect the result of the refresh, in a single perceivable update. No dead window between POST acknowledgement and visible result.

**Independent Test** (from `spec.md` US1): With the header pill at "n updates" (n > 0), click "Refresh Feeds" and observe the control continuously until the items list updates. There must be no period during which the control reads as idle while the refresh is still in progress.

### Tests for User Story 1

> Tests update first (existing files) and grow first (new file) before implementation, per repo convention. The test stubs in `test/feed-status-loader.ts` already include `StubEventSource` and `withStubbedFetch` — reuse them.

- [X] T005 [US1] Update existing tests in `test/state-auth-storage.ts` (the `refreshFeeds marks feed sync as syncing while request is in flight` and `refreshFeeds clears update counts and marks feed sync as synced` tests) so they (a) assert `state.refreshInProgress` (not `state.feedsLoading`) tracks the busy state, and (b) drive completion via a simulated SSE `refresh-complete` event rather than the POST resolve.
- [X] T006 [US1] Create `test/refresh-lifecycle.ts` with a `StubEventSource`/`withStubbedFetch` harness (lift the patterns from `test/feed-status-loader.ts:7-125`) and a happy-path test: after `State.refreshFeeds(state)` POST resolves, `refreshInProgress` is still `true` and `feedSyncStatus` is `'syncing'`; after firing SSE `refresh-complete` and yielding microtasks, `refreshInProgress` is `false` and `loadFeedStatus`-driven counts/pill have been reconciled (single settle batch).
- [X] T007 [US1] Add to `test/refresh-lifecycle.ts`: rapid duplicate clicks dispatch only one POST and do not restart the busy state (FR-008). Verify by counting fetch calls to `/feeds/refresh` while calling `State.refreshFeeds(state)` four times in a tight loop with `refreshInProgress` already `true`.
- [X] T008 [US1] Add to `test/refresh-lifecycle.ts`: while `refreshInProgress === true`, firing a `feed-updated` SSE event does NOT flip `refreshInProgress` to `false` (FR-011). Background-poll updates must not be confused for manual-refresh completion.
- [X] T009 [US1] Add to `test/refresh-lifecycle.ts`: SSE drop and reopen mid-refresh — fire `error` then `open` on the stub source while `refreshInProgress === true` and verify the `open` handler runs the full `refreshAfterSync` (counted via stubbed fetch) and batch-clears `refreshInProgress`.
- [X] T010 [US1] Add to `test/refresh-lifecycle.ts`: 60s safety-timer fallback — replace `setTimeout` with a fake-timer harness (or shorten the timeout via test seam), trigger `State.refreshFeeds(state)`, advance past `REFRESH_FEEDS_SAFETY_TIMEOUT_MS` without firing `refresh-complete`, and assert `refreshInProgress` ends `false`.
- [X] T011 [US1] Add to `test/refresh-lifecycle.ts`: zero-feed edge case — `state.feeds.value = []`, click refresh, fire `refresh-complete` with empty payload, assert `refreshInProgress` settles to `false`, `feedSyncStatus` settles to `'synced'`, no spurious error.
- [X] T012 [US1] Register the new test file by adding `import './refresh-lifecycle.js'` to `test/index.ts` so it runs under `npm test`'s bundled-tests step.

### Implementation for User Story 1

- [X] T013 [US1] Add the FR-008 re-entry guard at the top of `State.refreshFeeds` in `src/client/state.ts`: `if (state.refreshInProgress.value) return`. Place it before any state writes.
- [X] T014 [US1] Rewrite the click-time branch of `State.refreshFeeds` in `src/client/state.ts` (around the existing lines 1356-1363): in one `batch`, set `refreshInProgress=true`, `feedSyncStatus='syncing'`, `feedSyncError=null`; arm the existing 60s safety timer (`REFRESH_FEEDS_SAFETY_TIMEOUT_MS`); then POST `/feeds/refresh`. **Remove** the post-success writes that zero `feedUpdateCounts` or flip `feedSyncStatus` to `'synced'` — those are now `loadFeedStatus`'s sole responsibility (per `data-model.md` "Removed write" and `contracts/refresh-lifecycle.md` "Forbidden transitions").
- [X] T015 [US1] Rewrite the SSE `refresh-complete` handler in `State.openEventStream` (`src/client/state.ts` lines 582-597): clear the safety timer, `await State.refreshAfterSync(state)`, then in one `batch` set `refreshInProgress=false` (and `feedsLoading=false` as today, plus the existing defensive `loadFeedStatus` reconcile that's already there). The settle batch fires after `refreshAfterSync` resolves so button-idle, items-list, and pill update inside one paint (FR-005, SC-002).
- [X] T016 [US1] Extend the SSE `open` reconnect path in `State.openEventStream` (`src/client/state.ts` lines 685-694): when reopening with `state.refreshInProgress.value === true`, run the full `State.refreshAfterSync(state)` (not just `loadFeedStatus`) and batch-clear `refreshInProgress`. This handles the case where `refresh-complete` was lost during an SSE outage (per `research.md` "SSE-reconnect path also clears refreshInProgress").
- [X] T017 [US1] Update the existing safety-timer callback in `src/client/state.ts` (the one that today clears `feedsLoading`) to also clear `refreshInProgress`. The fallback must not touch `feedSyncStatus` — leave that to the next `loadFeedStatus` reconcile (per `data-model.md` state machine SETTLE (c)).
- [ ] T018 [US1] Manual verification per `specs/010-fix-refresh-feedback/quickstart.md` "Manual verification (happy path — User Story 1)": stage non-zero pending updates, click Refresh Feeds, observe a single continuous busy state through to the items-list update. Confirm SC-001 (continuous progress signal) and SC-002 (single done moment within one frame). **Pending real-browser verification.**

**Checkpoint**: US1 fully functional. Refresh button stays busy from click to visible result; pill, button, and items list snap to the post-refresh state together. US2 failure path may still mishandle counts on error — that's covered next.

---

## Phase 4: User Story 2 — Reader gets a clear signal when refresh fails (Priority: P2)

**Goal**: When the refresh fails (POST rejection, network error, 401), the button exits busy, a failure cue is surfaced, and the indicator is restored to its pre-click value rather than silently zeroed.

**Independent Test** (from `spec.md` US2): Force a refresh failure (offline, induced server error). Click "Refresh Feeds". Confirm the button exits busy, a failure cue appears, and the pre-click `n updates` count is restored.

### Tests for User Story 2

- [X] T019 [US2] Update the existing test `refreshFeeds failure leaves feedSyncStatus = error` in `test/feed-status-loader.ts` (around lines 449-476) to also assert `state.refreshInProgress` is `false` after the failure batch resolves.
- [X] T020 [US2] Add to `test/refresh-lifecycle.ts`: pre-populate `feedUpdateCounts={1:7}` and `feedSyncStatus='updates'`, click refresh, fail the POST with a 5xx, then assert `feedUpdateCounts` is restored to `{1:7}` (FR-007), `feedSyncStatus='error'`, `feedSyncError` is non-empty, and `refreshInProgress=false`.
- [X] T021 [US2] Add to `test/refresh-lifecycle.ts`: 401 path — pre-populate signed-in user, click refresh, fail the POST with a 401; assert `state.user.value === null`, `state.authError` is set, `_routeHistory` includes `/login`, and `refreshInProgress=false`, all within the same batch.

### Implementation for User Story 2

- [X] T022 [US2] In `State.refreshFeeds` (`src/client/state.ts`), capture `const priorCounts = state.feedUpdateCounts.value` at the start of the function (after the FR-008 guard, before the click batch). In the failure handler, restore it inside one `batch`: `refreshInProgress=false`, `feedSyncStatus='error'`, `feedSyncError=message`, `feedUpdateCounts=priorCounts`; clear the safety timer first (per `data-model.md` "Failure modes" row 1).
- [X] T023 [US2] Update the existing 401 branch in `State.refreshFeeds` (`src/client/state.ts` lines 1366-1376) to clear `refreshInProgress` inside the same `batch` that nulls `state.user.value`, sets `authError`, and routes to `/login` (per `data-model.md` "Failure modes" row 2). Clear the safety timer before the batch.
- [ ] T024 [US2] Manual verification per `specs/010-fix-refresh-feedback/quickstart.md` "Manual verification (failure path — User Story 2)": stop the worker, click Refresh Feeds, confirm the pill displays the error legend, the prior `n updates` count survives, and the button exits busy. Confirm SC-004 (failure surfaced; pill not silently zeroed). **Pending real-browser verification.**

**Checkpoint**: US2 fully functional. Both happy and failure paths resolve into coherent resting states.

---

## Phase 5: Polish & Cross-Cutting

- [X] T025 Run `npm test && npm run lint` from `/Users/nick/code/rsss`; resolve any failures introduced by the new lifecycle (e.g., stale assertions in unrelated tests that reached into the old `feedsLoading`-driven button binding).
- [ ] T026 [P] Accessibility verification per `specs/010-fix-refresh-feedback/quickstart.md` "Accessibility check": with VoiceOver/NVDA, tab to Refresh Feeds, activate it, and confirm the screen reader announces the busy state via `aria-busy="true"` and the pill transition via its existing `role="status" aria-live="polite"` region (FR-012). No new live-region noise compared to pre-fix. **Pending real-browser verification with screen reader.**
- [X] T027 [P] Confirm no CSS files were modified on this branch — run `git diff --stat origin/main...HEAD -- '*.css'` and verify the output is empty (constitution Tech Stack rule + global CLAUDE.md "NEVER change CSS that is not related to the task").

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → must complete before Phase 2.
- **Phase 2 (Foundational)** → MUST complete before any US phase. Both US1 and US2 read `state.refreshInProgress` and depend on the button binding flip.
- **Phase 3 (US1)** → independently testable as the MVP. Can ship without US2 only if you accept that failure paths may not yet restore counts (current behavior incidentally preserves them; FR-007 robustness is what US2 hardens).
- **Phase 4 (US2)** → depends on Phase 2 only. May be developed in parallel with US1 by a different developer, but in practice US2's tests reuse the harness US1 introduces in `test/refresh-lifecycle.ts` (T006), so easier to do US1 first.
- **Phase 5 (Polish)** → after both US phases complete.

### Within Each User Story

- Tests for the story are written first (T005-T012 for US1, T019-T021 for US2) and should fail against the unchanged code path.
- Implementation tasks (T013-T017 for US1, T022-T023 for US2) follow.
- Manual verification (T018, T024) is the final sign-off per story, performed in a real browser.

### Parallel Opportunities

- T002 (state.ts) and T003 (button.ts) are different files with no shared symbol — `[P]`.
- T026 (a11y check) and T027 (CSS-untouched check) are independent of each other and of code edits — `[P]`.
- US1 and US2 can be split between two developers after Phase 2 lands. Caveat: both stories edit `State.refreshFeeds` in `src/client/state.ts`; merge friction expected. Prefer single-developer sequential execution unless the failure-path edits are pre-staged.
- All tests within `test/refresh-lifecycle.ts` (T006-T011, T020-T021) share a single file and are NOT parallel-safe with each other.
- `test/state-auth-storage.ts` (T005) and `test/feed-status-loader.ts` (T019) are independent files — `[P]` against each other.

---

## Parallel Example: Phase 2

```text
# Both edits are in different files with no shared types:
Task: "Add refreshInProgress signal to AppState in src/client/state.ts"
Task: "Add aria-busy to rendered <button> in src/client/components/button.ts"
# Then sequentially:
Task: "Bind isSpinning to state.refreshInProgress in src/client/components/sidebar-footer.ts"
```

## Parallel Example: Phase 5

```text
# Independent verifications, no code edits:
Task: "Screen-reader a11y verification per quickstart.md"
Task: "git diff --stat to confirm no CSS files changed"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. **Phase 1**: confirm clean baseline (T001).
2. **Phase 2**: ship the new signal + button binding + aria-busy (T002-T004). The lifecycle is unchanged at this point, so the user-visible behavior is the pre-fix dead window — but the seams are in place.
3. **Phase 3**: rewrite the lifecycle (T005-T018). After T018, the user-reported bug is fixed for the happy path.
4. **Validate** with the User Story 1 manual verification (T018) and ship.

### Incremental Delivery

After MVP, US2 (T019-T024) hardens the failure path: priorCounts restoration, 401 batch clearing the busy state, failure-cue verification. US2 is small (5 implementation/test tasks + manual check) and naturally follows US1 because both touch `State.refreshFeeds`.

### Parallel Team Strategy

Not recommended for this feature: US1 and US2 both edit `State.refreshFeeds` in the same file, so concurrent work would create avoidable merge conflicts. A single developer should sequence US1 → US2.

---

## FR Traceability

| FR    | Tasks                                                                           |
|-------|---------------------------------------------------------------------------------|
| FR-001 | T013, T014, T015 (continuous busy from click to visible result)                |
| FR-002 | T014 (no clear at intermediate POST handoff)                                   |
| FR-003 | T002, T004, T015 (`refreshInProgress` is the persistent on-screen cue)         |
| FR-004 | T014, T015 (counts not zeroed at POST ack; reconciled at refresh-complete)     |
| FR-005 | T015 (settle batch after `await refreshAfterSync` — single done moment)        |
| FR-006 | T011, T015 (zero-feed empty-batch refresh-complete settles cleanly)            |
| FR-007 | T020, T022 (priorCounts snapshot + restore on failure)                         |
| FR-008 | T007, T013 (re-entry guard; rapid clicks do not fan out)                       |
| FR-009 | T014, T015 (single false→true→false transition per click)                      |
| FR-010 | T015 (lifecycle is signal-driven, independent of focus/scroll)                 |
| FR-011 | T008, T015 (only `refresh-complete` clears busy; `feed-updated` does not)      |
| FR-012 | T003, T026 (aria-busy on button; screen-reader verification)                   |

---

## Notes

- Tests assert lifecycle (signal transitions, batch boundaries) rather than UI strings — the StubEventSource/withStubbedFetch harness in `test/feed-status-loader.ts` is the canonical pattern.
- No CSS edits are part of this feature (constitution rule + global CLAUDE.md). T027 enforces this.
- The 60s safety timeout (`REFRESH_FEEDS_SAFETY_TIMEOUT_MS`) and the SSE event names are unchanged — all wire contracts are stable.
- The local-first SQLite mirror is untouched. No migration. No version bump.
