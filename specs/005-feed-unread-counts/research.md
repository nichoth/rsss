# Research: Per-Feed Unread Counts In Sidebar

**Branch:** `005-feed-unread-counts`
**Spec:** `./spec.md`
**Date:** 2026-05-03

## Open questions resolved

### Q1. Where does the per-feed unread number live in the data flow?

**Decision:** Extend the existing `CountsResponse` (shared by
`localAdapter` and `remoteAdapter`) with a new field
`perFeed:Record<string, number>`, mapping a feed's id (string-coerced
because JS object keys are strings on the wire) to that feed's unread
count. `state.counts.value.perFeed[String(feed.id)]` becomes the
single source of truth read by the sidebar.

**Rationale:** `State.loadCounts(state)` already runs after every
mutation that can change unread state — `toggleItemRead`
(`src/client/state.ts:1362`), `toggleItemStarred` (1401),
`markAllRead` (1420), `addFeed` (1172), `deleteFeed` (1203) — and
after every sync settle through `State.refreshAfterSync`
(`src/client/state.ts:509`), which is itself fired from the SSE
`feed-updated` event (576-580). Putting the per-feed map inside
`counts` piggybacks on this already-correct refresh wiring; FR-005,
FR-006, and FR-007 reactivity become free.

**Alternatives considered:**

- *Put `perFeed` in `FeedsResponse` (returned by `getFeeds`).*
  Rejected. `loadFeeds` is *not* called after a mark-read/unread
  toggle, so the number would go stale after every read. We'd have
  to add `loadFeeds` calls everywhere `loadCounts` is — duplicating
  the existing pattern instead of using it.
