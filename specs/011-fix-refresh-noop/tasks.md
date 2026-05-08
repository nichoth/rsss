# Tasks: Refresh Feeds Click Must Produce an Observable Response

**Input**: Design documents from `/specs/011-fix-refresh-noop/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/button-controlled-isspinning.md, quickstart.md

**Tests**: Tests are explicitly requested. FR-012 mandates an automated test that exercises the visible chain on each of the three resolution paths so the regression cannot silently return. `plan.md` "Project Structure" and `quickstart.md` "Automated verification" name a new browser-driven test file (`test/sidebar-footer-refresh.ts`) and an extension to the existing `test/refresh-lifecycle.ts`.

**Organization**: Tasks are grouped by user story so each P1 / P2 contract slice can be verified independently. The MVP — US1 (click is acknowledged within one frame) — carries the actual production code change, because the same one-line render-layer regression is what currently fails US1, US2, and US3 together. US2 and US3 are then test-only phases that lock in their additional observable contracts so future regressions are caught at the right slice.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story this task belongs to (US1, US2, US3)
- All file paths are absolute under repo root `/Users/nick/code/rsss`

## Path Conventions

This repo uses `src/client`, `src/server`, `src/shared` (not the template's `backend/` / `frontend/` split). Tests live under `test/`. Per `plan.md`, this feature touches **only** `src/client/components/button.ts`, `src/client/routes/updates.ts`, the named test files (`test/refresh-lifecycle.ts`, `test/sidebar-footer-refresh.ts`), and `test/index.ts` for test bundling. No server file, no schema, no wire format, no CSS.

---

## Phase 1: Setup

**Purpose**: Establish a clean, reproducible starting point before any code edits so test/lint regressions surface against this feature, not pre-existing state, and so the fix can be validated against a known-bad client.

- [X] T001 Run `npm test && npm run lint` from `/Users/nick/code/rsss` on the `011-fix-refresh-noop` branch and confirm a clean baseline before making any code changes.
- [X] T002 Reproduce the bug per `specs/011-fix-refresh-noop/quickstart.md` "Reproducing the bug (before the fix)" — sign in with a feed-bearing account, open DevTools Network filtered to `feeds/refresh`, click "Refresh Feeds", and confirm zero `POST /feeds/refresh` requests fire. This pins the known-bad state that the fix must invert.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None required. The signal (`state.refreshInProgress`), the button binding, and the lifecycle table all already exist (delivered by feature 010). This feature does not introduce shared infrastructure; the fix is one render-layer correction whose code change lives inside US1 because it is what unblocks the user-visible click acknowledgement.

**Checkpoint**: Phase 2 is a no-op for this feature. Proceed directly to US1.

---

## Phase 3: User Story 1 — Reader's click is acknowledged within one frame (Priority: P1) — MVP

**Goal**: A click on "Refresh Feeds" produces a visible change on screen within the same render frame as the click, and the busy cue persists continuously until the work resolves. Crucially, the underlying `POST /feeds/refresh` is actually dispatched — the regression silently swallows it today.

**Independent Test** (from `spec.md` US1): Open the home page with at least one subscribed feed, click "Refresh Feeds", and confirm without DevTools / stopwatch that the screen visibly changes by the time the click physically completes; have a second observer identify from a recording alone that a click occurred.

### Tests for User Story 1

> Tests grow first (failing against today's broken Button) before implementation, per project convention. The new browser-driven test file (`test/sidebar-footer-refresh.ts`) is the FR-012 regression-proof guard at the click boundary. The existing `test/refresh-lifecycle.ts` is extended with the unit-level invariant that no caller may set `state.refreshInProgress = true` before invoking `State.refreshFeeds`.

- [X] T003 [P] [US1] Extend `/Users/nick/code/rsss/test/refresh-lifecycle.ts` with a "broken-caller pattern" guard case: set `state.refreshInProgress.value = true` (simulating the broken `Button.click` write), then `await State.refreshFeeds(state)`, and assert zero `POST /feeds/refresh` requests are dispatched (counted via stubbed fetch). This encodes the invariant from `data-model.md` "Application signal model" that `state.refreshInProgress` is owned exclusively by `State.refreshFeeds` on the way in.
- [X] T004 [P] [US1] Create `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` with a browser-driven harness: lift `StubEventSource` and `withStubbedFetch` patterns from `test/feed-status-loader.ts` and `test/refresh-lifecycle.ts`, mount the real `SidebarFooter` component (from `src/client/components/sidebar-footer.ts`) against the tapout-bundled DOM, and provide test seams for dispatching a real `click` event on the rendered `<button>` (`button.dispatchEvent(new MouseEvent('click', { bubbles:true }))`). No assertions yet — harness only.
- [X] T005 [US1] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` a happy-path FR-001 case: dispatch a real click on the mounted "Refresh Feeds" `<button>`, await one microtask tick, assert exactly one stubbed `fetch` call to `/feeds/refresh` (this is the regression — the bug suppresses this POST), and assert the `<button>` carries `aria-busy="true"` and the `disabled` attribute after the POST resolves but before SSE `refresh-complete` arrives.
- [X] T006 [US1] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-002 / FR-005 sustained-busy case: from the post-T005 state, sample `aria-busy` after the POST resolves and again before firing SSE `refresh-complete`, asserting it stays `"true"` across that window; then fire SSE `refresh-complete` with a payload that mirrors the new-items shape, yield microtasks, and assert `aria-busy` flips to `"false"` in the same paint as the items list / pill update (single settle batch from feature 010).
- [X] T007 [US1] Wire the new file into the bundled test run by adding `import './sidebar-footer-refresh.js'` to `/Users/nick/code/rsss/test/index.ts`. Confirm the new tests run under `npm test`.

