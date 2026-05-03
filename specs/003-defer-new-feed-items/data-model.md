# Phase 1 Data Model: Defer New Feed Items Until Refresh

This document is short by design: no new tables, no new columns. The
only data-model adjustments are (a) widening the `/api/sync` payload
to include an existing column, and (b) formalizing how the cursor
maps to the visible reading list.

## Entities

### `feeds.last_pulled_at` (existing)

| Field | Type | Source |
|---|---|---|
| Column name | `last_pulled_at` | `src/shared/schema.ts:45` (TABLES_SQL) |
| SQL type | `TEXT` (ISO-8601 timestamp) or `NULL` | shared schema |
| Semantics | The pub_date of the most recent item the user has explicitly pulled into their reading view for this feed | server `advanceFeedCursor` |
| NULL meaning | This feed has never been refreshed by the user — none of its items are visible in the reading list | new (formalized by this feature) |
| Authoritative writer | server `advanceFeedCursor(feedId)` (called by `POST /feeds/refresh`, `POST /feeds/:id/refresh`, and the alarm-driven refresh) | `src/server/durable-objects/index.ts:520-528` |
| Replication | Server -> client via `/api/sync` feed payload (see contracts/api-sync.md). Client-side is read-only. | NEW in this feature |

Validation rules:

- Always set by the server; the client MUST NOT write it.
- Monotonically non-decreasing per feed (`advanceFeedCursor` assigns
  `MAX(items.pub_date)` and never moves it backwards).
- May be NULL only for feeds that have never been refreshed by the
  user since they were added.

State transitions for a single feed:

```text
[ added ]                      last_pulled_at = NULL
   |
   |  reader clicks "Refresh Feeds"
   v
[ at-cursor ]                  last_pulled_at = MAX(items.pub_date) at the time of refresh
   |
   |  background fetch / SSE adds newer items
   v
[ updates-available ]          last_pulled_at unchanged; some items have pub_date > last_pulled_at
   |
   |  reader clicks "Refresh Feeds"
   v
[ at-cursor ] (loops)
```

### `feeds` row (existing)

The full row is unchanged at the schema level. The only change for
this feature is that the row's `last_pulled_at` column is now part of
the `/api/sync` projection.

### `items` row (existing)

Unchanged. No new columns. No `pending` boolean. The cursor in
`feeds` is the authoritative source of "is this item visible".

## Derived rule: reading-list visibility

An item is **visible in the reading list** iff all of the following
hold:

1. `items.feed_id = feeds.id` (the obvious join).
2. `feeds.last_pulled_at IS NOT NULL`.
3. `items.pub_date IS NOT NULL`.
4. `items.pub_date <= feeds.last_pulled_at`.

Items that fail (2), (3), or (4) are **un-synced** and excluded from
the reading list. They still appear in:

- `getFeedsWithUpdates()` (server) — their feed is reported as
  having updates available.
- The per-feed pending list (`GET /feeds/:id/pending`) — unchanged.
- The per-feed sidebar unread count — unchanged (FR-009).

This rule applies symmetrically in both adapters (Principle IV).

### Why `pub_date IS NOT NULL` is required

Items without a `pub_date` cannot be ordered by the cursor. To avoid
making them permanently invisible (a worse failure mode than
visible-without-cursor-validation), they are admitted to the reading
list unconditionally. This matches the existing
`getFeedsWithUpdates()` predicate which also gates on
`pub_date IS NOT NULL`. Note: per the rule above, items with
`pub_date IS NULL` are technically excluded by the strict reading
of clause (3). For implementation, we treat them as visible by
including a `OR items.pub_date IS NULL` short-circuit in the WHERE
clause, with a comment explaining the rationale. This is the only
deviation from the strict cursor rule.

## Key Entities (cross-reference to spec)

| Spec entity | Maps to |
|---|---|
| Reading List | `items` filtered by the visibility rule above |
| Un-synced Counter | `state.feedUpdateCounts` signal in the client (sum of per-feed pending counts), which the server computes from items where `pub_date > last_pulled_at OR last_pulled_at IS NULL` |
| Sync Status Indicator | `state.feedSyncStatus` signal driven by the `feed-updates-available` and `refresh-complete` SSE events |
| Subscribed Feed | `feeds` row, replicated to the client immediately on add via the existing add-feed flow |