- *Add a new state field `state.feedUnreadCounts:Signal<Record<string, number>>`
  and a new `State.loadFeedUnreadCounts` that runs alongside
  `loadCounts`.* Rejected. Doubles the round-trip count for every
  mutation refresh and adds a second timing window where the two
  signals can disagree (a render between the two completions would
  show a per-feed count that doesn't sum to `counts.unread`).
- *Compute per-feed counts client-side from `state.items.value`.*
  Rejected. The reading list is paginated
  (`src/client/state.ts:537-539`), so `state.items.value` only
  contains the current page; counting it would understate the per-feed
  total for any feed that exceeds `pageSize`.

### Q2. What does "unread for this feed" actually mean?

**Decision:** `COUNT(*) WHERE is_read = 0` grouped by `feed_id`.
**No** filtering by `feeds.last_pulled_at`.

**Rationale:** FR-003 says the count "MUST equal the number of
articles in that feed that are currently in the unread state." That
is exactly `is_read = 0`. The existing global `unread` field on
`CountsResponse` uses the same predicate
(`src/server/durable-objects/index.ts:967` and
`src/client/db/local-adapter.ts:239`). Using the same predicate
guarantees the invariant `SUM(perFeed) === counts.unread`, which
backs FR-008's "All Feeds" sum without extra wiring.

This also means feature 003's `last_pulled_at` reading-list cursor
does NOT gate the sidebar count. That is intentional: the spec's
edge case "A feed that has not yet completed its first sync shows
`0` until articles are fetched" is satisfied because a freshly added
feed has zero items in the local DB, so its unread count is 0.

**Alternatives considered:**

- *Gate by `last_pulled_at` (mirror the reading-list cursor).*
  Rejected. The reading list defers items until the user clicks
  Refresh (feature 003), but the sidebar count is not a reading-list
  view — it is an inventory of unread articles attributable to a
  feed, and FR-008's "sum equals `counts.unread`" invariant requires
  the same predicate the global counter uses.

### Q3. Should `perFeed` include feeds with zero unread items?

**Decision:** Omit zeros from the wire payload; the renderer falls
back to `0` when the key is absent.

**Rationale:** FR-004 still requires a feed with zero unread to
display `0` (not blank) — that requirement is satisfied at render
time by `counts.value.perFeed[String(feed.id)] ?? 0`. Omitting zero
keys keeps the payload compact for users with many feeds and avoids
forcing `localAdapter` to LEFT JOIN against `feeds` just to emit
zero rows. The aggregate `SELECT feed_id, COUNT(*) FROM items WHERE
is_read = 0 GROUP BY feed_id` naturally excludes feeds with no items
and feeds with zero unread items, both of which the renderer maps to
`0`.

**Alternatives considered:**

- *Server emits zero rows for every subscribed feed.* Rejected.
  Larger payload, requires joining `feeds` server-side, and the
  renderer needs the fallback anyway (the sidebar may render a feed
  before `loadCounts` settles, and the row's count for a brand-new
  feed will lag the next `loadCounts` round-trip).

### Q4. How should the "All Feeds" pseudo-feed get its count?

**Decision:** Reuse the existing `state.counts.value.unread`. By
construction `SUM(perFeed) === counts.unread`.

**Rationale:** The spec (FR-008) requires "All Feeds" to display the
sum across feeds. Computing the sum client-side from `perFeed` would
produce the same number with extra arithmetic. Using the
already-resident `unread` is one fewer derived value and is
guaranteed to agree with the per-feed numbers as long as the
predicate stays `is_read = 0` (Q2).

**Alternatives considered:**

- *Compute `Object.values(perFeed).reduce(...)` in render.* Rejected.
  Redundant — the same number is already on the wire as
  `counts.unread`.

### Q5. Does the count need to be independent of the "Unread only" filter?

**Decision:** Yes — and naturally is, since `state.counts.value.perFeed`
and `state.counts.value.unread` are populated by `getCounts()`, which
does not consult `state.showUnreadOnly`. Toggling the filter mutates
only the reading-list view (`buildItemOptions` in
`src/client/state.ts:544-546`), not `counts`.

**Rationale:** FR-009 explicitly mandates this. The architecture
already separates the filter from the counts adapter call, so there
is no extra work to do — just *do not* introduce a conditional that
ties `counts.perFeed` to `showUnreadOnly`.

### Q6. Where do `loadCounts` callers fire today?

**Decision:** Already correct. After-mutation refresh and post-sync
refresh both call `loadCounts`:

- `toggleItemRead` → `state.ts:1362`
- `toggleItemStarred` → `state.ts:1401`
- `markAllRead` → `state.ts:1420`
- `addFeed` → `state.ts:1172`
- `deleteFeed` → `state.ts:1203`
- post-pull-sync refresh → `state.ts:509` (called from
  `State.refreshAfterSync`, which the `feed-updated` SSE handler
  invokes through `scheduleRefresh()`).

This satisfies FR-005 (read/unread mutations), FR-006 (background
sync), and FR-007 (add/delete) without new wiring.

**Rationale:** Constitution Principle II — the existing write/refresh
discipline is already correct. Adding redundant `loadCounts` calls
would violate the principle that each mutation has a single
canonical refresh point.

### Q7. Will the per-feed aggregate be expensive?

**Decision:** No. The query is

```sql
SELECT feed_id, COUNT(*) AS unread
  FROM items
 WHERE is_read = 0
 GROUP BY feed_id
```

Both `idx_items_is_read` and `idx_items_feed_id` exist
(`src/shared/schema.ts:77-78`). On the DO it runs in the same SQLite
process as the existing `/items/count` round-trip (one extra prepared
exec, no extra network hop). On the local-first client, the same
query runs against OPFS-backed SQLite via the existing `queryDb`
helper. Per-user item counts are at most low-thousands in v1; the
aggregate is microseconds.

**Rationale:** Constitution Performance Goals — render-only changes
are preferred but a single GROUP BY against existing indexes does
not change the perf envelope.

### Q8. Test surface

**Decision:**

1. **Sidebar render unit test** (`test/sidebar-feed-counts.ts`):
   stub `state.counts.value.perFeed` and `state.feeds.value`, render
   the `Sidebar` (or a small wrapper that exercises the same
   per-feed branch), and assert that:
   - every feed row shows a leading numeric badge containing the
     expected per-feed value (FR-001, FR-002, FR-003),
   - a feed missing from `perFeed` renders `0` (FR-004),
   - the "All Feeds" row shows `counts.unread` (FR-008), and
   - toggling `state.showUnreadOnly` does not change any sidebar
     value (FR-009).

2. **Adapter shape test** (extend `test/db-adapter.ts`): assert that
   `getCounts()` returns `perFeed:Record<string, number>` on both
   `localAdapter` and `remoteAdapter`, with the expected
   `is_read = 0` semantics (e.g. seed items, mark some read, expect
   `perFeed[feedId]` to drop accordingly).

3. **Manual browser verification** per `./quickstart.md`. Required
   by the constitution's Local Verification rule and covers the
   reactive paths (mutation, sync settle) end-to-end.

**Alternatives considered:**

- *Playwright test instead of Preact unit test.* Helpful but heavier.
  Existing project pattern (e.g. `test/sidebar-item.ts`) is to use
  Preact + `@substrate-system/tapzero` to mount with stubbed state;
  we follow that.

## Constitution touch-points

- **I. Local-First Reads:** New aggregate added to `getCounts()` on
  both adapters in lockstep; render path is adapter-agnostic. No
  online-only fallback for happy-path reads is introduced.
- **II. Idempotent, Outbox-Backed Sync:** No mutations, no outbox,
  no `/api/sync` payload change, no `pullSync` change.
- **III. Edge-Native Topology:** One extra prepared statement in an
  existing DO route; no new alarm, queue, or cross-user state.
- **IV. Capability-Gated Progressive Enhancement:** Both adapters
  carry the same shape; the feature works under fallback.
- **V. Bluesky-Anchored Identity:** Untouched.

No principle conflicts; Complexity Tracking will remain empty.

## Output

All NEEDS CLARIFICATION items resolved. Phase 1 (data-model,
contracts, quickstart) follows.
