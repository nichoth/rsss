# PRD: BlurHash Placeholders for RSS Feed Images

## 1. Introduction/Overview

Generate and serve [BlurHash](https://blurha.sh/) placeholder strings for
the OG images attached to RSS feed items, so the feed reader can render
a smooth blur-up effect using the already-installed
`@substrate-system/blur-hash` web component. Hashes are computed once
per image URL on the Cloudflare backend, cached globally across users,
and embedded directly in the SSR'd HTML so the placeholder paints on
first render with no additional client request.

Today, item images render cold: there is no placeholder, the layout
shifts as images load, and users see blank space until the network
completes. This feature replaces that with an instant blurred preview.

The full architectural rationale lives in
[`DOCS/PRD-blurhash.md`](../DOCS/PRD-blurhash.md). This document is the
implementation-oriented breakdown.

## 2. Goals

- Every feed item ingested after launch that has an `og:image`
  eventually has a BlurHash string and intrinsic dimensions associated
  with it.
- Hashes are deduplicated across users and feeds — keyed by image URL,
  computed once.
- Hashes are embedded directly in the SSR HTML; the `<blur-hash>`
  component paints the placeholder on first render with no client-side
  fetch.
- The pipeline runs entirely on Cloudflare primitives (Workers, Queues,
  KV, D1) with no external services.
- Items missing a hash render gracefully (plain `<img>`) until the
  encoder catches up — no broken UI.

## 3. User Stories

### US-001: Add `og_image_url`, `blurhash`, `image_width`, `image_height` columns to `feed_items`

**Description:** As a developer, I need columns on `feed_items` to
denormalize the OG image URL, its BlurHash, and its intrinsic
dimensions so the render path is a single `SELECT` with no per-item
KV lookup.

**Acceptance Criteria:**

- [ ] Migration adds `og_image_url TEXT NULL`, `blurhash TEXT NULL`,
      `image_width INTEGER NULL`, `image_height INTEGER NULL` to
      `feed_items`
- [ ] No index added (these columns are read with the row, never
      filtered on)
- [ ] Migration applies cleanly on a fresh DB and on an existing DB
      with existing rows (existing rows take `NULL` defaults)
- [ ] Typecheck and lint pass

### US-002: Provision `BLURHASH_KV` namespace and `blurhash-jobs` queue infrastructure

**Description:** As a developer, I need the KV namespace and queue (with
DLQ) declared in `wrangler` configuration so the producer and consumer
workers can bind to them.

**Acceptance Criteria:**

- [ ] `BLURHASH_KV` KV namespace declared in `wrangler.toml` (or
      equivalent) with appropriate binding for both poller and consumer
- [ ] `blurhash-jobs` queue declared as a producer binding for the
      poller
- [ ] `blurhash-jobs` queue declared as a consumer binding with
      `max_batch_size = 10`, `max_batch_timeout = 30`, `max_retries = 3`
- [ ] `blurhash-dlq` declared as `dead_letter_queue` for
      `blurhash-jobs`
- [ ] `wrangler types` (or the project equivalent) regenerated; types
      compile
- [ ] Typecheck and lint pass

### US-003: Extract `og:image` in the feed poller and persist `og_image_url`

**Description:** As a developer, I need the existing feed poller to
extract the `og:image` meta tag from each new item's article URL and
write it to the new `og_image_url` column, so subsequent stages have a
URL to hash. (The poller does not currently do this extraction.)

**Acceptance Criteria:**

- [ ] When the poller ingests a new item, it fetches the article URL
      and parses `<meta property="og:image">` (and `<meta
      name="og:image">` as fallback)
- [ ] The extracted absolute URL is stored in `og_image_url` on the
      item row
- [ ] If the article fetch fails, times out, or no `og:image` is found,
      `og_image_url` stays `NULL` and the item still ingests
      successfully
- [ ] Fetch uses the same redirect-handling and User-Agent conventions
      already used by `001-fix-og-image-redirects` (do not regress that
      fix)
- [ ] Typecheck and lint pass

### US-004: Check `BLURHASH_KV` in poller; write directly on hit, enqueue on miss

**Description:** As a developer, I want the poller to read
`BLURHASH_KV` for each new item's image URL so that, if another user's
poll has already produced a hash for that URL, we can write the hash
straight to D1 and skip the queue entirely.

**Acceptance Criteria:**

- [ ] KV key derived as
      `blurhash:<sha256(og_image_url).slice(0, 32)>`
- [ ] On KV hit: write `blurhash`, `image_width`, `image_height` to the
      item row in D1; do not enqueue
- [ ] On KV miss: insert the item with `blurhash = NULL` and enqueue
      `{ imageUrl, itemId }` onto `blurhash-jobs`
- [ ] If the item has no `og_image_url`, no KV read and no enqueue
      happens
- [ ] Hot-path KV read is one round trip per new item (cheap, edge-
      cached)
- [ ] Typecheck and lint pass

### US-005: Implement `blurhash-jobs` queue consumer that fetches, encodes, and writes

**Description:** As a developer, I need a queue consumer worker that
takes a job, fetches the image, decodes and resizes it with `@cf-wasm/
photon`, encodes a BlurHash, captures the image's intrinsic dimensions,
and writes results to KV and D1.

**Acceptance Criteria:**

- [ ] On batch receive, for each job: re-check KV (another worker may
      have hashed it) and skip-but-still-write-to-D1 if hit
- [ ] Image fetch uses `AbortController` with a 10 s timeout and a
      browser-like User-Agent
- [ ] Reject images larger than 5 MB by `Content-Length`, with a
      backstop check on actual bytes received
- [ ] Decode → resize to 32×32 (nearest-neighbor) with Photon → encode
      with `blurhash` at 4×4 components
- [ ] Capture `image_width` and `image_height` from the original
      decoded image (before resize) and store both alongside the hash
- [ ] Photon image instance `.free()` called in a `finally` block to
      avoid isolate memory leaks
- [ ] Write hash to `BLURHASH_KV` with 90-day TTL and to the item's
      `blurhash` / `image_width` / `image_height` columns
- [ ] Failure handling per the table in `DOCS/PRD-blurhash.md` §7.5:
      4xx fetch / decode failure / oversized → permanent skip + ack
      (item stays `NULL`); 5xx / timeout / KV/D1 write failure / Photon
      crash → retry; after 3 retries → DLQ
- [ ] Permanent-skip cases ack the message so it does not retry
- [ ] Typecheck and lint pass

### US-006: Render `<blur-hash>` in SSR with graceful fallback

**Description:** As a reader, when I open my feed list I want to see a
blurred preview of each article's image immediately, so the page feels
responsive even on slow connections — and when the encoder hasn't
caught up yet, I still want to see something sensible (no broken UI).

**Acceptance Criteria:**

- [ ] For items where `blurhash`, `og_image_url`, `image_width`, and
      `image_height` are all present: SSR emits `<blur-hash
      placeholder="…" src="…" width="…" height="…" alt="…">`
- [ ] For items with `og_image_url` but missing `blurhash`/dimensions:
      SSR emits a plain `<img src loading="lazy" alt>` (no layout
      placeholder; no broken component)
- [ ] For items with no `og_image_url`: no image element rendered
- [ ] No new client-side fetch is introduced for the placeholder — the
      hash is in the initial HTML
- [ ] No layout shift or flash of blank space on items that have a
      hash, on a throttled-network reload
- [ ] Typecheck and lint pass
- [ ] Verify in browser using dev-browser skill (load the feed list,
      throttle the network, confirm placeholders paint immediately and
      crossfade to real images, and confirm fallback `<img>` renders
      for items missing a hash)

## 4. Functional Requirements

- **FR-1:** `feed_items` shall gain four nullable columns:
  `og_image_url`, `blurhash`, `image_width`, `image_height`.
- **FR-2:** A `BLURHASH_KV` namespace shall exist, keyed by
  `blurhash:<sha256(imageUrl).slice(0, 32)>`, with values being raw
  BlurHash strings, written with a 90-day TTL.
- **FR-3:** A `blurhash-jobs` queue with `blurhash-dlq` dead-letter
  queue shall exist, with batch size 10, batch timeout 30 s, and 3
  retries.
- **FR-4:** When the feed poller ingests a new item, it shall extract
  `og:image` from the article and persist it to `og_image_url`.
- **FR-5:** After persisting `og_image_url`, the poller shall check
  `BLURHASH_KV` and either (a) write `blurhash` + dimensions directly
  to D1 on hit, or (b) enqueue `{ imageUrl, itemId }` on miss.
- **FR-6:** The queue consumer shall fetch the image (10 s timeout,
  5 MB cap, browser UA), decode + resize with Photon, encode with
  `blurhash` (4×4 components), capture intrinsic dimensions, and write
  the result to both KV and D1.
- **FR-7:** The consumer shall implement the failure-mode table:
  permanent skip + ack on 4xx / decode / oversized; retry then DLQ on
  5xx / timeout / write failure / Photon crash.
- **FR-8:** The SSR feed list shall render `<blur-hash>` for items with
  a complete hash + dimension set, plain `<img>` for items with an
  image URL but no hash, and nothing for items with no image at all.

## 5. Non-Goals (Out of Scope)

- **Image storage or transformation.** RSSS does not host the OG
  images; the `<img>` continues to point at the publisher's CDN.
- **Hashing for non-OG images.** Body-content images are out of scope.
- **Hash regeneration on image change.** Stale hashes for rotated
  images at the same URL are accepted in v1.
- **Client-side encoding.** All encoding is server-side.
- **Migration of historical items.** Only items ingested after launch
  receive hashes; backfill is deferred (not a story in this PRD).
- **External services.** No third-party image processing service.

## 6. Design Considerations

- The `@substrate-system/blur-hash` web component is already installed;
  this PRD only consumes it.
- The fallback (`<img loading="lazy">`) must use the same intrinsic
  rendering box as the `<blur-hash>` element to avoid layout flicker
  when the encoder catches up between renders.
- Existing OG-image redirect handling (from
  `001-fix-og-image-redirects`) must not be regressed by the new
  extraction step.

## 7. Technical Considerations

- **Why a queue, not synchronous encode in the poller:** Photon decode
  of multi-megabyte JPEGs burns significant CPU; keeping it out of the
  poller's request path protects polling throughput.
- **Why KV for dedup, D1 for per-item denormalization:** KV is read-
  mostly, eventually-consistent, and edge-cached — exactly the shape of
  "given an image URL, has anyone hashed this yet?". D1 holds the per-
  item hash so the render path is one query.
- **Why pre-queue KV check in the poller:** A second user on the same
  blog gets a free poll — no encode job, no queue entry.
- **Why embed in SSR HTML rather than a `/api/blurhash` endpoint:** A
  round trip per image to fetch a 30-byte string would defeat the
  purpose; by the time the hash arrived the real image would often
  already be loading.
- **Why probe-and-store dimensions:** the `<blur-hash>` element needs
  intrinsic `width`/`height` to reserve layout space; storing the
  source dimensions once during encode avoids per-render measurement.

## 8. Success Metrics

- Items ingested after launch with an `og:image` reach a non-`NULL`
  `blurhash` value within one queue-consumer cycle (typically seconds,
  bounded by retry policy at minutes).
- Cross-feed dedup ratio is observable: total unique image URLs hashed
  vs. total feed items with images. Higher ratio = better dedup.
- No layout shift on the feed list view at first paint for items with
  a hash (verified visually via the dev-browser skill).
- Zero regression in poller latency from the new OG extraction step
  (compare poller cron timings before/after).

## 9. Open Questions

- Should the feed poller fetch the article HTML to extract `og:image`,
  or is the RSS/Atom feed payload itself sometimes carrying it (e.g.
  `media:thumbnail`, `enclosure`)? If yes, prefer feed-payload data
  before fetching the article to save a round trip.
- Should we cap concurrent encode jobs per consumer invocation, given
  Photon's CPU profile, or is `max_batch_size = 10` sufficient back-
  pressure?
- For the `<blur-hash>` fallback `<img>`, do we want a fixed aspect
  ratio container (e.g. CSS `aspect-ratio`) so the layout box matches
  what the eventual `<blur-hash>` will occupy?
