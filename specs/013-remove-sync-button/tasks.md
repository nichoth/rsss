---
description: "Task list for feature 013-remove-sync-button"
---

# Tasks: Remove Redundant Sync Button from Settings

**Input**: Design documents from `/specs/013-remove-sync-button/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
quickstart.md

**Tests**: Not requested. The spec ships with manual verification
(see `quickstart.md`); research R4 confirms no existing test asserts
on the Sync button. No new automated tests are added by this feature.

**Organization**: Tasks are grouped by user story. Both US1 and US2
are P1 in `spec.md`. US1 is the deletion itself (the MVP); US2 is
the no-regression check on neighboring controls and is enabled by
US1's diff. Run US1's tasks first, then US2's verification, then
Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)
- File paths in descriptions are absolute / repo-relative

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: None. This feature edits two existing files in an
already-initialized project. No new tooling, scaffolding, or
dependencies are introduced.

*(Phase intentionally empty — proceed to Phase 2.)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None. Per `data-model.md`, this feature introduces no
schema, no signal contract, no payload, and no shared module. The
sync machinery (`sync-cycle.ts`, `sync-status.ts`,
`<sync-status>` component) is intentionally left intact and
continues to be consumed by `State.sync()` and the global indicator.

*(Phase intentionally empty — proceed to Phase 3.)*

---

## Phase 3: User Story 1 - Settings page no longer shows a redundant Sync control (Priority: P1) 🎯 MVP

**Goal**: The `/settings` route's Local Storage section no longer
renders a "Sync" button, the "Pull updates from the server" caption,
or a sync-error banner. Background sync still runs automatically;
the home-route "Refresh feeds" remains the canonical user-triggered
pull entry point.

**Independent Test**: Open `/settings` in the browser. The Local
Storage section contains exactly the two configuration toggles
("Sync subscriptions and read state to this device", "Store article
content locally for offline reading") and nothing else trailing.
DevTools search for `class="btn-sync"`, `class="sync-local-data"`,
and the literal "Pull updates from the server" each return zero
hits inside Local Storage. (Maps to spec FR-001, FR-002, FR-003 and
US1 acceptance scenarios AS-1, AS-2.)

### Implementation for User Story 1

- [X] T001 [US1] Remove the `<div class="sync-local-data">…</div>`
  JSX block (currently lines 540-554) and the immediately-following
  `${syncError.value && html`<p class="bootstrap-error">…</p>`}`
  fragment (currently lines 555-557) from
  `src/client/routes/settings.ts`. Leave the surrounding Local
  Storage `<section class="local-first-section">` and its two
  toggles untouched. (FR-001, FR-002, FR-003)

- [X] T002 [US1] Remove the `handleSync` async function (currently
  lines 376-386) from `src/client/routes/settings.ts`. After T001
  it has no remaining caller. (FR-001 follow-up)

- [X] T003 [US1] Remove the now-dead imports from
  `src/client/routes/settings.ts`:
  `import { runSyncCycle } from '../db/sync-cycle.js'` (line 41)
  and `import { syncStatus, syncError } from
  '../db/sync-status.js'` (line 42). Confirm via grep that none of
  `runSyncCycle`, `syncStatus`, `syncError` is referenced elsewhere
  in this file before deleting. Do NOT touch `sync-cycle.ts`,
  `sync-status.ts`, or the `<sync-status>` component — those remain
  in use by `State.sync()` and the global indicator (research R3).

- [X] T004 [US1] Remove the nested `& .sync-local-data { … }` rule
  (currently lines ~110-122, including its inner `& .sync-desc`)
  inside `.local-first-section` in
  `src/client/routes/settings.css`. Leave every other rule in that
  file alone (`.bootstrap-error` is shared with bootstrap status
  surfacing — do NOT remove it). (FR-001, plan §"CSS unrelated to
  the current task MUST NOT be modified")

- [X] T005 [US1] Remove the top-level `.btn-sync { … }` rule
  (currently lines ~125-142) from
  `src/client/routes/settings.css`. Confirm via grep that no other
  selector or template still references `.btn-sync` before
  deleting. (FR-001)

- [X] T006 [US1] Run `npm run lint` and TypeScript build
  (`npm run build` or the configured type-check) on the modified
  tree. Resolve any "declared but never read" / unused-import
  errors that surface — they should already be eliminated by T003,
  but confirm. (FR-007 prerequisite)

**Checkpoint**: User Story 1 is independently verifiable — the
Sync UI is gone from `/settings` and the build is clean. The MVP
diff is complete at this point.

---

## Phase 4: User Story 2 - No regressions to local-storage configuration controls (Priority: P1)

**Goal**: After US1's deletion, the two Local Storage toggles, the
Cache section, the Subscription section, and the home-route
"Refresh feeds" continue to work exactly as before. No new console
errors or warnings appear.

**Independent Test**: Following `quickstart.md` Steps 4-7, exercise
each control and verify persistence + side-effects + console
cleanliness. (Maps to spec FR-004, FR-005, FR-006, FR-007 and US2
acceptance scenarios AS-1, AS-2, AS-3.)

### Implementation for User Story 2

> User Story 2 is a verification phase. US1 should not have touched
> any of these surfaces, so the work here is to confirm — with the
> running app — that nothing regressed.

- [X] T007 [US2] Run `npm test` on the modified tree to confirm
  existing test suites (notably `test/settings-route.ts`,
  `test/local-first-settings.ts`, `test/sync-cycle.ts`) still pass.
  Per research R4, no test edits are expected; if any test now
  fails, treat it as a regression in US1, not a green-light to
  modify the test.

- [ ] T008 [US2] Start the dev server (`npm start`) and execute
  `quickstart.md` Step 4 — toggle "Sync subscriptions and read
  state to this device" off→on with reload, then toggle "Store
  article content locally for offline reading" off→on with reload.
  Verify each persists and that purge side-effects still fire on
  the content toggle. (FR-004, US2 AS-1)

- [ ] T009 [US2] In the same dev session, execute `quickstart.md`
  Step 5 — navigate to `/`, click "Refresh feeds", confirm new
  items load and the action completes without error. (FR-005, US1
  AS-3, US2 AS-2)

- [ ] T010 [US2] In the same dev session, execute `quickstart.md`
  Step 6 — adjust default cache mode, max size per feed, total
  cache size, and keep-for (days); adjust a per-feed cache override
  under "Subscribed Feeds"; confirm the Subscription section
  renders the user's plan label and Manage/Upgrade button. Each
  must persist across reload and be visually unchanged. (FR-006)

- [ ] T011 [US2] With DevTools Console open throughout T008-T010,
  confirm zero new errors or warnings. Specifically watch for
  `ReferenceError` for `runSyncCycle`, `syncError`, or `syncStatus`
  (research R5) and for Preact "key prop" / "missing function"
  warnings near the now-shorter Local Storage section. Pre-existing
  warnings unrelated to this change are acceptable but should be
  noted. (FR-007, SC-001)

- [ ] T012 [US2] Execute `quickstart.md` Step 3 — confirm no
  sync-error banner appears inside the Local Storage section even
  when offline/online toggling produces a `syncError` value
  elsewhere. The global sync-status indicator (out of scope per
  FR-003) must continue to render. (FR-003, US2 AS-3)

**Checkpoint**: Both User Stories complete. The Sync button is
gone, neighboring controls are intact, and the console is clean.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final verification gates before merging.

- [X] T013 Re-run `npm test && npm run lint` end-to-end and capture
  the green output. (Constitution "Local verification" gate.)

- [ ] T014 Execute the remaining `quickstart.md` steps not already
  covered in Phase 4: Step 1 (DOM search for `btn-sync`,
  `sync-local-data`, "Pull updates from the server" — zero hits in
  Local Storage), Step 2 (re-verify with the sync-subscriptions
  toggle off), Step 8 (discoverability — a fresh user finds
  "Refresh feeds" within 10 seconds). (SC-001, SC-004)

- [X] T015 Final diff audit: confirm the change set is limited to
  `src/client/routes/settings.ts`, `src/client/routes/settings.css`,
  and `specs/013-remove-sync-button/`. No other files modified. No
  new files created in `src/`. (plan §"Structure Decision",
  quickstart §"What 'done' looks like")

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: empty — nothing to do.
- **Phase 2 (Foundational)**: empty — nothing to do.
- **Phase 3 (US1)**: starts immediately. T001 → T002 → T003 are on
  the same file (`settings.ts`) and must be sequential. T004 → T005
  are on the same file (`settings.css`). T006 (lint/type-check) is
  the gate at the end of Phase 3.
- **Phase 4 (US2)**: depends on Phase 3 completing. T007 (`npm
  test`) can run as soon as US1's edits land. T008-T012 require the
  dev server running and are sequential by virtue of sharing a
  single browser session, but T012 (offline/online simulation) can
  be slotted alongside T008/T010 if convenient.
- **Phase 5 (Polish)**: depends on Phase 3 + Phase 4 complete.

### User Story Dependencies

- **US1 (P1)**: independent. The MVP scope of this feature.
- **US2 (P1)**: logically independent (asserts nothing about US1's
  internals), but practically a verification of the post-US1 state
  — start it after US1 is complete to make the assertions
  meaningful.

### Within Each User Story

- US1: TS edits (T001-T003) before CSS edits (T004-T005) are
  recommended to keep the JSX gone before the styling vanishes
  (avoids any transient FOUC during local dev), but the operations
  commute. Lint/type-check (T006) must come last.
- US2: tests (T007) before manual browser checks (T008-T012);
  console budget (T011) is observed throughout the manual checks.

### Parallel Opportunities

- T001/T002/T003 all touch `src/client/routes/settings.ts` →
  **NOT parallel** with each other.
- T004/T005 both touch `src/client/routes/settings.css` →
  **NOT parallel** with each other.
- The TS file and the CSS file are independent → T001-T003 (TS)
  may run in parallel with T004-T005 (CSS) on a multi-developer
  team. (None of these tasks are marked [P] because they are
  intra-story sequential within their respective files; the
  cross-file parallelism is per-developer, not per-task.)
- Within US2, T007 (`npm test`) can run concurrently with the dev
  server warming up for T008 if you have two terminals.

---

## Parallel Example

This feature is small enough that a single developer will likely
execute it serially. If splitting across two developers:

```bash
# Developer A — TS edits in src/client/routes/settings.ts
T001  Remove sync-local-data + syncError JSX block
T002  Remove handleSync function
T003  Remove runSyncCycle / syncStatus / syncError imports

