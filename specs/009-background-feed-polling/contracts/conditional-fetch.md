# Contract: Conditional Feed Fetch

**Owner**: `fetchFeedText` in `src/server/feed-fetch.ts`
**Caller**: `UserDO.fetchFeed` in
`src/server/durable-objects/index.ts`

This contract extends the existing feed-fetching helper to support
HTTP conditional GETs (FR-005, SC-003).

## Existing surface (unchanged)

```ts
export async function fetchFeedText (
    feedUrl:string,
    options:FetchFeedTextOptions = {}
):Promise<FetchFeedTextResult>
```

The redirect handling, hostname allowlist, abort-signal plumbing,
and bounded text read remain unchanged. This contract describes only
the new optional inputs and the new fields on the return value.

## Extended input

```ts
export interface FetchFeedTextOptions {
    fetchFn?:typeof fetch
    maxBytes?:number
    resolveHostname?:ResolveHostname
    signal?:AbortSignal
    // NEW:
    validators?:{
        etag?:string
        lastModified?:string
    }
}
```

When `validators` is provided:

- If `validators.etag` is present, `If-None-Match: <etag>` is added
  to the outbound request headers.
- If `validators.lastModified` is present,
  `If-Modified-Since: <lastModified>` is added.
- If both are present, both are sent (per RFC 9110 §13).
- If neither is present, the request is sent unconditionally
  (current behavior).

## Extended output

```ts
export interface FetchFeedTextResult {
    text:string         // empty string when notModified === true
    url:string          // post-redirect canonical URL (existing)
    // NEW:
    notModified:boolean // true iff origin returned 304
    etag?:string        // from response 'ETag' header on a 200; undefined on 304 or absent
    lastModified?:string // from response 'Last-Modified' header on a 200; undefined on 304 or absent
}
```

Behavior:

- **HTTP 200**: `notModified = false`, `text` is the bounded body,
  `etag` / `lastModified` are populated from response headers (when
  present). This is the path that exists today plus the new
  validator extraction.
- **HTTP 304**: `notModified = true`, `text = ''`, `etag` and
  `lastModified` are `undefined` (per RFC 9110, the response carries
  validators that match the request, not new ones; the caller
  retains its existing validators).
- **HTTP redirect (3xx other than 304)**: existing redirect loop
  handles it (`fetchValidatedResponse`). Conditional headers are
  re-sent on each redirect hop (the simplest correct behavior; the
  origin can re-evaluate against its own validators).
- **Non-2xx, non-304, non-redirect**: `FeedFetchError` thrown
  (existing behavior). The DO catches and records last_error /
  last_status and increments `consecutiveFailures`.

## Failure modes (must remain non-fatal at caller)

| Origin response | Old behavior | New behavior |
|---|---|---|
| 304 Not Modified | `FeedFetchError("status 304", 304)` | Returns `{ notModified: true, text: '', url, etag: undefined, lastModified: undefined }` |
| 200 with ETag | Returned body; ETag dropped | Returned body + ETag string |
| 200 without ETag | Returned body | Returned body, `etag` undefined |
| 4xx / 5xx | `FeedFetchError(status)` | Same |
| Network error | Thrown by `fetch` | Same |
| Redirect loop | `FeedFetchError("redirected too many times", 310)` | Same |

## Security / safety properties (preserved)

- Conditional headers are added AFTER the host allowlist check
  (`assertFeedUrlAllowed`) and AFTER DNS resolution (`validateResolvedHostname`).
  No new attack surface vs. the unconditional path.
- The bounded read (`MAX_FEED_BYTES`) is unchanged on a 200.
- A 304 is not redirect-followed by definition (see RFC 9110 §15);
  no redirect-loop-amplification risk.

## Why 304 is "success" and not "error"

`fetchValidatedResponse` currently throws on `!response.ok`. A 304 is
`ok === false` per the Fetch spec. The fix is to short-circuit 304
*before* the `!response.ok` check, treating it as a normal terminal
response. This keeps every other non-2xx as an error, preserving
current semantics for the rest of the status space.

## Test acceptance hooks

(See `quickstart.md` and existing tests under `test/feed-*`.)

- Feed returns 200 with `ETag: "abc"` → caller stores `etag = "abc"`.
- Next call with `validators.etag = "abc"` and origin returns 304 →
  result `notModified === true`, `text === ''`, no error.
- 200 → 200 with rotating ETag updates the stored validator each
  time.
- 304 then 200 with new content updates validators and triggers
  parse + insert.
- 200 without ETag and without Last-Modified leaves both validators
  undefined (no stale carryover).
