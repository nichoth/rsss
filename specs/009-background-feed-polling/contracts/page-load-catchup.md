# Contract: Page-Load Catch-Up Trigger

**Owner**: The `GET /feed-status` handler in `UserDO`
(`src/server/durable-objects/index.ts`).
**Trigger**: Any HTTP request to `/feed-status` (the page-load
indicator endpoint introduced by feature 008).

This contract describes how the page-load path primes background
polling when the alarm sweep has not run recently — for example,
when a user is returning after multiple cadences of inactivity.

## Existing /feed-status surface (unchanged)

The HTTP request, response shape, and authentication path from
feature 008 are preserved verbatim. This feature only adds work that
runs *after* the response body is computed and dispatched, behind
`ctx.waitUntil`. The caller observes:

- Identical response status code.
- Identical response body.
- Identical response timing on the page-load critical path (the
  catch-up sweep is non-blocking).

## Added behavior

After the response object is constructed (and before/after `c.json`
return — implementation choice as long as it does not delay the
response), the handler does the following:

1. Read the previously-stored `poll:account:last_active_at`
   (may be undefined on first request).
2. Decide whether to trigger a catch-up:
   ```text
   trigger = (
     prevLastActiveAt === undefined ||
     now - prevLastActiveAt > ACCOUNT_INACTIVITY_THRESHOLD_MS ||
     mostRecentSuccessfulAtAcrossFeeds < now - FEED_REFRESH_INTERVAL_MS
   )
   ```
   The third clause is the "alarm hasn't run recently for any
   reason" backstop: scan a small set of feed poller records (or a
   single aggregated counter, see Implementation Notes) to find the
   most recent successful poll across the user's feeds.
3. Write `poll:account:last_active_at = now` (always; even when no
   catch-up is triggered, the activity marker advances).
4. If `trigger`, call
   `this.ctx.waitUntil(this.refreshFeedBatches())`. This runs the
   same machinery the alarm uses; per-feed `nextDueAt` filtering
   ensures recently-polled feeds are skipped, so the catch-up does
   not double-poll healthy feeds.

## Why this is not blocking

SC-001 requires correct counts within 2 seconds of page load. A
synchronous catch-up against (potentially) 500 feeds cannot meet
that budget. Instead:

- The page-load response returns whatever the DO already has
  (which, after feature 008, is exactly the right query: pending
  items per feed).
- The catch-up runs in background. As it discovers new items, the
  existing `feed-updates-available` SSE event propagates the new
  counts to the open client, and the indicator transitions in
  place. This composes correctly with the SSE-reconnect refresh
  added by feature 008.

## Idempotency / no double-trigger

The trigger is naturally rate-limited because:

- After the first catch-up, `mostRecentSuccessfulAtAcrossFeeds` is
  recent, and the third clause becomes false until the next cadence
  rolls past.
- `last_active_at` is updated at the start, so two concurrent
  `/feed-status` calls (e.g., reconnect-on-focus) read the freshly-
  written value on the second call and both bail past the inactivity
  clause.

A small race remains: two concurrent requests can both observe an
old `last_active_at` and both call `refreshFeedBatches`. That is
acceptable — `refreshFeedBatches` itself uses the
`alarm_refresh_cursor` and per-feed `nextDueAt` filter, so two
concurrent runs converge to the same per-feed work and both honor
the manual-refresh dedupe map. No correctness violation, only at
worst a duplicated cursor walk that bails out early.

## Implementation notes

- "Most recent successful poll across feeds" is implementable
  cheaply by maintaining a single `poll:account:last_any_success_at`
  KV alongside the per-feed records. Each successful poll writes
  `Math.max(prev, now)` to that key. The `/feed-status` path then
  reads one record instead of scanning all per-feed records.
- The trigger logic SHOULD live in a small helper like
  `maybeKickCatchUp()` so the same hook can be reused on the SSE
  open path if future work wants it.

## Test acceptance hooks

- Seed `last_active_at` to 31 days ago, hit `/feed-status` →
  observe `last_active_at` advanced and a single
  `refreshFeedBatches` call (verifiable via a stub on the DO).
- Seed `last_active_at` to 1 minute ago and `last_any_success_at`
  to 1 minute ago, hit `/feed-status` → observe NO catch-up call
  (steady state).
- Hit `/feed-status` twice in quick succession after a long
  absence → both calls return promptly; only one (or at most two)
  catch-up invocations queued; no duplicate item inserts (FR-011).