# Developer B — CSS edits in src/client/routes/settings.css
T004  Remove .local-first-section .sync-local-data rule
T005  Remove .btn-sync rule

# Then either developer
T006  Run lint + type-check
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1, Phase 2: skip (empty).
2. Phase 3 (US1): execute T001-T006.
3. **STOP and VALIDATE**: open `/settings` in the dev browser and
   confirm the Sync UI is gone (quickstart Step 1).
4. This is shippable on its own — the feature's stated goal is
   met.

### Incremental Delivery

1. Land US1 → demo: Sync UI is gone, lint/build clean.
2. Run US2 verification (T007-T012) → demo: toggles, cache,
   subscription, refresh-feeds all unaffected.
3. Polish (T013-T015) → ready to merge.

### Single-Developer Strategy (likely)

Execute T001 → T015 in order. Total expected diff: ~25-30 lines
removed from `settings.ts`, ~30 lines removed from `settings.css`,
no new code.

---

## Notes

- [P] not used in this tasks file: the diff is concentrated in two
  files, so most tasks are intra-file sequential. Parallelism is
  available only at the file boundary (TS vs CSS), and that is
  noted explicitly in "Parallel Opportunities" rather than via [P]
  markers, to avoid implying that, e.g., T001 and T002 (same file)
  are independent.
- [Story] label maps each Phase 3/4 task to its user story.
- No test tasks: this feature is verified manually per
  `quickstart.md` (constitution's "Local verification" gate). A DOM
  regression test asserting the button is absent is a reasonable
  follow-up, but is not required by this spec (research R4).
- Do NOT delete `src/client/db/sync-cycle.ts`,
  `src/client/db/sync-status.ts`, or
  `src/client/components/sync-status.ts`. They remain in use by
  `State.sync()` and the global indicator (research R3, FR-003
  out-of-scope clause).
- Do NOT modify `.bootstrap-error` or any other CSS rule in
  `settings.css` beyond `.sync-local-data` (incl. nested
  `.sync-desc`) and `.btn-sync` (constitution: "CSS unrelated to
  the current task MUST NOT be modified").
- Commit cadence: one commit per task or one commit per phase, per
  the user's preference. The constitution does not mandate a
  cadence here.
