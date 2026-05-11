# Contract — `POST /api/feeds/:id/refresh`

## Before this feature (current behavior)

```http
POST /api/feeds/123/refresh
→ 200 OK
  Content-Type: application/json

{ "success": true }
```

Client must wait for SSE `feed-updated` (or the next pull-sync) to
learn the post-refresh state.

## After this feature

```http
POST /api/feeds/123/refresh
→ 200 OK
  Content-Type: application/json

{
  "feed": {
    "id": 123,
    "url": "https://example.com/feed.xml",
    "title": "Example",
    "description": "...",
    "site_url": "https://example.com",
    "last_fetched": "2026-05-10T12:34:56.000Z",
    "last_pulled_at": null,
    "last_error": null,
    "last_status": null,
    "created_at": "2026-05-10T12:34:00.000Z",
    "updated_at": "2026-05-10T12:34:56.000Z"
  }
}
```

The `feed` object MUST be the row as it exists *after* `fetchFeed`
returns (success or failure). Specifically:

- On success: `last_fetched != null`, `last_error == null`,
  `last_status == null`.
- On failure: `last_fetched == null` *or* unchanged from prior
  successful fetch; `last_error != null`; `last_status` set to the
  HTTP status (or 500 for unhandled, or 504 for timeout, etc.).

The response shape mirrors the wrapped-row convention used by
`/api/sync` conflict responses (Constitution II).

## Client handling

`State.retryResolveFeed` (`src/client/state.ts`) consumes the
response by:

1. Reading `body.feed`.
2. Calling `upsertFeedFromServer(db, body.feed)` so the local DB
   reflects the post-refresh state immediately (no wait for pull-sync
   or SSE).
3. Reloading the feeds signal (`State.loadFeeds`).

## Error responses

Unchanged from current behavior:

```http
404 Not Found
{ "error": "Feed not found" }

401 Unauthorized
{ "error": "Not authenticated" }
```

## Idempotency

Every call triggers a fresh fetch attempt. The endpoint is
**not** idempotent in the sense of "no-op on repeat" — that is by
design (the user is explicitly asking to retry). It is, however,
safe to call: there is no constraint violation, no duplicate row
created, and the outcome is captured server-side regardless of how
many times it's called.
