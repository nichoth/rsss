# Quickstart: Per-Feed Pending Count In Sidebar

## Goal

Manually verify that every sidebar feed row with a pending count
greater than zero shows the `(N) ` prefix before its display name,
that zero-pending feeds show no prefix, and that the aggregate
"updates available" pill and the per-feed prefixes always agree.

## Prerequisites

- `npm install` already done.
- Bluesky OAuth credentials in local `.env` per project README.
- At least one subscribed feed with discoverable new items (or two
  feeds; one will hold pending items, one will not).

## Steps

1. **Start the dev stack.**
   - `npm start` (Vite + wrangler dev). Open the printed URL.
   - Sign in with Bluesky.

2. **Establish a non-pending baseline.**
   - Click "Refresh Feeds" once and let the aggregate pill settle
     to "up to date" (green dot).
   - In the sidebar, every feed row should show only its display
     name with no parenthesized prefix.
   - The "All Feeds" row at the top of the feeds list should also
     show no parenthesized prefix (FR-007).

3. **Trigger a pending state and observe a prefix.**
   - Either:
     - **(a)** Add a brand-new feed via the sidebar `+` button (the
       existing "defer new feed items" behavior keeps its items
       pending until the next manual refresh — Acceptance
       Scenario 5); or
     - **(b)** Wait for a background poll tick (10-min cadence) to
       discover new items in an existing feed (Acceptance
       Scenario 4).
   - Expected: the affected feed row gains a leading `(N) ` prefix,
     where `N` is the count surfaced by the SSE
     `feed-updates-available` event. The aggregate pill in the
     sidebar footer updates in the same paint to read
     `(M updates)` where `M` equals the sum of every visible
     prefix count.

4. **Verify multi-digit rendering (Acceptance Scenario 6).**
   - With at least one feed showing a multi-digit pending count
     (e.g. ≥ 100): confirm the prefix renders fully without
     truncation, and that any truncation falls on the feed-name
     text further to the right of the prefix, not on the count
     itself. Confirm the per-row delete control is still visible
     and clickable.

5. **Verify URL-fallback rendering (Edge Case).**
   - For a feed whose `title` is empty/null (sidebar renders the
     URL): confirm the prefix appears before the URL with the same
     `(N) ` format and a single space.

6. **Verify refresh clears both indicators atomically (FR-005 /
   SC-003).**
   - Click "Refresh Feeds". As the refresh completes, every
     per-feed prefix MUST disappear in the same paint as the
     aggregate pill returns to "up to date" (green) — there must
     be no flicker where the aggregate has cleared but a prefix
     remains, or vice-versa.

7. **Verify a screen-reader hears the prefix inline with the feed
   name (FR-008).**
   - With VoiceOver / NVDA, navigate the sidebar feed list. Each
     feed link with a non-zero pending count should be announced
     as a single link whose name reads as `(N) <feed name>` (for
     example, `(3) Wired, link`). The prefix must read with the
     name, not as a separate node out of order.

## Sanity-check expectations

- Sum of pending counts visible across all per-feed sidebar
  prefixes equals the aggregate pill's count at every moment
  (FR-003 / SC-002).
- A feed with zero pending items has no parenthesized prefix at all
  (FR-002 / Acceptance Scenario 2).
- The "All Feeds" pseudo-row never gets a prefix (FR-007).
- Deleting a feed removes its row and prefix together; no other
  feed's prefix changes (Acceptance Scenario 7).

## Automated coverage

`npm test` runs the suite under `test/`. The new prefix behavior is
covered by extensions to `test/sidebar-feed-counts.ts` (see
`research.md` Decision 4), exercising Acceptance Scenarios 1, 2, 3
(via direct signal write), 4 (via direct signal write), 6, 7, and
the URL-fallback / All-Feeds-row edge cases.

`npm run lint` must also pass.
