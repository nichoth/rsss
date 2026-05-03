# Quickstart: Verify Sidebar Badge Tracks "Unread only"

**Branch:** `004-unread-only-count`
**Spec:** `./spec.md`

This is the manual browser verification required by the constitution
(Development Workflow & Quality Gates → Local verification: "UI
changes MUST be exercised in a browser before being claimed
complete"). Run it after `npm test && npm run lint` pass.

## Prerequisites

- A signed-in user with at least 1 read item AND at least 1 unread
  item across all subscribed feeds. If you don't have this, add a
  feed (any RSS feed will do), wait for items to appear, mark one as
  read, and leave at least one unread.
- Local dev server running: `npm start`.

## Setup

1. Open the app in a browser at the URL printed by `npm start`.
2. Sign in (Bluesky OAuth) if not already.
3. Navigate to the root route `/` so "All Items" is the active
   sidebar entry.

## Test 1 — Filter off shows total (FR-002, AS#1)

1. Confirm the "Unread only" checkbox below the reading list is
   **unchecked**.
2. Note the number rendered in the "All Items" sidebar badge → call
   it `N`.
3. Scroll/page through the reading list; count should match `N`
   (within paging — the `itemsTotal` shown next to the pager should
   equal `N`).

**Pass:** `N` equals the visible reading list size with the filter
off.

## Test 2 — Filter on shows unread (FR-003, AS#2)

1. Check the "Unread only" checkbox.
2. Without reloading, observe the "All Items" sidebar badge. It
   MUST drop to a smaller (or equal) number — call it `U`.
3. Scroll/page through the now-shorter reading list; the visible
   total (next to the pager) MUST equal `U`.

**Pass:** badge updates to `U` ≤ `N`, and the visible list size
matches `U`.

## Test 3 — Toggle back returns to total (AS#3)

1. Uncheck "Unread only".
2. Badge MUST return to `N`.

**Pass:** badge value flips back to `N` immediately.

## Test 4 — Mark-as-read keeps badge in sync (FR-005, AS#4)

1. Check "Unread only". Badge shows `U`.
2. Click any visible item to open it (this marks it read), then
   navigate back to the list.
3. Badge MUST now show `U - 1`. The item that was just read MUST
   no longer be in the visible list.

**Pass:** badge decrements by 1, list shrinks by 1, both agree.

## Test 5 — Mark-as-read with filter off (AS#5)

1. Uncheck "Unread only". Badge shows `N` (or `N` minus any items
   read in test 4 — the total is unchanged by reads, so `N`).
2. Click an unread item to mark it read, then navigate back.
3. Badge MUST still show `N` (total does not move on a read flip).
4. The item MUST still be visible in the list.

**Pass:** badge stays at `N`; item is still listed but rendered as
read.

## Test 6 — Starred badge unaffected (FR-006)

1. Note the "Starred" sidebar badge value → call it `S`.
2. Toggle "Unread only" on and off a few times.
3. The "Starred" badge MUST remain `S` throughout.

**Pass:** Starred badge does not change.

## Test 7 — Empty unread (Edge Case)

1. Mark all items as read (the "Mark all read" button if available,
   or read each remaining unread item).
2. Check "Unread only".
3. Badge MUST show `0`. Reading list MUST be empty.

**Pass:** badge is `0` and list is empty; both agree.

## Test 8 — Per-feed route stays global (Edge Case)

1. Click any individual feed in the sidebar to navigate to
   `/feed/<feed>`.
2. The "All Items" sidebar entry is no longer active, but its
   badge value MUST still equal `N` (filter off) or `U` (filter
   on). It is the **global** count, not the count for the visible
   per-feed list.

**Pass:** "All Items" badge continues to track the global filter
state, independent of which feed is being viewed.
