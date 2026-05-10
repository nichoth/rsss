# Phase 1 Data Model: Fix Flash of Unstyled Content on Page Refresh

## Summary

**No data model changes.** This feature is a rendering / asset-loading
fix. There is no new entity, no new field on an existing entity, no
DO schema change, no `/api/sync` payload change, and no local SQLite
schema change. The spec itself notes this in its Key Entities section
("Not applicable — this is a rendering / asset-loading concern, not
a data modeling change.").

## Entities consulted (read-only context)

### `HTML_KV` cache entries (existing; key schema rolls forward)

- **Type.** Cloudflare KV string entries, value is the full
  pre-rendered shell HTML.
- **Defined at.** `src/server/lazy-html-handler.ts:75-77` (write),
  `src/server/lazy-html-handler.ts:46-49` (read).
- **Cache key (current).** `html:<did>:<feed-version>` — built by
  `buildLazyHtmlCacheKey` in `src/server/lazy-html.ts:9-14`.
- **Cache key (after this fix).** `html:v2:<did>:<feed-version>`.
  The `v2` segment is a *schema version* for the *shell template*,
  not for the data inside the shell. It is bumped exactly when the
  shape of the shell changes (here: addition of the stylesheet
  link). Pre-fix entries become unreachable; their bytes expire on
  the existing 30-day TTL
  (`HTML_CACHE_TTL_SECONDS` at `src/server/lazy-html-handler.ts:9`).
- **Producer paths (unchanged).** Only
  `src/server/lazy-html-handler.ts:75-77` writes. The handler
  already keys with whatever `buildLazyHtmlCacheKey` returns; bumping
  the prefix is sufficient.
- **Reader paths (unchanged).** Only the same handler reads
  (`src/server/lazy-html-handler.ts:46-49`).
- **Validation rules.** N/A — KV stores opaque HTML strings.
- **State transitions.**
  - Pre-fix entries: written under `html:<did>:<v>`. Become
    unreachable on deploy of this fix; expire via TTL within 30
    days.
  - Post-fix entries: written under `html:v2:<did>:<v>` on first
    cache miss after the deploy.

### `index.html` (existing; one element added)

- **Type.** Static asset served by Vite in dev, by the Cloudflare
  Worker via `ASSETS` (resolved through the lazy HTML handler) in
  prod.
- **Defined at.** `/index.html` (project root).
- **Change.** Add a single new child of `<head>`:
  `<link rel="stylesheet" href="/src/client/style.css">`, placed
  before the existing
  `<script type="module" src="/src/client/index.ts">`.
- **Validation invariants the build artifact must satisfy
  (asserted by `test/shell-html.ts`).**
  1. `public/index.html` after `npm run build` contains at least
     one `<link rel="stylesheet" href="...">` element.
  2. The first `<link rel="stylesheet">` element appears inside
     `<head>` (not inside `<body>` or after `</head>`).
  3. The character offset of the first `<link rel="stylesheet">`
     in the document is *less than* the offset of the first
     `<script>` tag. (This is the regression-guard invariant —
     spec FR-007.)
- **Why these invariants.** They encode the conditions under which
  the browser will block the first paint until the stylesheet has
  applied, on every supported browser. (1) ensures the stylesheet
  is referenced. (2) ensures it is found by the preload scanner
  during HTML parsing. (3) ensures no preceding `<script>` can
  reorder fetch priority or block CSS discovery on a slow network.

## Out of scope (explicit non-changes)

- DO SQLite schema (`feeds`, `items`, `outbox`, `feed_versions`,
  etc.) — unchanged.
- `/api/sync` payload shape — unchanged.
- Local SQLite (OPFS) schema and `bootstrapLocalDb` — unchanged.
- `pullSync` upsert logic — unchanged.
- `localAdapter` / `remoteAdapter` interface — unchanged.
- Initial-feed bootstrap payload shape (`InitialFeedPayload` in
  `src/server/lazy-html.ts`) — unchanged.
- All component-level CSS imports (e.g.
  `src/client/components/header.ts:11`) — unchanged. See
  `research.md` Decision 4.
- `BlurHash` rendering pipeline — unchanged. The seeded
  `<blur-hash>` element's own CSS lives in its package; it is loaded
  via the JS bundle on hydration, after first paint.
