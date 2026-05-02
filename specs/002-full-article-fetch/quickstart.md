# Quickstart: Verify the Full-Article Fetch Feature

This is a manual verification recipe matching the spec's success
criteria. Use it to sanity-check the feature end-to-end after
implementation, and again before merging to `main`.

## Prerequisites

- Local dev environment up: `npm start`
- Browser open to `http://localhost:8888`
- Logged in (Dev Login is fine)
- A summary-only feed subscribed. The canonical example is
  `https://brittanyellich.com/index.xml`. (The README lists this
  among the example feeds; its RSS ships only `<description>`.)
- A full-content feed subscribed for the negative test. Any of
  `https://www.404media.co/rss/`,
  `https://piccalil.li/feed.xml`,
  `https://interconnected.org/home/feed` ships `content:encoded`.

## SC-001 / FR-002 — Open a summary-only item, see the full body

1. From the feed list, open any item from `brittanyellich.com`.
2. Within ~3 seconds the article view replaces the one-paragraph
   summary with the full article body, formatted readably (paragraphs,
   headings, inline images, links).
3. Below the body there is a link reading "Read the full article on
   brittanyellich.com" pointing at the article URL.

Pass criteria:

- The body is no longer one paragraph.
- Network panel shows exactly one `POST /api/items/<id>/fetch-full`
  call, with a 200 response.
- `localStorage` / OPFS DB now has `full_content_status = 'succeeded'`
  for that row (see [Inspect the local DB](#inspect-the-local-db)).

## FR-003 — Already-full items don't trigger a fetch

1. Open an item from a full-content feed (e.g. `404media`,
   `piccalil.li`).
2. Network panel: NO `fetch-full` request is fired.
3. Article view shows the body that was in the feed.

Pass criteria:

- Zero `POST /api/items/.../fetch-full` requests on opening the item.
- Reopening the same item: still zero such requests.

## FR-005 / SC-003 — Re-opens reuse the cached body

1. Reopen the same brittanyellich item from step SC-001.
2. The full body appears immediately (no loading flicker).
3. Network panel: NO `POST /fetch-full` request.

Pass criteria:

- Cache hit: returned-from-local instantly.
- No outbound article fetch on the second open.

## FR-008 / SC-005 — Fetch failure falls back to summary + publisher link

Two ways to exercise this:

**Offline:**

1. Disable the network (DevTools → Network → Offline).
2. Subscribe to a fresh summary-only feed (or open a not-yet-fetched
   item from one).
3. Open an item.
4. The article view shows the summary (one paragraph), a small notice
   "Couldn't load the full article.", a Retry button, and the
   "Read the full article on …" publisher link.

**Unreachable host:**

1. Stop your local network for one item by adding a host-blocking
   rule, or pick a feed whose article URLs return 404.
2. Open one of its items.
3. Same behaviour as the offline case.

Pass criteria:

- The summary is still visible.
- The notice and Retry button are rendered.
- The publisher link is rendered and works.
- `full_content_status` is one of `failed_network`, `failed_status`,
  `failed_redirect`.

## FR-009 — Retry from failure

1. From the failure state above, restore the network.
2. Click `Retry`.
3. The view shows a "Fetching full article…" indicator briefly, then
   replaces the summary with the full body.

Pass criteria:

- Clicking `Retry` triggers a `POST /api/items/<id>/fetch-full`
  request with `{ "force": true }`.
- On success, `full_content_status` flips to `succeeded` and the
  body renders.

## FR-011 / FR-012 / FR-013 / FR-015 — Publisher link

1. Open any item that has an article URL.
2. The link text reads "Read the full article on `<host>`" where
   `<host>` is `new URL(item.link).host` with a leading `www.` stripped
   (e.g. `brittanyellich.com`, `404media.co`, `blog.example.com`).
3. The link's `href` is the full `item.link` URL (not the displayed
   label). It opens in a new tab/window.
4. If `item.link` is null/empty, no link is rendered.

Pass criteria:

- Label matches the host with `www.` stripped.
- `target="_blank" rel="noopener noreferrer"` is set.
- Missing-link case: the publisher link element is absent from the DOM.

## SC-007 — Refresh feeds is no slower / costlier

1. Open the Network panel. Filter for `fetch-full`.
2. Click "Refresh feeds" on `/updates`.
3. While the refresh runs, no `POST /api/items/.../fetch-full` request
   appears.

Pass criteria:

- Zero `fetch-full` requests issued during a feed refresh.
- The refresh completion time is comparable to a baseline run from a
  pre-feature build (eyeballed; CI test asserts no extra outbound
  calls).

## SC-008 — Stored bodies are bounded

1. Open an item whose article HTML is well over 256 KiB (a long-form
   piece, e.g. an essay site).
2. Inspect `full_content` length in the local DB.

Pass criteria:

- `length(full_content)` ≤ `MAX_FULL_CONTENT_BYTES` (262 144 bytes).
- The body ends at a `</p>` or `</div>` boundary (no mid-tag
  truncation).

## Inspect the local DB

Open DevTools → Application → IndexedDB → OPFS-SAH → the rsss SQLite
file (or use the `script/sqlite-shell.sh` helper if present), then:

```sql
SELECT id, length(full_content) AS body_bytes,
       full_content_status, full_content_fetched_at
FROM items
WHERE link LIKE '%brittanyellich%'
ORDER BY pub_date DESC
LIMIT 5;
```

For the server-side DO database (when investigating a deploy):

```sh
sqlite3 \
  /Users/nick/code/rsss/.wrangler/state/v3/do/rsss-UserDO/<hash>.sqlite
sqlite> SELECT id, length(full_content), full_content_status FROM items
        WHERE full_content_status IS NOT NULL LIMIT 20;
```

## Test runs

```sh
npm test            # runs the full suite, including new article tests
npm run lint
```

Specific narrow test files for this feature:

```sh
npm run test:db      # local-adapter, includes full_content sync
# new test entries under test/ -- run with the existing pattern, e.g.:
esbuild test/article-extract.ts --bundle | tapout
esbuild test/article-fetch.ts    --bundle | tapout
esbuild test/article-detect.ts   --bundle | tapout
esbuild test/publisher-link.ts   --bundle | tapout
```
