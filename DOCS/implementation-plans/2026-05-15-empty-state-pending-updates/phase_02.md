# Empty-state pending-updates Implementation Plan — Phase 2

**Goal:** Wire `PendingUpdateEmptyState` (created in Phase 1) into
`src/client/routes/feed-reader.ts` so that when the item list is empty
**and** pending updates exist for the current view, the new component is
rendered with the right count and refresh primitive. When no pending
updates exist, the existing empty-state copy is preserved.

**Architecture:** A single conditional swap in the existing empty-state
branch of `feed-reader.ts:155-163`. The route computes `pendingCount`
from `state.feedUpdateCounts` (per-feed entry when `selectedFeedId !==
null`; otherwise the sum across all feeds) and picks the matching refresh
primitive (`State.refreshFeed` per-feed, `State.refreshFeeds` for All
Items / All Feeds). `PendingUpdateEmptyState` is rendered only when
`pendingCount > 0`; otherwise the existing copy is unchanged.

**Tech Stack:** TypeScript, Preact, `@preact/signals`, `htm/preact`,
`@substrate-system/tapzero`.

**Scope:** Phase 2 of 2 from
`/Users/nick/code/rsss/docs/design-plans/2026-05-15-empty-state-pending-updates.md`.

**Codebase verified:** 2026-05-15.

**Branch:** `empty-state-pending-updates` (based on `origin/staging`).

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

### empty-state-pending-updates.AC1.4 (closes Phase 1's contract)
- **empty-state-pending-updates.AC1.4 Edge:** With `count=0`, the parent does
  not render this component. Phase 1 honored this contract by not handling
  zero specially; Phase 2 enforces it at the call site (the wiring only
  renders the component when `pendingCount > 0`).

---

## Codebase context (for the implementor)

- The current empty-state branch is at
  `src/client/routes/feed-reader.ts:155-163` and looks exactly like this
  today:

  ```ts
  ${!itemsLoading.value && items.value.length === 0 && html`
      <div class="empty-state">
          ${feeds.value.length === 0 ?
              'Maybe add some feeds to start reading.' :
              selectedFeed ?
                  `No items in ${selectedFeed.title || selectedFeed.url}` :
                  'No items to show.'}
      </div>
  `}
  ```

  Keep the existing `!itemsLoading.value && items.value.length === 0`
  outer guard. Insert the new component **as a third branch** of the
  inner ternary, before the `feeds.length === 0` branch (no — keep that
  one first, see below).

- Existing imports in `feed-reader.ts` (lines 1-14) already include:
  `html` from `'htm/preact'`, `FunctionComponent` from `'preact'`,
  hooks from `'preact/hooks'`, `State` and `AppState` from
  `'../state.js'`, and components like `ItemRow` and `Sidebar`. Add a
  new component import next to those.

- Relevant signal types (from `src/client/state.ts`):
  - `feedUpdateCounts:Signal<Record<string, number>>` (line 301)
  - `selectedFeedId:Signal<number|null>` (line 319)
  - Both are already destructured patterns used elsewhere in the file.

- Relevant refresh primitives:
  - `State.refreshFeeds(state):Promise<void>` — at
    `src/client/state.ts:1636`. POSTs `feeds/refresh`, manages
    `state.refreshInProgress`, has re-entrancy guard, settles via SSE.
    Use this when `selectedFeedId.value === null`.
  - `State.refreshFeed(state, feedId:string):Promise<void>` — at
    `src/client/state.ts:2036`. POSTs `feeds/:id/refresh`, clears that
    feed's entry in `feedUpdateCounts`. Note: the parameter is a
    **string**, so when `selectedFeedId.value` is `number`, you must
    pass `String(selectedFeedId.value)`.

- Existing feed-reader test pattern lives at
  `test/feed-reader-cache-disclosure.ts`. Read that file for the exact
  `makeState`, `makeFeed`, `mount`, `unmount`, `nextTick` helpers and
  the way `State.*` functions are overridden for test isolation. The
  new test file should follow that structure.

---

## Tasks

<!-- START_TASK_1 -->
### Task 1: Wire PendingUpdateEmptyState into feed-reader empty-state

**Verifies:**
empty-state-pending-updates.AC3.1,
empty-state-pending-updates.AC3.2,
empty-state-pending-updates.AC3.3,
empty-state-pending-updates.AC3.4,
empty-state-pending-updates.AC4.1,
empty-state-pending-updates.AC4.2,
empty-state-pending-updates.AC4.3,
empty-state-pending-updates.AC4.4,
empty-state-pending-updates.AC1.4

**Files:**
- Modify: `src/client/routes/feed-reader.ts` (add import; expand
  empty-state branch at lines 155-163; compute `pendingCount` and
  `handleRefreshPending`)
- Test: `test/feed-reader-pending-updates.ts` (new file, integration
  style following `test/feed-reader-cache-disclosure.ts`)

**Implementation:**

