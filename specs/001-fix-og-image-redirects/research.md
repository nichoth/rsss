# Phase 0 Research: Fix OG-Image Redirect Errors

This document resolves the unknowns implied by the spec and the technical
context. There are no `NEEDS CLARIFICATION` markers in the plan.

## R-1: How many redirect hops should an article-page fetch tolerate?

**Decision**: 5 hops (a fetch may follow up to 5 redirects before
returning `null`).

**Rationale**:

- The spec asserts (FR-002, Assumptions §1) that ~5 hops covers the
  overwhelming majority of legitimate cases (http→https,
  apex→www, locale/device redirects, syndicated link unwrapping).
- 5 is also the default cap in `curl --max-redirs` documentation examples
  and is comfortably below the browser default (~20), keeping
  thumbnail-enrichment latency bounded.
- Going higher buys very little real-world success (the long tail is
  dominated by genuine loops or paywalls) but increases worst-case
  latency per item under the 10s `OG_IMAGE_FETCH_BUDGET_MS`.

**Alternatives considered**:

- **Match the browser default (~20)**: rejected. Doubles worst-case
  per-item time without measurable thumbnail-success gain.
- **Keep the existing 3**: rejected. This is the bug we are fixing
  (FR-002).
- **Make the budget configurable per feed**: rejected as
  out-of-scope. The spec does not request per-feed tuning, and the
  added surface would violate "do not introduce abstractions beyond
  what the task requires".

## R-2: How should the redirect budget be wired through `fetchValidatedResponse`?

**Decision**: Add an internal `maxRedirects` option to
`fetchValidatedResponse` (the shared helper in `src/server/feed-fetch.ts`).
`fetchFeedText` keeps the existing default `MAX_FEED_REDIRECTS = 3`.
`fetchOgImage` passes a new module-level constant
`MAX_ARTICLE_REDIRECTS = 5`.

**Rationale**:

- Keeps the change minimal: one shared helper, one extra option, two
  call sites use distinct constants.
- The two budgets are clearly named at the top of the file, so
  future readers see at a glance that feed-XML and article paths
  differ on purpose.
- No public API change. `FetchFeedTextOptions` and `FetchOgImageOptions`
  do not need to expose `maxRedirects` to callers; it is set internally.

**Alternatives considered**:

- **Two separate fetcher functions**: rejected. The redirect/SSRF/host
  validation logic is identical between the two paths; duplicating it
  invites the two copies to drift on a future security fix.
- **Expose `maxRedirects` on the public option types**: rejected. No
  caller outside this module needs it; YAGNI.

## R-3: What error message should the article-fetch redirect cap throw?

**Decision**: Throw a distinct message — `'Article redirected too many
times'` — when the article-page path exceeds `MAX_ARTICLE_REDIRECTS`.
The existing `'Feed redirected too many times'` message stays on the
feed-XML path.

**Rationale**:

- The bug report explicitly cited the misleading log line "Feed
  redirected too many times" surfacing during article enrichment.
- `fetchOgImage` already returns `null` on any thrown
  `FeedFetchError` and the DO no longer emits `console.error` for it
  (R-4), so the message is mostly diagnostic. But if the message ever
  *does* surface (debug log, future test failure, future DEBUG flag),
  it will accurately describe what was redirecting.
- Keeping the feed-XML message identical means FR-005's "clear,
  accurate error against that one feed" continues to work without UI
  copy changes or any consumer of the existing string breaking.

**Alternatives considered**:

- **Generic message that works for both**: rejected. Erases the
  feed-vs-article distinction the user said is confusing.
- **Add a `kind: 'feed' | 'article'` field on `FeedFetchError`**:
  rejected as premature abstraction. No caller branches on it today.

## R-4: How quiet should OG-enrichment failures be?

**Decision**: Drop the two `console.error('Error fetching og image
for …', err)` call sites in `fetchOgImageBeforeDeadline` (the
`onError` callback at line ~1290 and the outer `catch` at line
~1301). Do **not** introduce a replacement debug log in this change.

**Rationale**:

- FR-003 requires that enrichment failure "MUST NOT emit an
  error-level entry under normal operation".
- FR-004 says diagnostic logging *MAY* be added behind a debug flag,
  but does not require it. Per "don't add features beyond what the
  task requires", we omit the debug log until a real diagnostic need
  appears.
- Failure information is still implicitly observable: the item lands
  with `thumbnail_url IS NULL`, which is queryable.
- Genuine programmer errors (a thrown non-`FeedFetchError`) inside
  `fetchOgImage` would still surface — but only via the
  `Promise.allSettled` rejection logging in `updateNewItemThumbnails`
  (which fires on truly unexpected throws, not on the controlled
  `null` return path).

**Alternatives considered**:

- **Log at `console.debug`**: rejected for now. Adds no value in
  production (where debug is filtered) and clutters local dev when
  refreshing real feeds.
- **Increment an in-memory failure counter and expose via
  `/api/health`**: rejected as scope creep. Easy to add later if
  operators want it.

## R-5: Does the feed-XML failure path need adjustment?

**Decision**: No code change to the feed-XML path. The existing
`catch (err) { console.error("Error fetching feed ${feed.url}", err);
this.sql.exec("UPDATE feeds SET last_error = …") }` already satisfies
FR-005 (record against the feed, surface message, keep other feeds
running). This plan only verifies the path with a regression test.

**Rationale**:

- FR-005 is already implemented today; the bug only afflicts the
  *article-page* path.
- Touching the feed-XML path risks regressions on the
  user-visible "feed last_error" surface.

**Alternatives considered**: none warranted.

## R-6: How do we test "no error-level log line under normal refresh"?

**Decision**: Add a new test in `test/feed-parser.ts` that:

1. Stubs `globalThis.fetch` so the article URL returns 302→302→302→302
   (more than the new article budget).
2. Spies on `console.error` for the duration of the refresh.
3. Asserts the spy was not called with a string matching
   `/redirected too many times/i` or `/og image/i`.
4. Asserts the new item still inserts (with `thumbnail_url IS NULL`,
   or with the feed-supplied image when provided).

**Rationale**:

- Mirrors the existing stubbing style in `test/feed-parser.ts`.
- Console-spy assertions are the most direct way to encode FR-003/4.
- The existing redirect-cap unit test in `test/feed-fetch-security.ts`
  covers the "returns null after too many redirects" branch; we update
  its expected call count from 4 to 6 (initial + 5 redirects), and add
  a parallel test for `fetchFeedText` confirming the feed budget
  remains 3.

**Alternatives considered**:

- **Integration test against a real network**: rejected. Flaky and
  slow; existing tests already use stubbed `fetch`.

## Summary of constants and signatures introduced

```ts
// src/server/feed-fetch.ts (top of file)
const MAX_FEED_REDIRECTS = 3       // unchanged
const MAX_ARTICLE_REDIRECTS = 5    // new

// internal
async function fetchValidatedResponse (
    inputUrl:string,
    options:FetchFeedTextOptions & { maxRedirects?:number }
):Promise<{ response:Response; url:string }>

// fetchFeedText:    uses maxRedirects = MAX_FEED_REDIRECTS,
//                   throws 'Feed redirected too many times'
// fetchOgImage:     uses maxRedirects = MAX_ARTICLE_REDIRECTS,
//                   throws 'Article redirected too many times'
//                   (caught internally; returns null)
```

No public type changes. No new exports. No new dependencies.
