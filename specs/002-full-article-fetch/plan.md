# Implementation Plan: Fetch Full Article Body When Feed Provides Only a Summary

**Branch**: `002-full-article-fetch` | **Date**: 2026-05-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-full-article-fetch/spec.md`

## Summary

Some publishers ship only a one-paragraph summary in their RSS/Atom feeds.
When a reader opens such an item, the in-app article view is one or two
sentences and the only path to the actual content is a generic
`Open original` button that takes the reader out of the app entirely.

This feature adds a third tier to the body-resolution pipeline (after
`content:encoded` and `<description>`): when the reader opens an item
whose locally-stored body looks like a summary, the user's Durable
Object fetches the article URL on the user's behalf, extracts the
readable body, sanitises and caches it in the items row, and surfaces it
in the same article view. The publisher's link is always rendered below
the body as `Read the full article on <publisher-domain>`, replacing the
generic `Open original` button as the explicit escape hatch.

The fetch is per-open (never during routine feed refresh, per the lock-
down established in US-144), bounded in size and time, and falls back
gracefully to the feed summary plus the publisher link when the publisher
is unreachable, paywalled, non-HTML, or otherwise unextractable.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime, ES2022 lib)
**Primary Dependencies**:

- Server: `hono`, `@cloudflare/workers-types`, existing
  `src/server/feed-fetch.ts` (SSRF-validated fetch + redirect/timeout
  rules established in spec 001). No new dependencies.
- Client: `@preact/signals`, `htm/preact`, `dompurify` (existing). No
  new dependencies.

**Storage**: Per-user Durable Object SQLite (server-authoritative); local
OPFS-backed SQLite (client-mirrored via `/api/sync`). Three new columns
on `items`. Columns are synced through the existing pull-sync path.

**Testing**: `tap`/`tapout` (existing pattern). New tests in
`test/article-extract.ts`, `test/article-fetch.ts`, `test/publisher-link.ts`,
`test/article-detect.ts`, plus extensions to existing `test/sync.ts`
and `test/local-adapter.ts`.

**Target Platform**: Cloudflare Worker + per-user Durable Object backend
with a Preact SPA frontend.

**Project Type**: Edge web service + SPA. This change touches both
server (DO route, schema, extractor, fetcher) and client (item-reader
UI, state action, sync upserts, types).

**Performance Goals**:

- SC-002: full body appears within 3 seconds on a typical broadband
  connection. Article fetch budget set to 8s server-side (must finish
  before the user gives up); the 3s target is the typical case.
- SC-007: zero added cost on `POST /api/feeds/refresh`. The article
  fetch is wired only into the per-open path, not the refresh path.

**Constraints**:

- Server-side fetch only (privacy edge case; reuse spec-001 SSRF
  protection).
- Stored body bounded by `MAX_FULL_CONTENT_BYTES` (256 KiB).
- Fetched response bounded by `MAX_ARTICLE_FETCH_BYTES` (1 MiB raw).
- Article-page redirect budget: 5 hops (consistent with spec 001
  `MAX_ARTICLE_REDIRECTS`).
- Fetch deadline: 8s per attempt.
- Sanitisation: server strips dangerous tags before storage; client
  re-runs `sanitizeHtml` (DOMPurify) at render time, same as feed
  content (FR-006).
- No CSS unrelated to this feature is modified.

**Scale/Scope**:

- Server: 2 new modules (`src/server/article-extract.ts`,
  `src/server/article-fetch.ts`), 1 new shared module
  (`src/shared/article-detect.ts`), 1 new shared helper
  (`src/shared/publisher-link.ts`), schema additions in
  `src/shared/schema.ts`, new DO route + migration in
  `src/server/durable-objects/index.ts`.
- Client: type extension (`src/client/db/types.ts`), state action
  (`src/client/state.ts`), remote-adapter method
  (`src/client/db/remote-adapter.ts`), sync upserts
  (`src/client/db/pull-sync.ts`, `src/client/db/push-sync.ts`),
  bootstrap fetch column passthrough, item-reader UI
  (`src/client/routes/item-reader.ts` + its CSS).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `/Users/nick/code/rsss/.specify/memory/constitution.md`
v1.0.0:

- **I. Local-First Reads** — Compliant. The new
  `full_content`/`full_content_fetched_at`/`full_content_status` columns
  are added to the shared `items` schema and synced through `/api/sync`
  into the client's OPFS SQLite. The article-reader render path remains
  a local read (it consults `item.full_content`, falls back to
  `item.content` / `item.description`). The on-demand fetch is a
  *remote-only* enrichment (the publisher's HTML lives off-platform); a
  local-only read of an unfetched item still yields the feed summary plus
  the publisher link, which is the documented FR-008 fallback. The pull-
  sync upsert in `pullSync` is updated to copy the new columns; the local
  SQLite schema (mirror of `TABLES_SQL`) inherits them.
- **II. Idempotent, Outbox-Backed Sync** — See Complexity Tracking
  entry 1. The fetch-full operation is a *server-side derivation
  request*, not a client value-assignment, so it does not flow through
  the outbox. Idempotency is provided by item ID + status semantics
  (re-issuing on a `succeeded` row is a no-op; re-issuing on a
  `failed_*` row re-attempts the fetch). No client_op_id / processed-op
  table is needed because the result is derived server-side and returned
  inline; the client trusts the row in the response.
- **III. Edge-Native Topology** — Compliant. All fetching, extraction,
  and storage stay inside the user's `UserDO`. No new alarms, queues,
  workers, or cross-user state. The DO continues to be the single
  authoritative source for `items`.
- **IV. Capability-Gated Progressive Enhancement** — Compliant. The
  fetch trigger is wired through a `State.fetchFullArticle` action that
  works the same in both adapters: it always calls
  `POST /api/items/:id/fetch-full` (server-side fetch is mandatory per
  privacy edge case + reuse of spec-001 redirect rules), then upserts
  the returned row into either the local DB (local-first mode) or the
  in-memory item state (remote-only mode). The publisher link renders
  identically in both modes.
- **V. Bluesky-Anchored Identity** — N/A. No auth changes.

Coding-standards gate:

- TypeScript style preserved (80-col, no space after colon, multi-line
  ternaries).
- No CSS unrelated to this task is modified. New rules added to
  `src/client/routes/item-reader.css` for the publisher link and the
  fetch-state notice.
- No emoji in code/comments.
- Logging & privacy: article URLs are user-visible item links, so a
  one-line per-attempt info log is acceptable; no headers, cookies, or
  request bodies are logged. Failure logging follows the spec-001
  pattern (no `console.error` for routine failures; record on the row
  via `full_content_status` instead).

**Result**: PASS, with one Complexity Tracking entry (justifying the
non-outbox path for `fetch-full`).

## Project Structure

### Documentation (this feature)

```text
specs/002-full-article-fetch/
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output (decisions + rationale)
├── data-model.md        # Phase 1 output (Item schema delta + status enum)
├── quickstart.md        # Phase 1 output (manual verification recipe)
├── contracts/
│   └── fetch-full-article.md
│                        # Phase 1 output (HTTP contract for the new
│                        # POST /api/items/:id/fetch-full endpoint)
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks - NOT in this run)
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── schema.ts                    # +full_content, full_content_fetched_at,
│   │                                #  full_content_status on items
│   ├── article-detect.ts            # NEW: deterministic "summary-only?" check
│   └── publisher-link.ts            # NEW: link -> domain for the read-on link
│
├── server/
│   ├── article-extract.ts           # NEW: HTML body extractor (article >
│   │                                #  main > density), no new deps
│   ├── article-fetch.ts             # NEW: fetch + extract + sanitise
│   │                                #  pipeline, reuses fetchValidatedResponse
│   │                                #  with MAX_ARTICLE_REDIRECTS = 5 (spec 001)
│   └── durable-objects/
│       └── index.ts                 # New route POST /items/:id/fetch-full;
│                                    # ITEM_COLUMNS extended; migration to
│                                    # ALTER TABLE items ADD COLUMN ... x3;
│                                    # USER_DO_MIGRATION_VERSION bumped 4->5
│
└── client/
    ├── db/
    │   ├── types.ts                 # Item: +full_content, +full_content_*
    │   ├── remote-adapter.ts        # +fetchFullArticle(id, force?)
    │   ├── pull-sync.ts             # upsertItem extended with new columns
    │   ├── push-sync.ts             # upsertItemFromServer extended
    │   └── local-adapter.ts         # SELECT * already covers new cols;
    │                                # add a small applyFetchedFullArticle
    │                                # helper for local upsert after a fetch
    └── routes/
        ├── item-reader.ts           # auto-trigger fetch on open if summary;
        │                            # render publisher link; status notice;
        │                            # retry button on failure;
        │                            # replace "Open original" with publisher link
        └── item-reader.css          # +.article-publisher-link,
                                     # +.article-fetch-status,
                                     # +.article-fetch-retry styles only

