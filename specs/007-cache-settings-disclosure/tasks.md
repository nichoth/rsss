# Tasks: Cache Settings Disclosure (Feed Reader)

**Input**: Design documents from `/specs/007-cache-settings-disclosure/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Test tasks ARE included. Per `research.md` R6, one new
DOM/markup test file is required to lock the affordance contract.
Animation/focus/ARIA wiring is covered by the upstream component's
own test suite and is not retested here.

**Organization**: Tasks are grouped by user story. Both stories are
P1 — US1 introduces the disclosure affordance; US2 verifies the
existing cache controls keep working through the swap. They share
the same source file (`src/client/routes/feed-reader.ts`), so US2
runs immediately after US1 and depends on it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)
- All paths are repo-relative

## Path Conventions

Single-project layout under `src/`. Client code lives in
`src/client/`; tests live in `test/` at repo root and are
registered in `test/index.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make the `@substrate-system/details-summary` custom
element available app-wide (JS registration + stylesheet) so any
route can use it. The package is already in `package.json` at
`^0.0.2`; this phase only wires it in.

- [X] T001 Add side-effect import `import '@substrate-system/details-summary'` in `src/client/index.ts` next to the existing `import './style.css'` line so the custom element is registered exactly once per app load.
- [X] T002 [P] Add `@import url("@substrate-system/details-summary/css");` to `src/client/style.css` next to the other `@substrate-system/*` CSS imports (after `hamburger-two/css`, before the route-level imports).

**Checkpoint**: The `<details-summary>` element upgrades and its
default stylesheet loads on every route, but no route uses it yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Scope the component's CSS variable overrides to the
feed-reader cache disclosure host so that when User Story 1 swaps
the markup, the visual integration with the items header is correct
on first paint (avoids the layout-jump regression in SC-004 and the
overlap risk in FR-008).

⚠️ CRITICAL: Must complete before any user story phase touches the
markup, otherwise the new disclosure will render with the
component's default 1rem padding / 600 weight / bottom border and
collide with the items-header controls.

- [X] T003 In `src/client/routes/feed-reader.css`, inside the existing `& .feed-cache-controls { ... }` block (around line 59), add the component CSS variable overrides documented in research R3: `--details-summary-padding: 0;`, `--details-summary-font-weight: 400;`, `--details-summary-font-size: 1rem;`, `--details-summary-content-color: var(--color-text);`, `--details-summary-transition-speed: 0.2s;`, plus `border-bottom: none;` to opt out of the component's outer border. Use existing tokens from `_variables.css` only — do NOT modify `_variables.css` (data-model I-9).

**Checkpoint**: Theming hooks are in place; the route still renders
the old `<details>` markup. No user-visible change yet.

---

## Phase 3: User Story 1 — Recognise that cache settings can be opened (Priority: P1) 🎯 MVP

**Goal**: The `Cache: ...` summary on the feed reader route reads
as an interactive disclosure (visible affordance, hover/focus
state, smooth open/close) rather than as plain text. Mouse, touch,
and keyboard all toggle the panel.

**Independent Test**: Open the feed reader, select a feed. Verify
that (a) the `Cache: ...` summary shows the component's animated
`+` / `x` affordance, (b) clicking it expands the panel with a
smooth animation, (c) tabbing onto it shows a visible focus ring
and `Enter` / `Space` toggle the panel, (d) with
`prefers-reduced-motion: reduce` the state still flips but no
height/opacity tween plays, (e) switching to a different feed
remounts the disclosure in the closed state.

### Tests for User Story 1 ⚠️

> Write the test FIRST, confirm it FAILS against the current `<details>`
> markup, then proceed to implementation.

- [X] T004 [US1] Create `test/feed-reader-cache-disclosure.ts` covering the markup contract from `data-model.md` — assert that the feed-reader route renders a `<details-summary class="feed-cache-controls">` element wrapping exactly one `<details>` whose direct children are exactly one `<summary>` (text starts with `Cache:`) and one `<div class="details-content">`. Follow the style of existing client tests (e.g. `test/settings-route.ts`) for harness setup. Run a second render with a different `selectedFeed.id` and assert that the new `<details>` element has no `open` attribute (data-model I-4, "no carry-over"). Register the new file in `test/index.ts` next to the other client tests.

### Implementation for User Story 1

