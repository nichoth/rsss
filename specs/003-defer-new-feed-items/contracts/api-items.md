# Contract: `GET /api/items` (semantic change)

**Status:** Existing endpoint, semantic change. No URL or query
parameter changes. No response shape changes.

## Behavior change

The endpoint MUST return only **synced** items, defined by the
reading-list visibility rule in `data-model.md`:

- Item's feed has `last_pulled_at IS NOT NULL`, AND
- Item's `pub_date IS NULL`, OR
- Item's `pub_date <= feeds.last_pulled_at`.

Equivalent SQL fragment (added to the existing
`JOIN feeds ON items.feed_id = feeds.id WHERE 1=1` clause):

```sql
AND (
    items.pub_date IS NULL
    OR (
        feeds.last_pulled_at IS NOT NULL
        AND items.pub_date <= feeds.last_pulled_at
    )
)
```

The same predicate MUST be applied to the count(*) query that
populates the response's `total` field, so pagination remains
consistent.

## Response (unchanged shape)

```json
{
    "items": [ /* item rows */ ],
    "total": 0,
    "limit": 50,
    "offset": 0
}
```

## Adapter parity

`localAdapter.getItems()` MUST apply the same predicate against the
local SQLite, joining `items` with `feeds` on `feed_id`. Existing
filters (feedId, isRead, isStarred) are unaffected.

## Negative cases (assertions)

- A reader with one feed whose `last_pulled_at IS NULL`: the endpoint
  returns `{items: [], total: 0}`.
- A reader who has clicked "Refresh Feeds" once and the server has
  since fetched newer items: the endpoint returns only items with
  `pub_date <= last_pulled_at`. Newer items are absent.
- A reader who marks an item read or starred: the read/starred state
  flips, but the visibility rule still applies — operations on
  un-synced items are not exposed via this endpoint because un-synced
  items are not returned. (Marking via `GET /feeds/:id/pending` is
  out of scope for this feature.)

## Out of scope

- `GET /feeds/:id/pending` is unchanged. It is the canonical endpoint
  for the un-synced set and continues to use
  `pub_date > COALESCE(last_pulled_at, '1970-01-01')`.
- `GET /items/count` and `GET /items/by-route` (the per-feed sidebar
  unread counts) are unchanged per FR-009.
