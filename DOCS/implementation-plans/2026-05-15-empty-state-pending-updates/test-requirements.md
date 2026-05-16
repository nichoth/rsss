# Test Requirements

Maps each acceptance criterion from
`/Users/nick/code/rsss/docs/design-plans/2026-05-15-empty-state-pending-updates.md`
to either an automated test (with file path and creating task) or a
human-verification step.

Note: per project house-style (`/Users/nick/.claude/CLAUDE.md`), tests do
not assert specific HTML text content. AC1.1 and AC1.2 are automated by
asserting return values of a pure `pendingUpdateLabel` helper — string
equality on a function return is not an HTML text-content assertion. The
"Refreshing…" / "Click to refresh" button labels in AC2.1/AC2.2 are
DOM-rendered text and are therefore split: the `disabled` attribute
toggle is automated; the label text itself is human-verified.

---

## Automated tests

### empty-state-pending-updates.AC1.1
- **Verifies:** `pendingUpdateLabel(1)` returns `"1 pending update"`
  (singular form).
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 1

### empty-state-pending-updates.AC1.2
- **Verifies:** `pendingUpdateLabel(50)` returns `"50 pending updates"`
  (plural form); also `pendingUpdateLabel(2)` and `pendingUpdateLabel(0)`
  lock the plural branch on small/edge values.
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 1

### empty-state-pending-updates.AC1.3
- **Verifies:** Clicking the rendered button invokes the `onRefresh`
  callback exactly once (spy counter).
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 2

### empty-state-pending-updates.AC1.4
- **Verifies:** With `pendingCount === 0`, the parent feed-reader does
  not render `.pending-update-empty-state`. Structurally covered by the
  AC4.2 (per-feed, pending=0) and AC4.3 (all-feeds, pending=0)
  feed-reader tests, which assert `.pending-update-empty-state` is
  absent.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC2.1 (disabled-attribute portion)
- **Verifies:** While the awaited `onRefresh()` promise is pending, the
  rendered button's `disabled` attribute is `true`. (The
  "Refreshing…" label text is human-verified; see below.)
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 2

### empty-state-pending-updates.AC2.2 (re-enable portion)
- **Verifies:** After `onRefresh()` resolves and microtasks flush, the
  rendered button's `disabled` attribute is `false` again. (The label
  reverting to "Click to refresh" is human-verified; see below.)
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 2

### empty-state-pending-updates.AC2.3
- **Verifies:** When `onRefresh()` rejects, the busy flag clears and
  `button.disabled === false` again, so the user can retry; the
  rejection still propagates (component does not swallow). Re-clicking
  the disabled button while in-flight does not double-invoke
  `onRefresh`.
- **Type:** unit
- **Test file:** `test/pending-update-empty-state.ts`
- **Created by:** Phase 1, Task 2

### empty-state-pending-updates.AC3.1
- **Verifies:** Per-feed view (`selectedFeedId !== null`),
  `items.length === 0`, `feedUpdateCounts[id] > 0` →
  `.pending-update-empty-state` is rendered.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC3.2
- **Verifies:** All-feeds view (`selectedFeedId === null`),
  `items.length === 0`, `Σ feedUpdateCounts > 0` →
  `.pending-update-empty-state` is rendered (count = sum across feeds).
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC3.3
- **Verifies:** Clicking the refresh button on a per-feed view invokes
  `State.refreshFeed(state, String(selectedFeedId))` and does NOT call
  `State.refreshFeeds`. Spy on both primitives; assert the string-form
  feed id.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC3.4
- **Verifies:** Clicking the refresh button on the All Items view
  invokes `State.refreshFeeds(state)` and does NOT call
  `State.refreshFeed`.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC4.1
- **Verifies:** When `feeds.length === 0`, the feed-reader renders a
  `.empty-state` container but NOT `.pending-update-empty-state`, even
  if pending counts are non-zero (proves no-feeds branch wins).
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC4.2
- **Verifies:** Per-feed view with `items=[]` and pending=0 renders
  `.empty-state` but NOT `.pending-update-empty-state`.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC4.3
- **Verifies:** All Items view with `items=[]` and `Σ pending === 0`
  renders `.empty-state` but NOT `.pending-update-empty-state`.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

### empty-state-pending-updates.AC4.4
- **Verifies:** When `itemsLoading.value === true`, the loading
  indicator (`.loading-text`) is present and neither `.empty-state`
  nor `.pending-update-empty-state` is rendered, even with non-zero
  pending counts.
- **Type:** integration
- **Test file:** `test/feed-reader-pending-updates.ts`
- **Created by:** Phase 2, Task 1

---

## Human verification

### empty-state-pending-updates.AC2.1 (label text only)
- **What to verify:** While a refresh is in flight, the refresh
  button's visible text reads exactly `"Refreshing…"` (with the
  horizontal-ellipsis character `…`, not three periods).
- **Why human:** Project house-style forbids asserting specific HTML
  text content on rendered DOM. The `disabled` attribute toggle (the
  user-observable interaction lockout) is covered by the AC2.1
  automated test; the visible label is a presentation detail and is
  verified visually instead.
- **Steps:**
  1. Run the app locally (`npm run dev`) and sign in with a user that
     has at least one feed with pending updates and an empty current
     view (e.g. all items marked read, then trigger a server-side
     pending count via the background poller, or seed
     `state.feedUpdateCounts` in devtools).
  2. Navigate to the affected feed (or All Items view) so the
     `PendingUpdateEmptyState` renders.
  3. Click the "Click to refresh" button.
  4. While the network request is in flight (use devtools Network
     throttling — Slow 3G — to extend the window), confirm the button
     label visibly reads `"Refreshing…"`.

### empty-state-pending-updates.AC2.2 (label-revert text only)
- **What to verify:** After the refresh request settles successfully
  and the component remains mounted (e.g. the response brought back no
  new items), the refresh button's visible label reverts to exactly
  `"Click to refresh"`.
- **Why human:** Same constraint as AC2.1 — the re-enable behavior is
  automated via the `disabled` attribute toggle; the literal label
  string is verified visually.
- **Steps:**
  1. Continuing from the AC2.1 steps, let the throttled request
     complete (or remove the throttle and re-trigger).
  2. While the component is still on screen (force this by ensuring
     the response brings no new items, e.g. by mocking the refresh
     endpoint to return an empty result), confirm the button's
     visible label has reverted to `"Click to refresh"` and the
     button is clickable.
