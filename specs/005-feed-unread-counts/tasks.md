---
description: "Task list for Per-Feed Unread Counts In Sidebar"
---

# Tasks: Per-Feed Unread Counts In Sidebar

**Input:** Design documents from `/specs/005-feed-unread-counts/`
**Prerequisites:** plan.md, spec.md, research.md, data-model.md,
contracts/counts-response.md, contracts/sidebar-feed-counts.md,
quickstart.md

**Tests:** Included. Plan §Testing and research §Q8 explicitly call for
two tests (Preact-render unit test for the sidebar feed list + adapter
shape test on both `localAdapter` and `remoteAdapter`).

**Organization:** Single user story (US1, P1). Foundational phase
covers the one shared interface change (`CountsResponse.perFeed`) that
all producer and consumer tasks depend on.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 only here)
- File paths are relative to repo root `/Users/nick/code/rsss/`

## Path Conventions

Web app layout (Cloudflare Worker + DO backend, Preact SPA frontend):

- Backend (worker + DO): `src/server/`
- Frontend (Preact SPA): `src/client/`
- Cross-edge shared code: `src/shared/`
- Tests: `test/`

---

## Phase 1: Setup

**Purpose:** Pre-flight on the existing project. No new dependencies,
no new directories, no new build config — this feature reuses the
already-established Cloudflare Worker + DO + Preact SPA layout.

- [X] T001 Pre-flight: confirm `npm test && npm run lint` pass on the
      current branch tip (so any later regressions are attributable to
      this feature, not pre-existing breakage). Working dir: repo root.

**Checkpoint:** Branch is green; ready to extend the shared contract.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose:** Extend the shared `CountsResponse` interface that both
producers (server DO + local adapter) and consumers (state initial
value + sidebar render) depend on. This MUST land before any
producer/consumer task in Phase 3 to avoid TS errors and to give the
adapter shape test something to import.

**CRITICAL:** No US1 task can begin until T002 is complete.

- [X] T002 Extend `CountsResponse` in `src/client/db/types.ts` to add
      `perFeed:Record<string,number>` after the existing
      `unread`/`starred`/`total` fields. Match the no-space-after-colon
      style and ≤80-col rule (CLAUDE.md). Per
      `contracts/counts-response.md`, this field is required on the
      wire and on the in-memory signal — producers must always set it
      (`{}` when no items are unread) so consumers never see
      `undefined`.

**Checkpoint:** Shared contract updated. Producers and consumers can
now be implemented in parallel.

---

## Phase 3: User Story 1 — See Unread Count Per Feed (Priority: P1) — MVP

**Goal:** Render a numeric unread count to the left of every feed row
in the sidebar's feeds-list section (including the "All Feeds" pseudo-
feed). The number for each feed equals `COUNT(items WHERE is_read = 0
AND feed_id = F)`; the "All Feeds" row reuses
`state.counts.value.unread`. Counts update reactively after mark
read/unread, after background sync settles, and after add/delete feed
— wired through the existing `State.loadCounts` refresh point.

**Independent Test:** Per `quickstart.md`. Subscribe to two feeds
where `F1` has ≥2 unread items and `F2` has 0; open the app; confirm
every sidebar feed row (and "All Feeds") has a numeric badge to the
left of the name; mark an item in `F1` read and confirm `F1`'s badge
decrements by 1 with other rows unchanged; toggle "Unread only" and
confirm sidebar counts do not change.

### Tests for User Story 1

> **NOTE:** Per `superpowers:test-driven-development`, write these
> tests first and confirm they FAIL against current `main` behavior
> before writing the production code in T005–T010. The unit test will
> fail because `sidebar.ts` does not render a count badge yet; the
> adapter test will fail because `getCounts()` does not yet emit
> `perFeed`.

- [X] T003 [P] [US1] Add adapter shape test in `test/db-adapter.ts`
      (extend the existing file). Cover both `localAdapter` and
      `remoteAdapter`: assert `getCounts()` resolves to an object that
      includes `perFeed` as a `Record<string, number>` keyed by
      stringified `feed_id`; seed two feeds with mixed read/unread
      items, mark some read, and assert `perFeed[String(feed.id)]`
      drops accordingly. Assert the invariant
      `Object.values(perFeed).reduce((a,b)=>a+b, 0) === unread`. Assert
      that feeds with zero unread items are absent from the map (the
      omission rule from `contracts/counts-response.md`). Run with
      `npm test`.

