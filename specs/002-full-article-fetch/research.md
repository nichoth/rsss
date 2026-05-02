# Phase 0 Research: Fetch Full Article Body When Feed Provides Only a Summary

This document resolves the technical decisions implied by the spec and
records the rationale and alternatives. There are no `NEEDS
CLARIFICATION` markers in the plan.

## R-1: How does the reader detect "summary-only" without a model call?

**Decision**: A deterministic, item-data-only heuristic implemented in
`src/shared/article-detect.ts`:

```text
isSummaryOnly(item) ⇔
   item.link is non-empty AND
   plainTextLength(bestBody(item)) < SUMMARY_TEXT_THRESHOLD
```

where:

- `bestBody(item)` is `item.content || item.description || ''` (mirrors
  the existing item-reader fallback chain).
- `plainTextLength` strips HTML tags, decodes entities, collapses
  whitespace, and counts Unicode code points.
- `SUMMARY_TEXT_THRESHOLD = 1500`.
- The heuristic is *pure* (input-only, no I/O), exported from
  `src/shared/`, and used identically on client (gate the auto-trigger)
  and server (gate the actual fetch).

**Rationale**:

- FR-001 requires the detection to be deterministic and testable from
  item data alone (no model calls). A length threshold is the simplest
  defensible rule.
- 1500 plain-text characters is roughly the boundary between "teaser"
  and "real post". A typical RSS summary is 200–800 chars; a real post
  is rarely below 1500 chars. The spec accepts that "a short
  legitimately-tiny post will be treated as a summary and trigger one
  on-demand fetch on first open" (Assumption §5).
- Putting the heuristic in `src/shared/` means the client and server
  agree by construction. The server still re-checks before fetching
  (defence in depth: client logic could regress).

**Alternatives considered**:

- **Sniff for "Continue reading…" / "Read more" markers**: rejected
  alone (publisher copy varies enormously and matchers rot), kept as
  a possible *additive* signal for a future tuning pass.
- **Word-count instead of code-point count**: rejected. Word counts
  diverge across CJK / scripts; code-point length is more robust.
