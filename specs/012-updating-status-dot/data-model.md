# Data Model: Yellow "Updating" Pill State

This feature is a pure-client display refinement. There are no new
database columns, no new SQLite tables, no new `/api/sync` payload
fields, no new SSE events, and no new HTTP routes. The "data model"
in question is the in-memory state of the Preact client, specifically
the signal graph that drives the header status pill.

## Existing signals (carried forward unchanged)

| Signal                          | Type                                                | Source of truth                                                                                                          |
|---------------------------------|-----------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| `state.refreshInProgress`       | `Signal<boolean>`                                   | Manual-refresh lifecycle from feature 010 / 011. Six edges defined in `010-fix-refresh-feedback/contracts/refresh-lifecycle.md`. |
| `state.feedSyncStatus`          | `Signal<'inactive'\|'updates'\|'syncing'\|'error'\|'synced'>` | `loadFeedStatus`; SSE listeners; failure / 401 batches in `refreshFeeds`.                                                |
| `state.feedUpdateCounts`        | `Signal<Record<string, number>>`                    | `loadFeedStatus`; SSE `feed-updates-available` / `feed-updates-cleared` listeners; failure batch restores `priorCounts`. |
| `state.feedSyncError`           | `Signal<string\|null>`                              | `refreshFeeds` (clear on click; set on failure); `loadFeedStatus` (clear on success; set on failure).                     |
| `state.feedUpdateStatus`        | `ReadonlySignal<'updates'\|'synced'>`               | Computed view over `feedSyncStatus` (compatibility for `/updates` route).                                                |
| `state.feedsWithUpdates`        | `ReadonlySignal<string[]>`                          | Computed view over `feedUpdateCounts`.                                                                                   |

The 008 invariant remains: `loadFeedStatus` is the *single
authoritative* writer of `feedSyncStatus` / `feedUpdateCounts`
outside the manual-refresh window. SSE listeners are valid mid-window
writers (they keep the underlying counts current), but their writes
are masked from the displayed pill while `refreshInProgress` is true.

## New signal

| Signal                              | Type                                                          | Source of truth                                          |
|-------------------------------------|---------------------------------------------------------------|----------------------------------------------------------|
| `state.displayedFeedSyncStatus`     | `ReadonlySignal<'inactive'\|'updates'\|'syncing'\|'error'\|'synced'>` | Computed: `refreshInProgress.value ? 'syncing' : feedSyncStatus.value`. |

### Definition

```ts
displayedFeedSyncStatus: computed(() => (
    state.refreshInProgress.value ?
        'syncing' :
        state.feedSyncStatus.value
)),
```

Placed in `State()` alongside the existing `feedUpdateStatus` and
`feedsWithUpdates` computeds in `src/client/state.ts`.

### Reader

`FeedStatus` (`src/client/components/feed-status.ts`) is the only
reader. Its existing references to `state.feedSyncStatus.value` are
replaced with `state.displayedFeedSyncStatus.value`. The `error`
branch and the count summation continue to read
`state.feedSyncError.value` and `state.feedUpdateCounts.value`
respectively (those are not masked — when the pill is in `'error'`
the underlying `feedSyncStatus` is the source).

### Lifecycle (display-time)

| `refreshInProgress` | `feedSyncStatus`      | `displayedFeedSyncStatus` |
|---------------------|-----------------------|---------------------------|
| false               | `'inactive'`          | `'inactive'`              |
| false               | `'synced'`            | `'synced'`                |
| false               | `'updates'`           | `'updates'`               |
| false               | `'error'`             | `'error'`                 |
| false               | `'syncing'`           | `'syncing'` *             |
| true                | any                   | `'syncing'`               |

`*` Currently `'syncing'` is reachable on `feedSyncStatus` via the
failure batch's transient writes and via legacy callers; with the
plan's removal of the click-time `feedSyncStatus = 'syncing'` write,
this row becomes effectively unreachable in production but remains
type-correct.

## Render mapping (UI contract)

`FeedStatus` maps `displayedFeedSyncStatus.value` to the wrapper class
modifier and the `<Dot color>` / legend text.

| `displayedFeedSyncStatus` | Wrapper class                         | Dot color | Legend label   | aria-label                              |
|---------------------------|---------------------------------------|-----------|----------------|-----------------------------------------|
| `'inactive'`              | `feed-status`                         | `gray`    | (none)         | `Feed sync status: inactive`            |
| `'synced'`                | `feed-status`                         | `green`   | `up to date`   | `Feed sync status: up to date`          |
| `'updates'`               | `feed-status`                         | `blue`    | `n updates`    | `Feed sync status: n updates`           |
| `'syncing'`               | `feed-status syncing`                 | `yellow`  | `updating`     | `Feed sync status: updating`            |
| `'error'`                 | `feed-status` (existing error branch) | `red`     | `sync failed`  | `Feed sync error: <message>`            |

The `syncing` modifier class on the wrapper is new. CSS uses it to
override the `@media (680px <= width < 1000px)` legend hide for the
`'updating'` label only (research.md Decision 4).

## Mutations forbidden in this feature

- No new field on `state`.
- No write to `state.refreshInProgress` from anywhere outside the
  six edges defined in feature 010.
- No write to `state.feedSyncStatus = 'syncing'` from
  `State.refreshFeeds` click-setup batch (removed in this feature).
- No write to `state.displayedFeedSyncStatus` (it is read-only by
  construction; computed signals throw on assignment).
- No new direct reader of `state.feedSyncStatus` for display
  purposes — the `FeedStatus` component reads the computed.
  Non-display readers (`feedUpdateStatus` computed, tests,
  diagnostics) keep their current reads.

## Server-side contracts

Unchanged. `GET /feed-status`, `POST /feeds/refresh`, the SSE wire
format (`feed-updated`, `feed-updates-available`,
`feed-updates-cleared`, `refresh-complete`), and the per-user DO
SQLite schema (`feeds`, `items`, sync cursor) are all read-only with
respect to this feature.
