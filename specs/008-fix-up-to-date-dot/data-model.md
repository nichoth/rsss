# Phase 1 Data Model: Fix Up-to-Date Dot Indicator

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This feature does **not** introduce or modify any persistent columns.
It re-uses existing entities and exposes one derived view through a
new endpoint and an enriched SSE payload. The data-model entry below
documents only the entities and invariants the indicator depends on.

## Entities

### Feed (existing - DO SQLite, table `feeds`)

Per-user RSS/Atom subscription. The columns relevant to this feature:

| Column            | Type    | Source of truth | Used for                |
| ----------------- | ------- | --------------- | ----------------------- |
| `id`              | INTEGER | Server          | Identity in payload     |
| `last_pulled_at`  | TEXT    | Server          | Pulled-state marker     |

**Invariants**

- `last_pulled_at` is monotonic per feed; it is advanced only by
  `advanceFeedCursor()` after a feed-level pull and only to the
  maximum `items.pub_date` among that feed's items.
- A `last_pulled_at` of `NULL` means the reader has never pulled this
  feed (newly subscribed). Per FR-011, every item the server has for
  such a feed counts as pending.

### Item (existing - DO SQLite, table `items`)

Per-feed entry. The columns relevant to this feature:

| Column        | Type    | Source of truth | Used for                  |
| ------------- | ------- | --------------- | ------------------------- |
| `id`          | INTEGER | Server          | Identity                  |
| `feed_id`     | INTEGER | Server          | Group key for counts      |
| `pub_date`    | TEXT    | Feed source     | Comparison vs `last_pulled_at` |

**Invariants**

- `pub_date` is the parsed publication timestamp from the feed; rows
  with `pub_date IS NULL` are ignored by the indicator (matching the
  existing `getFeedUpdateCounts()` query, which has `items.pub_date IS
  NOT NULL` in its `LEFT JOIN`).
- A pending item is exactly one whose `pub_date > feeds.last_pulled_at`
  (or where `feeds.last_pulled_at IS NULL`).

## Derived view: pending counts

Computed on demand by the existing `UserDO.getFeedUpdateCounts()`:

```sql
SELECT
    feeds.id AS id,
    COUNT(items.id) AS pending_count
FROM feeds
LEFT JOIN items
    ON items.feed_id = feeds.id
    AND items.pub_date IS NOT NULL
    AND (
        feeds.last_pulled_at IS NULL
        OR items.pub_date > feeds.last_pulled_at
    )
GROUP BY feeds.id
```

The result shape, after stringification of `feeds.id`, is the
`feedUpdateCounts` map carried in both the new `GET /feed-status`
response and the enriched `feed-updates-available` SSE event.

## Client-side state (existing signals; no shape change)

| Signal                   | Type                    | Owner now            | Owner after change    |
| ------------------------ | ----------------------- | -------------------- | --------------------- |
| `state.feedUpdateCounts` | `Record<feedId,number>` | `loadFeeds()` + SSE  | `loadFeedStatus()` + SSE |
| `state.feedSyncStatus`   | union (see below)       | `loadFeeds()` + SSE  | `loadFeedStatus()` + SSE + refresh |
| `state.feedSyncError`    | `string \| null`        | `refreshFeeds()`     | `refreshFeeds()` + `loadFeedStatus()` |

`feedSyncStatus` enum (unchanged):
`'inactive' | 'updates' | 'syncing' | 'error' | 'synced'`.

**State transitions added by this feature**

- After a successful `loadFeedStatus()`:
  - if `totalPending > 0` -> `feedSyncStatus = 'updates'`
  - else -> `feedSyncStatus = 'synced'`
- After a failed `loadFeedStatus()`:
  - `feedSyncStatus = 'error'`, `feedSyncError = <message>` (FR-012)
- On `feed-updates-available` SSE event with payload counts:
  - `feedUpdateCounts` is merged with the per-feed counts in the
    payload (overwrite, not increment), then `feedSyncStatus` is
    derived from the resulting total.
- On EventSource reconnect (`open` after a previous `error`):
  - call `loadFeedStatus()` to reconcile (FR-007).

## Out of scope (explicit non-changes)

- DO SQLite schema (no `ALTER TABLE`).
- Local SQLite schema in `local-schema.ts` (no new columns).
- `bootstrapLocalDb`, `pullSync`, `pushSync`, `outbox` -
  Principle II's "schema and sync are coupled" gate is not triggered
  because we are not changing any column the client renders.
- Per-feed sidebar counts: continue to read from
  `state.feedUpdateCounts`, which improves transparently.
