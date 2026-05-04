---
description: "Task list for the Sync Status Legend feature"
---

# Tasks: Sync Status Legend

**Input**: Design documents from `/specs/006-sync-status-legend/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
quickstart.md (no contracts/ — no external interface change)

**Tests**: INCLUDED. Research R5 explicitly calls for a unit-style test
of the per-state label function and a manual browser check (constitution
"Local verification" gate).

**Organization**: This feature has a single user story (P1). All
implementation tasks live under that story. There is no Setup or
Foundational work — the project, signals (`feedSyncStatus`,
`feedUpdateCounts`), host component (`Header` -> `FeedStatus`), and
test harness all already exist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Maps task to user story (US1)
- File paths are exact

## Path Conventions

Single-project layout under `src/`. Client component code at
`src/client/components/`, tests flat under `test/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: None required. The project is fully initialized and the
host component (`FeedStatus`) is already mounted in `Header`. No
dependencies to add, no scaffolding to create.

*(no tasks)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None required. Both input signals
(`state.feedSyncStatus`, `state.feedUpdateCounts`) and the
existing dot/`aria-label` plumbing in `feed-status.ts` already exist
and are unchanged by this feature.

*(no tasks)*

---

## Phase 3: User Story 1 - Understand sync state at a glance (Priority: P1) MVP

**Goal**: Render a short text label next to the existing colored dot
in the top-right header for each of the three primary states so the
indicator is self-evident: green -> "up to date", blue -> "1 update"
/ "n updates", yellow -> "refreshing". Visible text and `aria-label`
must agree (FR-006). The `inactive` and `error` states are preserved
unchanged (FR-007).

**Independent Test**: Sign in and observe the indicator in the
top-right of the header in each of the three primary states (synced
/ pending updates / refreshing). The matching text appears alongside
the dot and matches the spec wording exactly. The accessible name
(via Accessibility panel or
`document.querySelector('.feed-status').getAttribute('aria-label')`)
matches the visible text by suffix. (See `quickstart.md`.)

### Tests for User Story 1

> **NOTE**: Write the test FIRST, ensure it FAILS before implementing
> the label function, then make it pass.

- [X] T001 [US1] Add unit test for the per-state label function in
  `test/feed-status.ts`: covers
  (a) `synced` -> `{ label: "up to date", ariaLabel:
      "Feed sync status: up to date" }`,
  (b) `updates` with `count === 1` -> `"1 update"` (singular),
  (c) `updates` with `count > 1` -> `"n updates"` (plural; e.g. n=3),
  (d) `syncing` -> `"refreshing"`,
  (e) `inactive` -> no new label (existing presentation preserved,
      per FR-007 / data-model I-4),
  (f) `error` -> no new label (existing `"sync failed"` preserved).
  Wire the test into the test runner the same way sibling component
  tests are wired (see `test/dot.ts`, `test/header-component.ts`,
  `test/run-header-tests.mjs`).

### Implementation for User Story 1

- [X] T002 [US1] Extract a pure helper
  `legendFor(status, count): { label, ariaLabel }` inside
  `src/client/components/feed-status.ts` per the data-model output
  table. Exporting (named export) is required so `test/feed-status.ts`
  can import it without rendering the component. Both fields equal
  for in-scope states (suffix parity for `aria-label` per
  invariant I-1). Singular vs. plural branches on
  `count === 1`. `inactive`/`error` return the existing
  presentation values so the component's render branches are
  byte-identical to today (FR-007). Keep TS lines <= 80 cols and
  no-space-after-colon style per CLAUDE.md.

- [X] T003 [US1] Wire `legendFor` into `FeedStatus` in
  `src/client/components/feed-status.ts`: replace the existing
  inline `label`/visible-content derivation with one call to
  `legendFor(status, count)`. Render `result.label` as a text node
  next to `<${Dot}/>`, set `aria-label=${result.ariaLabel}`. Do NOT
  touch the `error` branch (preserves existing `aria-label`,
  `title`, and `"sync failed"` text per FR-007 / I-4). Do NOT add
  any `useEffect`, listener, or new signal — reading the existing
  signals in render satisfies FR-005 / I-5. Do NOT add logging.

