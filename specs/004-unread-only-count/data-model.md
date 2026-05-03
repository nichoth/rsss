# Data Model: Sync "All Items" Count With Unread-Only Filter

**Branch:** `004-unread-only-count`
**Spec:** `./spec.md`
**Date:** 2026-05-02

## Overview

This feature is render-only. **No persistent data is added, removed,
or changed.** The DO SQLite schema, the `/api/sync` payload,
`bootstrapLocalDb`, the local SQLite schema, and `pullSync` upsert
logic all remain unchanged.

The only "model" surface this feature touches is the in-memory
client state already maintained as `@preact/signals`.

## Client state in scope

### `state.counts:Signal<CountsResponse>`

Defined in `src/client/state.ts:248-249`. Shape from
`src/client/db/types.ts:48-52`:

```ts
interface CountsResponse {
    unread:number   // count of items where is_read = 0
    starred:number  // count of items where is_starred = 1
    total:number    // count of items overall
}
```

- **All three fields are global** (across all feeds the user is
  subscribed to). They are not per-feed and not per-route.
- Populated by `State.loadCounts(state)` (`src/client/state.ts:1312-1324`),
  which calls `adapter.getCounts()` on either `localAdapter` or
  `remoteAdapter`.
- Refreshed after every mutation that can change a count: read/unread
  toggle, star/unstar toggle, mark-all-read, and post-pull-sync
  refresh.

### `state.showUnreadOnly:Signal<boolean>`

Defined in `src/client/state.ts:251`. Toggled by the "Unread only"
checkbox in `src/client/routes/feed-reader.ts:176-180`. Initial value
`false` (filter off).

- Used today by `buildItemOptions()` (`src/client/state.ts:544-546`)
  to set `options.isRead = false` when loading items.
- Will additionally be **read by `SidebarItem`** to choose between
  `counts.total` and `counts.unread`.

### Derived display values (no new state)

Two view-level expressions, both inside `SidebarItem`'s render:

| derived value | expression | replaces |
|---|---|---|
| All Items badge | `state.showUnreadOnly.value ? state.counts.value.unread : state.counts.value.total` | current `counts.value.unread` |
| Starred badge | `state.counts.value.starred` | unchanged |

These are derived directly in the JSX. A `useComputed` is not
required: the component already subscribes to `counts` and to
`showUnreadOnly` via signal access during render.

## Invariants (post-change)

1. **Settled-state agreement (FR-007 / SC-002):** When
   `state.itemsLoading.value === false`, the All Items badge equals
   the size of the global reading list under the current filter. In
   practice this holds because both `counts.total`/`counts.unread`
   and the visible list derive from the same underlying `items` table
   in the same adapter, and `loadCounts` is paired with every write.
2. **Toggle agreement (FR-004):** Mutating
   `state.showUnreadOnly` causes the badge to re-render in the same
   tick (signal subscription), without an additional async fetch.
3. **Mutation agreement (FR-005 / SC-003):** Marking an item read or
   unread updates `state.counts` via `loadCounts()` after the
   `updateItem` call resolves, so the badge re-agrees with the
   visible list within one render cycle.
4. **Starred independence (FR-006):** `state.showUnreadOnly` does not
   feed into the Starred badge expression.

## Out of scope (explicit non-changes)

- DO SQLite schema (`src/server/durable-objects/index.ts`).
- `/api/sync` payload shape.
- `bootstrapLocalDb` (`src/client/db/bootstrap.ts` if/where present).
- Local SQLite schema (`src/client/db/local-adapter.ts` schema setup).
- `pullSync` / outbox entries.
- `DbAdapter.getCounts()` signature on either adapter.
- Server `GET /api/items/count` route.
- Per-feed sidebar entries.

## State transitions

There are no entity state transitions. The only "transition" is the
existing two-state filter toggle (off ↔ on), which already exists and
is being given an additional consumer (the badge).
