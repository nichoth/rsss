# Quickstart: Defer New Feed Items Until Refresh

This is the canonical manual-test flow for verifying the feature
end-to-end after implementation. It maps each step to the spec's
acceptance scenarios. Run it in a real browser per the constitution's
local verification rule (type-check and unit tests are not
sufficient evidence on their own).

## Prerequisites

- `npm start` running cleanly.
- Logged in as a test user via Bluesky OAuth (or the dev login if
  available in development).
- At least one already-subscribed feed with several items in the
  reading list, so you can visually confirm the reading list does
  NOT change.
- A second tab is NOT open against the same OPFS handle (v1 single
  tab).

## Step 1 — Baseline

1. Note the contents of the reading list (top item title is enough).
2. Note the value of the un-synced counter dot (may be hidden if
   zero).
3. Note the state of the sync status pill in the header
   ("synced" expected if you have refreshed recently).

## Step 2 — Add a feed (US1, FR-001..FR-006)

Use a feed URL that has at least 3 posts and is NOT already in your
subscriptions. Suggested:

- `https://brittanyellich.com/index.xml`
- `https://piccalil.li/feed.xml`
- `https://interconnected.org/home/feed`

Submit the "Add" form.

**Expected:**

- Sidebar gains the new feed entry within ~1s. (FR-004)
- Reading list contents are visually unchanged. The top item's
  title is still the one you noted in Step 1. (FR-002, AC1)
- Un-synced counter dot becomes visible (or its number increases by
  the number of items the new feed contributes, N). (FR-003, AC1,
  AC2, SC-002)
- Sync status pill transitions to "updates available" (unless it was
  already in a more dominant state like syncing/error/offline).
  (FR-006, US3 AC1)
- The "Refresh Feeds" button is enabled.

**Failure modes to watch for:**

- Reading list flickers or briefly shows the new items, then
  reverts. This is a regression — the filter is being applied late.
- Counter does not update. Re-check that the SSE handler ran (the
  network panel should show a `text/event-stream` connection with a
  `feed-updates-available` event).

## Step 3 — Click "Refresh Feeds" (US2, FR-005)

**Expected:**

- Sync status pill transitions to "syncing" while in flight.
  (US2 AC3)
- After refresh completes, the reading list now contains the new
  feed's posts in their correct chronological positions.
  (US2 AC1, SC-001 inverse)
- Un-synced counter clears to zero (dot hidden). (US2 AC1)
- Sync status pill returns to "synced".

**Failure modes to watch for:**

- Reading list does not update. The cursor was not advanced for the
  new feed. Check that `advanceFeedCursor` was called on the
  newly-added feed inside the `/feeds/refresh` handler.
- Counter does not clear. Check that the `refresh-complete` SSE was
  received and that `feedUpdateCounts` was reset to `{}`.

## Step 4 — Add a feed with zero items (Edge case)

Use any feed URL whose source happens to have no items today, or
a deliberately empty test feed.

**Expected:**

- Sidebar gains the new entry.
- Reading list unchanged.
- Un-synced counter unchanged. (FR-007 indirect, AC4 of US1)

## Step 5 — Add a duplicate feed (Edge case)

Submit the same URL you added in Step 2 (post Step 3).

**Expected:**

- The existing duplicate response message appears.
- Reading list unchanged.
- Un-synced counter unchanged.
- Sync status pill unchanged. (FR-007)

## Step 6 — Add an invalid URL (Edge case)

Submit an obviously bad URL ("not a url").

**Expected:**

- The existing add-feed error message appears.
- Reading list unchanged.
- Un-synced counter unchanged.
- Sync status pill unchanged. (FR-007, FR-008)

## Step 7 — Local-first vs remote-fallback parity

Repeat Steps 1-3 in two contexts:

a. With local-first enabled (`syncSubscriptions` setting on,
   cross-origin-isolated, OPFS available): the reading-list filter
   runs against the local SQLite.

b. With local-first disabled (e.g., `syncSubscriptions` off, or in
   a private window without OPFS): the reading-list filter runs on
   the server.

**Expected:** identical user-visible behavior in both contexts.

## Step 8 — Cross-session persistence (US2 AC4)

After Step 2 (add-feed succeeded, but BEFORE clicking Refresh),
fully reload the page.

**Expected:**

- Reading list still does not contain the new feed's items.
- Un-synced counter still reflects the pending count.
- Sync status pill is still "updates available".

This verifies that the deferred state is not held only in client
memory.

## Step 9 — Multiple feeds added in rapid succession (Edge case)

Add three feeds back-to-back without clicking Refresh between them.

**Expected:**

- Reading list unchanged throughout.
- Counter accumulates the total pending posts across all three
  feeds.
- Single click of "Refresh Feeds" surfaces all of them at once.

## Mapping to Success Criteria

| Step | Covers |
|---|---|
| 2     | SC-002, SC-001 (no change), SC-005 (with empty feed) |
| 3     | SC-003, SC-001 inverse (refresh promotes deferred items) |
| 5, 6  | SC-006 |
| 8     | persistence assumption |

If all expected behaviors hold, the feature is complete per the
spec's measurable outcomes.
