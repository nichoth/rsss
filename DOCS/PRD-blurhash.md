# PRD: BlurHash Placeholders for RSS Feed Images

**Project:** RSSS (Really Simple Syndication Service)
**Author:** Nichoth
**Status:** Draft
**Last updated:** May 2026

---

## 1. Summary

Generate and serve [BlurHash](https://blurha.sh/) placeholder strings for the OG images attached to RSS feed items, so that the feed reader can render a smooth blur-up effect using the [`@substrate-system/blur-hash`](https://github.com/substrate-system/blur-hash) web component. Hashes are computed once per image URL on the Cloudflare backend, cached globally, and embedded directly into the SSR'd HTML so that the placeholder paints on first render with no additional client request.

## 2. Background

The RSSS feed reader displays a list of items pulled from RSS/Atom feeds users have subscribed to. Each item typically has an associated image via the post's `og:image` meta tag (the screenshot below shows a typical render — WIRED articles with hero images on the left).

Currently the UI renders these images cold: there's no placeholder, so the layout shifts as images load and users see blank space until the network completes. BlurHash solves this by encoding a tiny (~30 character) representation of the image that the client can decode into a blurred preview instantly.

The encode step is computationally expensive and requires fetching the source image and decoding it to raw pixels. Doing it client-side defeats the purpose. It needs to happen on the backend, the result needs to be cached, and the cache needs to be shared across all users subscribed to overlapping feeds (one popular blog → one encode job, not N).

## 3. Goals

1. Every feed item that has an `og:image` eventually has a BlurHash string associated with it, computed asynchronously after the item is ingested.
2. Hashes are deduplicated across users and feeds — keyed by image URL, computed once.
3. Hashes are embedded directly in the SSR HTML so the `<blur-hash>` component paints the placeholder on first render with no client-side fetch.
4. The pipeline runs entirely on Cloudflare primitives (Workers, Queues, KV, D1) with no external services.
5. New feed items missing a hash render gracefully (plain `<img>`) until the encoder catches up — no broken UI for the brief interval between ingest and encode.

## 4. Non-goals

- **Image storage or transformation.** We don't host the OG images, only encode their hash. The `<img>` continues to point at the publisher's CDN.
- **Hashing for non-OG images.** Images embedded in post body content are out of scope for this iteration.
- **Hash regeneration on image change.** If a publisher rotates the image at the same URL, the cached hash will be stale. Acceptable for v1; revisit if it becomes a visible problem.
- **Client-side encoding.** All encoding happens server-side.
- **Migration of historical items.** v1 only encodes for items ingested after launch. A backfill job can be added later if useful.

## 5. User stories

- *As a reader,* when I open my feed list, I want to see a blurred preview of each article's image immediately, so the page feels responsive even on slow connections.
- *As a reader,* when an article's image is still loading, I don't want layout shift or a flash of blank space.
- *As an operator,* when two users subscribe to the same blog, I want the system to encode each image once, not twice.

## 6. Architecture

### 6.1 Components

- **D1** — `feed_items` table gets two new columns: `og_image_url TEXT` and `blurhash TEXT NULL`. The hash is denormalized onto the item so the render query is a single `SELECT` with no per-item KV lookup.
- **KV** (`BLURHASH_KV`) — global dedup cache keyed by the SHA-256 of the image URL. Maps image URL → hash string. Read by the feed poller before enqueueing, and written by the queue consumer after a successful encode.
- **Queues** (`blurhash-jobs`) — async work queue. Messages are `{ imageUrl, itemId }`. Consumer batch size 10, max retries 3, with a `blurhash-dlq` dead-letter queue.
- **Cron Worker** (existing feed poller) — extended to extract `og:image` from each new item, check KV for an existing hash, and either write the hash directly or enqueue a job.
- **Queue consumer Worker** — fetches the image, runs `@cf-wasm/photon` to decode and resize, runs `blurhash` to encode, writes to KV and updates D1.

### 6.2 Data flow

**Ingest path** (cron-triggered feed poll):

1. Poller fetches the feed and finds new items.
2. For each new item, extract `og:image` URL.
3. Hash the image URL (`sha256` → first 32 hex chars) to compute the KV key.
4. Read `BLURHASH_KV` for that key.
5. If hit: write the hash directly to the item's `blurhash` column in D1.
6. If miss: insert the item with `blurhash = NULL` and enqueue a job onto `blurhash-jobs`.

**Encode path** (queue consumer):

1. Receive batch of jobs from the queue.
2. For each job, double-check KV (another worker may have hashed it in the interval).
3. If still a miss: fetch the image (with timeout, size cap, browser UA), decode + resize to 32×32 with Photon, encode with `blurhash` (4×4 components).
4. Write the hash to KV (90-day TTL) and to the item's `blurhash` column.
5. Ack the message. On failure, retry with 60s delay; after 3 retries, dead-letter.

**Render path** (page request):

1. Worker queries D1 for the user's feed items, including `blurhash` and `og_image_url`.
2. SSR template emits `<blur-hash placeholder="…" src="…" width="…" height="…">` for items with a hash, or a plain `<img>` for items without one (encoder hasn't caught up).
3. Client receives complete HTML; the `<blur-hash>` web component paints the placeholder on `connectedCallback`, then crossfades to the real image when it loads.

### 6.3 Why this shape

- **Queue rather than synchronous encode in the poller.** Photon decode of a multi-megabyte JPEG can burn significant CPU; we don't want it in the request path of the poller, which has its own work to do.
- **KV for the cross-user dedup cache, D1 for per-item denormalization.** KV is read-mostly, eventually-consistent, and edge-cached — exactly the shape of "given an image URL, has anyone hashed this yet?". D1 holds the per-item hash so the render path is one query, no fan-out.
- **Pre-queue KV check in the poller.** The cheap path: if the hash already exists, skip the queue entirely and write directly to D1. Two users on the same blog → second one's poll is free.
- **Embed in SSR HTML rather than fetch from a `/api/blurhash` endpoint.** A round trip on every image to retrieve a 30-character string would defeat the purpose. By the time the hash arrived, the real image would often already be loading.
- **Graceful fallback for missing hashes.** Render a plain `<img>` for items the encoder hasn't caught up on. Better than blocking, better than empty.

## 7. Detailed design

### 7.1 Schema change

```sql
ALTER TABLE feed_items ADD COLUMN og_image_url TEXT;
ALTER TABLE feed_items ADD COLUMN blurhash TEXT;
```

No index needed — `blurhash` is read with the row, never queried by.

### 7.2 KV layout

- Key: `blurhash:<sha256(imageUrl).slice(0, 32)>`
- Value: BlurHash string (e.g. `LEHV6nWB2yk8pyo0adR*.7kCMdnj`), ~30 bytes
- TTL: 90 days (long enough that long-tail OG images stay cached, short enough that stale rotated images recover eventually)

### 7.3 Queue configuration

```toml
[[queues.consumers]]
queue = "blurhash-jobs"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "blurhash-dlq"
```

Batch size 10 is conservative — Photon decode dominates CPU and a single oversized image shouldn't take down a batch of 25.

### 7.4 Encoder constraints

- **Max image size:** 5 MB. Reject larger via `Content-Length` header, with a backstop check on the actual byte length after fetch.
- **Fetch timeout:** 10 seconds via `AbortController`.
- **User-Agent:** browser-like string; some publishers 403 unfamiliar UAs.
- **Resize before encode:** 32×32 nearest-neighbor. BlurHash only needs a tiny thumbnail; encoding at full resolution is wasted CPU.
- **WASM lifecycle:** call `.free()` on Photon image instances in a `finally` block. Skipping this leaks isolate memory across requests.
- **Components:** 4×4 (the BlurHash default; matches the component's expected aspect).

### 7.5 Failure modes

| Mode | Handling |
|---|---|
| Image fetch 4xx | Skip permanently. Item stays with `blurhash = NULL`, ack. |
| Image fetch 5xx / timeout | Retry up to 3× with 60s delay. After 3, DLQ. |
| Image decode failure (corrupt, unsupported format) | Skip permanently. Ack. |
| Image > 5 MB | Skip permanently. Ack. |
| KV write failure | Retry the message. |
| D1 write failure | Retry the message. |
| Photon WASM crash | Retry; if persistent, DLQ. |

A null `blurhash` is a fully acceptable end state — the item simply renders without a placeholder.

### 7.6 Rendering

```tsx
{items.map(item =>
  item.blurhash
    ? html`<blur-hash
        placeholder=${item.blurhash}
        src=${item.og_image_url}
        width="600" height="300"
        alt=${item.title}
      ></blur-hash>`
    : html`<img src=${item.og_image_url} loading="lazy" alt=${item.title} />`
)}
```

Only items with both `og_image_url` and `blurhash` get the component; everything else gets a plain image (or no image, if there's no `og:image` either).

## 8. Performance and cost

- **Cross-feed dedup ratio:** unknown until measured, but expected to be meaningful for popular publishers (WIRED, NYT, etc) that many users subscribe to.
- **Per-encode CPU budget:** dominated by JPEG decode. A 1 MB image decode + 32×32 resize + BlurHash encode should fit well under the Worker CPU limit. To verify in practice during development.
- **KV reads on the ingest path:** one per new item. Cheap and edge-cached.
- **KV writes:** one per unique image URL ever seen. Tiny values.
- **D1 writes:** one update per item once the hash is computed.
- **HTML payload increase:** ~30 bytes per item. For a 50-item feed view, ~1.5 KB extra — negligible compared to images themselves.

## 9. Rollout

1. Schema migration (add columns, deploy). Items continue to render as today.
2. Deploy queue infrastructure and consumer worker (no producers yet).
3. Update poller to extract `og:image` and populate `og_image_url` (no hashing yet).
4. Enable the queue producer in the poller. Hashes start flowing for new items.
5. Update the SSR template to render `<blur-hash>` when `blurhash` is present.
6. (Optional) Backfill job for historical items.

Each step is independently reversible. The render template change is the only user-visible step; everything before it is silent backend work.