- [X] T004 [P] [US1] Add Preact render unit test in
      `test/sidebar-feed-counts.ts` (new file, follow the established
      `test/sidebar-item.ts` pattern using
      `@substrate-system/tapzero` + Preact mount with stubbed
      `AppState`). Cover:
      (a) FR-001 / FR-002: every row in `.feeds-list .feed-item` (one
      per stubbed feed plus the "All Feeds" row) contains a
      `.feed-unread-count` (or `.badge`) element appearing before the
      feed-name link in DOM order;
      (b) FR-003 / FR-008: the per-feed badge text equals
      `state.counts.value.perFeed[String(feed.id)]`, and the "All
      Feeds" badge text equals `state.counts.value.unread`;
      (c) FR-004: a feed whose id is missing from `perFeed` renders
      the literal text `0` (not blank, not absent);
      (d) FR-009: setting `state.showUnreadOnly.value = true` and re-
      rendering does not change any badge text.

### Implementation for User Story 1

- [X] T005 [P] [US1] Update the in-memory initial value of
      `state.counts` in `src/client/state.ts` (the signal is currently
      created at `state.ts:248-250`) to include `perFeed: {}`. This is
      a one-line default change so `state.counts.value.perFeed` is
      never `undefined` before the first `loadCounts` round-trip.

- [X] T006 [P] [US1] Server producer: in
      `src/server/durable-objects/index.ts`, extend the
      `app.get('/items/count')` handler (around line 966-967) to run
      one additional prepared aggregate
      `SELECT feed_id, COUNT(*) AS unread FROM items WHERE is_read = 0
      GROUP BY feed_id` after the existing combined COUNT query, build
      a `Record<string, number>` keyed by `String(feed_id)`, and
      include it as `perFeed` in the JSON response. The endpoint stays
      GET, no parameters, status codes unchanged. Producer guarantee
      from `contracts/counts-response.md`: ALWAYS emit `perFeed`
      (`{}` when no rows match) so older-server / newer-client mismatch
      cannot return `undefined`.

- [X] T007 [P] [US1] Local-first producer: in
      `src/client/db/local-adapter.ts`, extend `getCounts()` (around
      line 231-239) to run the same aggregate against the OPFS-backed
      SQLite via the existing `queryDb` helper, transform rows into
      `Record<string, number>`, and return `perFeed` alongside the
      existing `unread`/`starred`/`total`. ALWAYS include the key
      (`{}` when no rows match) for the same reason as T006.

- [X] T008 [US1] Remote adapter consumer: in
      `src/client/db/remote-adapter.ts`, confirm `getCounts()` passes
      through the new `perFeed` field from the HTTP response unchanged
      (the adapter just deserializes JSON; if its return type or any
      explicit field-by-field mapping is in place, update it to
      include `perFeed`). Verify against the test added in T003.
      Depends on T002 (type), T006 (server producer).

- [X] T009 [US1] Sidebar render: in
      `src/client/components/sidebar.ts`, modify the feeds-list
      section to render a leading numeric badge for each row, per the
      DOM contract in `contracts/sidebar-feed-counts.md`:
      - For the "All Feeds" pseudo-feed row (`href="/"`), render a
        `<span class="badge feed-unread-count">` whose text is
        `state.counts.value.unread`, before the feed-name link.
      - For each feed row in `state.feeds.value`, render the same
        `<span class="badge feed-unread-count">` whose text is
        `state.counts.value.perFeed[String(feed.id)] ?? 0`, before the
        feed-name link and before the delete control.
      Do NOT modify `SidebarItem` (the upper "All Items" / "Starred"
      section is out of scope per spec Assumptions). Keep all
      TypeScript ≤80 cols and follow the no-space-after-colon /
      ternary-break style from CLAUDE.md. Depends on T002, T005.

- [X] T010 [P] [US1] Sidebar count styling: in
      `src/client/components/sidebar.css` (or, if no per-component CSS
      file exists for the sidebar, the existing sidebar styles file),
      add a nested `.feed-unread-count` selector under the existing
      `.feeds-list .feed-item` selector. Position the badge to the
      left of the feed-name link. Use only colors already declared in
      `src/client/styles/_variables.css` (or the project's variables
      file — re-use an existing color variable rather than introducing
      a new one). Font-size MUST be ≥ `1rem` (CLAUDE.md). Do NOT
      modify any CSS unrelated to this feature (CLAUDE.md
      "NEVER change CSS that is not related to the task"). Independent
      file from T009.

