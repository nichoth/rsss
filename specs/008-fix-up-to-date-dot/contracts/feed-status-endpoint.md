# Contract: `GET /api/feed-status`

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

The Worker proxies any unmatched `/api/*` request to the caller's
Durable Object, so this endpoint is implemented as `GET /feed-status`
on `UserDO` and reachable to authenticated clients at
`/api/feed-status`.

## Purpose

Single round-trip page-load comparison between the server's pulled-
state markers and the items the server holds. Drives the header
"n updates / up to date" indicator (FR-001, FR-010, SC-004).

## Authentication

- Required. Routed under `dataRouter.use('*', requireAuth)`. Returns
  `401` for unauthenticated requests.
- Free (non-entitled) users **are** allowed (the indicator must work
  in online-only mode per FR-004); the endpoint does not go through
  `requireEntitlement`.

## Request

```http
GET /api/feed-status HTTP/1.1
Cookie: <session>
X-CSRF-Token: <token>          # only if present (CSRF middleware
                               # enforces it on state-changing
                               # methods; harmless on GET)
```

No query parameters. No body.

## Response

### 200 OK

```json
{
    "feedUpdateCounts": {
        "<feedId>": <pendingCount>,
        ...
    },
    "totalPending": <number>
}
```

- `feedUpdateCounts` includes one entry per subscribed feed; feeds
  with `0` pending are present so the client can detect feeds whose
  pending count went to zero between events. (Symmetric with the
  existing `feed-updates-cleared` event.)
- `totalPending` is the sum of `feedUpdateCounts` values; provided as
  a convenience so the client does not have to recompute it on every
  render.
- A reader with zero subscribed feeds receives `feedUpdateCounts: {}`
  and `totalPending: 0` (edge-case in spec).

### 401 Unauthorized

```json
{ "error": "unauthorized" }
```

The client treats `401` as a session expiry: clears the user, sets
`feedSyncStatus = 'error'`, navigates to `/login` (consistent with
existing `PullSyncAuthError` handling).

### 5xx Server Error

```json
{ "error": "<short opaque message>" }
```

The client treats any non-OK response as a status failure: sets
`feedSyncStatus = 'error'`, `feedSyncError` = the message (FR-012,
SC-006). The indicator MUST NOT silently revert to "up to date".

## Performance

- Cost is one `LEFT JOIN ... GROUP BY feeds.id` over `items` per
  request; this is the same query already used by
  `getFeedUpdateCounts()` for `GET /feeds`.
- One round trip regardless of subscribed-feed count (FR-010,
  SC-004).
- No write side-effects, no broadcast.

## When the client calls it

1. After auth lands and the adapter is resolved (replaces the
   indicator-state side effect of `loadFeeds()`).
2. After every `EventSource` `open` past the first one (i.e.
   reconnect; FR-007).
3. After `online` event fires (mirrors existing `runSync` rerun).
4. After `refresh-complete` SSE event (defensive; the event already
   sets `feedUpdateCounts = {}`, but a status reconcile guarantees
   correctness even if items arrived during the refresh).