### Implementation for User Story 1

- [X] T008 [US1] In `/Users/nick/code/rsss/src/client/components/button.ts`, introduce the controlled-vs-uncontrolled distinction per `contracts/button-controlled-isspinning.md`: capture `const isControlled = Boolean(_isSpinning)` once, then in the `click` handler write `isSpinning.value = true` / `isSpinning.value = false` only when `isControlled === false`. Wrap the `await props.onClick(ev)` in `try/finally` so the uncontrolled-mode signal returns to `false` on a thrown / rejecting `onClick` (closes invariant I-3 — the latent "throw leaves spinner stuck" bug). Public API (`ButtonProps`) is unchanged; rendered attributes (`aria-busy`, `disabled`, `spinning` class) continue to read from the same signal.
- [X] T009 [P] [US1] In `/Users/nick/code/rsss/src/client/routes/updates.ts`, drop the per-feed `spinning:Signal<boolean>` field from the `RefreshMap` type and from every place that initializes / writes it; remove the `isSpinning=${refresh.spinning}` prop from the per-feed `<${Button}>` so `Button` falls back to its uncontrolled-mode internal `useSignal<boolean>(false)` and auto-manages the busy state for the duration of `await State.refreshFeed(...)`. Keep the `error:Signal<string|null>` field — the parent still reads it for the per-feed `<p class="refresh-error">` render.
- [X] T010 [US1] Run `npm test` and confirm that (a) the broken-caller-pattern guard test from T003 now passes (the signal stays high so `State.refreshFeeds` short-circuits, validating the invariant — note this test passes both before *and* after the production fix because it directly tests `State.refreshFeeds` behavior, not `Button`), (b) T005/T006 now pass (the bug is gone — POST fires, `aria-busy` follows the right lifecycle), and (c) no existing test in `test/refresh-lifecycle.ts` regresses.
- [ ] T011 [US1] Repeat `quickstart.md` "Manual verification (happy path — User Story 1)" against a real browser session: stage non-zero pending updates, click "Refresh Feeds", confirm a single `POST /feeds/refresh` fires (where today there are zero), the button stays busy continuously through the refresh window, and the items / pill / button transition together at the conclusion. _Pending live browser session — automated coverage in `test/sidebar-footer-refresh.ts` exercises the same click → POST → aria-busy → SSE settle chain._

**Checkpoint**: US1 fully delivered. Click → POST → continuous busy → resolution all observable. The reader-reported "nothing happens" symptom is gone.

---

## Phase 4: User Story 2 — Reader sees a clear conclusion to the refresh (Priority: P1)

**Goal**: Every refresh resolves into exactly one of three observable terminal states (new items, up to date, failure) with the cessation of the busy cue and the conclusion cue perceived as one coherent moment. There must be no silent fourth resolution path.

**Independent Test** (from `spec.md` US2): Trigger refresh under each of three controlled conditions (new items, no new items, induced failure) and have an observer identify from a recording alone (a) that a refresh ran and (b) which outcome occurred.

> All tasks in this phase extend the same `test/sidebar-footer-refresh.ts` file added in US1, so they are sequential within the file (no `[P]`). They depend on the harness from T004 and on the production fix from T008.

### Tests for User Story 2

