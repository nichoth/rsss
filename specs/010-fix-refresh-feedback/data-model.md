# Phase 1 Data Model: Faithful Visual Feedback During Refresh Feeds

This feature is UI-state lifecycle only. No SQLite schema, no
`/api/sync` payload, and no DO KV record changes. The "data model"
here is the client's `AppState` signals and their lifecycle.

## Scope

- **In scope.** The shape and transitions of the new
  `refreshInProgress` signal, and the existing
  `feedSyncStatus` / `feedUpdateCounts` / `feedSyncError` signals
  *during the manual-refresh window*.
- **Out of scope.** Per-user DO SQLite tables (`feeds`, `items`,
  `outbox`, `read_state`), DO KV poller state from feature 009,
  `/api/sync` payload shape, `/feed-status` payload shape, the
  local SQLite mirror schema. None of these change.

## Client signals (changed)

### `state.refreshInProgress:Signal<boolean>` (NEW)

- **Default**: `false`.
- **Set to `true` by**: `State.refreshFeeds(state)` at the start
  of the manual-refresh flow.
- **Set to `false` by** (in priority order):
  1. The SSE `refresh-complete` listener, after
     `await State.refreshAfterSync(state)` resolves, inside a
     single `batch`.
  2. The SSE `open` reconnect listener, after
     `await State.refreshAfterSync(state)` resolves, when the
     reconnect happened with `refreshInProgress === true`.
  3. The 60-second safety timeout
     (`REFRESH_FEEDS_SAFETY_TIMEOUT_MS`).
  4. The POST failure handler in `State.refreshFeeds`, inside the
     same `batch` that sets `feedSyncStatus = 'error'`.
  5. The 401 branch in `State.refreshFeeds`, inside the same
     `batch` that nulls `state.user.value`.
- **Read by**: `SidebarFooter` to set
  `Button.isSpinning`.
- **Invariants**:
  - At most one `true → false` transition per `false → true`
    transition (no flicker).
  - When `true`, no other signal writer flips it to `false` except
    the listed paths.
  - When `false`, `State.refreshFeeds` is callable; when `true`,
    `State.refreshFeeds` returns immediately without dispatching
    a POST (FR-008).

### `state.feedsLoading:Signal<boolean>` (UNCHANGED)

- **Behavior unchanged.** `State.loadFeeds` continues to toggle
  it for the duration of a feeds read.
- **Decoupled from the refresh button.** No longer drives the
  "Refresh Feeds" button's `isSpinning`. Only drives the sidebar
  "Loading feeds…" empty-state placeholder
  (`src/client/components/sidebar.ts` line 152).

### `state.feedSyncStatus:Signal<'inactive'|'updates'|'syncing'|'error'|'synced'>` (CHANGED LIFECYCLE)

- **Owner**: `State.loadFeedStatus` after the manual-refresh
  window settles, same as feature 008. *Inside* the manual-
  refresh window, `State.refreshFeeds` writes `'syncing'` on
  click and `'error'` on POST/401 failure.
- **Removed write**: the post-POST-success block in
  `State.refreshFeeds` no longer flips this to `'synced'`. That
  transition now happens implicitly via `loadFeedStatus` inside
  `refreshAfterSync` triggered from the `refresh-complete`
  handler.

### `state.feedUpdateCounts:Signal<Record<string, number>>` (CHANGED LIFECYCLE)

- **Owner**: `State.loadFeedStatus` is the single source of truth
  after feature 008.
- **Removed write**: the post-POST-success block in
  `State.refreshFeeds` no longer assigns `{}` to this signal.
  Counts are reconciled by `loadFeedStatus` inside
  `refreshAfterSync` at `refresh-complete`.
- **New snapshot semantics**: `State.refreshFeeds` captures
  `priorCounts = state.feedUpdateCounts.value` at click. On
  failure the snapshot is restored inside the error `batch`
  (FR-007). On success, the snapshot is unused (the post-refresh
  reconcile takes precedence).

### `state.feedSyncError:Signal<string|null>` (UNCHANGED)

- Cleared on click (`null`), set to a message on failure. Same as
  today.

## Refresh lifecycle state machine

