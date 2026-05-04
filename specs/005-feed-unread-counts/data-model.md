# Data Model: Per-Feed Unread Counts In Sidebar

**Branch:** `005-feed-unread-counts`
**Spec:** `./spec.md`
**Date:** 2026-05-03

## Overview

This feature is read-only with respect to persistent state. **No
SQLite column is added, removed, or changed** on either side; the
DO schema, the local SQLite schema (`src/client/db/local-schema.ts`),
the `/api/sync` payload, `bootstrapLocalDb`, and `pullSync` upsert
logic all stay as they are.

The only model surfaces this feature touches are:

1. The wire shape of `CountsResponse` (an in-flight API contract).
2. The in-memory client state already maintained as
   `@preact/signals` (`state.counts`, `state.feeds`).

Per-feed unread counts are *derived at read time* from the existing
`items.is_read` and `items.feed_id` columns.

## Entities (in scope)

### Feed (existing — unchanged)

Defined in `src/shared/schema.ts:38-50` (server) and mirrored in
`src/client/db/local-schema.ts` (via the same shared SQL). For this
feature, the relevant attributes are:

- `id:integer` — primary key, used as the lookup key into the per-feed
  unread map.
- `title`, `url` — already rendered in the sidebar feed list; no
  change.

### Item (existing — unchanged)

Defined in `src/shared/schema.ts:52-72`. Relevant attributes for
this feature:

- `feed_id:integer` — grouping key for the per-feed aggregate.
- `is_read:integer (0|1)` — predicate. Counted when `is_read = 0`.

No state transitions are added. Existing transitions
(`is_read 0 → 1` via `toggleItemRead`, `1 → 0` likewise; bulk
`is_read 0 → 1` via `markAllRead`) already trigger
`State.loadCounts(state)`, which is the refresh point that keeps
`counts.perFeed` agreeing with the database.

### CountsResponse (extended on the wire)

```ts
// Before (src/client/db/types.ts:48-52)
interface CountsResponse {
    unread:number   // count of items where is_read = 0
    starred:number  // count of items where is_starred = 1
    total:number    // count of items overall
}

// After
interface CountsResponse {
    unread:number
    starred:number
    total:number
    perFeed:Record<string, number>
}
```

`perFeed` semantics:

- Keys are stringified `feeds.id` values (JSON forces strings; we
  match that on the TypeScript side).
- Values are non-negative integers — the count of items in that
  feed where `is_read = 0`.
- Feeds with zero unread items are **omitted** from the map.
  Renderers MUST treat a missing key as `0`.
- `Object.values(perFeed).reduce((a, b) => a + b, 0) === unread` is
  an invariant guaranteed by the producer (same predicate
  `is_read = 0` runs the global and the per-feed aggregate).

## Producers

The two producers run the same logical query against their
respective storage:

```sql
SELECT feed_id, COUNT(*) AS unread
  FROM items
 WHERE is_read = 0
 GROUP BY feed_id
```

| Producer | File | Surface |
|---|---|---|
| Server (DO) | `src/server/durable-objects/index.ts` `app.get('/items/count')` (line 966) | Reachable to clients via `GET /api/items/count` (the user's DO is selected by the worker). |
| Local-first | `src/client/db/local-adapter.ts` `getCounts()` (line 231) | Reachable via `getAdapter(did)` when the local-first capability gate is open. |

Both transform the rows into a `Record<string, number>` keyed by the
stringified `feed_id`.

## Consumers

### `state.counts:Signal<CountsResponse>` (existing — value-shape extended)

Defined in `src/client/state.ts:248-250`. Initial value updated to:

```ts
counts: signal<CountsResponse>({
    unread: 0, starred: 0, total: 0, perFeed: {}
})
```

Populated by `State.loadCounts(state)`
(`src/client/state.ts:1318-1330`), which calls `adapter.getCounts()`
on either adapter and writes the full response into the signal.

### Sidebar feed list (new consumer)

`src/client/components/sidebar.ts` reads `state.counts.value.perFeed`
when rendering each feed row, and `state.counts.value.unread` when
rendering the "All Feeds" row. The sidebar is the only consumer.

### Derived display values

| derived value | expression |
|---|---|
| Per-feed badge | `state.counts.value.perFeed[String(feed.id)] ?? 0` |
| "All Feeds" sum badge | `state.counts.value.unread` |

These are computed inline in JSX. A `useComputed` is not required:
the component subscribes to `state.counts` via signal access during
render.

## Refresh wiring (existing — unchanged)

The points at which `state.counts.value.perFeed` is refreshed are
exactly the points at which the existing `unread`/`total`/`starred`
fields are refreshed. No new call sites are introduced.

| Trigger | Refresh path | FR backed |
|---|---|---|
| User marks an item read/unread | `State.toggleItemRead` → `loadCounts` | FR-005 |
| User marks all read | `State.markAllRead` → `loadCounts` | FR-005 |
| User toggles starred | `State.toggleItemStarred` → `loadCounts` | (incidental — does not affect counts.unread) |
| Background sync settles | `State.refreshAfterSync` → `loadCounts` | FR-006 |
| User adds a feed | `State.addFeed` → `loadCounts` | FR-007 |
| User deletes a feed | `State.deleteFeed` → `loadCounts` | FR-007 |

## Invariants

1. **Sum-equals-unread (FR-008):** For any settled `state.counts`
   value, `Object.values(perFeed).reduce((a,b)=>a+b, 0) === unread`.
   Producers enforce this by using the same predicate.
2. **Filter independence (FR-009):** `state.counts.value.perFeed` is
   not a function of `state.showUnreadOnly`. Toggling the filter
   does not call `loadCounts` and does not mutate `counts`.
3. **Zero is rendered (FR-004):** A feed whose key is absent from
   `perFeed` (because the producer omitted zeros) renders the
   numeral `0` thanks to the `?? 0` fallback in the consumer.
4. **Settled-state agreement (FR-010 / SC-002):** When
   `state.feedsLoading.value === false` and no in-flight mutation,
   the rendered per-feed badge for feed `F` equals the count of
   items in `F` where `is_read = 0` in the active adapter's storage.
   This holds because (a) producers run the predicate atomically
   inside the same query as `unread`/`total`/`starred`, and (b)
   `loadCounts` is the single refresh point paired with every write.

## Out of scope (explicit non-changes)

- DO SQLite schema / `src/shared/schema.ts`.
- Local SQLite schema / `src/client/db/local-schema.ts`.
- `/api/sync` payload shape / `src/client/db/pull-sync.ts`.
- `bootstrapLocalDb` (initial pull-down).
- `pullSync` upsert logic.
- Outbox shape / push-sync flow.
- The "All Items" and "Starred" rows in the upper sidebar section
  (these continue to render via `SidebarItem` and remain the only
  consumers of `counts.total` / `counts.starred`).
- The per-feed reading list page (`/feed/<feed>`); its layout and
  data path are unchanged.
- Any visual styling beyond placing the count to the left of the
  feed name; spec Assumptions explicitly leave font/color/badge-vs-
  plain-number to implementation.
