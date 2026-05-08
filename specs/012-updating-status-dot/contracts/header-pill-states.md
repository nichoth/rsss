# Contract: Header Pill States and Display Derivation

This feature is server-stable. All server-facing contracts are
unchanged from features 008-011: `POST /feeds/refresh`,
`GET /feed-status`, the SSE wire format (`feed-updated`,
`feed-updates-available`, `feed-updates-cleared`, `refresh-complete`),
and the per-user DO SQLite schema. The contract this feature
introduces is internal to the client: the visual state machine of
the header status pill (`<FeedStatus>`) and its derivation rule.

## Pill states

| State name    | Dot color | Legend label  | When                                                                                            |
|---------------|-----------|---------------|-------------------------------------------------------------------------------------------------|
| `inactive`    | gray      | (none)        | No user, or pre-load. Used for the unauthenticated / boot states.                                |
| `synced`      | green     | `up to date`  | Last authoritative reconcile reported zero pending items, and no manual refresh is in flight.    |
| `updates`     | blue      | `n updates`   | Last authoritative reconcile reported one or more pending items, and no manual refresh is in flight. |
| `syncing`     | yellow    | `updating`    | A manual refresh is in flight (`state.refreshInProgress.value === true`).                        |
| `error`       | red       | `sync failed` | Last authoritative reconcile or manual refresh failed; pill carries `state.feedSyncError` as the title. |