- [X] T005 [US1] In `src/client/routes/feed-reader.ts` (around lines 247–333), replace the bare `<details class="feed-cache-controls">…</details>` subtree with `<details-summary class="feed-cache-controls">` wrapping a `<details>` whose direct children are `<summary>` and `<div class="details-content">`. Move all non-summary content (the `.feed-cache-form` block AND the `.btn-clear-cache` button) inside `.details-content` (data-model I-1, I-2; research R2). Keep the existing summary text exactly as-is: `Cache:&nbsp;${modeLabel}` plus the conditional `' (default)'` suffix (data-model I-3).
- [X] T006 [US1] Pass `key=${selectedFeed.id}` to the `<details-summary>` element so Preact remounts it on feed switch (research R5; data-model I-4). Use the htm-with-preact attribute spelling already used elsewhere in the file.
- [X] T007 [US1] Add a `prefersReducedMotion` local state in `FeedReader` (`useState(false)` plus a `useEffect` that subscribes to `window.matchMedia('(prefers-reduced-motion: reduce)')` and updates on the `change` event with cleanup on unmount). Conditionally apply `duration="0"` to `<details-summary>` when reduced motion is active; omit the attribute otherwise so the component default (300 ms) applies (research R4; data-model I-5). Do NOT promote this to `state.ts` (data-model I-7).

**Checkpoint**: User Story 1 is fully functional. The summary has
the affordance, mouse/touch/keyboard activate it, animation plays
when reduced motion is off and is suppressed when on, and feed
switches start in the closed state. T004 passes.

---

## Phase 4: User Story 2 — Existing cache controls keep working (Priority: P1)

**Goal**: With the disclosure now open, every existing per-feed
cache control still works — choosing a cache mode, setting max
size, setting retention days, and clicking "Clear cache" all
persist via the same handlers as before; the summary label updates
when the effective mode changes; the `(default)` suffix only
appears when the value comes from the user default.

**Independent Test**: With the panel open: (a) change "Cache mode"
to "Text only" and blur — summary updates to `Cache: Text only`
(no `(default)` suffix); switch back to "Use default" — summary
updates to e.g. `Cache: Text + images (default)`. (b) Enter `5` in
max size, blur — value persists across reload. (c) Enter `7` in
retention days, blur — value persists. (d) Click "Clear cache" and
confirm — existing success/error feedback shows, cached content
removed.

**Dependency**: Sequential after US1 (same file).

### Tests for User Story 2 ⚠️

- [X] T008 [US2] Extend `test/feed-reader-cache-disclosure.ts` (created in T004) with assertions that the `<div class="details-content">` contains exactly one `<select>` whose `name` starts with `feed-cache-mode-`, one `<input type="number">` whose `name` starts with `feed-max-size-`, one `<input type="number">` whose `name` starts with `feed-max-age-`, and one `<button class="btn-clear-cache">` (data-model I-2, I-6). Add an assertion that when the effective mode for the test fixture comes from the user default, the rendered `<summary>` text ends with `(default)`; when an override is set, it does not (FR-004, data-model I-3).

### Implementation for User Story 2

- [X] T009 [US2] In `src/client/routes/feed-reader.ts`, verify after the markup move from T005 that the existing handler bindings on the inner `<select>` and `<input>` elements (`handleFeedCacheModeChange`, `handleFeedMaxSizeChange`, `handleFeedMaxAgeChange`) and the `.btn-clear-cache` button (`handleClearFeedCache`) are unchanged in signature and call site (data-model I-6). No new handlers, no signature changes, no new signal writes. Do NOT modify `src/client/db/feed-cache-policy.ts` (no schema/persistence change per plan).
- [X] T010 [US2] Confirm the Settings route's per-feed cache controls are NOT touched (data-model I-8): leave `src/client/routes/settings.ts` and `test/settings-route.ts` unchanged. If any selector in those files happens to rely on `details > .feed-cache-form` rather than on the feed-reader-route DOM specifically, leave it alone — Settings still uses the bare `<details>` widget.

**Checkpoint**: All four cache actions persist the same way as
before, summary label tracks the effective mode, `(default)`
suffix appears only when expected, and the Settings route is
untouched. T008 passes alongside T004.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Verification gates required by the constitution and
the spec's success criteria.

