# Empty-state pending-updates affordance Design

## Summary

The change is purely client-side. A new presentational Preact component,
`PendingUpdateEmptyState`, is introduced to render a "N pending update(s)"
message and a "Click to refresh" button when the feed-reader's main panel
is empty but the server has signalled that new items are available. The
component accepts a `count` prop and an `onRefresh` callback; it owns a
local signal-backed busy flag so it can disable and relabel the button for
the lifetime of the in-flight request, without touching any global state.

The existing feed-reader route (`src/client/routes/feed-reader.ts`) already
has a single empty-state branch. Phase 2 expands that branch into four
cases: no feeds at all, items empty with pending updates, items empty
without pending updates on a per-feed view, and items empty without
pending updates on the all-feeds view. The pending count is derived from
`state.feedUpdateCounts` — either the entry for the selected feed or the
sum across all feeds. Keeping count derivation and callback selection in
the parent means `PendingUpdateEmptyState` has no knowledge of routing or
global state, making it straightforward to test in isolation.

## Definition of Done

- When the feed-reader main panel has `items.length === 0` AND pending updates
  exist for the current view, the panel shows **"N pending update(s)"** with a
  **"Click to refresh"** button instead of the existing "No items in X" copy.
- On a per-feed view, `N = feedUpdateCounts[selectedFeedId]` and the button
  calls `State.refreshFeed(state, String(selectedFeedId))`.
- On the All Items / All Feeds view (no `selectedFeedId`),
  `N = Σ feedUpdateCounts.values` and the button calls
  `State.refreshFeeds(state)`.
- Singular vs plural copy is handled ("1 pending update" vs
  "50 pending updates").
- While a refresh is in flight, the button is disabled and reads
  "Refreshing…".
- When `items.length === 0` AND no pending updates, the existing
  "No items in X" / "Maybe add some feeds to start reading." messages are
  preserved unchanged.

## Acceptance Criteria

### empty-state-pending-updates.AC1: Pending-update component renders correctly

- **empty-state-pending-updates.AC1.1 Success:** With `count=1`, the component
  renders "1 pending update" (singular) and a "Click to refresh" button.
- **empty-state-pending-updates.AC1.2 Success:** With `count=50`, the component
  renders "50 pending updates" (plural) and a "Click to refresh" button.
- **empty-state-pending-updates.AC1.3 Success:** Clicking the button invokes
  the `onRefresh` callback exactly once.
- **empty-state-pending-updates.AC1.4 Edge:** With `count=0`, the parent does
  not render this component (the component itself is not required to handle
  zero — that's the caller's contract).

### empty-state-pending-updates.AC2: Button in-flight state

- **empty-state-pending-updates.AC2.1 Success:** While the awaited
  `onRefresh()` promise is pending, the button is disabled and its label
  reads "Refreshing…".
- **empty-state-pending-updates.AC2.2 Success:** When `onRefresh()` resolves,
  the button re-enables and the label reverts to "Click to refresh".
- **empty-state-pending-updates.AC2.3 Failure:** When `onRefresh()` rejects,
  the busy flag clears and the button re-enables (label reverts) so the
  user can retry. The component does not surface an inline error message.

### empty-state-pending-updates.AC3: Feed-reader wires the right primitive

- **empty-state-pending-updates.AC3.1 Success:** When the user is on a
  per-feed view (`selectedFeedId !== null`) with `items.length === 0` and
  `feedUpdateCounts[id] > 0`, the feed-reader renders
  `PendingUpdateEmptyState` with `count = feedUpdateCounts[id]`.
- **empty-state-pending-updates.AC3.2 Success:** When the user is on the All
  Items / All Feeds view (`selectedFeedId === null`) with
  `items.length === 0` and `Σ feedUpdateCounts > 0`, the feed-reader renders
  `PendingUpdateEmptyState` with `count = Σ feedUpdateCounts.values`.
- **empty-state-pending-updates.AC3.3 Success:** Clicking the button on a
  per-feed view calls `State.refreshFeed(state, String(selectedFeedId))`.
- **empty-state-pending-updates.AC3.4 Success:** Clicking the button on the
  All Items / All Feeds view calls `State.refreshFeeds(state)`.

### empty-state-pending-updates.AC4: Existing empty-state behavior preserved

- **empty-state-pending-updates.AC4.1 Success:** When `feeds.length === 0`,
  the feed-reader still renders "Maybe add some feeds to start reading."
  regardless of pending counts.
- **empty-state-pending-updates.AC4.2 Success:** On a per-feed view with
  `items.length === 0` AND `feedUpdateCounts[id] === 0`, the feed-reader
  still renders "No items in <title>".
- **empty-state-pending-updates.AC4.3 Success:** On the All Items view with
  `items.length === 0` AND `Σ feedUpdateCounts === 0`, the feed-reader still
  renders "No items to show."
