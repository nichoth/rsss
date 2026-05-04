# Contract: `CountsResponse` (extended)

**Branch:** `005-feed-unread-counts`
**Surface:** `DbAdapter.getCounts()` (both adapters) + the underlying
`GET /api/items/count` HTTP endpoint that backs the remote adapter.
**Files:**

- `src/client/db/types.ts` — type definition
- `src/client/db/local-adapter.ts` — local producer
- `src/client/db/remote-adapter.ts` — remote consumer (HTTP body)
- `src/server/durable-objects/index.ts` `app.get('/items/count')` —
  remote producer (HTTP body)

## Wire shape (after this feature)

```ts
interface CountsResponse {
    unread:number                       // unchanged
    starred:number                      // unchanged
    total:number                        // unchanged
    perFeed:Record<string, number>      // NEW
}
```

JSON example:

```json
{
  "unread": 7,
  "starred": 2,
  "total": 42,
  "perFeed": {
    "1": 3,
    "4": 4
  }
}
```

## `perFeed` semantics

- **Keys** are the stringified primary key of the producing
  storage's `feeds.id` row. The server returns native integer
  ids; JSON serializes object keys as strings; TypeScript types
  the map as `Record<string, number>` to match the wire and to
  match the `String(feed.id)` lookup the renderer uses.
- **Values** are non-negative integers — the count of rows in
  `items` for that `feed_id` where `is_read = 0`.
- **Omission rule:** Feeds whose unread count is `0` MAY be
  omitted from the map. Consumers MUST treat a missing key as
  `0`. Producers in this feature WILL omit zeros (the natural
  output of `GROUP BY feed_id`).
- **Invariant:** `Object.values(perFeed).reduce((a,b) => a+b, 0)
  === unread`. The producer runs the same `is_read = 0`
  predicate for both fields atomically inside the same DB
  round-trip, so this holds at any settled state.

## Producer query (logical, identical on both sides)

```sql
SELECT feed_id, COUNT(*) AS unread
  FROM items
 WHERE is_read = 0
 GROUP BY feed_id
```

Both producers transform the rows into a plain object and emit it
under the `perFeed` key. The server-side `unread`/`starred`/`total`
queries (already three single-row aggregates) are unchanged.

### Server (DO) — `app.get('/items/count')`

Adds one extra `this.sql.exec(...)` after the existing three. Maps
the result into the JSON response object. No other changes. The
endpoint remains GET, JSON, no parameters.

### Local — `localAdapter.getCounts()`

Adds one extra `queryDb` call after the existing combined COUNT
query. Builds the `Record<string, number>` from the rows. Same
return type.

## Compatibility

- **Older clients hitting a newer server** (worker rolling forward
  before the SPA bundle): existing fields (`unread`/`starred`/
  `total`) are unchanged, so the badge in `SidebarItem` keeps
  working. `perFeed` is silently ignored by older code.
- **Newer client hitting older data path** (e.g. cached worker
  during deploy): the renderer reads `counts.value.perFeed[id]
  ?? 0`. With `perFeed === undefined`, the lookup throws.
  **Producer guarantee:** both producers MUST always include the
  `perFeed` key (an empty `{}` if no items are unread); the
  initial signal value also includes `perFeed: {}`. This makes
  the consumer side never see `undefined`.

## Non-changes (explicit)

- `GET /api/items/count` URL, method, request body, and response
  status codes are unchanged.
- `DbAdapter` interface keeps `getCounts(): Promise<CountsResponse>`;
  no new method, no new parameter.
- `state.counts` signal type continues to be `Signal<CountsResponse>`.
- No changes to `getFeeds`, `getItems`, or `updateItem`.
