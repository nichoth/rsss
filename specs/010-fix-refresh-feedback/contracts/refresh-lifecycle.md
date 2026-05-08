# Contract: Refresh Lifecycle (Client-Internal)

This feature is server-stable. All server-facing contracts —
`POST /feeds/refresh`, `GET /feed-status`, the SSE event format —
are unchanged from features 008 and 009. The contract this feature
introduces is internal to the client: the visual lifecycle of the
"Refresh Feeds" control as observed by the user, by automated
tests, and by assistive technology.

## Lifecycle contract

### State signals

| Signal                      | Type                                | Owner                                        |
|-----------------------------|-------------------------------------|----------------------------------------------|
| `refreshInProgress`         | `Signal<boolean>`                   | NEW — owned by the manual refresh flow.      |
| `feedSyncStatus`            | `Signal<'syncing'\|'synced'\|...>`  | `loadFeedStatus`, with `'syncing'`/`'error'` written transiently by `refreshFeeds`. |
| `feedUpdateCounts`          | `Signal<Record<string, number>>`    | `loadFeedStatus` — single source of truth.   |
| `feedSyncError`             | `Signal<string\|null>`              | `refreshFeeds` and `loadFeedStatus`.         |

### Allowed transitions on `refreshInProgress`

| From  | Trigger                                              | To    | Notes                                                      |
|-------|------------------------------------------------------|-------|------------------------------------------------------------|
| false | `State.refreshFeeds(state)` invoked                  | true  | Inside the click-setup `batch`.                            |
| true  | SSE `refresh-complete` after `refreshAfterSync()`    | false | Inside a settling `batch`.                                  |
| true  | SSE `open` reconnect after `refreshAfterSync()`      | false | Inside a settling `batch`. Only when reconnect happens with `refreshInProgress === true`. |
| true  | 60s safety timer fires                               | false | Standalone write; pill not touched.                         |
| true  | POST `/feeds/refresh` rejects                        | false | Inside the failure `batch` (also writes `feedSyncStatus`/`feedSyncError`/restores `feedUpdateCounts`). |
| true  | POST `/feeds/refresh` returns 401                    | false | Inside the existing 401 `batch` (also nulls `state.user`). |

No other path may set `refreshInProgress`.

### Forbidden transitions

- The successful POST resolve handler MUST NOT set
  `refreshInProgress = false`.
- The successful POST resolve handler MUST NOT zero
  `feedUpdateCounts`.
- The successful POST resolve handler MUST NOT set
  `feedSyncStatus = 'synced'`.
- The SSE `feed-updated` listener (per-feed) MUST NOT touch
  `refreshInProgress`. (It continues to debounce-schedule a
  `refreshAfterSync` for items/counts/pill update, as today.)
- The SSE `feed-updates-available` and `feed-updates-cleared`
  listeners MUST NOT touch `refreshInProgress`.

## UI contract

### "Refresh Feeds" button (`SidebarFooter`)

- Renders the `Button` component with
  `isSpinning=${state.refreshInProgress}`.
- The `Button` component:
  - Sets `disabled` when `isSpinning` is true (existing).
  - Sets `aria-busy` to the same value (NEW, per FR-012).
  - Adds the `spinning` CSS class when `isSpinning` is true
    (existing).
- Click is wired to `() => State.refreshFeeds(state)` (unchanged).

### Header indicator (`FeedStatus`)

- Renders the existing pill driven by `feedSyncStatus` /
  `feedUpdateCounts` (unchanged from feature 008).
- During the manual-refresh window the pill shows `'refreshing'`
  (the `'syncing'` legend) because `refreshFeeds` set
  `feedSyncStatus = 'syncing'` at click and no other writer
  changes it until `loadFeedStatus` reconciles at the
  `refresh-complete` settle. Pill and button transition
  perceivably together (FR-005), inside the same `batch`.

### Items list (`feed-reader`)

- Re-renders from `state.items` after `refreshAfterSync`'s
  `loadItems` resolves. Because the settle `batch` runs *after*
  `refreshAfterSync` resolves, the user sees the updated items
  list and the idle button in the same paint.

## Acceptance contract (mapped from spec FRs)

| FR     | Verified by                                                                                                |
|--------|------------------------------------------------------------------------------------------------------------|
| FR-001 | Lifecycle table above + new test "button stays spinning past POST ack until SSE refresh-complete".          |
| FR-002 | Forbidden transitions list (no clear at intermediate POST handoff).                                         |
| FR-003 | `refreshInProgress=true` is the on-screen cue continuously across the refresh window; pill shows 'refreshing'. |
| FR-004 | `feedUpdateCounts` is not zeroed at POST ack; the post-refresh value is reconciled by `loadFeedStatus`.     |
| FR-005 | Settle `batch` clears `refreshInProgress` *after* `await refreshAfterSync()` so all updates land together.  |
| FR-006 | Zero-feed case: server's empty-batch `refresh-complete` settles via the same path; pill goes to 'synced'.   |
| FR-007 | `priorCounts` snapshot restored in failure `batch`; `feedSyncError` set, button exits busy.                  |
| FR-008 | Re-entry guard at top of `refreshFeeds` (`if (refreshInProgress.value) return`).                           |
| FR-009 | Single `false → true → false` transition per click; no intermediate clear.                                  |
| FR-010 | Lifecycle is signal-driven; rendering is independent of focus / scroll position / current panel.            |
| FR-011 | `feed-updated` listener does not touch `refreshInProgress`; only `refresh-complete` does.                    |
| FR-012 | `aria-busy` on the rendered `<button>`; pill keeps existing `role="status" aria-live="polite"`.             |