- **empty-state-pending-updates.AC4.4 Success:** While
  `itemsLoading === true`, neither the new component nor the existing
  copy is rendered (the loading indicator continues to take precedence).

## Glossary

- **`feedUpdateCounts`**: A `Signal<Record<string, number>>` in `AppState`
  (keyed by feed ID as a string) that tracks how many unfetched items the
  server has reported for each feed since the last refresh.
- **`selectedFeedId`**: A signal in `AppState` holding the numeric ID of
  the currently viewed feed, or `null` when the user is on the All Items /
  All Feeds view.
- **`State.refreshFeed`**: Client function that POSTs to
  `feeds/:id/refresh` for a single feed, clears that feed's pending count,
  and updates `feedSyncStatus`.
- **`State.refreshFeeds`**: Client function that POSTs to `feeds/refresh`
  for all feeds; manages the `refreshInProgress` lifecycle with SSE-driven
  settlement and a re-entrancy guard.
- **`refreshInProgress`**: Global signal in `AppState` that is `true`
  while an all-feeds refresh is in flight; set only by
  `State.refreshFeeds`, not by `State.refreshFeed`.
- **`AppState`**: The top-level client state object whose fields are
  `@preact/signals` `Signal` instances, passed to components and state
  functions across the app.
- **SSE**: Server-Sent Events. The all-feeds refresh path waits for an SSE
  `refresh-complete` event to settle `refreshInProgress` after the POST
  returns; this design does not change that.
- **`@preact/signals`**: Lightweight reactive-state library; signals
  re-render only the components that read them. Used here for both global
  app state and the component-local busy flag (`useSignal`).
- **`htm/preact`**: Template-literal JSX alternative; lets Preact components
  be written without a compile step, using tagged template strings.
- **`tapzero`** (`@substrate-system/tapzero`): The project's test runner,
  used to write TAP-outputting unit tests for components and state.
- **`PendingUpdateEmptyState`**: The new Preact component introduced by
  this plan; renders the pending-count message and the refresh button,
  owns the in-flight busy flag.

## Architecture

The change is confined to the client. A new presentational component
`PendingUpdateEmptyState` renders the count + refresh button and owns its
in-flight visual state via a local signal. The existing feed-reader route
chooses between three empty-state branches:

1. No feeds at all → existing "Maybe add some feeds to start reading."
2. Items empty AND pending updates > 0 for the current view →
   `PendingUpdateEmptyState`.
3. Items empty AND no pending updates → existing "No items in X." /
   "No items to show."

The component receives `count:number` and `onRefresh:() => Promise<void>` from
its caller. It does not know about `AppState`, `selectedFeedId`, or the
refresh functions — the parent (feed-reader) selects the right primitive
based on whether a feed is selected:

- per-feed view → `State.refreshFeed(state, String(selectedFeedId))`
- All Items / All Feeds view → `State.refreshFeeds(state)`

This keeps `PendingUpdateEmptyState` reusable and side-effect-free at the
component boundary.

### In-flight state

`State.refreshFeed` (single-feed) does **not** touch
`state.refreshInProgress` — only `State.refreshFeeds` does. To get a
"Refreshing…" label regardless of which primitive is invoked, the new
component tracks its own busy flag for the lifetime of the `onRefresh`
promise. The global `state.refreshInProgress` signal is unchanged.

This keeps blast radius small (no edits to refresh primitives) and gives
correct local UX: clicking "Click to refresh" disables and relabels the
button until the awaited call settles.

### Render conditions in feed-reader

The current condition at `src/client/routes/feed-reader.ts:155-163` is:

```
!itemsLoading && items.length === 0 → [empty copy]
```

becomes:

```
!itemsLoading && items.length === 0 →
  feeds.length === 0      → "Maybe add some feeds…"
  pendingCount > 0        → <PendingUpdateEmptyState count onRefresh />
  selectedFeed            → "No items in <title>"
  else                    → "No items to show."
```

`pendingCount` is computed in the route function:
- if `selectedFeedId.value !== null` →
  `feedUpdateCounts.value[String(selectedFeedId.value)] ?? 0`
- else → `Object.values(feedUpdateCounts.value).reduce((a,b)=>a+b,0)`

## Existing Patterns

Investigation found:

- Empty-state copy lives inline in
  `src/client/routes/feed-reader.ts:155-163` as a conditional branch on the
  items list. The new component slots into the same branch.
- Pending counts come from `state.feedUpdateCounts` declared at
  `src/client/state.ts:301` (initialized at `:378`, a
  `Signal<Record<string,number>>` keyed by feed id as string).
- Single-feed refresh: `State.refreshFeed(state, feedId)` at
  `src/client/state.ts:2036`. POSTs to `feeds/:id/refresh`, clears that feed's
  pending count, and flips `feedSyncStatus` to `'synced'` if the map empties.