```text
                    ┌────────────┐
                    │  IDLE       │   refreshInProgress = false
                    │             │   (server may or may not have
                    │             │    pending updates; pill state
                    │             │    governed by loadFeedStatus)
                    └─────┬──────┘
                          │  user clicks "Refresh Feeds"
                          │  (and refreshInProgress === false)
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  CLICK SETUP (single batch)                           │
   │   - refreshInProgress = true                          │
   │   - feedSyncStatus    = 'syncing'                     │
   │   - feedSyncError     = null                          │
   │   - priorCounts       = snapshot(feedUpdateCounts)    │
   │   - safety timer armed (60s)                          │
   └──────────────┬───────────────────────────────────────┘
                  │
                  │  POST /feeds/refresh
                  │
            ┌─────┴─────┐
            │           │
        success         failure
            │           │
            ▼           ▼
   ┌──────────────┐  ┌────────────────────────────────────┐
   │ AWAIT BATCH   │  │  POST FAILURE (single batch)        │
   │ (no signal    │  │   - clear safety timer              │
   │  writes here) │  │   - refreshInProgress = false        │
   │               │  │   - feedSyncStatus    = 'error'      │
   │ refreshIn-    │  │   - feedSyncError     = message      │
   │ Progress      │  │   - feedUpdateCounts  = priorCounts  │
   │ stays true    │  └─────────────────┬────────────────────┘
   │ pill stays    │                    │
   │ 'syncing'     │                    ▼
   └──────┬───────┘                   IDLE
          │
          │  one of:
          │   (a) SSE refresh-complete arrives
          │   (b) SSE open reconnect with
          │       refreshInProgress === true
          │   (c) safety timeout fires
          │
          ▼
   ┌────────────────────────────────────────────────────────┐
   │  SETTLE (a/b)                                            │
   │   - clear safety timer                                   │
   │   - await refreshAfterSync(state)                        │
   │       → loadFeeds, loadItems, loadCounts, loadFeedStatus │
   │       → loadFeedStatus reconciles                         │
   │         feedSyncStatus + feedUpdateCounts                 │
   │   - batch:                                                │
   │       refreshInProgress = false                           │
   │                                                            │
   │  SETTLE (c)                                                │
   │   - refreshInProgress = false                              │
   │   - leave feedSyncStatus alone (next loadFeedStatus        │
   │     reconciles, e.g. on next SSE event or page nav)        │
   └──────────────────────────────────┬─────────────────────────┘
                                      │
                                      ▼
                                    IDLE
```

## Idempotency

- **Click while busy**. `State.refreshFeeds` returns at entry if
  `refreshInProgress.value === true`; no POST is dispatched. The
  Button component's `disabled={isSpinning}` provides a
  belt-and-suspenders DOM-level block.
- **Multiple SSE `refresh-complete` events**. The handler is
  re-entrant. If `refreshInProgress` is already `false` when
  `refresh-complete` arrives, `refreshAfterSync` still runs
  (legitimate reconcile), but the `batch` that clears
  `refreshInProgress` is a no-op write.
- **Background poll's `feed-updated` during refresh**. Does not
  touch `refreshInProgress`. Continues to schedule the existing
  debounced `refreshAfterSync` for items / counts / pill, which
  is what FR-011 wants.

## Failure modes and recovery

| Failure                                              | Behavior                                                                                          |
|------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `POST /feeds/refresh` rejects (non-200, network)     | refreshInProgress=false, feedSyncStatus='error', feedSyncError set, priorCounts restored          |
| `POST /feeds/refresh` returns 401                    | existing 401 branch: user=null, authError set, route='/login', refreshInProgress=false in batch   |
| Server fetches start but `refresh-complete` is lost  | safety timer fires at 60s: refreshInProgress=false                                                |
| SSE drops mid-refresh and `refresh-complete` is lost | on SSE reopen with refreshInProgress=true: refreshAfterSync runs, refreshInProgress=false         |
| Zero subscribed feeds                                | server's `Promise.all([])` resolves immediately, broadcasts `refresh-complete`, settles as normal |
| Refresh completes but `refreshAfterSync` rejects     | refreshInProgress is still cleared in the same batch; the next manual refresh or SSE event reconciles |

## Persistence

- `refreshInProgress` is in-memory only. It is not persisted to
  local storage, IndexedDB, OPFS, the local SQLite mirror, or any
  server store.
- Reload mid-refresh: `refreshInProgress` resets to `false` (its
  default). The pill is then governed by `loadFeedStatus` from the
  app boot path. If the server's manual refresh was still running
  at reload, its eventual `feed-updated` SSE events update the pill
  through the existing path; the user no longer "owns" the busy
  state because the refresh control was unmounted with the page.
  This matches the spec's framing — busy state is per-session
  visual feedback, not durable.