- [X] T011 [P] Run `npm test` and `npm run lint` from repo root and confirm both are green (the new `test/feed-reader-cache-disclosure.ts` plus existing `test/settings-route.ts` and the rest must all pass; lint must not flag the new TS lines).
- [ ] T012 [P] Walk through `specs/007-cache-settings-disclosure/quickstart.md` end-to-end in a real browser per the constitution's "Local verification" gate. Tick every "Done conditions" checkbox: affordance visible, mouse/touch/keyboard toggle, smooth animation off / no motion on with reduced-motion emulation, summary label updates on mode change with correct `(default)` suffix behaviour, all four inner controls persist, no carry-over on feed switch, no overlap at ~700 px viewport, accessibility tree exposes name + expanded state.
- [X] T013 [P] Search the diff for any unintended CSS changes outside `.feed-cache-controls` (data-model I-9). Confirm `_variables.css` and the global `details-summary` selector were not modified, and that no font-size below `1rem` was introduced (data-model I-10, project rules).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. T001 and T002 touch different files and can run in parallel.
- **Foundational (Phase 2)**: Depends on Setup (the CSS variables in T003 only have an effect once the component's stylesheet from T002 is loaded). Blocks all user-story phases.
- **US1 (Phase 3)**: Depends on Foundational. Tests (T004) before implementation (T005–T007).
- **US2 (Phase 4)**: Depends on US1 (same file, US2 verifies US1's swap did not regress the inner controls). Test extension (T008) before implementation verification (T009–T010).
- **Polish (Phase 5)**: Depends on US1 and US2 complete.

### Within Each User Story

- Tests are written first and FAIL before the matching implementation runs.
- US1: T004 (test) → T005 (markup swap) → T006 (key for remount) → T007 (reduced-motion). T006 and T007 modify the same component but logically distinct edits; do them sequentially to keep diff readable.
- US2: T008 (test extension) → T009 (handler-binding verification) → T010 (Settings-route untouched check).

### Parallel Opportunities

- **Phase 1**: T001 (TS file) and T002 (CSS file) — different files, [P].
- **Phase 5**: T011, T012, T013 are independent verification activities — all [P].
- **Across stories**: US1 and US2 cannot be parallelised because they edit the same `feed-reader.ts` file in overlapping regions.

---

## Parallel Example: Phase 1 Setup

```bash
# Run in parallel:
Task: "Add side-effect import in src/client/index.ts (T001)"
Task: "Add @import in src/client/style.css (T002)"
```

## Parallel Example: Phase 5 Polish

```bash
# Run in parallel after US1 + US2 are done:
Task: "Run npm test && npm run lint (T011)"
Task: "Walk through quickstart.md in a browser (T012)"
Task: "Audit diff for unintended CSS changes (T013)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup (T001, T002).
2. Phase 2 Foundational (T003).
3. Phase 3 US1 (T004 → T005 → T006 → T007).
4. **STOP and VALIDATE**: Manual browser check that the affordance
   is visible and mouse/keyboard activation works. The four inner
   controls are still wired to the same handlers as before US1
   (because we only moved the markup; we did not change handlers),
   so the MVP is already functionally complete — but US2's tests
   lock that guarantee in.
5. Optional partial demo at this point.

### Incremental Delivery

1. Setup + Foundational → component available, theming scoped, no
   visible change yet.
2. US1 → disclosure affordance live; ship behind no flag (it's a
   purely presentational change).
3. US2 → tests extended to lock inner-control parity; demo full
   feature.
4. Polish → quickstart + lint/test gates green; merge.

### Single-Developer Strategy (Expected)

This feature is small enough for one developer in one sitting.
Recommended order: T001 → T002 → T003 → T004 → T005 → T006 → T007
→ T008 → T009 → T010 → T011 → T012 → T013. Run `npm test` after
T004 to confirm the test fails against the old markup, after T005
to confirm it passes against the new markup, and again at T011 as
the final gate.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps each task to its user story; setup,
  foundational, and polish tasks have no story label by design.
- This feature does NOT add a new signal, schema, wire format, or
  HTTP route. The "contract" is the markup shape required by
  `@substrate-system/details-summary`, which is asserted by T004
  and T008.
- Per project CSS rules, do not modify CSS unrelated to the cache
  disclosure. Per data-model I-8, do not modify the Settings
  route's per-feed cache controls.
- Per data-model I-7, do not promote `prefersReducedMotion` into
  `state.ts`; keep it local to `FeedReader`.
- Commit after each phase or logical group. Stop at any checkpoint
  to validate independently.