- [X] T004 [US1] Update spacing + narrow-viewport rule in
  `src/client/components/feed-status.css`: keep the existing
  `gap: 0.25rem` between dot and text. Add a single `@media`
  rule that hides ONLY the new text node (e.g. via a child class
  `.feed-status__legend { display: none }`) when the right cluster
  cannot fit alongside `SyncStatus` / Logout / `UserIcon` in the
  680-1000px range, so the dot stays visible and `aria-label`
  continues to expose the full sentence (R3). Reuse existing
  `_variables.css` tokens; do NOT add new colors; do NOT touch
  unrelated CSS; font-size stays `>= 1rem` (CLAUDE.md CSS rules).

- [X] T005 [US1] Run `npm test && npm run lint` from the repo root
  and confirm both are green. Fix any lint or test failures
  surfaced.

- [X] T006 [US1] Run the manual browser verification from
  `specs/006-sync-status-legend/quickstart.md`. Confirm every Done
  Condition: (i) all three in-scope states render the correct
  label, (ii) `aria-label` matches the visible label by suffix for
  each, (iii) singular `1 update` appears at exactly n=1, (iv)
  `inactive` and `error` render exactly as before, (v) no layout
  jump in the right cluster on transitions, (vi) at narrow widths
  the text hides via CSS while the dot remains visible.

**Checkpoint**: User Story 1 fully functional and independently
testable. This is the entire feature; no further user stories.

---

## Phase 4: Polish & Cross-Cutting Concerns

*(no tasks — feature is intentionally minimal: presentational mapping
only, no new state, no new data source, no schema/sync/server
changes, no docs surface beyond `quickstart.md` which already lives
in this feature dir)*

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): empty
- Phase 2 (Foundational): empty
- Phase 3 (US1): only phase with work — start immediately
- Phase 4 (Polish): empty

### Within User Story 1

Sequential by design (small surface area, all touches the same
component):

1. T001 (write failing test)
2. T002 (implement helper -> test goes green)
3. T003 (wire helper into component)
4. T004 (CSS for narrow viewport + spacing)
5. T005 (`npm test && npm run lint`)
6. T006 (manual browser check per quickstart)

T001 -> T002 -> T003 is a strict TDD chain (test must fail before
T002, test must pass after T002, T003 cannot land without T002).
T004 depends on T003 because the new text node is what the CSS
rule targets. T005 depends on T001-T004. T006 depends on T005.

### Parallel Opportunities

None within this feature. The implementation set is small (one TS
file + one CSS file + one test file) and the tasks form a TDD
chain. Parallelism would be artificial and would risk merging an
unverified label string.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

This story IS the MVP. Phases 1, 2, and 4 are intentionally empty:

1. T001 (write failing test)
2. T002 (extract `legendFor`)
3. T003 (wire into `FeedStatus`)
4. T004 (CSS adjustments)
5. T005 (`npm test && npm run lint`)
6. T006 (manual browser verification per quickstart.md)
7. STOP and VALIDATE — feature is complete.

### Incremental Delivery

Not applicable — single story, single component, single CSS file.
The feature ships as one increment.

### Parallel Team Strategy

Not applicable — tasks form a TDD chain on the same two source
files.

---

## Notes

- [P] is intentionally absent from every task: all tasks touch
  `feed-status.ts` or its companion CSS, or they verify the same
  set of changes.
- The `legendFor` helper MUST be exported from `feed-status.ts` so
  the test in T001 can call it without a render harness (R5).
- Do NOT change the `error` branch in `feed-status.ts` (FR-007 /
  data-model I-4). The existing `aria-label`, `title`, and visible
  `"sync failed"` text remain byte-identical.
- Do NOT add new CSS variables or colors; reuse existing tokens
  per CLAUDE.md.
- Visible text and `aria-label` for in-scope states share their
  source via `legendFor` — this is the data-model invariant I-1.
- No `batch()` usage required: this feature does not write any
  signal.
- The `inactive` branch of the existing component renders nothing
  new today; preserve that behavior exactly.

---

## Format Validation

All 6 tasks follow `- [ ] T### [US1] description with file path`.
No `[P]` markers used (justified above). Story label `[US1]`
present on every task in Phase 3. Phases 1, 2, and 4 have no tasks
(documented why). Setup/Foundational/Polish phases correctly carry
no story label because they contain no tasks.