- [X] T012 [US2] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-003a / FR-005 new-items resolution case: dispatch a click, fire SSE `refresh-complete` with a payload that surfaces 3 new items (use the same payload shape as `loadFeedStatus`'s success branch), assert in a single tick that `aria-busy="false"`, the items list contains the 3 new items, and the header pill text reflects the post-refresh value — all visible together (no preceding silent gap per FR-005).
- [X] T013 [US2] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-003b no-new-items resolution case: with `state.feedUpdateCounts` already showing zero, dispatch a click, fire SSE `refresh-complete` with an empty / zero-counts payload, and assert (a) `aria-busy="false"`, (b) the pill transitions cleanly through `syncing` to `up to date` (or stays at `up to date` if it was already there) — never to a fourth silent state.
- [X] T014 [US2] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-003c / FR-006 / FR-007 failure resolution case: stub `fetch` to reject the `POST /feeds/refresh` (or return a non-2xx without an SSE follow-up), capture the pre-click `state.feedUpdateCounts.value`, dispatch a click, await the failure batch, and assert (a) `aria-busy="false"`, (b) the pill renders the error legend / `feedSyncStatus === 'error'`, (c) `state.feedUpdateCounts.value` is restored to its pre-click value (NOT zeroed — FR-006 explicitly forbids "completed successfully" semantics on failure), and (d) `feedSyncError` carries a non-null message.

**Checkpoint**: US2 fully verified. Each of the three terminal cues is observable from the DOM after a click; no resolution path silently settles.

---

## Phase 5: User Story 3 — Reader can repeat refresh without confusion (Priority: P2)

**Goal**: Successive refreshes feel responsive and identical. A click while a refresh is in flight does not start a parallel refresh and does not interrupt the in-progress busy state.

**Independent Test** (from `spec.md` US3): Click "Refresh Feeds", wait for resolution, click again, and repeat several times in quick succession. Each click must produce the full visible chain from US1 / US2 with no degradation.

> All tasks in this phase extend `test/sidebar-footer-refresh.ts`. They depend on the harness from T004 and on the production fix from T008.

### Tests for User Story 3

- [X] T015 [US3] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-008 successive-resolved-clicks case: dispatch click 1, fire SSE `refresh-complete`, await settle; dispatch click 2, fire SSE `refresh-complete`, await settle; dispatch click 3 same way. Assert `fetch` was called with `/feeds/refresh` exactly three times (one per click), and that each click went through the full FR-001 → FR-005 visible chain (`aria-busy` rises and falls inside its own lifecycle, items / pill update at each settle). The Nth click must not be observably "quieter" than the 1st.
- [X] T016 [US3] Add to `/Users/nick/code/rsss/test/sidebar-footer-refresh.ts` an FR-007 click-while-busy guard case: dispatch click 1 but DO NOT fire SSE `refresh-complete`; while the button is `disabled` / `aria-busy="true"`, dispatch a second click (the DOM-level `disabled` attribute should swallow it). Assert `fetch` was called with `/feeds/refresh` exactly once. Then fire SSE `refresh-complete` and confirm the in-progress run resolves cleanly (US1's visible chain is not "left in a state that reads as broken once the in-progress run finishes").

**Checkpoint**: US3 verified. The `disabled` DOM gate, the `State.refreshFeeds` re-entry guard, and the parent's ownership of `state.refreshInProgress` together provide three layers of protection (per `data-model.md` "Idempotency"), and the test surface confirms the visible behavior.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Final verification that the regression is closed end-to-end, that the broader edge-case surface from `quickstart.md` continues to behave, and that the assistive-tech path is intact.

- [X] T017 Run `npm test && npm run lint` from `/Users/nick/code/rsss` on the `011-fix-refresh-noop` branch. All existing tests must continue to pass; the new tests T003 / T005 / T006 / T012-T016 must all be green.
- [ ] T018 Walk through `specs/011-fix-refresh-noop/quickstart.md` "Manual verification (edge cases)" in a real browser: rapid clicks (FR-008 DOM gate), successive resolved refreshes (FR-008), SSE drop mid-refresh (feature 010 carry-forward), slow refresh (no flicker), zero subscribed feeds (settles to `up to date`, no spurious failure cue), background poll during manual refresh (FR-011), and the per-feed Refresh button on `/updates` (regression check on the uncontrolled-mode fallback after T009). _Pending live browser session — automated coverage in `test/sidebar-footer-refresh.ts` covers FR-007 (T016) and FR-008 (T015); rapid-click DOM-disable, SSE drop, and per-feed regression need human verification._
- [ ] T019 Accessibility check per `quickstart.md` "Accessibility check": with VoiceOver (macOS) or NVDA (Windows), Tab to "Refresh Feeds", activate via `Enter` and again via `Space`, and confirm the screen reader announces the busy state via `aria-busy="true"` and the resolution via the `role="status" aria-live="polite"` pill region (FR-009). Both keyboard activation paths must produce the same visible chain that mouse click does — the click event the test dispatches is the same event the keyboard path produces, so this is the live-environment confirmation. _Pending live AT session._

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately. T001 and T002 are independent of each other (T001 is the lint/test baseline; T002 is the manual reproduction).
- **Foundational (Phase 2)**: No-op for this feature.
- **User Story 1 (Phase 3)**: Carries the production code change. T008 / T009 are the implementation. T003 / T004 / T005 / T006 / T007 are tests that grow before T008 / T009.
- **User Story 2 (Phase 4)**: Depends on the harness from T004 and on the production fix from T008 / T009 (otherwise the resolution-path assertions can't run because no POST fires).
- **User Story 3 (Phase 5)**: Depends on T004 and T008 / T009 same as US2.
- **Polish (Phase N)**: Depends on US1 / US2 / US3 being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Independently testable once the harness (T004) and production fix (T008 / T009) ship. This story is the MVP — delivering it alone closes the user-visible "nothing happens" complaint.
- **User Story 2 (P1)**: Independently testable once the harness exists and the fix has shipped; verifies a different observable contract slice (the three resolution cues) on the same code path.
- **User Story 3 (P2)**: Independently testable once the harness exists and the fix has shipped; verifies the re-entry / DOM-disable surface, which feature 010 already implements but which becomes reachable from the click path again only after this fix.

### Within Each User Story

- Tests grow before implementation where applicable (US1).
- Within `test/sidebar-footer-refresh.ts`, harness (T004) before assertions (T005, T006, T012, T013, T014, T015, T016).
- T007 (wire test into `test/index.ts`) before T010 (run npm test) and T017 (final test run).
- T008 (Button controlled mode) and T009 (per-feed map cleanup) ship together — independently they are correct, but the per-feed Refresh button only behaves correctly when both have shipped.

### Parallel Opportunities

- T003 (extension of `test/refresh-lifecycle.ts`) and T004 (creation of `test/sidebar-footer-refresh.ts`) — different files, both tests-first, both [P].
- T008 (`button.ts`) and T009 (`updates.ts`) — different production files, both [P]. They must both land before US2 / US3 are verified, but neither blocks the other.
- US2 and US3 test additions (T012-T016) all edit the same file (`test/sidebar-footer-refresh.ts`) and so are sequential within the file. They can be picked up by different reviewers but only one editor at a time.
- Setup tasks T001 and T002 are independent and can run in parallel.

---

## Parallel Example: User Story 1 tests

```bash
# Two independent test edits at the start of US1 (different files):
Task: "Extend test/refresh-lifecycle.ts with broken-caller-pattern guard (T003)"
Task: "Create test/sidebar-footer-refresh.ts harness (T004)"

# Two independent production-file edits during implementation (different files):
Task: "Make Button controlled-mode-aware in src/client/components/button.ts (T008)"
Task: "Drop per-feed spinning binding in src/client/routes/updates.ts (T009)"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup (T001, T002) — confirm clean baseline and pin the bug.
2. Phase 3: User Story 1 (T003-T011) — write the regression tests, ship the controlled-mode fix, drop the dead per-feed `spinning` field, run the new tests, walk the happy-path quickstart.
3. **STOP and VALIDATE**: with US1 alone, the user-reported "nothing happens" complaint is closed. The MVP is shippable.

### Incremental Delivery

1. Setup → Foundation ready (no-op for this feature).
2. US1 → MVP / demo: click is acknowledged, POST fires, busy chain runs.
3. US2 → adds three resolution-path tests; locks in FR-003 contract surface.
4. US3 → adds re-entry / successive-clicks tests; locks in FR-007 / FR-008 contract surface.
5. Polish → final lint / test / quickstart / accessibility pass.

### Rollback

Per `quickstart.md` "Rollback": all changes are client-side. Reverting the commits that touch `src/client/components/button.ts` and `src/client/routes/updates.ts` restores the pre-fix client (the bug returns) without any server, schema, or routing rollback.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps task to specific user story (US1, US2, US3) for traceability against `spec.md`.
- Tests grow before implementation in US1 so the regression-proof guard is in place when the fix lands.
- US1 is the only phase with production code edits; US2 / US3 are test-only phases that broaden the regression-test surface across FR-003 / FR-006 / FR-007 / FR-008.
- No emoji in any source file, test file, or commit message authored by Claude (constitution Tech Stack rule, repeated in `plan.md` Constraints).
- CSS unrelated to the refresh button is NOT modified — there is in fact no CSS change in this feature at all (per `plan.md` Constraints).