test/
├── article-extract.ts               # NEW: pure extractor unit tests
├── article-fetch.ts                 # NEW: server pipeline tests (success,
│                                    # paywall stub, non-HTML, redirect cap,
│                                    # timeout, size cap, invalid URL)
├── article-detect.ts                # NEW: summary-vs-full heuristic
├── publisher-link.ts                # NEW: link -> label/href
├── sync.ts                          # +full_content sync round-trip
└── local-adapter.ts                 # +full_content local upsert
```

**Structure Decision**: Web app topology (`backend/` = Worker + DO,
`frontend/` = Preact SPA), already in place. No new top-level
directories. The four new modules each have a single, narrow
responsibility (detect, extract, fetch-pipeline, publisher-link) so
each can be unit-tested without spinning up a DO.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 1. `POST /api/items/:id/fetch-full` does not flow through the client outbox (Principle II) | The fetch-full result is *derived server-side* from the publisher's HTML at fetch time. The client cannot construct the result locally to express it as a queued mutation; the outbox model is built around client-initiated value-assignments (read/star toggle, add/delete feed). Idempotency under retry is preserved differently: re-issuing on a `succeeded` row is a server-side no-op, and re-issuing on a `failed_*` row re-attempts. | Routing through the outbox would require either (a) the outbox carrying a "request to compute" with no payload, which abuses the outbox semantics and would still require an inline response to satisfy SC-002 (3-second TTI), or (b) splitting the operation into a queued request + a separate poll loop, which adds latency and a second moving part for no benefit. The current approach keeps the operation strictly inside the DO with the result returned inline; the client mirrors the row into its local DB on receipt. |