- **Per-feed override ("this feed is summary-only, always fetch")**:
  rejected as out-of-scope (spec Assumptions: "OPML-level 'always
  fetch full article' preferences ... [are] out of scope").

## R-2: Where does the full body live, and how does the client see it?

**Decision**: Server-authoritative, with the row mirrored to the client
through the existing `/api/sync` payload.

- Three new columns on `items`:
  - `full_content TEXT` — the extracted, sanitised body (HTML).
  - `full_content_fetched_at TEXT` — ISO timestamp of last successful
    fetch (NULL if never succeeded).
  - `full_content_status TEXT` — one of the values listed in R-7.
- Columns are added in `src/shared/schema.ts` (TABLES_SQL), so the DO
  schema and the local SQLite schema stay literally identical.
- DO migration `migrateAddItemFullContent` adds the three columns to
  pre-existing rows (`USER_DO_MIGRATION_VERSION` bumps 4 → 5).
- `pullSync.upsertItem` and `pushSync.upsertItemFromServer` are
  extended to copy the three columns. `ITEM_SYNC_COLUMNS` and
  `ITEM_COLUMNS` in the DO are extended.
- The fetch-full endpoint returns the updated item; the client upserts
  it locally on receipt so the article view re-renders within the
  same tick.

**Rationale**:

- Constitution Principle I requires local-first reads. Storing the body
  server-only would force the article view to make a remote read on
  every open, which violates I.
- Constitution Principle III (per-user DO is the source of truth) is
  preserved.
- The existing sync protocol already pages items by `updated_at`. A
  successful fetch bumps `updated_at` (via the existing
  `items_updated_at` trigger on UPDATE), so the row appears in the next
  pull naturally — no new sync surface needed.
- Multi-device: a successful fetch on device A is automatically visible
  on device B without a re-fetch.

**Alternatives considered**:

- **Client-only storage**: rejected. Breaks multi-device behaviour, and
  obliging the client to fetch the publisher directly violates the
  privacy edge case (spec) and means re-implementing SSRF protection
  in the browser.
- **Server-only storage (no sync), client always asks for it**:
  rejected. Violates Principle I; adds remote-call latency to every
  open of an already-fetched item.

## R-3: How is the body extracted from arbitrary publisher HTML?

**Decision**: A small in-tree extractor (`src/server/article-extract.ts`)
with no new dependencies. Pipeline:

1. Strip dangerous / structural noise: `<script>`, `<style>`,
   `<noscript>`, `<iframe>`, `<form>`, `<svg>`, HTML comments,
   `<header>`, `<nav>`, `<aside>`, `<footer>`, plus elements with
   common chrome class names (`comments`, `share`, `related`,
   `newsletter`, `sidebar`, `subscribe`).
2. Pick a candidate root, in order:
   - First `<article>` tag.
   - First `<main>` tag.
   - The `<div>` or `<section>` with the highest visible-text length.
3. Extract `innerHTML` of the candidate root.
4. Pass the result through `sanitiseExtractedHtml(html)` which strips
   inline event handlers (`on*=`), `javascript:` / `data:` URLs (except
   `data:image/...`), and any remaining `<script>` / `<style>`. This is
   a server-side defensive pass. The client still re-sanitises with
   DOMPurify at render time, per FR-006.
5. Cap the result at `MAX_FULL_CONTENT_BYTES = 256 * 1024` bytes
   (UTF-8). If oversized, truncate at the nearest paragraph boundary
   below the cap; if no such boundary exists, fall back to status
   `failed_no_body` (per FR-007).
6. After sanitisation, count plain-text length. If
   `plainTextLength < EXTRACTED_MIN_TEXT = 500`, treat as
   `failed_no_body` (likely a paywall stub or an empty page;
   FR-008's "body extraction returned nothing usable").

**Rationale**:

- Cloudflare Workers do not have a DOM. `@mozilla/readability` requires
  one (`jsdom` / `linkedom`); both are sizable Workers bundles and add
  a recurring upgrade-and-audit cost. The extraction quality wanted
  here ("get the readable body for typical Astro/Jekyll/Ghost posts")
  is well within reach of a tag-based heuristic.
- Spec assumption §4 explicitly leaves the extractor an
  implementation detail.
- A small, in-tree extractor is unit-testable end-to-end without a
  DOM, fits into a single ~150-line file, and reuses the same regex
  utilities already in `src/server/feed-fetch.ts`.

**Alternatives considered**:

- **`@mozilla/readability` + `linkedom`**: rejected for v1. Adds two
  significant dependencies, larger Worker bundle, and a regular audit
  burden. Easy to swap in later if the in-tree extractor proves
  insufficient — `extractArticleBody(html, baseUrl)` is the single
  call site.
- **`unfluff`**: rejected. Stale (no recent updates), CommonJS, and
  uses `cheerio` which depends on a DOM-ish parser tree.
- **Server-side `DOMParser` polyfill**: rejected on bundle-size grounds
  for the same reason as `linkedom`.

## R-4: How is the on-demand fetch triggered?

**Decision**: A new endpoint `POST /api/items/:id/fetch-full` (proxied
to the DO). Triggered by:

- The client's `item-reader.ts` route, on open, when `isSummaryOnly(item)`
  AND `item.full_content_status !== 'succeeded'` AND the browser is
  online. (The "succeeded" guard means the auto-trigger does not
  re-fetch; the user can still force a refetch via the retry button.)
- A "Retry" button rendered on the failure notice (FR-009): same
  endpoint, with `{ "force": true }` in the body.

The endpoint is *not* wired into:

- `POST /api/feeds/refresh` or any DO alarm path (FR-004 / SC-007 — the
  US-144 lockdown is preserved).
- `bootstrapLocalDb` or `pullSync` (no automatic batch fetches).

**Rationale**:

- FR-002 mandates server-side, on-open fetch.
- FR-004 / SC-007 prohibit any change to feed-refresh cost. Putting
  the fetch on a per-item endpoint keeps it strictly per-open.
- FR-009 requires a manual retry; a `force` flag on the same endpoint
  is the smallest possible surface.

**Alternatives considered**:

- **Trigger on every read**: rejected. A user can re-open the same
  item many times; FR-005 requires the body to be reused without
  re-fetching.
- **Trigger from the client without server involvement**: rejected.
  Violates the privacy edge case (publisher would see the reader's
  IP and request headers directly) and re-implements SSRF protection
  in the browser.
- **Background prefetch on item arrival**: rejected. Spec scope
  explicitly excludes "offline pre-fetch of full bodies" (Assumptions
  §6).

## R-5: Reuse spec-001 redirect, timeout, and SSRF rules?

**Decision**: Yes — the article-fetch pipeline routes through
`fetchValidatedResponse` in `src/server/feed-fetch.ts` with
`maxRedirects = MAX_ARTICLE_REDIRECTS = 5` and the established
`FEED_FETCH_TIMEOUT_MS = 15_000` baseline. We add a tighter
`ARTICLE_FETCH_TIMEOUT_MS = 8_000` override for this path so a single
slow publisher cannot exceed the 3-second SC-002 envelope by much.

**Rationale**:

- FR-010 requires consistency with the redirect/timeout behaviour
  established for OG-image enrichment in spec 001. Using the same
  helper guarantees that consistency by construction.
- The 5-redirect cap was decided in spec 001 R-1 and explicitly
  covers article-page redirect chains.
- SSRF protection (`isBlockedHostname`, DoH resolution) is already in
  place; the article fetch inherits it for free.
- An 8s deadline gives a typical broadband round-trip room (sub-3s
  per SC-002) without indefinite waits on slow publishers.

**Alternatives considered**:

- **Inline a separate fetcher**: rejected. Duplicates SSRF/redirect
  logic and risks drift on a future security fix. Spec 001
  Complexity Tracking notes the same point.
- **Use `FEED_FETCH_TIMEOUT_MS` as-is (15s)**: rejected. The user is
  staring at the article view; a 15s wait blows past SC-002.

## R-6: Status enum and idempotency

**Decision**: `full_content_status` takes one of these literal string
values:

| Value | Meaning |
|---|---|
| `null` | Never attempted (default for new and pre-migration rows) |
| `succeeded` | Fetched and extracted; body in `full_content` |
| `failed_network` | Connection error, DNS failure, timeout, blocked host |
| `failed_status` | Publisher returned non-2xx (incl. 4xx/5xx) |
| `failed_redirect` | Exceeded `MAX_ARTICLE_REDIRECTS` |
| `failed_non_html` | Response Content-Type was not HTML |
| `failed_too_large` | Response exceeded `MAX_ARTICLE_FETCH_BYTES` and could not be truncated to a usable body |
| `failed_no_body` | Extracted text was empty / under `EXTRACTED_MIN_TEXT` |

Idempotency:

- Without `force: true`: if status is `succeeded` and `full_content` is
  non-empty, return the existing row immediately (no fetch).
- With `force: true`: re-attempt regardless of current status.
- A `failed_*` row is re-attempted on every call without `force`,
  because retry is the user's expectation when they click "Retry"
  (and because failures may be transient — offline, briefly down).

This means the auto-trigger needs a guard *on the client* to avoid
re-fetching on every reopen of a `failed_*` item: the client only
auto-triggers when `full_content_status` is `null` (untried). Re-tries
require an explicit click. This satisfies FR-005 (no extra request on
normal repeat opens) and FR-009 (manual retry available).

**Rationale**:

- A small, finite enum is easier to render with confidence in the UI
  (User Story 3) and easier to test than a free-form error string.
- Storing the *kind* of failure (rather than a full error string)
  keeps PII-bearing strings (URLs, headers) out of the database.

**Alternatives considered**:

- **A single `failed` value**: rejected. The UI cannot distinguish
  "publisher down for 30s, retry will probably work" from "non-HTML
  response, retry won't help" without the kind. The kind also makes
  triage easier on the operator side.
- **Storing the raw error message**: rejected. Operationally noisy,
  and a leak risk if the message includes the URL.

## R-7: Sanitisation and safety

**Decision**: Two-layer defence:

1. **Server**: `sanitiseExtractedHtml` (in
   `src/server/article-extract.ts`) does a regex-based pass that
   removes inline event handlers (`on*=`), removes `javascript:` URLs,
   keeps `data:image/...` URLs, drops residual `<script>` and
   `<style>`, drops empty `style=""` attributes. This is a defensive
   storage filter, not the rendering sanitiser.
2. **Client**: the existing `sanitizeHtml(html)` (DOMPurify-backed)
   is applied at render time in `item-reader.ts`, identical to how
   feed `content`/`description` is sanitised today.

**Rationale**:

- FR-006 requires the same sanitisation pipeline as feed content.
  DOMPurify *is* that pipeline; running it on the server would require
  a DOM, which Workers lack. Reusing it on the client preserves the
  guarantee.
- Server-side stripping closes the subset of attacks that target the
  storage layer (e.g. an event handler that fires if the row were
  ever rendered through a non-sanitising path, or a CSS exfiltration
  payload via inline `style`).

**Alternatives considered**:

- **Trust client-side DOMPurify alone**: rejected. Defence in depth
  is cheap (a few small regexes), and a future code path that renders
  `full_content` outside of `sanitizeHtml` would otherwise be an
  XSS hazard.
- **Run DOMPurify in a Workers DOM polyfill on the server**: rejected
  on bundle-size grounds, same as R-3.

## R-8: Storage and fetch caps

**Decision**: Three constants in `src/server/article-fetch.ts`:

- `MAX_ARTICLE_FETCH_BYTES = 1 * 1024 * 1024` (1 MiB raw HTML).
- `MAX_FULL_CONTENT_BYTES = 256 * 1024` (256 KiB stored extracted body).
- `EXTRACTED_MIN_TEXT = 500` (plain-text characters required after
  extraction; below this is `failed_no_body`).

When stored content exceeds `MAX_FULL_CONTENT_BYTES`, the extractor
truncates at the last `</p>` or `</div>` boundary that fits, falling
back to `failed_too_large` if no such boundary exists.

**Rationale**:

- SC-008 ("local DB does not grow without bound") requires a per-item
  cap.
- 256 KiB stored is generous for prose articles (typical 5–10k words
  fit comfortably) without bloating the OPFS DB on a reader who has
  thousands of items.
- 1 MiB raw fetch is generous for the input HTML and matches the same
  order of magnitude as `MAX_FEED_BYTES = 5 MiB` already in feed-fetch.

**Alternatives considered**:

- **Tighter cap (64 KiB stored)**: rejected. Cuts off long-form posts
  needlessly.
- **No cap**: rejected. Violates SC-008.

## R-9: How does the UI tell the three states apart? (User Story 3)

**Decision**: Render-time logic in `item-reader.ts`:

- Status `null` or absent, body present in feed: nothing extra (item
  was already full).
- Status `succeeded`, body fetched: render `item.full_content` with no
  banner (User Story 3, scenario 2 explicitly accepts a silent
  successful fetch).
- Auto-fetch in flight (component-local signal): show a small
  "Fetching full article…" indicator above the summary. This is the
  3-second window per SC-002.
- Status starts with `failed_`: show a small "Couldn't load the full
  article." notice with a `Retry` button, immediately above the
  publisher link.

The publisher link (User Story 2) is rendered in *all* of these states
when `item.link` exists.

**Rationale**:

- SC-006 requires that the user can visually distinguish a fully-
  fetched view from a fallback in 100% of cases. The presence/absence
  of the failure notice is the explicit signal.
- Spec User Story 3 scenario 2 says a successful fetch "either shows
  the full body without any notice, or shows a small, non-alarming
  notice". We choose the silent option to keep the article view clean.

**Alternatives considered**:

- **Always show a "fetched on your behalf" banner on success**:
  rejected for noise (the spec lets us choose silent).
- **Hide the publisher link on success**: rejected. FR-014 explicitly
  requires the link in all body states.

## R-10: How does this coexist with US-144's "no automatic feed refresh"?

**Decision**: The fetch-full endpoint is registered on the DO router
*outside* the alarm path, and is only called from the per-item open
handler in `item-reader.ts`. We add a static-grep test
(`test/article-fetch-not-in-refresh.ts`) — modelled on the existing
`test/state-refresh-audit.ts` and `test/sync-invariant-static.mjs`
patterns — that asserts:

- `fetchFullArticle` and `extractArticleBody` are NOT called from
  `fetchFeed`, `updateNewItemThumbnails`, or DO alarm handlers.
- `POST /api/feeds/refresh` returns the same byte budget on items
  that would otherwise be summary-only.

**Rationale**:

- FR-004 explicitly cites US-144 and forbids re-introducing an
  automatic refresh path. A static-grep test catches accidental
  regressions during future refactors.
- SC-007 ("routine refresh is not slower or costlier") is testable
  by counting outbound `fetch` calls with a mock fetcher.

**Alternatives considered**:

- **Trust review alone**: rejected. The user explicitly flagged this
  guard rail in FR-004; making it a test makes it permanent.