- All-feeds refresh: `State.refreshFeeds(state)` at
  `src/client/state.ts:1636`. POSTs to `feeds/refresh`, manages
  `state.refreshInProgress` lifecycle with safety timeouts and SSE-driven
  settlement. Re-entrancy guard at line 1640.
- Components live in `src/client/components/`. Existing precedent for small
  presentational components: `feed-status.ts`, `sidebar-footer.ts`, etc.
- Tests use `@substrate-system/tapzero` and render the route directly with a
  fabricated `AppState`, per `test/feed-reader-cache-disclosure.ts`.
- Templating: `htm/preact` template literals. Local component state via
  `@preact/signals` — `batch()` is used when setting multiple signals
  sequentially (per project house-style in CLAUDE.md).

The design follows these existing patterns without divergence.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: PendingUpdateEmptyState component

**Goal:** Self-contained component that renders the pending-update message,
the refresh button, and its own in-flight state.

**Components:**
- `src/client/components/pending-update-empty-state.ts` — Preact
  `FunctionComponent<{ count:number; onRefresh:() => Promise<void> }>`.
  Owns a local `useSignal(false)` busy flag. Button is disabled and reads
  "Refreshing…" while the awaited `onRefresh()` is pending; reverts on
  settle (success or failure). Pluralizes the count label
  ("1 pending update" / "N pending updates"). The "Click to refresh" button
  is the focal element; the count line is plain text above it.
- `src/client/components/pending-update-empty-state.css` (optional) — only
  if styling diverges from the existing `.empty-state` class in
  `src/client/routes/feed-reader.css`. Prefer re-using existing variables
  per project CSS rules (`_vars.css` / `_variables.css`); avoid creating new
  colors.
- `test/pending-update-empty-state.ts` — verifies pluralization, button
  enabled/disabled transitions, callback invocation, and that failure of
  `onRefresh` still re-enables the button.

**Dependencies:** None (new file, no other code touched yet).

**Done when:** Component renders both copy variants, button toggles
in-flight state correctly across success and failure, and Phase 1 tests
pass — covering AC1.1, AC1.2, AC1.3, AC1.4, AC2.1, AC2.3.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Wire into feed-reader empty-state

**Goal:** Replace the existing empty-state conditional in feed-reader so it
chooses the new component when pending updates exist.

**Components:**
- `src/client/routes/feed-reader.ts` — at the empty-state branch
  (currently lines 155-163), compute `pendingCount` from
  `state.feedUpdateCounts` and `state.selectedFeedId`, and pick the
  `onRefresh` closure (`State.refreshFeed` per-feed,
  `State.refreshFeeds` all-feeds). Render `<PendingUpdateEmptyState>` when
  `pendingCount > 0`, otherwise fall through to the existing copy.
- `test/feed-reader-pending-updates.ts` — three render scenarios
  (per-feed with pending, all-feeds with pending, no pending → existing
  message preserved) and verifies the correct refresh primitive is called
  for each scenario.

**Dependencies:** Phase 1.

**Done when:**
- Per-feed view with `feedUpdateCounts[id] > 0` and `items=[]` renders the
  new component with the per-feed count; clicking calls `State.refreshFeed`
  with that feed id. Covers AC3.1, AC3.3.
- All Items view with `Σ feedUpdateCounts > 0` and `items=[]` renders the
  new component with the sum; clicking calls `State.refreshFeeds`.
  Covers AC3.2, AC3.4.
- Items=[] and pending=0 still renders the existing "No items in X" /
  "No items to show." / "Maybe add some feeds…" copy unchanged.
  Covers AC4.1, AC4.2, AC4.3.
- All Phase 2 tests pass.
- `npm test && npm run lint` pass on the branch.
<!-- END_PHASE_2 -->

## Additional Considerations

**Reentrancy on per-feed refresh.** `State.refreshFeed` has no re-entrancy
guard (unlike `refreshFeeds`). The new component's local busy flag is the
only thing preventing a double-click while the POST is in flight. That's
sufficient for this UI, but the underlying primitive remains
double-clickable from elsewhere. Out of scope here.

**"Unread only" filter.** Pending items are unfetched and have no read
state; the filter doesn't gate the new affordance. The empty-state with
pending count appears whether or not the filter is on. After refresh, the
newly-fetched items will be unread (so they pass the filter) and items
will be > 0, naturally hiding the empty state.

**Error path.** If `onRefresh()` rejects, the busy flag clears and the
button becomes clickable again. Error messaging is already surfaced
elsewhere (`state.feedSyncError` in the header status), so the empty-state
component does not duplicate it.

**No SSE coupling.** The component awaits the primitive's returned promise
only. `State.refreshFeeds`'s SSE-driven settlement of
`state.refreshInProgress` is independent and unchanged. The button's busy
label ends when the network round-trip ends, which is the natural local
signal.
