# Phase 0 Research: Defer New Feed Items Until Refresh

This document resolves the technical unknowns surfaced by the spec
and the Constitution Check before design begins. All findings refer
to code in `src/` at branch `003-defer-new-feed-items`.

## R1: Where the reading-list and counter signals live, and what drives them today

**Decision:** The reading list is driven by `state.items` (set in
`State.loadItems()` at `src/client/state.ts`). The un-synced counter
is driven by `state.feedUpdateCounts` (per-feed pending count) and
the status pill is driven by `state.feedSyncStatus`. Both are updated
by the SSE handler for `feed-updates-available` and cleared by the
SSE handler for `refresh-complete`. The server publishes these events
after `fetchFeed` inserts new items and after a manual refresh
advances the cursor.

**Rationale:** The spec's "un-synced posts counter" and "sync status
indicator" map directly onto `feedUpdateCounts` /
`getFeedsWithUpdates()` and `feedSyncStatus`. We do not need a new
mechanism — we extend the read-side filter so the existing cursor
(`feeds.last_pulled_at`) gates visibility.

**Alternatives considered:**

- *Introduce a new `pending_items` table / boolean column on `items`.*
  Rejected: it duplicates information already captured by
  `last_pulled_at`, doubles the maintenance surface, and breaks the
  Principle II preference for value-assignment idempotency in favor
  of bespoke state.
- *Hold the deferred set purely in a client signal.* Rejected: it
  violates Principle I (local-first reads) because the deferred state
  would not survive reload offline, and any reload would silently
  promote the deferred items into the reading list.

## R2: `last_pulled_at` is the right server-side primitive

**Decision:** The semantic "items already pulled into the reader's
view for this feed" is precisely what `feeds.last_pulled_at` records
today on the server. `advanceFeedCursor(feedId)` sets it to
`MAX(items.pub_date)` for that feed, which the manual
`POST /feeds/refresh` and `POST /feeds/:id/refresh` already call.
The unmanaged path — the post-add background `fetchFeed` — does NOT
call `advanceFeedCursor`. That is the correct existing behavior for
this feature: a newly added feed has `last_pulled_at IS NULL` until
the reader clicks Refresh.

**Rationale:** Reusing this primitive means no new persistence, no
new mutation, no new SSE event, and no new sync surface beyond
adding the column to the existing payload. Principle II is honored
trivially because no new mutation is introduced.

**Alternatives considered:**

- *Add a `pending` boolean per item, advanced atomically on refresh.*
  Rejected: it costs a new column, an UPDATE-many on every refresh,
  and is strictly redundant with the cursor.

## R3: `last_pulled_at` must be replicated to the local SQLite

**Decision:** `last_pulled_at` is present in `TABLES_SQL`
(`src/shared/schema.ts:45`) and therefore in both server and client
SQLite. However, it is NOT in `FEED_SYNC_COLUMNS`
(`src/server/durable-objects/index.ts:104-107`) and the client's
`pull-sync.ts:upsertFeed` does not write the column. As a result, the
client's local SQLite always reads `last_pulled_at` as NULL, so a
local-first reader cannot evaluate the cursor filter.

This is a **schema/sync coupling violation** (constitution
"Schema and sync changes are coupled"). The fix is required and must
land in the same change set:

1. Add `last_pulled_at` to `FEED_SYNC_COLUMNS` (server).
2. Update client `pull-sync.ts:upsertFeed` to write `last_pulled_at`
   in both INSERT and `ON CONFLICT(id) DO UPDATE SET` lists.
3. `bootstrap.ts` uses the same `upsertFeed`, so it transitively gets
   the column once (1) and (2) land.

**Rationale:** Without this replication, the local-first read path
would be silently broken (Principle I), forcing a fallback to the
network or a divergent UI between local-first and remote-fallback
modes (Principle IV).

**Alternatives considered:**

- *Compute `last_pulled_at` client-side from the highest pub_date
  observed at last refresh.* Rejected: every divergence from the
  server-authoritative cursor is a future bug; the server already
  publishes the canonical value.

## R4: Migration / rollout for existing client SQLite databases

**Decision:** The server's existing migration that ALTERs the
`feeds` table to add `last_pulled_at`
(`src/server/durable-objects/index.ts:467-477`) populates the column
for pre-existing rows but does NOT bump `updated_at`. Existing
clients have already pulled those feed rows; without an `updated_at`
bump, the next `pullSync(since=lastSyncTime)` will not re-fetch them,
so the new `last_pulled_at` value never reaches the local DB for
already-synced feeds.

The chosen rollout is to add a one-time, idempotent server-side
migration step (gated on a `migration_version` storage key) that
issues a single `UPDATE feeds SET updated_at = datetime('now')` to
force every feed row to be re-emitted to the client on the next pull.
This is a **read-only-effect bump** for the client (the row is
upserted with values that match what the client already has, plus
the newly-included `last_pulled_at`), and it is idempotent because
the migration_version key prevents repeating it.

This step is grouped with the `FEED_SYNC_COLUMNS` change and
documented in `contracts/api-sync.md`.

**Rationale:** Without it, the feature would only behave correctly
for users who clear OPFS or whose feed rows happen to be touched
post-deploy. The bump is a one-line UPDATE behind a versioned guard.

**Alternatives considered:**

