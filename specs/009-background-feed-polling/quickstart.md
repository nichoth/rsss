# Quickstart: Background Feed Polling

**Feature**: 009-background-feed-polling
**Audience**: an engineer verifying the feature works after
implementation, and CI authors who want to know what each acceptance
hook is.

This file lists the manual reproduction steps for each acceptance
scenario in the spec, plus the operational checks for the
measurable outcomes.

## Prerequisites

- A signed-in account with at least three subscribed feeds, ideally
  one of each:
  - **F-stable**: a feed that returns valid `ETag` and/or
    `Last-Modified` headers (most modern feeds; `https://overreacted.io/rss.xml`
    works as a public sample).
  - **F-broken**: a feed URL that returns 5xx persistently (point a
    test feed at a 500 endpoint).
  - **F-active**: any feed that publishes items at least once a day.
- `wrangler dev` running locally OR a deployed environment where you
  can read the DO's stored alarms and KV-style state via the existing
  admin tools.

## US1 (P1): Returning reader sees accurate "n updates"

1. From a signed-in browser tab, click "Refresh Feeds" and wait for
   it to complete (header shows "up to date").
2. Wait at least one base cadence (10 minutes by default) AND make
   sure F-active publishes a new item upstream during the wait. (For
   tests, a controllable test feed is easier than a live one.)
3. Reload the page **without** clicking Refresh Feeds.
4. **Expected**: the header shows the blue "n updates" pill with a
   count ≥ 1 within 2 seconds of page load (SC-001).
5. **Expected**: clicking through to the feed shows the new items.

## US1 (P1): Live transition while open

1. Sign in and leave the app open on the items list.
2. Trigger F-active to publish a new item upstream.
3. **Expected**: within `cadence + 5 s` (15 minutes worst case at the
   default 10-min cadence), the indicator transitions to "n updates"
   without any user action (SC-002).

## US1 (P1): Zero subscribed feeds

1. Sign in fresh; do not subscribe to any feeds.
2. Open the app.
3. **Expected**: the indicator shows "up to date".
4. **Expected**: alarm sweep ticks produce zero outbound HTTP
   requests (verify via `wrangler tail` or test mock counters).

## US2 (P2): Conditional GETs hit on stable feed

1. Subscribe to F-stable. Wait for the first poll to complete (a
   manual refresh works too).
2. Inspect DO storage (or a test stub) and confirm that
   `poll:feed:<id>` now contains an `etag` and/or `lastModified`
   value.
3. Wait one cadence.
4. **Expected**: the next outbound request to F-stable carries
   `If-None-Match: <etag>` and/or `If-Modified-Since: <date>`.
5. **Expected**: if the feed content has not changed, F-stable
   returns 304 and **no items are inserted, no SSE event is sent,
   and the indicator does not transition** (FR-005, FR-010).

## US2 (P2): Backoff on failing feed

1. Subscribe to F-broken (5xx persistently).
2. Watch the alarm tick at the cadence boundary; record
   `consecutive_failures` and `next_due_at` after each tick.
3. **Expected sequence**: failures = 1 → next_due_at ≈ now + 20m;
   failures = 2 → ≈ now + 40m; … doubling each time, capped at
   `FEED_BACKOFF_CEILING_MS` (24 h).
4. **Expected**: between alarm ticks where F-broken is *not* due,
   no outbound request is made for it (FR-007).
5. Switch F-broken to a working endpoint; the next time it is due,
   a successful poll resets `consecutive_failures` to 0 and
   `next_due_at` to `now + cadence`.

## US2 (P2): One bad feed does not poison the sweep

1. Subscribe to F-stable, F-broken, and F-active.
2. Trigger an alarm tick.
3. **Expected**: F-stable and F-active both poll on schedule even
   while F-broken is failing (FR-006).
4. **Expected**: the indicator state for F-stable / F-active is
   unaffected by F-broken's last_status / last_error.

## US3 (P3): Inactive accounts stop polling

1. Pick a test account with subscribed feeds.
2. Manually seed `poll:account:last_active_at` to a value 31 days in
   the past (via a test harness or admin endpoint).
3. Trigger an alarm tick (or wait for one in dev).
4. **Expected**: zero outbound HTTP requests and zero
   `fetchFeedText` invocations during the tick (SC-005). The alarm
   re-arms normally for the next cadence.
5. From a clean browser, sign in with the same account and load the
   app.
6. **Expected**: the page-load catch-up triggers a sweep
   immediately (via `ctx.waitUntil`); within one cadence + 5 s the
   indicator shows accurate counts (SC-001 fallback path).

## Edge case spot-checks

- **Two tabs**: open the app in two browser tabs; trigger a poll
  that finds new items; both tabs should converge to the same
  indicator state via the existing SSE channel (no new code
  required, just verify the regression is intact).
- **Brand-new feed**: subscribe to a feed with one known unread
  item; expect that item to appear immediately (the existing
  `POST /feeds` flow already calls `fetchFeed` synchronously) and
  the feed to be polled again at the next cadence boundary.
- **Concurrent manual + alarm**: click "Refresh Feeds" near a
  cadence boundary; expect no duplicate items in the items list
  (the `UNIQUE(feed_id, guid)` constraint and `INSERT OR IGNORE`
  guarantee FR-011).
- **Zero new items on poll**: an alarm tick that returns 200 but
  produces zero new inserts MUST NOT emit a `feed-updates-available`
  event and MUST NOT transition the indicator (FR-010); verify in
  `wrangler tail` or via the test that asserts the SSE stream.

## Operational outcomes (production verification)

- **SC-003 (≥80% conditional-GET hit rate)**: log per-poll outcome
  (`200`, `304`, `error`) and aggregate over a week. Stable feeds
  (overreacted, hacker news, most static-site generators) should
  account for the bulk of polls and most of those should be 304s.
- **SC-004 (500 feeds in one cadence)**: provision a test account
  with 500 subscribed feeds; trigger an alarm tick; verify (a) the
  cursor returns to `0` (sweep complete) within the cadence, and
  (b) origin-request count is ≤ 1 per non-failing feed per cadence.
- **SC-006 (spurious "up to date" effectively zero)**: sample N
  page loads, snapshot each `/feed-status` response, then crawl the
  same feed origins out-of-band and compare. Difference rate should
  be near-zero for feeds whose backoff is at base cadence.
