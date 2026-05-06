# Implementation Plan: Fix Up-to-Date Dot Indicator

**Branch**: `008-fix-up-to-date-dot` | **Date**: 2026-05-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/008-fix-up-to-date-dot/spec.md`

## Summary

The header "n updates / up to date" pill must reflect the truth: how
many items the server holds that the client has not yet pulled. Today
the indicator can silently show green when the client is genuinely
behind, because the indicator state is sourced from `loadFeeds()` (and
the local adapter returns no counts), and because `feed-updates-
available` SSE events drop counts and skip re-broadcast when a feed is
already in the unsynced set.

The fix is a small contract change with no schema or migration
impact:

1. Add a single read-only endpoint `GET /api/feed-status` on the user
   Durable Object that returns the authoritative per-feed pending
   count (`feeds.last_pulled_at` vs `items.pub_date`). This is one
   round trip, regardless of adapter mode or feed count.
2. Move ownership of `feedUpdateCounts` / `feedSyncStatus` from
   `loadFeeds()` into a new `State.loadFeedStatus()` so both
   `localAdapter` and `remoteAdapter` resolve the indicator from the
   same source.
3. Make page-load failures visible: a failed `loadFeedStatus()` sets
   `feedSyncStatus = 'error'` instead of leaving the indicator green.
4. Augment the `feed-updates-available` SSE event to carry per-feed
   counts and to fire whenever a feed gains items (not only on the
   first transition into the unsynced set), so the displayed total
   keeps pace with the server.
5. Reconcile on SSE reconnect: when the EventSource re-opens after a
   drop, re-run `loadFeedStatus()` so missed events cannot leave the
   indicator stale.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers + ES2022 lib for
server / DO; ES2022 via Vite for client)
**Primary Dependencies**: Hono (server router), `@cloudflare/workers-
types`, Preact + `@preact/signals` + `htm/preact` (client), `ky`
(client HTTP), `EventSource` (browser SSE)
**Storage**: Per-user Durable Object SQLite (server-authoritative
`feeds.last_pulled_at` and `items.pub_date`); local SQLite via
`@sqlite.org/sqlite-wasm` over OPFS-SAH-pool (client mirror)
**Testing**: `tape` test files under `test/` (Node-side stubs of CF
Workers + DOM); browser-driven runs through `npm test`
**Target Platform**: Cloudflare Workers (DO + Worker), modern
evergreen browsers for the client
**Project Type**: Web application (Cloudflare Worker + Preact SPA in
the same repo; `src/server`, `src/client`, `src/shared`)
**Performance Goals**: Indicator correct within 2 s of page load
(SC-001); SSE-driven update within 5 s (SC-002); refresh clears within
3 s (SC-003); single round-trip for page-load status regardless of
feed count (SC-004 / FR-010)
**Constraints**: No schema migration; no per-feed request fan-out;
indicator MUST NOT silently default to "up to date" on error (FR-012);
must work for free (online-only) users and paid (local-first) users
without bifurcation
**Scale/Scope**: Per-user feed count assumed to remain small (today's
account scales, per spec assumption). The new endpoint runs one
GROUP BY over `items` per request; well under DO budget.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0
(principles I-V):

- **I. Local-First Reads** - PASS. The indicator is meta-state about
  server-vs-client divergence; it cannot be derived from the local DB
  alone (the local DB does not know what items the server has that the
  client has not pulled). The new endpoint is intentionally a server
  read for that comparison only; happy-path reads (`loadFeeds`,
  `loadItems`, `loadCounts`) continue to resolve through
  `localAdapter` unchanged.
- **II. Idempotent, Outbox-Backed Sync** - PASS. The new endpoint is
  read-only. No new mutations, no outbox change, no idempotency key
  required.
- **III. Edge-Native Topology (Worker + Per-User DO)** - PASS. The
  `/feed-status` route lives inside `UserDO` and reads its own SQLite
  storage. No cross-user shared state, no external queue, no extra
  cron. The Worker proxies via the existing `/api/*` -> DO path.
- **IV. Capability-Gated Progressive Enhancement** - PASS. Both
  `localAdapter` and `remoteAdapter` users hit the same status
  endpoint; the indicator behaves identically across modes. No
  feature is made local-first-only.
- **V. Bluesky-Anchored Identity** - PASS. The endpoint is mounted
  under `dataRouter.use('*', requireAuth)`; no new auth flow, no
  shadow user table.

No violations; Complexity Tracking section unused.

## Project Structure

### Documentation (this feature)

```text
specs/008-fix-up-to-date-dot/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── feed-status-endpoint.md
│   └── sse-feed-updates-available.md
└── tasks.md             # Phase 2 output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── server/
│   ├── durable-objects/
│   │   └── index.ts            # add GET /feed-status; update
│   │                           # feed-updates-available broadcast
│   └── index.ts                # unchanged (existing /api/* proxy
│                               # already forwards /feed-status to DO)
├── client/
│   ├── state.ts                # new State.loadFeedStatus(); wire
│   │                           # into auth load, SSE open/reconnect,
│   │                           # online, refresh-complete; consume
│   │                           # counts on feed-updates-available
│   ├── db/
│   │   ├── remote-adapter.ts   # drop count fields from getFeeds()
│   │   ├── local-adapter.ts    # unchanged
│   │   └── types.ts            # add FeedStatusResponse; trim
│   │                           # FeedsResponse
│   └── components/
│       └── feed-status.ts      # unchanged (already reads counts
│                               # from state.feedUpdateCounts)
└── shared/
    └── (no changes)

test/
├── feed-status.ts              # extend: error/unknown legend
├── dot.ts                      # extend: error color path
├── do-handlers.ts              # extend: GET /feed-status
└── feed-status-loader.ts       # NEW: client loader + SSE behavior
```

**Structure Decision**: This repo does not use the boilerplate
`backend/`/`frontend/` split shown in the spec template; the actual
layout is `src/server`, `src/client`, `src/shared`. The plan references
the real paths. The DO routes live in
`src/server/durable-objects/index.ts`; the SPA lives in `src/client`.

## Complexity Tracking

> Not applicable. Constitution Check passes without violations.