**Checkpoint:** US1 is fully functional and independently testable.
Run `npm test && npm run lint` and walk through `quickstart.md` Tests
1–11 in a browser before claiming done (constitution Local
Verification rule, plan §Testing).

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose:** Final verification gates before merge.

- [X] T011 Run the manual browser quickstart in
      `specs/005-feed-unread-counts/quickstart.md` Tests 1–11 against
      a local `npm start` instance. This is the constitution's Local
      Verification gate ("UI changes MUST be exercised in a browser
      before being claimed complete"). Confirm Test 11 (local-first
      vs. fallback) passes both modes.

- [X] T012 Run `npm test && npm run lint` from the repo root and
      confirm both pass. Fix any new failures introduced by Phase 3.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. Single task (T002),
  the shared type extension. **Blocks ALL of Phase 3.**
- **User Story 1 (Phase 3)**: Depends on Phase 2. Internal task
  ordering below.
- **Polish (Phase 4)**: Depends on Phase 3 completion.

### Within User Story 1

- T003, T004 (tests) SHOULD be written first (TDD) and confirmed to
  fail before implementation.
- T005, T006, T007, T010 are mutually independent files and can run
  in parallel after T002.
- T008 (remote-adapter passthrough) depends on T002 (type) and T006
  (server producer behavior to verify against).
- T009 (sidebar render) depends on T002 (type) and T005 (initial
  signal value) so `state.counts.value.perFeed` is always defined.

### Parallel Opportunities

- Within Phase 3 after T002: `{T003, T004, T005, T006, T007, T010}`
  can all run in parallel (different files, no dependencies on each
  other).
- T008 must wait for T006.
- T009 must wait for T005 (and T002).

---

## Parallel Example: User Story 1

```bash
# After T002 completes, launch the independent file changes together:
Task: "Adapter shape test in test/db-adapter.ts"          # T003
Task: "Sidebar render test in test/sidebar-feed-counts.ts" # T004
Task: "perFeed:{} in initial counts signal in src/client/state.ts" # T005
Task: "DO /items/count perFeed aggregate, src/server/..."  # T006
Task: "localAdapter.getCounts perFeed aggregate, src/client/db/..." # T007
Task: "Sidebar count CSS in src/client/components/sidebar.css" # T010

# Then sequentially:
Task: "Remote adapter passthrough in src/client/db/remote-adapter.ts" # T008
Task: "Sidebar render in src/client/components/sidebar.ts"            # T009
```

---

## Implementation Strategy

### MVP-First (single-user-story feature)

This feature *is* its MVP — there is one P1 user story and no P2/P3.

1. Phase 1 (T001) — confirm green branch.
2. Phase 2 (T002) — extend the shared type.
3. Phase 3 (T003–T010) — producers + consumer + tests.
4. Phase 4 (T011, T012) — manual browser quickstart + automated gate.

### Incremental Delivery

Single increment. Ship the whole story together; per `quickstart.md`,
the visible behavior is "every sidebar feed row shows a numeric
unread count to the left of the name, and counts update reactively."

### Solo / Parallel Strategy

If working solo, follow the order: T001 → T002 → (T003, T004 first,
in either order) → (T005, T006, T007, T010 in any order) → T008 →
T009 → T011 → T012.

If working in parallel, after T002 dispatch T003/T004/T005/T006/T007/
T010 simultaneously, then converge on T008 and T009, then T011/T012.

---

## Notes

- This feature adds **no** new SQLite columns, **no** sync-protocol
  changes, **no** outbox entries, and **no** new HTTP endpoints. All
  reactivity is inherited from the existing `State.loadCounts` refresh
  point already wired into every mutation and post-sync settle (see
  research §Q6, data-model §"Refresh wiring").
- Producer-side guarantee: both `localAdapter.getCounts()` and the
  DO `/items/count` handler MUST always emit a `perFeed` object (use
  `{}` when no rows match) so the consumer never observes `undefined`
  during deploys when worker and SPA bundle versions don't match.
- Render-side guarantee: the sidebar uses `?? 0` so a feed missing
  from `perFeed` (zero unread, or added between `loadCounts`
  round-trips) renders the numeral `0` (FR-004).
- Constitution Local Verification (T011) is non-optional: type-check
  and unit tests do not catch UI placement/styling regressions.
- No CSS unrelated to this feature is to be modified (CLAUDE.md).
- No emojis in code or file names; no font-size below `1rem`; only
  colors from `_variables.css` (CLAUDE.md).
