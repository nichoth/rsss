---
description: "Task list for feature 004-unread-only-count"
---

# Tasks: Sync "All Items" Count With Unread-Only Filter

**Branch:** `004-unread-only-count`
**Input:** Design documents from `/specs/004-unread-only-count/`
**Prerequisites:** plan.md, spec.md, research.md, data-model.md,
contracts/sidebar-badge.md, quickstart.md

**Tests:** Included. The plan calls for a unit render test covering
both filter states (`research.md` Q5, `plan.md` Project Structure
"NEW: test/sidebar-item.ts"), plus the constitution-required manual
browser quickstart.

**Organization:** Single user story (P1). Phases 1 and 2 are empty
because this feature is render-only on top of an existing,
already-shipped client.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies).
- **[Story]**: User story label (US1).
- File paths are absolute relative to repo root.

## Path Conventions

Web app — Cloudflare Worker + Preact SPA. Production code under
`src/client/` and `src/server/`; tests under `test/`. Confirmed in
`plan.md` Structure Decision.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose:** Project initialization.

*No tasks.* The project, toolchain, lint config, and test runner are
already in place. This feature adds zero dependencies (`plan.md`
Technical Context: "No new dependencies").

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose:** Cross-cutting prerequisites that must precede any user
story.

*No tasks.* `state.counts` (incl. `total`), `state.showUnreadOnly`,
`DbAdapter.getCounts()` on both adapters, and the `loadCounts()`
refresh after every count-affecting mutation already exist
(`research.md` Q1, Q3; `data-model.md` Client state in scope).

---

## Phase 3: User Story 1 — Count Reflects Active Filter (Priority: P1) MVP

**Goal:** The "All Items" sidebar badge value MUST equal the size of
the visible reading list under the current "Unread only" filter
state. Today the badge unconditionally renders `counts.unread` and
disagrees with the visible list whenever the filter is off.

**Independent Test:** Quickstart Tests 1–3
(`specs/004-unread-only-count/quickstart.md`):

1. With ≥1 read and ≥1 unread item, "Unread only" off — badge equals
   visible list size `N`.
2. Check "Unread only" — badge updates to unread count `U` and
   matches the now-shorter visible list.
3. Uncheck "Unread only" — badge returns to `N`.

### Tests for User Story 1

> Write the test FIRST and confirm it FAILS against the unmodified
> `sidebar-item.ts` before implementing T002.

- [X] T001 [US1] Add render test
  `/Users/nick/code/rsss/test/sidebar-item.ts` that mounts
  `SidebarItem` with `starred=false` against a stub `AppState`
  (mirroring the pattern in `test/item-row.ts:1-15`) and asserts the
  contract from `contracts/sidebar-badge.md` Output table:
    - `showUnreadOnly=false` + `counts={unread:3,starred:1,total:7}` →
      badge text `7`.
    - `showUnreadOnly=true` + same counts → badge text `3`.
    - Toggling `state.showUnreadOnly.value` between renders flips the
      badge in the same tick (FR-004 / Reactivity contract #1) — no
      `loadCounts` call required.
    - `starred=true` branch: badge always shows `counts.starred`
      regardless of `showUnreadOnly` (FR-006).
  Register the new file by adding `import './sidebar-item.js'` to
  `/Users/nick/code/rsss/test/index.ts` alongside the existing UI
  imports (e.g., next to line 32 `import './item-row.js'`). No
  changes needed to `test/run-all-tests.mjs` — the existing
  `test/index.ts` bundle command on line 88-94 picks it up.

### Implementation for User Story 1

- [X] T002 [US1] Edit
  `/Users/nick/code/rsss/src/client/components/sidebar-item.ts`
  line 39 to drive the All Items badge from `showUnreadOnly`. Pull
  `showUnreadOnly` out of `state` alongside the existing destructure
  on line 13 (`const { showStarredOnly, counts, route } = state`),
  then change the badge expression to:

  ```ts
  ${starred ?
      counts.value.starred :
      (showUnreadOnly.value ?
          counts.value.unread :
          counts.value.total)}
  ```

  Style constraints (`CLAUDE.md`): keep lines ≤80 columns; use the
  ternary line-break style shown above (operator at end of line);
  no space between `:` and type in any new annotations. Do NOT
  modify CSS, the adapter contract, or
  `feed-reader.ts:176-180` — `total` and `unread` are invariant
  under filter toggles per `contracts/sidebar-badge.md` Non-changes.

- [X] T003 [US1] Run `npm test && npm run lint` from
  `/Users/nick/code/rsss` and confirm both pass — including the new
  `sidebar-item.ts` test added in T001.

**Checkpoint:** US1 is fully functional. Proceed to polish.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose:** Constitution-mandated browser verification and
cleanup.

- [X] T004 [US1] Execute the manual browser verification in
  `/Users/nick/code/rsss/specs/004-unread-only-count/quickstart.md`
  end-to-end (Tests 1–8) against a local `npm start` session. This
  is required by `CLAUDE.md` global rules and the constitution's
  Local Verification rule (`plan.md` Constitution Check) — type
  check + unit tests alone do not satisfy completion. Record any
  deviations; if all eight tests pass, the feature is complete.

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup): empty.
- Phase 2 (Foundational): empty.
- Phase 3 (US1): can start immediately.
- Phase 4 (Polish): T004 depends on T002 + T003.

### Within User Story 1

- T001 before T002 (TDD: red before green).
- T002 before T003 (lint/tests run against the implemented change).
- T003 before T004 (don't browser-verify until automated checks pass).

### Parallel Opportunities

Single-file change. No parallelizable tasks within this feature
(none marked `[P]`). The sole "parallelism" is the natural one of
keeping T001's test sketch open while editing T002.

---

## Implementation Strategy

### MVP

US1 *is* the entire feature. Complete T001 → T002 → T003 → T004.
Stop. There is no Phase 5+, no follow-on story, and no anticipated
deferred work — `plan.md` Complexity Tracking is empty by design.

### Risk

Lowest-risk class of change in the codebase: render-only, no schema,
no sync, no server, no adapter contract change, no new dependency.
The only realistic regression surface is the Starred branch — T001
covers it explicitly (`FR-006`).

---

## Notes

- File paths are absolute per skill format requirements; the actual
  edits live under `src/client/components/sidebar-item.ts` and
  `test/sidebar-item.ts`.
- TDD ordering is required by the project's superpowers/TDD norms
  even though the change is one expression — the test pins
  `contracts/sidebar-badge.md` against future regressions (someone
  flipping the ternary back, or adding a third filter).
- Do NOT add a `loadCounts()` call to the "Unread only" handler in
  `feed-reader.ts:176-180`. `total` and `unread` are invariant under
  filter toggles (`research.md` Q3, `contracts/sidebar-badge.md`
  Non-changes #4).
