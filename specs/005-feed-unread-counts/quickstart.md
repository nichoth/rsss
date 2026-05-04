# Quickstart: Verify Per-Feed Unread Counts In Sidebar

**Branch:** `005-feed-unread-counts`
**Spec:** `./spec.md`

This is the manual browser verification required by the
constitution (Development Workflow & Quality Gates → Local
verification: "UI changes MUST be exercised in a browser before
being claimed complete"). Run it after `npm test && npm run lint`
pass.

## Prerequisites

- A signed-in user with at least **two** subscribed feeds, where:
  - one feed (`F1`) has at least 2 unread articles, and
  - one feed (`F2`) has 0 unread articles (mark them all read up
    front, or use a brand-new feed that has not yet synced).
- Local dev server running: `npm start`.

If you do not have this setup, add a feed via the `+` control in
the sidebar, wait for the first sync, then mark the items in `F2`
as read.

## Setup

1. Open the app in a browser at the URL printed by `npm start`.
2. Sign in (Bluesky OAuth) if not already.
3. Navigate to `/` so the reading list is showing.

## Test 1 — Every feed row shows a leading count (FR-001, FR-002)

1. Look at the sidebar's feeds-list section.
2. For each row in that section (including the "All Feeds" row at
   the top of the list), confirm a number is rendered to the
   **left** of the feed name.

**Pass:** every row in the feeds-list section has a leading number.

## Test 2 — Counts agree with the data (FR-003, SC-002)

1. Click `F1` to open its `/feed/<F1>` page; note the count of
   visible unread items (the visible total reported by the pager
   plus any pages of unread items). Call it `U1`.
2. Look at the sidebar count for `F1`.

**Pass:** the sidebar count for `F1` equals `U1`.

## Test 3 — Zero is rendered, not blank (FR-004, Edge Case)

1. Look at the sidebar count for `F2` (the feed with 0 unread).

**Pass:** the value rendered is the numeral `0`, not a blank slot,
not a hidden element.

## Test 4 — Mark-as-read decrements (FR-005, AS#2)

1. Click `F1` to open `/feed/<F1>`.
2. Note `F1`'s sidebar count → call it `U1`.
3. Click an unread item in `F1` to open it (this marks it read),
   then navigate back.
4. The sidebar count for `F1` MUST now be `U1 - 1`.
5. Other feeds' sidebar counts MUST be unchanged.

**Pass:** `F1` decrements by 1, all other rows unchanged.

## Test 5 — Mark-as-unread increments (FR-005, AS#5)

1. With the item from Test 4 still open, click the "mark unread"
   control (or whatever toggles the read state back).
2. The sidebar count for `F1` MUST now be back to `U1`.

**Pass:** `F1` increments by 1, all other rows unchanged.

## Test 6 — "All Feeds" sums match (FR-008, SC-002)

1. Without reloading, look at the "All Feeds" sidebar count → `A`.
2. Sum every individual feed row's count → `S`.

**Pass:** `A === S`.

## Test 7 — Sync refresh updates counts (FR-006, AS#4)

1. Trigger a refresh that brings in new items (click "Refresh
   Feeds", or wait for the DO alarm to fire on a stale feed).
2. When the refresh settles (the syncing indicator returns to its
   idle state), confirm any feed that received new unread items
   has had its sidebar count increased by exactly the number of
   new unread items, and "All Feeds" reflects the increased sum.
3. Feeds that did not receive new items MUST be unchanged.

**Pass:** affected feeds increment correctly without a manual
reload; unaffected feeds unchanged.

## Test 8 — Filter independence (FR-009)

1. Note the per-feed and "All Feeds" counts.
2. Toggle the "Unread only" checkbox in the reading-list pane on
   and off a few times.
3. The per-feed counts and the "All Feeds" count MUST NOT change.

**Pass:** sidebar counts are invariant under "Unread only" toggle.

## Test 9 — Add a feed (FR-007)

1. Click `+` in the sidebar's feeds list and add a new feed `G`.
2. After the add settles, `G`'s row MUST appear in the sidebar
   with a numeric count (initially `0` until items are fetched).
3. Wait for the first sync of `G` to complete.
4. `G`'s sidebar count MUST update to reflect the unread items
   that were fetched, and "All Feeds" MUST update to include them.

**Pass:** new row appears with `0`, then increments after sync;
no other feeds' counts change.

## Test 10 — Delete a feed (FR-007)

1. Click the delete control on `F2` and confirm.
2. `F2`'s row MUST disappear from the sidebar.
3. Other feeds' counts MUST be unchanged.
4. "All Feeds" MUST drop by `F2`'s previous count (which was 0,
   so it stays the same — but verify that for a feed with > 0
   unread, deleting drops the sum accordingly; you may repeat
   with a small deletable test feed if needed).

**Pass:** deleted row gone, other rows unchanged, "All Feeds"
sum continues to equal the sum of remaining rows.

## Test 11 — Local-first vs. fallback (Constitution IV)

The above tests should pass identically with local-first
enabled and disabled.

1. With local-first enabled (default in supported browsers),
   re-run Test 4 and Test 7 quickly to confirm reactivity.
2. Open the app in a private window or a second tab where the
   OPFS lock is held by the first tab — this forces fallback to
   `remoteAdapter`.
3. Re-run Test 4 in that window.

**Pass:** counts update correctly in both modes.
