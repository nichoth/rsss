# Contract: Polling Sweep (DO Alarm)

**Owner**: `UserDO.alarm()` and `UserDO.refreshFeedBatches()` in
`src/server/durable-objects/index.ts`
**Trigger**: Cloudflare Durable Object alarm, fired by
`ctx.storage.setAlarm()`.

This contract describes how the DO performs a background polling
sweep across the user's subscribed feeds. It is a server-internal
contract: there is no HTTP surface and no client visibility beyond
the existing `/feed-status` and `feed-updates-available` SSE event
from feature 008.

## Pre-conditions

- The DO is alive (Cloudflare wakes it on the alarm).
- An alarm time was previously set; on first construction, the DO
  schedules an alarm at `now + FEED_REFRESH_INTERVAL_MS` if none
  exists (existing code at construction time, lines ~341-347).

## Invariants

1. The next alarm MUST be re-armed before any feed work starts
   (`scheduleNextFeedRefresh` is called at the top of `alarm()`).
   This guarantees the sweep continues even if the in-progress
   sweep crashes or hibernates mid-flight.
2. A failure in any single feed's poll MUST NOT halt the sweep
   (FR-006). The existing `fetchFeed` already swallows per-feed
   errors and writes `last_error` / `last_status` instead of
   throwing.
3. The sweep MUST NOT modify `feeds.last_pulled_at`. Only the
   client-initiated pull contract (feature 008) may advance that
   column.

## Algorithm

```text
on alarm():
    1. Run any pending account-deletion housekeeping (existing).
    2. Re-arm next alarm at now + FEED_REFRESH_INTERVAL_MS.
    3. Read poll:account:last_active_at.
       If now - lastActiveAt > ACCOUNT_INACTIVITY_THRESHOLD_MS:
         return immediately. (FR-008, SC-005)
    4. Resume the existing batch cursor (alarm_refresh_cursor)
       and walk feeds in id order, FEED_REFRESH_CONCURRENCY at a
       time, but filter each batch to only those feeds where
       PollerFeedState.nextDueAt <= now.
       (Feeds with no PollerFeedState are treated as due.)
    5. For each due feed, call pollFeed(feed):
        a. Read PollerFeedState.{etag, lastModified} from DO storage.
        b. If a manual refresh for this feed is in flight
           (manualRefreshClaims), skip and let the manual refresh win.
        c. Call fetchFeedText(feed.url, { etag, lastModified }).
        d. Write back to DO storage based on the result:
           - HTTP 304: increment lastSuccessfulAt, reset
             consecutiveFailures = 0, recompute nextDueAt =
             now + baseCadence. DO NOT parse, DO NOT insert,
             DO NOT broadcast.  (FR-005, FR-010)
           - HTTP 200: parse + INSERT OR IGNORE items (existing
             fetchFeed body), update validators (etag/lastModified
             from response), reset consecutiveFailures = 0,
             nextDueAt = now + baseCadence. Broadcast
             feed-updates-available iff at least one new item was
             inserted (FR-010).
           - Error / non-2xx / non-304: write last_error /
             last_status (existing), increment consecutiveFailures,
             compute nextDueAt = now + min(
                 baseCadence × FEED_BACKOFF_MULTIPLIER^failures,
                 FEED_BACKOFF_CEILING_MS).
       e. Catch + log errors per feed; do not propagate (FR-006).
    6. Continue until the cursor returns no more feeds; then clear
       the cursor (existing behavior).
```

## Post-conditions

- Every due feed has been polled exactly once during the sweep
  (manual-refresh dedupe excepted).
- Every poll attempt has updated the corresponding
  `poll:feed:<id>` record.
- No spurious `feed-updates-available` event was emitted (FR-010).
- The next alarm is armed for `now + FEED_REFRESH_INTERVAL_MS`.

## Concurrency contract with manual refresh

| Background sweep state | Manual `POST /feeds/:id/refresh` | Outcome |
|---|---|---|
| Idle | New refresh starts | Manual refresh runs; no conflict. |
| In-flight on feed F | New refresh on feed F arrives | The existing `manualRefreshClaims` map coalesces — manual call awaits or skips per current behavior; no double fetch. |
| In-flight on feed G | New refresh on feed F arrives | Both proceed; different feeds. |
| About to poll feed F | Manual refresh in flight on F | Sweep skips F this cycle and lets the manual refresh complete; next sweep tick will poll F if still due. |

Per-feed `INSERT OR IGNORE INTO items` on `UNIQUE(feed_id, guid)`
is the final correctness backstop: even with double fetches, no
duplicate items are produced (FR-011).

## Test acceptance hooks

(See `quickstart.md` for the manual reproduction steps.)

- A feed with persistent 5xx must show `consecutive_failures`
  incrementing across alarm ticks and `next_due_at` doubling each
  time, capped at the ceiling.
- A feed with stable content and a working ETag must show 304s on
  subsequent ticks and zero new items inserted.
- An account marked inactive (manual seed of `last_active_at`) must
  show zero `fetchFeedText` calls during alarm ticks, and the alarm
  re-arm continues to fire on cadence.