- *Force a full re-bootstrap on the client.* Rejected: it discards
  unrelated local state (full-content cache, image cache) and is far
  more invasive than necessary.
- *Sniff "feed has items but no last_pulled_at" client-side and
  trigger a `since=null` resync.* Rejected: this is precisely the
  intended state for a freshly-added feed (the heuristic would
  destroy the feature it is meant to enable).

## R5: Items with NULL `pub_date` (edge case)

**Decision:** Items with `pub_date IS NULL` are treated as **visible
in the reading list** (i.e., not filtered out by the cursor). The
server's `getFeedsWithUpdates()` already excludes such items from
the un-synced indicator (`pub_date IS NOT NULL` in the WHERE clause
at `src/server/durable-objects/index.ts:484-489`). For symmetry, the
reading-list filter MUST also use `items.pub_date IS NOT NULL` and
NOT additionally filter out null-`pub_date` rows. In practice these
items are rare (they imply a feed without item-level dates), but
hiding them indefinitely from the reading list would produce the
"invisible unread items" failure mode that is far worse than a minor
ordering anomaly.

**Rationale:** The cursor is a date — it cannot meaningfully gate
items without a date. Failing open (showing them) preserves the
"items always reach the user eventually" property.

**Alternatives considered:**

- *Treat NULL `pub_date` as "newer than any cursor".* Rejected: a
  NULL pub_date item would then be permanently un-syncable, which is
  worse than the alternative.

## R6: Counter / sync-status behavior is already correct for new feeds

**Decision:** No change required to the SSE producer or to
`feedUpdateCounts` / `feedSyncStatus` consumers. When a feed is
added, the server's background `fetchFeed` inserts items and emits
`feed-updates-available` with the affected feed IDs
(`src/server/durable-objects/index.ts:1441-1443`). The client's SSE
handler already increments per-feed pending counts and flips the
status pill to `'updates'`. This satisfies FR-003 and FR-006 without
client changes; the spec's assumption that the existing un-synced
mechanism extends to add-feed is correct **today**, modulo the
reading-list visibility bug (which is what this feature fixes).

**Verification:** During Phase 1, exercise the manual flow in the
quickstart and confirm the dot count increments by exactly N (number
of items the new feed contributes) and the pill shows "updates
available" within ~1s of add (SC-002).

**Rationale:** This finding is what keeps the feature small.

## R7: `state.ts` add-feed handler should stop forcing `loadItems()`

**Decision:** `State.addFeed()` currently calls
`State.loadItems(state)` after the add succeeds
(`src/client/state.ts:1163-1166`, per the explore map). With the new
filter in place, `loadItems()` would correctly return zero new items
for the just-added feed, so leaving the call in would be functionally
correct but wastefully round-trips the items list. We remove the
`loadItems()` call from the add-feed success branch and keep
`loadFeeds()` (sidebar update) and `loadCounts()` (per-feed sidebar
counts).

The SSE-driven counter update remains the path that reflects the new
feed's pending posts; no new client-side fetch is needed.

**Rationale:** Less work, less flicker. The visible state delta after
add is purely: sidebar gains a new entry, dot count increments via
SSE, pill flips to "updates available" via SSE. The reading list is
unchanged.

**Alternatives considered:**

- *Leave `loadItems()` in place and rely on the filter to elide the
  new items.* Rejected: it preserves a network round-trip for no UX
  benefit and may briefly re-render the reading list.

## R8: Items endpoint filter shape

**Decision:** Apply the filter inside the existing
`JOIN feeds ON items.feed_id = feeds.id` clause already present in
`GET /items` (`src/server/durable-objects/index.ts:842`):

```sql
AND feeds.last_pulled_at IS NOT NULL
AND items.pub_date IS NOT NULL
AND items.pub_date <= feeds.last_pulled_at
```

The same predicate is added to the `count(*)` query for the same
endpoint (lines 868-...), so totals stay consistent with the page.
Mirror the same filter inside `localAdapter.getItems()` against the
local SQLite (which now has `last_pulled_at` populated by R3/R4).

**Rationale:** This is the single inequality the cursor was designed
for, applied at exactly one place per adapter.

**Alternatives considered:**

- *Filter in JS after a wide SELECT.* Rejected: it discards SQL's
  ability to bound the page size correctly with `LIMIT/OFFSET`.

## Summary of changes derived from research

| Surface | Change | Source |
|---|---|---|
| `src/shared/schema.ts` | _no change_ — column already present | R3 |
| `src/server/durable-objects/index.ts` `FEED_SYNC_COLUMNS` | add `last_pulled_at` | R3, R8 |
| `src/server/durable-objects/index.ts` `GET /items` | apply cursor filter (items + count) | R8 |
| `src/server/durable-objects/index.ts` migrations | one-time `UPDATE feeds SET updated_at = datetime('now')` behind a `migration_version` guard | R4 |
| `src/client/db/pull-sync.ts` `upsertFeed` | write `last_pulled_at` (insert + on-conflict) | R3 |
| `src/client/db/local-adapter.ts` `getItems` | apply cursor filter via `JOIN feeds` | R8 |
| `src/client/state.ts` add-feed success branch | drop `loadItems()`, keep `loadFeeds()` + `loadCounts()` | R7 |
| `src/client/db/remote-adapter.ts` | _no change_ — server applies the filter | R8 |
| Counter / status pill components | _no change_ — driven by existing SSE | R6 |
