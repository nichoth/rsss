# Tasks: Per-Feed Pending Count In Sidebar

**Input**: Design documents from `/specs/014-sidebar-pending-count/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Test tasks are INCLUDED. The plan and research explicitly require
extending `test/sidebar-feed-counts.ts` (research.md Decision 4) to cover
Acceptance Scenarios 1, 2, 3, 4, 6, 7 and the URL-fallback / All-Feeds-row
edge cases. Tests are written before implementation (TDD) per project
guidelines.

**Organization**: This feature has a single user story (US1, P1). All
implementation tasks are grouped under that story. There is no Phase 2
foundational work because the underlying signal (`feedUpdateCounts`)
already exists and is already wired to its producers.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1)
- File paths in descriptions are absolute from repo root

## Path Conventions

- **Web app frontend**: `src/client/` (the only tree touched here)
- **Tests**: `test/` (project uses `@substrate-system/tapzero`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No setup required. Project is initialized, dependencies
(`preact`, `@preact/signals`, `htm/preact`, `tapzero`) are already
installed, and the file under change (`src/client/components/sidebar.ts`)
already exists. Skip directly to Phase 2 / Phase 3.

*(no tasks)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: No foundational work required. The signal this feature reads
(`state.feedUpdateCounts`) is already declared at
`src/client/state.ts:182`, initialized at `src/client/state.ts:241`, and
populated by the existing SSE / refresh / reconcile paths
(`state.ts:644-667`, `state.ts:1277-1285`, `state.ts:1399 / 1441 /
1691-1694`). The same signal is already summed by `FeedStatus`
(`feed-status.ts:74-75`). No new entities, no new contracts, no schema
work — see `data-model.md` "Out of scope".

*(no tasks)*

**Checkpoint**: Foundation already in place — proceed directly to
User Story 1.

---

## Phase 3: User Story 1 - See Pending Count Per Feed In Sidebar (Priority: P1) MVP

**Goal**: For every subscribed feed shown in the left sidebar, render
`(N) ` immediately before the feed's display name when
`state.feedUpdateCounts.value[String(feed.id)] > 0`. Omit the prefix
entirely when the count is zero or undefined. The "All Feeds"
pseudo-row never gets a prefix.

**Independent Test** (from spec): Subscribe to two or more feeds, then
trigger a state where at least one feed has pending items (add a new
feed, or wait for a background poll). Open the app and look at the
sidebar. Confirm every feed with pending items shows `(N) feedName`
where `N` is the pending count, and every feed with zero pending items
shows just `feedName`. Click "Refresh Feeds"; confirm all parenthesized
prefixes disappear once the refresh completes, in the same paint as
the aggregate "updates available" pill clears.

### Tests for User Story 1 (TDD — write first, ensure they FAIL before implementation)

- [X] T001 [P] [US1] Extend `StubOpts` in `/Users/nick/code/rsss/test/sidebar-feed-counts.ts` with an optional `pendingCounts?:Record<string, number>` field, and update `stubState()` (around line 32-51) to seed `feedUpdateCounts: signal(opts.pendingCounts ?? {})` from it. Add a `rowAnchorText(row)` helper that returns the trimmed `textContent` of the row's `a.feed-select`. Both helpers are needed by every test below; this task is a precondition for T002–T009 and they will fail until it lands.
- [X] T002 [P] [US1] Acceptance Scenario 1 — add test "feed with N>0 pending shows `(N) ` prefix before name" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub two feeds, seed `pendingCounts: { 1: 3 }`, mount, assert `rowAnchorText(rows[0])` starts with `(3) ` and ends with the feed-1 title; assert no other row has a parenthesized prefix.
- [X] T003 [P] [US1] Acceptance Scenario 2 — add test "feed with zero/undefined pending shows no prefix" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub two feeds, seed `pendingCounts: { 1: 0 }` (and omit feed 2 entirely), mount, assert neither anchor's text contains `(` — i.e. NO `(0) ` placeholder, NO empty `()` (FR-002).
- [X] T004 [P] [US1] Acceptance Scenario 3 / FR-005 — add test "clearing feedUpdateCounts removes the prefix in the same paint" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub one feed with `pendingCounts: { 1: 4 }`, mount, assert prefix `(4) ` present, then write `state.feedUpdateCounts.value = {}` and assert the anchor no longer contains a `(` (a Preact render flush within the test, e.g. `await new Promise(r => setTimeout(r, 0))`, may be needed before re-asserting).
- [X] T005 [P] [US1] Acceptance Scenario 4 — add test "signal change re-renders the prefix without reload" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub one feed with empty `pendingCounts`, mount, assert no prefix; then write `state.feedUpdateCounts.value = { 1: 7 }` and assert the anchor text now starts with `(7) `.
- [X] T006 [P] [US1] Acceptance Scenario 6 — add test "multi-digit count renders fully (e.g. 153)" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub one feed with `pendingCounts: { 1: 153 }`, assert `rowAnchorText(rows[0]).startsWith('(153) ')` (no truncation of the digits in the rendered text).
- [X] T007 [P] [US1] Acceptance Scenario 7 — add test "deleting one feed does not change another's prefix" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub two feeds with `pendingCounts: { 1: 2, 2: 5 }`, mount, assert both prefixes; then write `state.feeds.value = [feed2]` (simulate deletion), assert only feed-2 row remains with prefix `(5) ` and its prefix is unchanged.
- [X] T008 [P] [US1] Edge Case (URL fallback) — add test "feed with no title gets the prefix before its URL" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub a feed via `makeFeed(...)` with `title: ''` (or null cast), seed `pendingCounts: { 1: 9 }`, assert the anchor text reads `(9) <url>` exactly (single ASCII space between `)` and the URL).
- [X] T009 [P] [US1] FR-007 — add test "the All Feeds pseudo-row never receives a prefix" to `/Users/nick/code/rsss/test/sidebar-feed-counts.ts`: stub two feeds with `pendingCounts: { 1: 4, 2: 6 }`, mount, locate the All-Feeds pseudo-row (`.sidebar-item` matching the "All Feeds" label, NOT inside `.feeds-list .feed-item`), assert its visible text contains no `(` substring.

### Implementation for User Story 1

- [X] T010 [US1] In `/Users/nick/code/rsss/src/client/components/sidebar.ts`, inside the `feeds.value.map(feed => ...)` block (currently at lines 159-200), compute `const pending = state.feedUpdateCounts.value[String(feed.id)] ?? 0` alongside the existing `feedUnread` calculation. Then prepend `(${pending}) ` as leading text inside the `<a class="feed-select">` anchor (currently lines 177-182), but ONLY when `pending > 0`. When `pending <= 0` the anchor renders exactly as today (no prefix, no `(0) `, no empty parens). Use the same `htm` template literal style as the surrounding code; do not introduce new DOM elements, new classes, or new CSS rules. The All-Feeds pseudo-row above this block is NOT modified — it stays prefix-free per FR-007.

### Verification for User Story 1

- [X] T011 [US1] Run `npm test` from `/Users/nick/code/rsss` and confirm the new cases T002–T009 PASS and the previously-existing `test/sidebar-feed-counts.ts` cases still pass. Run `npm run lint` and confirm no new violations were introduced.
- [ ] T012 [US1] Execute the manual quickstart at `/Users/nick/code/rsss/specs/014-sidebar-pending-count/quickstart.md`: start `npm start`, sign in, establish a non-pending baseline (Step 2), trigger pending state via add-feed or background poll (Step 3), verify multi-digit rendering (Step 4), verify URL fallback (Step 5), verify refresh clears both indicators atomically (Step 6), and verify a screen-reader announces the prefix inline with the link name (Step 7). Document any deviation from spec FR-001..FR-008.

**Checkpoint**: User Story 1 — and therefore the entire feature — is fully functional and independently testable.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Final cleanup and SC-005 sanity check. There are no
documentation files to update for this feature (no public API change),
no security surface changes, and no new dependencies.

- [X] T013 [P] Re-read the diff on `/Users/nick/code/rsss/src/client/components/sidebar.ts` and confirm the change is a *single* conditional string prepend inside the existing anchor. Reject any inadvertent CSS edit, any new class name, or any change outside the `feeds.value.map(...)` block (per global rule "NEVER change CSS that is not related to the task").
- [ ] T014 SC-005 sanity — with the feature on, mount or load the app against a stubbed `feeds.value` of length 200 (in DevTools console: `state.feeds.value = Array.from({length: 200}, (_, i) => ({...state.feeds.value[0], id: i+1, title: 'Feed ' + i})); state.feedUpdateCounts.value = Object.fromEntries(Array.from({length: 200}, (_, i) => [String(i+1), i % 5]))`) and confirm the sidebar still renders without perceptible delay. No automated perf test is required by the plan.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Empty — nothing to do.
- **Phase 2 (Foundational)**: Empty — `feedUpdateCounts` already exists and is already populated by SSE / refresh / reconcile paths.
- **Phase 3 (User Story 1)**: Can begin immediately. T001 unblocks T002–T009. T002–T009 all share the same test file but each appends an independent test case and can be authored in parallel by different drafts and merged together. T010 depends only on T001's stub helper being in place (so the failing tests have a target to run against). T011 depends on T010. T012 depends on T010.
- **Phase N (Polish)**: T013 and T014 depend on T010.

### User Story Dependencies

- **User Story 1 (P1)**: No upstream story dependencies. Stand-alone MVP.

### Within User Story 1

- T001 (test scaffolding) → T002–T009 (each individual failing test).
- T002–T009 must be RED (failing) before T010 lands.
- T010 (single-file production change) makes T002–T009 GREEN.
- T011 (npm test + npm run lint) gates the implementation.
- T012 (manual quickstart) gates the user-visible contract.

### Parallel Opportunities

- T002, T003, T004, T005, T006, T007, T008, T009 can be written in parallel (each is a self-contained `test(...)` call inside the same file; merge order does not affect correctness).
- T013 (diff sanity) and T014 (perf sanity) can run in parallel after T010.

---

## Parallel Example: User Story 1 — TDD test phase

```bash
# After T001 lands, draft these eight tests in parallel:
Task: "T002 Acceptance Scenario 1 (N>0 prefix renders) in test/sidebar-feed-counts.ts"
Task: "T003 Acceptance Scenario 2 (zero / undefined → no prefix) in test/sidebar-feed-counts.ts"
Task: "T004 Acceptance Scenario 3 / FR-005 (clearing signal removes prefix) in test/sidebar-feed-counts.ts"
Task: "T005 Acceptance Scenario 4 (signal change re-renders prefix) in test/sidebar-feed-counts.ts"
Task: "T006 Acceptance Scenario 6 (multi-digit count) in test/sidebar-feed-counts.ts"
Task: "T007 Acceptance Scenario 7 (delete one feed, sibling unchanged) in test/sidebar-feed-counts.ts"
Task: "T008 Edge Case (URL fallback) in test/sidebar-feed-counts.ts"
Task: "T009 FR-007 (All Feeds row never gets a prefix) in test/sidebar-feed-counts.ts"

# All tests must FAIL before T010 begins.
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

This feature *is* MVP. There is no US2, US3, or future story to defer.

1. Skip Phase 1 (empty).
2. Skip Phase 2 (empty — signal already exists).
3. Complete T001, then write T002–T009 in parallel and confirm they all FAIL.
4. Land T010 (single-file production change) and confirm T002–T009 now PASS.
5. Run T011 (`npm test && npm run lint`) and T012 (manual quickstart).
6. **STOP and VALIDATE**: spec FR-001..FR-008 and SC-001..SC-005 satisfied.
7. Run T013 / T014 polish.
8. Done — feature is shippable.

### Incremental Delivery

Single-increment feature. After T010 the entire user-visible contract
is in place; tests and quickstart confirm it.

### Parallel Team Strategy

For one developer this is a half-day task. For two developers, one can
draft the eight test cases (T002–T009) while the other prepares T010
against a local checkout of T001's helpers; they reconcile at T011.

---

## Notes

- [P] tasks = different files, OR self-contained additions to the same file with no ordering constraint between them (the eight test cases each register an independent `test(...)`).
- [Story] label is US1 throughout — single-story feature.
- TDD ordering (T001 → T002–T009 RED → T010 GREEN) is required by project guidelines.
- Avoid: introducing any new CSS rule, any new class, any new DOM node, or any change outside `src/client/components/sidebar.ts` and `test/sidebar-feed-counts.ts`. The plan's "Project Structure" section explicitly fences the feature to those two files.
- Verification commands per `CLAUDE.md`: `npm test && npm run lint`.