1. **Add import** alongside the other component imports near the top
   of `feed-reader.ts` (after `Sidebar` / `CacheSettings`):

   ```ts
   import {
       PendingUpdateEmptyState
   } from '../components/pending-update-empty-state.js'
   ```

   Note: `.js` extension on the import path matches the project
   convention (see `import { ItemRow } from '../components/item-row.js'`).

2. **Compute `pendingCount`** inside the `FeedReader` function body.
   Place this near the existing `useMemo` blocks (around the
   `selectedFeed` memo at line 35) so it lives alongside other derived
   values. It must read from signals so it re-renders correctly:

   ```ts
   const pendingCount = (() => {
       const counts = state.feedUpdateCounts.value
       if (state.selectedFeedId.value !== null) {
           return counts[String(state.selectedFeedId.value)] ?? 0
       }
       return Object.values(counts).reduce((a, b) => a + b, 0)
   })()
   ```

   Implementor's choice: this can be a plain `const` inside the render
   (re-computed each render — cheap, no memoization needed because the
   reads are already tracked by signals), or wrapped in a `useMemo` with
   the two underlying signals in the deps. Prefer the plain `const` for
   simplicity unless lint flags it.

3. **Compute `handleRefreshPending`** as a callback:

   ```ts
   const handleRefreshPending = useCallback(async ():Promise<void> => {
       const feedId = state.selectedFeedId.value
       if (feedId !== null) {
           await State.refreshFeed(state, String(feedId))
       } else {
           await State.refreshFeeds(state)
       }
   }, [])
   ```

   Reads `state.selectedFeedId.value` at call time (not at memo time)
   so the callback always picks the right primitive even if the user
   navigates between views before clicking. `useCallback` deps stay
   empty — the closure already reads the live signal.

4. **Expand the empty-state branch** at lines 155-163.

   **Recommended approach: extract a helper function.** The empty-state
   region already sits ~5 levels deep inside `<main>` > `<ul
   class="items-list">` in `feed-reader.ts`. A four-way inline ternary
   under that indentation will almost certainly cross the 80-column
   project limit. Extract a `renderEmptyState` helper inside the
   `FeedReader` function body (so it closes over `pendingCount`,
   `handleRefreshPending`, `feeds`, `selectedFeed`, etc.) and call it
   from the JSX. Example shape:

   ```ts
   const renderEmptyState = ():unknown => {
       if (feeds.value.length === 0) {
           return html`<div class="empty-state">
               Maybe add some feeds to start reading.
           </div>`
       }
       if (pendingCount > 0) {
           return html`<${PendingUpdateEmptyState}
               count=${pendingCount}
               onRefresh=${handleRefreshPending}
           />`
       }
       if (selectedFeed) {
           return html`<div class="empty-state">
               No items in ${selectedFeed.title || selectedFeed.url}
           </div>`
       }
       return html`<div class="empty-state">
           No items to show.
       </div>`
   }
   ```

   The empty-state JSX in the route body then becomes:

   ```ts
   ${!itemsLoading.value && items.value.length === 0 &&
       renderEmptyState()}
   ```

   Notes on the rewrite:
   - The order of branches is: no-feeds → pending → per-feed-no-pending
     → all-feeds-no-pending. This preserves AC4.1 (no-feeds beats
     everything) and routes the pending case ahead of the existing
     "No items in X" copy.
   - Each branch carries its own `class="empty-state"` (or
     `class="empty-state pending-update-empty-state"` from the
     component). This keeps existing CSS targeting unchanged while
     allowing the new component to bring its own wrapper.
   - Mind the 80-column limit and the project's ternary style. If you
     attempt an inline nested ternary instead of the helper and it
     fails lint, do not add `eslint-disable` — switch to the helper.
     The helper is the default; the inline form is only OK if it
     happens to fit cleanly.

**Testing:**

Create `test/feed-reader-pending-updates.ts`. Mirror the structure of
`test/feed-reader-cache-disclosure.ts`:

- Import `test` from `'@substrate-system/tapzero'`.
- Import `FeedReader`, `State`, `AppState` from
  `'../src/client/routes/feed-reader.js'` and
  `'../src/client/state.js'`.
- Re-use the `makeState`, `makeFeed`, `mount`, `unmount`, and
  `nextTick` helper shapes from `feed-reader-cache-disclosure.ts`. If
  practical, you may copy those helpers into the new file; do not
  refactor them into a shared module as part of this task
  (out-of-scope, and the existing test does it inline).
- **Mandatory:** Override `State.loadItems`, `State.refreshFeeds`, and
  `State.refreshFeed` with no-op spies *before* clicking the refresh
  button in each test. Capture and restore the originals between
  tests, following the existing pattern. Reason: the test `makeState`
  in `feed-reader-cache-disclosure.ts` does not include
  `state.refreshInProgress`, which the real `State.refreshFeeds` reads
  at `src/client/state.ts:1640`. If the real function runs, the test
  will throw "Cannot read properties of undefined."
