# Implementation Plan: Newly Added Feeds Must Reach a Terminal State

**Branch**: `018-fix-feed-resolving-stuck` | **Date**: 2026-05-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-fix-feed-resolving-stuck/spec.md`

## Summary

The "resolving" state for newly added feeds never terminates because the
client–server contract for terminal-state fields is broken on **both
sides** and there is no time-bounded fallback when the broken contract
swallows a real outcome.

- **Client side (primary visible bug).** `upsertFeed` in
  `src/client/db/pull-sync.ts:146-175` and `upsertFeedFromServer` in
  `src/client/db/push-sync.ts:131-158` do not include `last_error` or
  `last_status` in their INSERT/UPDATE column lists. The server already
  serializes both fields in `/api/sync` (`FEED_SYNC_COLUMNS`,
  `src/server/durable-objects/index.ts:117-120`), but the local SQLite
  copy keeps `last_error = NULL`, so the sidebar's `isResolving`
  predicate (`feed.last_fetched === null && !feed.last_error`) stays
  true forever.
- **Server side (secondary, masks the same symptom).** `fetchFeed`
  (`src/server/durable-objects/index.ts:1507-1734`) has two success
  paths that leave `last_fetched` NULL:
  - The 304 Not Modified branch (lines 1525-1542) returns early without
    touching `last_fetched`. On a first-time fetch that hits 304, the
    row stays resolving even though the upstream is reachable. This is
    a direct FR-005 violation.
  - The "parse succeeded but `title`/`description`/`link` are all
    empty" branch skips the `UPDATE feeds SET ... last_fetched = ...`
    statement entirely (gated by the `if` at line 1557). Per FR-004
    this row must still reach the resolved state.
- **Recovery gap (worst case).** `POST /api/feeds` schedules
  `this.ctx.waitUntil(this.fetchFeed(feed))` and returns immediately.
  If the DO is evicted mid-fetch, neither `last_fetched` nor
  `last_error` is written. The 10-minute periodic alarm
  (`alarm()` at lines 2450-2477) eventually re-fetches and lands the
  row in a terminal state, but FR-001 demands a much shorter bounded
  window.

**Technical approach.** Fix all three layers in the same change set so
the state machine is correct end to end.

1. **Client persistence layer.** Add `last_error` and `last_status` to
   the column lists, `excluded.*` clauses, and parameter binds of
   `upsertFeed` (`pull-sync.ts`) and `upsertFeedFromServer`
   (`push-sync.ts`). Add a guarded `ALTER TABLE` in
   `src/client/db/local-db.ts` so existing local DBs gain the columns
   (the local-first schema in `src/shared/schema.ts:38-50` already
   defines them; only legacy local DBs created before commit 7189ddc
   lack them).
2. **Server fetch paths.** Make every successful `fetchFeed` path write
   a terminal marker:
   - 304 branch: write `last_fetched = datetime('now')`, clear
     `last_error`/`last_status`.
   - Drop the `if (title || description || link)` gate so the
     `last_fetched/last_error/last_status` UPDATE runs on every parsed
     response. The `COALESCE` keeps metadata sticky when fields are
     null.
   - Keep the existing failed-path writes (`last_error`/`last_status`)
     untouched.
3. **Server timeout sweep.** Add a bounded-window guarantee
   server-side. After `POST /api/feeds` inserts a new row, schedule a
   DO alarm at `min(existingAlarm, now + RESOLVE_WINDOW_MS)`. The
   `alarm()` handler gains a "sweep stuck-resolving feeds" pass that
   marks rows with `last_fetched IS NULL AND last_error IS NULL AND
   created_at < now - RESOLVE_WINDOW_MS` as failed with a
   `RESOLVE_TIMEOUT_ERROR` reason, then broadcasts `feed-updated` for
   each. This covers DO eviction, dropped `waitUntil`, and any future
   silent-failure path.
4. **Refresh response.** Change `POST /api/feeds/:id/refresh` to return
   the post-fetch feed row (not just `{ success: true }`), so the
   client can write the terminal state back immediately rather than
   waiting for the next pull-sync.
5. **Client convergence guarantee.** When `State.addFeed` succeeds,
   start a one-shot `setTimeout` (`RESOLVE_WINDOW_MS + 5s`) that calls
   `runSync` if the new row is still in `resolving`. This is defense
   in depth so the bounded window holds even when SSE is dropped
   entirely (FR-006).

`RESOLVE_WINDOW_MS` is **30 seconds**. Justification: the server's
`FEED_FETCH_TIMEOUT_MS` is 15s (`src/server/feed-fetch.ts:3`), so 30s
absorbs one timed-out fetch plus DO scheduling latency without making
the user wait a minute. See `research.md` for alternatives considered.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for the
client; Cloudflare Workers + ES2022 lib for the DO/worker)
**Primary Dependencies**: Hono (worker router), `@cloudflare/durable-objects`,
`@cloudflare/workers-types`, `fast-xml-parser` (server feed parser);
Preact + `@preact/signals` + `htm/preact` (client),
`@sqlite.org/sqlite-wasm` (local SQLite over OPFS-SAH-pool)
**Storage**: Per-user Durable Object SQLite (server-authoritative,
`feeds` table; `last_error TEXT`, `last_status INTEGER` already exist
in `src/shared/schema.ts:38-50`). Local OPFS-backed SQLite for
local-first reads — needs an idempotent `ALTER TABLE` for legacy DBs.
**Testing**: `npm test` (vitest) + `npm run lint`. Manual browser
verification per the constitution.
**Target Platform**: Cloudflare Workers + Durable Objects (server),
modern evergreen browsers with OPFS-SAH-pool (client local-first path)
and remote-only fallback (`remoteAdapter`).
**Project Type**: Web service + SPA (Worker + Durable Object + Preact
client) — `backend/` and `frontend/` per `CLAUDE.md` are realized as
`src/server`, `src/client`, `src/shared` in this repo.
**Performance Goals**: Bounded resolution window for any newly added
feed: target ≤ 30s from `POST /api/feeds` to terminal-state visibility
on the client (FR-001, SC-001, SC-004).
**Constraints**: No new persistent schema migration on the *server*
side (columns exist). Idempotent local `ALTER TABLE` so legacy local
DBs upgrade without data loss. CSS unchanged (constitution: do not
modify CSS unrelated to the task). The visual treatments for
resolving/failed/resolved are unchanged.
**Scale/Scope**: Per-user; touches `src/client/db/pull-sync.ts`,
`src/client/db/push-sync.ts`, `src/client/db/local-db.ts`,
`src/client/state.ts`, `src/server/durable-objects/index.ts`. Roughly
5 files; no new packages.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

| Principle | Status | Notes |
|---|---|---|
| I. Local-First Reads | PASS | Local SQLite still owns the read path; the sidebar's `isResolving`/`hasFailed` predicate continues to read `feeds` from `localAdapter`. The fix corrects what the local DB *stores*, not how it's read. |
| II. Idempotent, Outbox-Backed Sync | PASS | No new mutations introduced. `POST /api/feeds` is already idempotent (URL is the key). The new server-side sweep is an internal write (mark stuck row failed) that is value-assignment idempotent. The new client one-shot `runSync` is a normal pull-sync trigger. |
| III. Edge-Native Topology | PASS | All server logic stays in the per-user DO. The new sweep runs inside the existing `alarm()` handler; no external cron, queue, or worker is introduced. |
| IV. Capability-Gated Progressive Enhancement | PASS | The fix benefits both `localAdapter` (via `upsertFeed`/`upsertFeedFromServer`/`ALTER TABLE`) and `remoteAdapter` (via the corrected `POST /feeds/:id/refresh` response and the new sweep, which makes the next `GET /api/sync` or `GET /api/feeds` already correct). No new local-first-only behavior. |
| V. Bluesky-Anchored Identity | PASS | No auth changes. |

Schema-and-sync coupling check (Development Workflow): the *server*
DO schema is unchanged; the local SQLite schema gains `last_error`,
`last_status` via idempotent `ALTER TABLE` in `local-db.ts`. The
shared schema (`src/shared/schema.ts:38-50`) already declares both
columns, so the local schema is being brought into compliance with
the shared definition — not divergence. `/api/sync` payload (column
list `FEED_SYNC_COLUMNS`) already includes the fields. `pullSync`
upsert is being updated as part of this change. No partial schema
change.

**Result**: No constitutional violations. No Complexity Tracking
entries required.

## Project Structure

### Documentation (this feature)

```text
specs/018-fix-feed-resolving-stuck/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (feed-row state machine)
├── quickstart.md        # Phase 1 output (verify the fix end to end)
├── contracts/
│   ├── refresh-response.md   # POST /api/feeds/:id/refresh shape
│   └── feed-row-state.md     # client predicate over feed columns
├── spec.md              # already present
└── tasks.md             # Phase 2 output (/speckit.tasks - NOT this command)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── components/
│   │   └── sidebar.ts          # Renders resolving/failed/resolved
│   │                           # cue (no change in this feature;
│   │                           # predicate at lines 166-170 stays
│   │                           # the same).
│   ├── db/
│   │   ├── local-db.ts         # Add idempotent ALTER TABLE for
│   │   │                       # legacy local DBs lacking
│   │   │                       # last_error / last_status.
│   │   ├── pull-sync.ts        # upsertFeed: add last_error,
│   │   │                       # last_status to INSERT, UPDATE,
│   │   │                       # and bind list.
│   │   └── push-sync.ts        # upsertFeedFromServer: same fix.
│   └── state.ts                # State.addFeed: arm a one-shot
│                               # convergence runSync at
│                               # RESOLVE_WINDOW_MS + grace, if
│                               # the just-added row is still
│                               # resolving. retryResolveFeed:
│                               # write back the response row.
├── server/
│   ├── durable-objects/
│   │   └── index.ts            # fetchFeed: write last_fetched
│   │                           # on 304 path and on
│   │                           # parsed-but-no-metadata path.
│   │                           # POST /api/feeds: schedule
│   │                           # alarm at min(existing, now +
│   │                           # RESOLVE_WINDOW_MS).
│   │                           # alarm(): sweep stuck-resolving
│   │                           # rows older than window and
│   │                           # mark failed with timeout
│   │                           # reason.
│   │                           # POST /api/feeds/:id/refresh:
│   │                           # return the post-fetch row.
│   └── feed-fetch.ts           # No change (FEED_FETCH_TIMEOUT_MS
│                               # = 15s, referenced from plan).
└── shared/
    └── schema.ts               # Already declares the columns.
                                # No change.

test/                           # Add vitest specs covering:
                                #  - upsertFeed/upsertFeedFromServer
                                #    persist last_error/last_status
                                #  - 304 and no-metadata fetchFeed
                                #    paths set last_fetched
                                #  - sweep marks stuck rows failed
                                #    past the window
                                #  - retry response includes the
                                #    post-fetch row
```

**Structure Decision**: This repo follows the `src/client`,
`src/server`, `src/shared` split documented in `CLAUDE.md` under
"Project Structure" (mapped from the generic `frontend/`, `backend/`
labels). All changes land in those existing trees; no new top-level
directories.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified.**

No violations. Section intentionally empty.
