# Contract: `POST /api/items/:id/fetch-full`

This is the only externally-visible contract change introduced by this
feature. All other reads against `items` continue to use the existing
`/api/items`, `/api/items/by-route`, and `/api/sync` endpoints, which
gain three new optional fields on each item row but do not change shape.

## Endpoint

- **Method**: `POST`
- **Path**: `/api/items/:id/fetch-full`
- **Auth**: required (existing `requireAuth` middleware in
  `src/server/index.ts`).
- **Entitlement**: free-tier path (matches the `/api/items` data
  endpoints in entitlement). The endpoint goes through the proxy
  (`dataRouter.all('*', ...)`) and reaches the user's DO at
  `POST /items/:id/fetch-full`.
- **Idempotent**: yes (see Idempotency below).

## Request

### Path

- `:id` — integer item id, scoped to the authenticated user's DO.

### Body

```json
{
  "force": false
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `force` | `boolean` | `false` | When `true`, re-fetch even if the row already has `full_content_status === "succeeded"`. The user-facing Retry button sends `force: true`. |

The body MAY be omitted; an empty body is equivalent to `{ "force": false }`.

## Response

### `200 OK` — already-fetched cache hit (without `force`)

When the row already has `full_content_status === "succeeded"` and a
non-empty `full_content`, and the request did NOT pass `force: true`,
the DO returns the existing row immediately without making any
outbound HTTP request:

```json
{
  "item": {
    "id": 123,
    "feed_id": 4,
    "guid": "...",
    "title": "...",
    "link": "https://brittanyellich.com/...",
    "description": "...",
    "content": null,
    "full_content": "<p>...</p>",
    "full_content_fetched_at": "2026-05-01 12:34:56",
    "full_content_status": "succeeded",
    "...": "all other Item columns"
  }
}
```

### `200 OK` — fetch attempted

When a fetch was attempted (either because status was non-`succeeded`,
or because `force: true` was passed), the response carries the row
*after* the attempt completed. The same shape is used for both success
and failure; the caller distinguishes them by inspecting
`item.full_content_status`:

- `"succeeded"` — `full_content` is non-empty,
  `full_content_fetched_at` is the just-now timestamp.
- any `"failed_*"` — `full_content` is unchanged from before the call
  (i.e. the previous successful body, if any, is preserved on a forced
  re-fetch that fails).

### `400 Bad Request`

Returned when:

- The `:id` is not parseable as a positive integer.
- The body is invalid JSON.

```json
{ "error": "invalid_id" }
```

or

```json
{ "error": "invalid_body" }
```

### `404 Not Found`

Returned when the item id does not exist in this user's DO.

```json
{ "error": "Item not found" }
```

### `409 Conflict`

Returned when the item has no `link` (no article URL to fetch).

```json
{ "error": "item_has_no_link" }
```

### `429 Too Many Requests`

Returned when the same item has been fetched within
`FETCH_FULL_MIN_INTERVAL_MS = 5_000` and `force` was NOT passed.
This is a defensive throttle against UI bugs that auto-trigger on
every render — it does not throttle the user's deliberate Retry
clicks.

```json
{ "error": "fetch_full_throttled" }
```

The response includes a `Retry-After` header in seconds, mirroring the
existing `POST /feeds/:id/refresh` rate-limit shape.

### `503 Service Unavailable`

Returned when the DO itself is unreachable (proxy-level failure,
matches the existing pattern in
`/api/account/delete`).

```json
{ "error": "fetch_full_unavailable" }
```

The DO never returns 5xx as part of its normal article-fetch flow:
publisher-side failures are recorded on the row and returned with
`200 OK`, status `failed_*`. A 5xx out of this endpoint indicates a
genuine DO-level fault.

## Idempotency

- **No outbox**: this endpoint is a server-side derivation request and
  does not flow through the client outbox. See plan.md, Complexity
  Tracking entry 1.
- **Without `force`**: idempotent within a single fetch window. Two
  concurrent calls on a `NULL`-status row will both fetch (the DO does
  not coalesce concurrent fetches in v1; the second one will overwrite
  the first's outcome on completion, which is acceptable because both
  outcomes are derived from the same publisher URL within seconds of
  each other).
- **With `force`**: the caller explicitly opts in to re-fetch.

The endpoint does not write a `client_op_id` because there is no
client-side mutation to deduplicate; the only side effect is the
`UPDATE items SET full_content...`, which is itself idempotent under
retry (an identical fetch result writes identical row state).

## Server-side flow

1. Resolve the row by `id`. If missing → `404`.
2. If `force` is not set and `full_content_status === 'succeeded'` and
   `full_content` is non-empty → return the row unchanged.
3. If `link` is empty or fails `validateFeedUrl` → write
   `full_content_status = 'failed_network'`,
   `full_content_fetched_at = datetime('now')`, return the row.
4. Apply the throttle (`FETCH_FULL_MIN_INTERVAL_MS`) for non-forced
   calls.
5. Call `fetchValidatedResponse(link, { maxRedirects: 5,
   redirectErrorMessage: 'Article redirected too many times', signal:
   AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS) })`.
6. Inspect `Content-Type`. Non-HTML → `failed_non_html`. Bytes >
   `MAX_ARTICLE_FETCH_BYTES` while reading → `failed_too_large`.
7. Run `extractArticleBody(html, finalUrl)` →
   - `null` (no candidate root) → `failed_no_body`.
   - extracted string with `plainTextLength < EXTRACTED_MIN_TEXT` →
     `failed_no_body`.
   - oversized after extraction with no clean truncation point →
     `failed_too_large`.
8. On success, write `full_content`, `full_content_fetched_at =
   datetime('now')`, `full_content_status = 'succeeded'`. The
   `items_updated_at` trigger bumps `updated_at` so the row will be
   delivered on the next `/api/sync` page.
9. Return the updated row.

## Out-of-scope

- Bulk fetch endpoints (no `POST /api/items/fetch-full-batch`).
- Per-feed configuration of fetch behaviour.
- Server-pushed notifications when a fetch completes (the response
  carries the row inline; the client upserts immediately).