- **Spy timing:** `handleRefreshPending` reads `State.refreshFeed` /
  `State.refreshFeeds` as a property access on the `State` namespace
  at click time, not at render time. You can install spies any time
  between mount and click — you do not need to override before
  rendering.

**Tests must verify each AC listed above. All assertions are
structural — no HTML text-content comparisons.** Use
`document.querySelector('.pending-update-empty-state')` as the
presence-of-new-component hook (this class is rendered by the Phase 1
component). Use `document.querySelector('.empty-state')` for the
existing copy branches but check that the `.pending-update-empty-state`
class is *not* present, not that the inner text matches.

Test cases:

- **AC3.1 + AC3.3** — Per-feed view, pending=50:
  - `state.feeds = [feed1 (id=1)]`, `state.items = []`,
    `state.feedUpdateCounts = { "1": 50 }`,
    `splats = ['example.com', 'feed.rss']` (so `selectedFeedId`
    resolves to 1 via the existing `useEffect`).
  - Assert `.pending-update-empty-state` is present.
  - Assert there is exactly one button inside it.
  - Override `State.refreshFeed` with a spy that records its args.
    Click the button. After `nextTick()`, assert the spy was called
    with `(state, "1")`. Specifically: `String` not `number`.
  - Assert `State.refreshFeeds` was NOT called.

- **AC3.2 + AC3.4** — All Items view (no splats / unmatched splat),
  pending sum across feeds:
  - `state.feeds = [feed1, feed2]`, `state.items = []`,
    `state.feedUpdateCounts = { "1": 30, "2": 20 }`,
    `splats = []`.
  - Assert `.pending-update-empty-state` is present.
  - Override `State.refreshFeeds` with a spy. Click the button.
    After `nextTick()`, assert the spy was called with `(state)` (just
    the state).
  - Assert `State.refreshFeed` was NOT called.

- **AC4.1** — No feeds at all:
  - `state.feeds = []`, `state.items = []`,
    `state.feedUpdateCounts = {}` (or even
    `{ "1": 5 }` to prove this branch wins over pending).
  - Assert `.pending-update-empty-state` is NOT present.
  - Assert a `.empty-state` element is present (the existing copy
    container). Do not assert its text content.

- **AC4.2** — Per-feed view, pending=0:
  - `state.feeds = [feed1]`, `state.items = []`,
    `state.feedUpdateCounts = { "1": 0 }`, splats select feed1.
  - Assert `.pending-update-empty-state` is NOT present.
  - Assert `.empty-state` IS present. Don't check text.

- **AC4.3** — All Items view, pending sum = 0:
  - `state.feeds = [feed1, feed2]`, `state.items = []`,
    `state.feedUpdateCounts = {}`, splats empty.
  - Assert `.pending-update-empty-state` is NOT present.
  - Assert `.empty-state` IS present.

- **AC4.4** — `itemsLoading=true`:
  - `state.feeds = [feed1]`, `state.items = []`,
    `state.feedUpdateCounts = { "1": 50 }`,
    `state.itemsLoading.value = true`.
  - Assert `.pending-update-empty-state` is NOT present.
  - Assert the existing loading indicator (`.loading-text` at
    `feed-reader.ts:142-144`) IS present. Or, equivalently, assert
    that `.empty-state` is NOT present (since both empty-state
    branches are gated on `!itemsLoading`).

- **AC1.4** — Already covered structurally by AC4.2 (per-feed,
  pending=0) and AC4.3 (all-feeds, pending=0). No extra test needed —
  Phase 2's wiring is what enforces the count=0 → no-render rule.

**Verification:**

Run: `npm test`
Expected: All new Phase 2 tests pass alongside Phase 1's component
tests. Existing test suite still passes (especially
`test/feed-reader-cache-disclosure.ts`).

Run: `npm run lint`
Expected: No new lint errors. If new lint errors appear from the
expanded ternary, prefer extracting the empty-state JSX into a small
`renderEmptyState` helper inside `FeedReader` rather than adding
`eslint-disable` comments.

**Commit:**

```bash
git add src/client/routes/feed-reader.ts \
        test/feed-reader-pending-updates.ts
git commit -m "feat(feed-reader): show pending-updates empty state with refresh"
```
<!-- END_TASK_1 -->

---

## Phase completion checklist

- [ ] `src/client/routes/feed-reader.ts` imports
  `PendingUpdateEmptyState` and renders it from the empty-state branch
  when `pendingCount > 0`.
- [ ] `pendingCount` correctly switches between per-feed lookup and
  global sum based on `state.selectedFeedId.value`.
- [ ] `handleRefreshPending` reads `state.selectedFeedId.value` at call
  time and dispatches to the matching primitive.
- [ ] `test/feed-reader-pending-updates.ts` exists with the AC3.x /
  AC4.x test cases above. All assertions are structural.
- [ ] `npm test` passes (including pre-existing tests).
- [ ] `npm run lint` passes.
- [ ] Branch is on `empty-state-pending-updates` with Phase 1 and
  Phase 2 commits.