The wrapper element's `aria-label` always begins with
`Feed sync status:` followed by the legend wording (or
`Feed sync error: <message>` for the error state, preserving feature
008's existing behavior).

## Display derivation rule

The component's displayed state is **not** the underlying
`state.feedSyncStatus` signal. It is the computed signal
`state.displayedFeedSyncStatus`, defined as:

```text
displayedFeedSyncStatus =
  refreshInProgress.value ? 'syncing' : feedSyncStatus.value
```

This is the only rule the component applies. The component does not
read `state.refreshInProgress` directly; that signal is bound to the
controlled `Button` `isSpinning` prop in `<SidebarFooter>` (feature
010 / 011) and is only observable from the pill via the computed.

## Allowed transitions on `displayedFeedSyncStatus`

The computed re-evaluates whenever either input signal changes.
Transitions seen by the component are therefore the cross-product of
the two signals' lifecycles, but the manual-refresh window is the
only path where the pill's display can disagree with `feedSyncStatus`:

| From (display)                | Trigger                                                                          | To (display) | Notes                                                                              |
|-------------------------------|----------------------------------------------------------------------------------|--------------|------------------------------------------------------------------------------------|
| any non-`syncing`             | `state.refreshFeeds(state)` invoked → click-setup `batch` flips `refreshInProgress` to `true` | `syncing`    | FR-002. Same render frame as the click. The pre-click `feedSyncStatus` is preserved underneath. |
| `syncing`                     | `refresh-complete` SSE → `refreshAfterSync(state)` resolves → settle `batch` flips `refreshInProgress` to `false` | `synced` or `updates` | FR-004. The settle `batch` runs *after* `loadFeedStatus` has updated `feedSyncStatus`, so the pill exits yellow into the post-refresh value. |
| `syncing`                     | POST `/feeds/refresh` rejects → failure `batch` writes `feedSyncStatus = 'error'`, restores `feedUpdateCounts = priorCounts`, clears `refreshInProgress` | `error`      | FR-005. Same `batch` writes both sides, so the pill exits yellow directly into the error state. |
| `syncing`                     | POST `/feeds/refresh` returns 401 → 401 `batch` writes `feedSyncStatus = 'error'`, clears `refreshInProgress` | `error`      | Routed via 010's existing 401 branch (with `_setRoute('/login')` after). |
| `syncing`                     | 60s safety timer fires → `refreshInProgress` cleared without `feedSyncStatus` write | retains pre-click `feedSyncStatus` value | Edge case from 010. The pill exits yellow into whatever resting state was true before the click. Acceptable degradation; the pill is at least no longer stuck on yellow. |
| `syncing`                     | SSE `open` reconnect with `refreshInProgress === true` → `refreshAfterSync` resolves → settle `batch` clears `refreshInProgress` | `synced` or `updates` | Same exit semantics as `refresh-complete`. |

## Forbidden transitions on `displayedFeedSyncStatus`

- The pill MUST NOT show `'syncing'` when `refreshInProgress.value
  === false`. The yellow display is reserved for in-flight manual
  refresh. (FR-007 / SC-005.)
- The pill MUST NOT exit `'syncing'` while `refreshInProgress.value
  === true`. Specifically: SSE `feed-updates-available`,
  `feed-updates-cleared`, `feed-updated` → `refreshAfterSync`
  debounced reload, or any other writer of `feedSyncStatus` /
  `feedUpdateCounts` that fires during the refresh window MUST NOT
  cause an intermediate transition out of yellow. The computed
  masks them. (FR-003 / FR-011.)
- The pill MUST NOT enter `'syncing'` from any path other than the
  manual `state.refreshFeeds` flow. Background polling (feature
  009), page-load `loadFeedStatus`, and SSE listeners do not write
  `state.refreshInProgress`, so they cannot turn the pill yellow.
  (FR-007.)
- The pill MUST NOT silently drop `'syncing'` to `'synced'` on
  failure. The failure batch in `refreshFeeds` writes
  `feedSyncStatus = 'error'` *and* clears `refreshInProgress`
  inside the same `batch`, so the displayed value moves yellow →
  red atomically, never yellow → green. (FR-005 / SC-004.)

## UI contract

### `<FeedStatus>` (`src/client/components/feed-status.ts`)

- Reads `state.displayedFeedSyncStatus.value` for the dot color and
  legend choice. Reads `state.feedUpdateCounts.value` for the
  `'updates'` count summation. Reads `state.feedSyncError.value` for
  the `'error'` tooltip / aria-label. Does not read
  `state.feedSyncStatus.value` for display purposes.
- Renders the wrapper as
  `<span class="feed-status [syncing]" role="status"
   aria-live="polite" aria-label="...">`. The `syncing` modifier
  class is present iff the displayed status is `'syncing'`.
- The dot color mapping is:

  ```text
  inactive → gray, updates → blue, syncing → yellow,
  error → red, synced → green
  ```

- The `legendFor(status, count)` helper:
  - `synced` → `up to date`
  - `updates` → `n update` / `n updates`
  - `syncing` → `updating` (changed from `refreshing`)
  - `error` → `sync failed`
  - `inactive` → empty label, aria-label `Feed sync status: inactive`

### `<SidebarFooter>` / `<Button>` (feature 010 / 011)

Unchanged. `state.refreshInProgress` continues to drive the
controlled `isSpinning` prop on the refresh button. The pill picks
up the same signal indirectly through the new computed; the button
and the pill therefore enter and exit their busy displays in the
same `batch`.

### Items list (`feed-reader`)

Unchanged. `refreshAfterSync`'s `loadItems` populates `state.items`
before the settle `batch` clears `refreshInProgress`, so the items
list, the idle button, and the pill exit yellow all land in the same
paint (FR-006 / SC-003).

## Responsive layout contract

The existing `@media (680px <= width < 1000px)` rule that hides
`.feed-status .feed-status-legend` is preserved for resting states
(`synced`, `updates`, `inactive`). For `'syncing'` the legend
remains visible at all viewports. CSS:

```css
@media (680px <= width < 1000px) {
    .feed-status:not(.syncing) .feed-status-legend {
        display: none;
    }
}
```

(or equivalent narrower selector), keeping the medium-viewport
header layout intact for the resting states while preserving the
non-color cue for the in-progress state. (FR-009.)

## Acceptance contract (mapped from spec FRs)

| FR     | Verified by                                                                                                                  |
|--------|------------------------------------------------------------------------------------------------------------------------------|
| FR-001 | "Pill states" + "Render mapping" tables; `legendFor('syncing', _)` returns `'updating'`.                                    |
| FR-002 | "Allowed transitions" first row; click-setup `batch` writes `refreshInProgress = true` synchronously inside the click handler. |
| FR-003 | "Forbidden transitions" — pill must not exit `'syncing'` while `refreshInProgress === true`.                                 |
| FR-004 | "Allowed transitions" second row; settle `batch` runs after `loadFeedStatus` updates `feedSyncStatus`.                        |
| FR-005 | "Allowed transitions" rows for POST reject and POST 401; failure `batch` writes both `feedSyncStatus = 'error'` and `refreshInProgress = false` inside the same `batch`. |
| FR-006 | Settle `batch` semantics: pill and button both bound to `refreshInProgress` directly or via the computed.                    |
| FR-007 | "Forbidden transitions" third row; only `state.refreshFeeds` writes `state.refreshInProgress`.                               |
| FR-008 | `<FeedStatus>` wrapper retains `role="status" aria-live="polite"`; aria-label includes `updating`.                            |
| FR-009 | Responsive layout contract: `.feed-status.syncing .feed-status-legend` stays visible at all viewports.                       |
| FR-010 | Re-entry guard at top of `state.refreshFeeds` (010 contract); duplicate clicks short-circuit before any signal write.        |
| FR-011 | "Forbidden transitions" second row; SSE writers cannot exit yellow during the refresh window.                                |
| FR-012 | Browser-driven test `test/updating-pill-lifecycle.ts` covering all three resolution paths plus the background-poll case.     |
