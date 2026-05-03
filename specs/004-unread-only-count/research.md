# Research: Sync "All Items" Count With Unread-Only Filter

**Branch:** `004-unread-only-count`
**Spec:** `./spec.md`
**Date:** 2026-05-02

## Open questions resolved

### Q1. What is the badge currently bound to, and what is missing?

**Decision:** The "All Items" badge in `src/client/components/sidebar-item.ts:39`
already reads from a signal that contains both `unread` and `total` —
`state.counts:Signal<CountsResponse>` shaped `{ unread, starred, total }`
(`src/client/db/types.ts:48-52`, `src/client/state.ts:248-249`). The bug
is purely in the render: the badge unconditionally shows
`counts.value.unread` regardless of `state.showUnreadOnly`. Both adapters
already populate `total`:

- Local: `src/client/db/local-adapter.ts:219-239` — `SELECT COUNT(*) ...
  FROM items` returns `total` alongside `unread` and `starred`.
- Remote: `src/client/db/remote-adapter.ts:129-132` — `GET items/count`
  returns `CountsResponse`; the server side is unchanged by this work.

**Rationale:** The smallest correct fix is the one that doesn't touch
the data layer. `total` is already on the wire, already in the signal,
and already refreshed after every mutation that changes it.

**Alternatives considered:**

- *Add a filter argument to `DbAdapter.getCounts(opts)`.* Rejected.
  Would change the adapter contract and the `/api/items/count`
  server route for no benefit — the values needed are already
  returned. Adds work to both adapters and a server route for a
  pure-render bug.
- *Derive the badge value from `state.items.value.length`.* Rejected.
  The reading list is paged (`src/client/state.ts:537-539`), so
  `items.value` only contains the current page; using its length
  would understate the total in any list that exceeds `pageSize`. The
  spec is explicit (SC-002) that the badge equals "the number of
  items currently rendered in the reading list **(across pages)**."
- *Compute unread on the client by counting `is_read===0` in
  `state.items`.* Rejected for the same paging reason.

### Q2. What value should the badge show under each filter state?

**Decision:** Drive the badge from `(showUnreadOnly, starred)`:

| sidebar entry | `showUnreadOnly` off | `showUnreadOnly` on |
|---|---|---|
| All Items | `counts.total` | `counts.unread` |
| Starred | `counts.starred` | `counts.starred` (unchanged) |

**Rationale:** Matches FR-002, FR-003, FR-006 directly. The Starred
badge stays anchored to `counts.starred` because the unread-only
control does not gate the starred reading list (spec Assumptions, and
the per-feed starred filter is owned by `showStarredOnly`, a separate
signal — `src/client/state.ts:252`).

**Alternatives considered:**

- *Have the Starred badge also collapse to "unread-and-starred" when
  unread-only is on.* Rejected: out of scope per spec FR-006 and
  Assumptions, and there is no `unreadStarred` field in
  `CountsResponse` to back it.

### Q3. How does the badge stay in sync after mutations?

**Decision:** No new sync wiring. `State.loadCounts(state)` is already
called after every mutation that changes the counts:

- `toggleItemRead` → `state.ts:1356`
- `toggleItemStarred` → `state.ts:1395`
- `markAllRead` → `state.ts:1414`
- post-pull-sync refresh → `state.ts:509`
- post-route-item read flip → handled via `toggleItemRead` (state.ts:289-294, 320-325)

Because the badge reads from `state.counts` (already-updated) and from
`state.showUnreadOnly` (a signal whose toggle in `feed-reader.ts:177`
already triggers re-render via Preact signal subscription), no extra
effect or `loadCounts` call is needed when the user toggles
"Unread only." `total` and `unread` in `counts` are stable across that
toggle — only the *selection* of which one to show changes.

**Rationale:** Constitution Principle II (idempotent, outbox-backed
sync) — the current write path is already correct. Adding a
`loadCounts` call on every filter toggle would be redundant and
introduce a network/IO call per click for no new information.

### Q4. Behavior on per-feed routes (`/feed/<feed>`)?

**Decision:** Unchanged. `counts` is global (the SQL queries do not
filter by feed). The "All Items" sidebar entry semantics stay global,
which the spec edge-case explicitly endorses ("its badge still
represents the global reading list (all feeds), not the currently
visible feed"). No per-feed counts are introduced.

### Q5. Scope of test coverage

**Decision:** Add a UI-level test that exercises the
`SidebarItem` render path under both `showUnreadOnly` states, asserting
the badge text. Existing adapter tests in `test/db-adapter.ts` already
cover `getCounts()` returning the correct `{ unread, starred, total }`
shape; we do not need to extend them, since the adapter contract is
unchanged.

**Alternatives considered:**

- *Browser/playwright integration test.* Helpful but optional — a
  Preact unit render is cheaper to maintain and isolates the
  observable rule (`badge text == counts.unread or counts.total
  depending on showUnreadOnly`) without standing up the full app.
  We will additionally do the constitution-required browser
  verification by hand against `npm start` before claiming the
  feature done.

## Constitution touch-points

- **I. Local-First Reads:** No new reads. Both adapters already
  return `total`; `loadCounts()` already routes through `getAdapter()`
  → `localAdapter`/`remoteAdapter` per the standard fallback rules.
- **II. Idempotent, Outbox-Backed Sync:** No new mutations, no
  schema, no new outbox entries.
- **III. Edge-Native Topology:** No DO change.
- **IV. Capability-Gated Progressive Enhancement:** Render-only fix
  works identically under either adapter.
- **V. Bluesky-Anchored Identity:** Untouched.

No principle conflicts; Complexity Tracking will be empty.

## Output

All NEEDS CLARIFICATION items resolved. Phase 1 (data-model,
contracts, quickstart) follows.
