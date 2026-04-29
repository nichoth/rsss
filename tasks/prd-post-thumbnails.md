# PRD: Post Thumbnails from Open Graph / Feed Media Tags

## 1. Introduction / Overview

The feed reader currently renders each post as a row containing only
the title, source feed, date, excerpt, and action icons. When the
underlying article has a representative image, the row is text-only and
visually undifferentiated from every other row.

This feature ingests image URLs from each post's source -- preferring
Open Graph (`og:image`, see https://ogp.me/) on the article HTML,
falling back to image hints already present in the feed XML
(`media:thumbnail`, `media:content` with `medium="image"`,
`<enclosure type="image/...">`, and a first `<img>` inside the
description / content) -- stores the resulting URL on the `items` row,
and renders a small thumbnail at the left of the row when one exists.

## 2. Goals

- Capture a single thumbnail URL per post during server-side feed
  ingestion and persist it on the `items` table.
- Prefer `og:image` on the article HTML; fall back to feed-provided
  image hints when OG is absent or unfetchable.
- Render the thumbnail at a small fixed size on the left of each
  `item-row` when a URL is available.
- Posts without a thumbnail keep their existing layout (no
  placeholder, no reserved column).
- No additional client-side fetches (no client-side scraping of OG
  tags).
- No backfill of existing rows in this PRD.

## 3. User Stories

### US-001: Add `thumbnail_url` column to the items schema

**Description:** As a developer, I need a place to store each post's
thumbnail URL so the client can render it without re-fetching anything.

**Acceptance Criteria:**
- [ ] `thumbnail_url TEXT` added to the `items` `CREATE TABLE` in
      `src/shared/schema.ts` (nullable, default omitted).
- [ ] Server Durable Object runs an `ALTER TABLE items ADD COLUMN
      thumbnail_url TEXT` migration (idempotent / catches "duplicate
      column" errors) so existing server databases pick the column up.
- [ ] Client OPFS-backed SQLite (whatever path applies the
      `TABLES_SQL`) also picks up the new column on fresh installs;
      existing client DBs survive the schema change without errors
      (drop / re-create the local cache is acceptable if that is the
      project's existing pattern -- match what `last_status` /
      `last_error` did).
- [ ] `Item` interface in `src/client/db/types.ts` gains
      `thumbnail_url:string|null`.
- [ ] `npm run typecheck` passes.

### US-002: Extract feed-provided image hints during XML parsing

**Description:** As a developer, I need `parseRss` and `parseAtom` in
`src/server/durable-objects/index.ts` to surface a candidate image URL
per item so we have something to fall back on when OG fetching fails
or is skipped.

**Acceptance Criteria:**
- [ ] `ParsedFeedItem` gains an optional `imageUrl:string | null`
      field.
- [ ] RSS extraction tries, in order:
      1. `media:thumbnail` `@_url`
      2. first `media:content` with `@_medium="image"` (or a
         `@_type` starting with `image/`) -- read its `@_url`
      3. first `enclosure` whose `@_type` starts with `image/` --
         read its `@_url`
      4. first `<img src>` inside `content:encoded` / `content` /
         `description` (use a simple regex; do not pull in a DOM
         parser)
- [ ] Atom extraction tries, in order:
      1. `media:thumbnail` `@_url`
      2. first `<link rel="enclosure" type="image/...">` `@_href`
      3. first `<img src>` inside `content` / `summary`
- [ ] Returns `null` when nothing matches.
- [ ] Resolves any extracted URL against the item's `link` (or feed
      `link`) so relative `<img src>` values become absolute. Drops
      values that do not resolve to `http:` or `https:`.
- [ ] Unit-test coverage in the existing feed-parsing test suite
      covers each of the cases above.
- [ ] `npm run typecheck` and `npm run lint` pass.

### US-003: Fetch `og:image` from each new item's article URL

**Description:** As a developer, I need the server to fetch the post's
`link` once at ingest time, parse `<meta property="og:image">` (and
`og:image:url`, `og:image:secure_url`, plus `twitter:image` as a
secondary fallback), and use that URL when present.

**Acceptance Criteria:**
- [ ] New helper `fetchOgImage(url, options)` lives next to the
      existing `fetchFeedText` in `src/server/feed-fetch.ts` (or a
      new `og-fetch.ts` if that file gets crowded). Reuses the
      existing SSRF protections: same URL validation, same DoH
      hostname check, same redirect cap, same timeout, same byte
      cap.
- [ ] Reads response only as far as `</head>` (cap at e.g. 256 KiB)
      to avoid downloading entire articles.
- [ ] Parses meta tags with a regex / simple scanner -- no
      heavyweight HTML parser. Looks for, in order:
      `property="og:image"`, `property="og:image:secure_url"`,
      `property="og:image:url"`, `name="twitter:image"`.
- [ ] Resolves the resulting URL against the article URL; drops
      non-http(s) values.
- [ ] Returns `null` on any failure (network error, non-2xx, parse
      miss, blocked host, timeout). Never throws to the caller.
- [ ] Unit tests cover: OG hit, secure_url fallback, twitter:image
      fallback, no-meta page, redirect, timeout, blocked host,
      non-HTML content-type.
- [ ] `npm run typecheck` and `npm run lint` pass.

### US-004: Wire thumbnail extraction into feed ingestion

**Description:** As a developer, I need `fetchFeed` in the Durable
Object to compute a `thumbnail_url` per new item and persist it.

**Acceptance Criteria:**
- [ ] In the insertion loop (around
      `src/server/durable-objects/index.ts:1062`), only newly
      inserted items have OG fetching attempted (skip rows that hit
      `INSERT OR IGNORE`'s no-op path -- check `changes()` after
      the insert, or detect the unique-constraint short-circuit).
- [ ] For each new item:
      1. If `item.link` is present, call `fetchOgImage(item.link)`.
      2. If that returns null, use the parser-supplied
         `imageUrl` from US-002.
      3. If both are null, leave `thumbnail_url` null.
- [ ] OG fetches run in parallel (e.g. `Promise.allSettled` over
      the new items) but with a small concurrency cap (e.g. 4) to
      avoid hammering one origin.
- [ ] An overall budget caps total OG-fetch wall time per
      `fetchFeed` call (e.g. 10 s); items whose fetch is still
      pending at the deadline fall back to the parser hint and the
      feed ingest still completes.
- [ ] `thumbnail_url` is written via `UPDATE items SET
      thumbnail_url = ? WHERE id = ? AND thumbnail_url IS NULL`
      (so we never overwrite a non-null value, and rows already
      ingested before this feature stay untouched -- per Non-Goals).
- [ ] OG-fetch failures are logged but never mark the feed as
      errored (`last_error` / `last_status` only reflect feed-level
      failures, not per-item OG failures).
- [ ] `npm run typecheck`, `npm run lint`, and existing
      feed-related tests pass.

### US-005: Render thumbnail on the left of each item row

**Description:** As a user, I want to see a small image at the left of
each post row when the post has one, so I can recognize articles at a
glance.

**Acceptance Criteria:**
- [ ] `ItemRow` (`src/client/components/item-row.ts`) renders an
      `<img class="item-thumbnail">` before `.item-main` when
      `item.thumbnail_url` is non-null and non-empty.
- [ ] `<img>` attributes: `loading="lazy"`,
      `decoding="async"`, `referrerpolicy="no-referrer"`,
      `alt=""` (decorative -- the title is the accessible label),
      and an `onError` handler that hides the element on failure
      (so a dead image URL doesn't leave a broken-image icon).
- [ ] Fixed size, e.g. 80 x 80, `object-fit: cover`,
      `border-radius` matching nearby UI, defined in
      `item-row.css` using `_variables.css` colors / radii (no new
      hardcoded colors).
- [ ] CSS uses nested selectors per the project style guide; no
      new top-level class proliferation.
- [ ] When `thumbnail_url` is absent, the row renders **exactly as
      it does today** -- no placeholder, no reserved space, no
      shifted text.
- [ ] Lines stay under 80 columns; TypeScript style follows the
      project conventions (no space between `:` and type).
- [ ] `npm run typecheck`, `npm run lint`, `npm run stylelint`
      pass.
- [ ] Verify in browser using the dev-browser skill: subscribe to
      a feed known to have `og:image` (e.g. a typical blog), let
      it ingest, confirm thumbnails render and rows without
      thumbnails are visually unchanged from before.

### US-006: Surface `thumbnail_url` through the items API / sync

**Description:** As a developer, I need the server-to-client items
payload to include `thumbnail_url` so the client renders it.

**Acceptance Criteria:**
- [ ] Whatever endpoint / sync path produces `Item` rows for the
      client (`getItems`, item-by-route, push/pull sync, etc.)
      includes `thumbnail_url` in its `SELECT` columns and serialized
      output.
- [ ] Client DB adapter mirrors the column when writing synced rows
      locally.
- [ ] Existing tests in `test/sync.ts`, `test/db-adapter.ts`,
      `test/local-adapter.ts`, `test/api-router.ts`, and any
      `pull-sync` / `push-sync` suites still pass; add at least one
      assertion that `thumbnail_url` round-trips.
- [ ] `npm run typecheck` passes.

## 4. Functional Requirements

- **FR-1:** The `items` table has a nullable `thumbnail_url TEXT`
  column on both server (Durable Object SQLite) and client (OPFS
  SQLite).
- **FR-2:** During `fetchFeed`, for every newly inserted item with a
  non-null `link`, the server attempts to fetch and parse `og:image`
  (and equivalents) from that link.
- **FR-3:** When OG fetching yields no URL, the server falls back to
  feed-provided image hints (`media:thumbnail`, `media:content`,
  `<enclosure>`, first `<img>` in description / content).
- **FR-4:** If neither source yields a URL, `thumbnail_url` stays
  `NULL` and the row renders without a thumbnail.
- **FR-5:** OG fetching obeys the same SSRF protections (URL
  validation, DoH hostname check, redirect cap, timeout, byte cap)
  that `fetchFeedText` already enforces.
- **FR-6:** OG-fetch failures never cause `fetchFeed` to mark the feed
  as errored.
- **FR-7:** OG fetching has a per-`fetchFeed` time budget so a single
  slow article can't stall the whole ingest.
- **FR-8:** OG fetching has a small concurrency cap to avoid stampedes
  against any single origin.
- **FR-9:** `ItemRow` renders an `<img>` with `loading="lazy"`,
  `decoding="async"`, `referrerpolicy="no-referrer"`, and `alt=""`
  on the left of the row when `item.thumbnail_url` is non-empty.
- **FR-10:** A failed image load (`onError`) hides the `<img>` so the
  row degrades to its no-thumbnail layout.
- **FR-11:** The thumbnail is a fixed 80x80 box with
  `object-fit: cover` (final dimensions can be tweaked during polish,
  but it must be a fixed size).
- **FR-12:** Rows without `thumbnail_url` render byte-for-byte the
  same DOM and CSS as before this feature -- no extra wrappers, no
  reserved column, no shifted text.
- **FR-13:** `thumbnail_url` flows through whatever sync /
  serialization path already moves items between server and client.

## 5. Non-Goals (Out of Scope)

- **No backfill.** Items already in the DB at deploy time keep
  `thumbnail_url = NULL` unless they're re-ingested through the normal
  feed-fetch path. A backfill job is explicitly deferred to a future
  PRD.
- **No image proxying / re-hosting / CDN.** We render the original
  third-party URL via `<img src>`. The PRD that adds proxying or R2
  hosting is a separate concern (privacy / hotlink / mixed-content
  trade-offs are acknowledged but not solved here).
- **No client-side OG fetching.** Browsers will not scrape article
  HTML; the server is the only producer of `thumbnail_url`.
- **No placeholder thumbnails.** Posts without an image stay text-only.
- **No image-dimension probing, no aspect-ratio metadata.** We trust
  the URL and `object-fit: cover`.
- **No cropping / resizing pipeline.**
- **No detail-view changes.** This PRD only changes the feed-list row.
- **No new dependencies.** Specifically, no HTML parser (cheerio,
  jsdom, parse5) -- regex / simple scanner only, scoped to `<head>`.

## 6. Design Considerations

- The thumbnail sits inside the existing `.item-row` flex container,
  before `.item-main`. The current `<a class="item-link">` wraps
  `.item-main`; the thumbnail can sit either inside that anchor (so
  clicking the image opens the post) or as a sibling -- prefer
  inside-the-anchor unless that breaks the layout.
- 80x80 px, `border-radius` matching nearby surfaces, `object-fit:
  cover`. Use existing `_variables.css` tokens for radius / borders;
  do not introduce new colors.
- Unread rows already have their own background; the thumbnail
  needs no special unread treatment.
- Match the project's CSS style: nested selectors inside
  `.item-row { ... }`, not a flat `.item-thumbnail { ... }` block at
  the top level.

## 7. Technical Considerations

- **SSRF.** OG fetches go to arbitrary third-party URLs supplied by
  feed authors. They MUST go through the same `validateFeedUrl` /
  DoH-hostname-check / redirect-cap / byte-cap / timeout pipeline as
  `fetchFeedText`. Factor the shared bits if needed; do not duplicate
  weakly.
- **Parser locality.** The OG parser scans only the response prefix up
  to `</head>` (or a hard cap, e.g. 256 KiB). Anything past that is
  ignored.
- **Content-Type guard.** Skip OG parsing if `Content-Type` is not
  `text/html` or `application/xhtml+xml`.
- **Idempotency.** Re-running `fetchFeed` after this PRD ships must
  not overwrite a thumbnail that was already populated. Use `WHERE
  thumbnail_url IS NULL` on the `UPDATE`.
- **Mixed content.** `<img src>` to an `http://` URL on an `https://`
  page will be blocked by browsers. The OG fetcher should drop
  `http:` results and only return `https:` URLs (this also rules out
  one class of confused-deputy linking). Document this behavior in
  the helper's JSDoc.
- **Privacy.** Loading third-party images leaks the user's IP /
  User-Agent / referrer to the article's image origin. The
  `referrerpolicy="no-referrer"` attribute is mandated by FR-9 to
  reduce that surface; full proxying is a non-goal.
- **State management.** Per project conventions, any sequential signal
  writes during item refresh should be wrapped in `batch()` from
  `@preact/signals`.
- **Error rendering.** A dead OG URL will fail to load; the
  `onError` handler in FR-10 hides it. Consider also sending a
  one-time `UPDATE items SET thumbnail_url = NULL WHERE id = ?` from
  the client when an `onError` fires, so the bad URL doesn't keep
  failing on every reload -- but treat that as nice-to-have, not a
  blocker.

## 8. Success Metrics

- A meaningful share of newly ingested items end up with a non-null
  `thumbnail_url` (target: greater than 60% for a typical mix of
  blogs / news feeds).
- `fetchFeed` p95 wall time does not regress by more than ~25% after
  the OG-fetch step is added (measure before / after on a dev feed
  list).
- No increase in `feeds.last_error` rates attributable to OG fetching
  (OG failures must not bubble up).
- Visual: thumbnails render at 80x80 with no layout shift in rows
  that have one; rows without a thumbnail are pixel-identical to the
  pre-feature layout.

## 9. Open Questions

- **Slow / unreliable origins.** If a single feed produces hundreds of
  new items in one ingest (e.g. first-fetch of a brand-new feed),
  even with concurrency caps the OG-fetch pass could be slow. Should
  first-fetch skip OG entirely and let it backfill on later
  refreshes? (Out of scope unless first-fetch becomes painful.)
- **Stale URLs.** Image hosts go down. Worth tracking
  `thumbnail_url_last_failed_at` so we can purge / retry? (Probably
  yes, but a follow-up PRD.)
- **Image dimensions.** Some `og:image` URLs are 1200x630 social
  cards; others are tiny. Should we capture `og:image:width` /
  `og:image:height` and skip below-threshold images? (Deferred.)
- **Animated GIFs / videos.** `og:image` can technically point at a
  GIF; should we filter by extension? (Deferred -- `loading="lazy"`
  mitigates.)
- **Detail view.** Should the post detail page also use
  `thumbnail_url` as a hero image? (Deferred -- this PRD covers the
  list row only.)
