# Contract: SSE event `feed-updates-available`

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)
**Stream**: `GET /api/events` (existing)

## Purpose

Push-side counterpart to `GET /api/feed-status`: when the server
detects new items on a subscribed feed, it broadcasts the canonical
per-feed pending count(s) so the indicator can update without polling
(FR-005, FR-006).

## Today (before this feature)

```text
event: feed-updates-available
data: {"feedIds":["<feedId>", ...]}
```

- Sent once per `fetchFeed` call **only when**
  `newItems.length > 0 && !wasAlreadyUnsynced`.
- No counts; the client increments `feedUpdateCounts[feedId]` to `1`
  on first sight, and never again for that feed.

Two consequences this feature fixes:

1. Once a feed is in the unsynced set, additional items do not
   broadcast, so the displayed total stops growing (violates
   Acceptance Scenario 2.2).
2. The displayed count is "1 update" no matter how many items
   actually arrived.

## After this feature

```text
event: feed-updates-available
data: {"feedUpdateCounts":{"<feedId>":<pendingCount>, ...}}
```

- Sent for every `fetchFeed` call where `newItems.length > 0`,
  regardless of `wasAlreadyUnsynced`.
- `feedUpdateCounts` carries the canonical pending count for each
  affected feed (computed via `getFeedUpdateCounts()` filtered to the
  feeds touched by this fetch). It is an absolute value, not a
  delta.

The companion event `feed-updates-cleared` is unchanged in shape:

```text
event: feed-updates-cleared
data: {"feedIds":["<feedId>", ...]}
```

The client interprets clear as "remove these keys from
`feedUpdateCounts`", same as today.

## Client merge semantics

- On `feed-updates-available`:

  ```ts
  state.feedUpdateCounts.value = {
      ...state.feedUpdateCounts.value,
      ...payload.feedUpdateCounts
  }
  state.feedSyncStatus.value =
      total(state.feedUpdateCounts.value) > 0 ? 'updates' : 'synced'
  ```

  Overwrite, do not increment. A `0` value in the payload (a feed
  whose pending count went to zero) MUST result in the entry being
  removed from the map.

- On `feed-updates-cleared`: as today.
- A subscriber that receives an event whose `feedId` is not in the
  user's current feeds list MUST ignore it (edge case: feed unsubscribed
  in another tab).

## Backwards compatibility

The change is internal to RSSS (only its own client consumes this
SSE channel). The shape change does not need a version negotiation,
but the client SHOULD tolerate the legacy `feedIds` shape for the
duration of one deploy window (treat it as "fetch
`/api/feed-status` to recover the count"). Implementation is free to
drop this fallback after the deploy stabilizes.

## Why "absolute counts" instead of "deltas"

Deltas require both ends to agree on every operation that mutates the
count, including operations the client cannot observe (e.g. a feed
deletion racing an in-flight fetch). Sending the canonical count
makes the client a passive renderer of state, which removes a class
of arithmetic-drift bugs and matches the SSE channel's
"best-effort + reconcile" model.
