# Implementation Plan: Defer New Feed Items Until Refresh

**Branch**: `003-defer-new-feed-items` | **Date**: 2026-05-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-defer-new-feed-items/spec.md`

## Summary

When a reader adds a new feed, the reading list MUST stay visually
unchanged until the reader explicitly clicks "Refresh Feeds". The new
feed's posts MUST instead increase the existing un-synced posts
counter (the small dot in the header) and place the sync status pill
in the "updates available" state.

The architecture already exposes the right primitive for this:
`feeds.last_pulled_at` is the per-feed cursor that records the most
recent post the reader has pulled into their reading view. On manual
refresh the server already advances this cursor (`advanceFeedCursor`)
to `MAX(pub_date)`, and `getFeedsWithUpdates()` already uses it to
identify "updates available" feeds. The implementation gap is that the
reading-list query does NOT yet apply this cursor as a filter, and
`last_pulled_at` is not yet replicated to the client's local SQLite,
so a local-first reader cannot apply the same filter offline.

This plan delivers three small, coupled changes that together close
that gap:

1. **Filter the reading list by `last_pulled_at`** in both `GET /items`
   (server) and `localAdapter.getItems()` (client). An item is visible
   iff its feed's `last_pulled_at` is non-null and the item's
   `pub_date` is `<=` that cursor. Newly added feeds (cursor IS NULL)
   contribute zero visible items until the reader clicks refresh.
2. **Replicate `last_pulled_at` through `/api/sync`** by adding it to
   `FEED_SYNC_COLUMNS` server-side and to `upsertFeed` on the client's
   `pull-sync.ts`. This is the "schema and sync are coupled" change
   mandated by the constitution.
3. **Stop forcing `loadItems()` immediately after add-feed** in
   `state.ts`, since the new feed contributes no visible items by
   definition. Continue calling `loadFeeds()` (sidebar updates) and
   `loadCounts()` (per-feed sidebar counts).

The un-synced counter (`feedUpdateCounts`) and the sync status pill
(`feedSyncStatus`) are already driven by the existing
`feed-updates-available` SSE event, which fires after the post-add
background `fetchFeed` inserts items. No counter/status code changes
are required, only verification.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers + ES2022 lib)
**Primary Dependencies**: Hono (server), Preact + `@preact/signals`
(client), `@sqlite.org/sqlite-wasm` (client OPFS), Cloudflare Durable
Objects with SQLite storage (server)
**Storage**: Per-user Durable Object SQLite (server-authoritative);
local OPFS-SAH-pool SQLite mirror (client). Shared `TABLES_SQL` lives
in `src/shared/schema.ts`. The `feeds.last_pulled_at TEXT` column
already exists in the shared schema and on both sides.
**Testing**: Existing `npm test` suite (Vitest-style). Manual browser
verification per the constitution's local verification rule.
**Target Platform**: Cloudflare Workers + modern browsers with OPFS
support (cross-origin-isolated). Falls back to `remoteAdapter` when
local-first capability is unavailable.
**Project Type**: Web application (Preact SPA + Cloudflare Worker
backend). Layout matches the existing `src/client/`, `src/server/`,
`src/shared/` tree.
**Performance Goals**: Match existing read latency. The new filter
adds at most a single inequality comparison per item row; the
`feeds JOIN items` is already present in the relevant queries.
**Constraints**: No regressions to add-feed error or duplicate
behavior (FR-007, FR-008). No change to per-feed sidebar unread
counts (FR-009). No service worker, no shared cross-user state
(constitution III, IV).
**Scale/Scope**: Per-user, single-tab local-first; reading list sizes
in the low thousands at most. No new persistence introduced.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

| Principle | Verdict | Notes |
|-----------|---------|-------|
| I. Local-First Reads | **PASS** | The new filter is applied symmetrically in both `localAdapter.getItems()` and `remoteAdapter`/server `GET /items`. The cursor (`last_pulled_at`) is replicated to the local DB so the read works offline without a network round-trip. No happy-path read is bypassed to the network. |
| II. Idempotent, Outbox-Backed Sync | **PASS** | No new mutations. `advanceFeedCursor` is idempotent (assigns `MAX(pub_date)`). Pull-sync upserts continue to use the existing wrapped-row pattern. The client outbox is unchanged. |
| III. Edge-Native Topology | **PASS** | All work stays inside the existing Worker + per-user UserDO. No cross-user state, no new external worker, queue, or cron. The existing 10-minute alarm-driven refresh already calls `advanceFeedCursor`. |
| IV. Capability-Gated Progressive Enhancement | **PASS** | Both adapters carry the same filter so the local-first and remote-fallback paths are behaviorally identical. No feature is made local-first-only. No service worker is introduced. |
| V. Bluesky-Anchored Identity | **PASS** | Authentication is untouched. Identity flow is unchanged. |
| Schema/sync coupling rule | **PASS (with required edits)** | The `feeds.last_pulled_at` column already exists in `TABLES_SQL`. To honor the rule we update, in the same change set: server `FEED_SYNC_COLUMNS`, the `/api/sync` payload contract, client `pull-sync.ts:upsertFeed`, and (transitively) `bootstrap.ts`. See data-model.md and contracts/ for specifics. |
| Idempotency review (mutations) | **N/A** | No new mutation routes. The single semantic change to `POST /feeds` is that its background `fetchFeed` MUST NOT advance the cursor for the new feed (it already doesn't — only manual `/feeds/refresh` and `/feeds/:id/refresh` call `advanceFeedCursor`). Verified during research. |
| Capability fallback review | **PASS** | Both `localAdapter.getItems()` and `remoteAdapter.getItems()` change in lock-step. The fallback path remains a first-class path. |

**Outcome:** No principle violations, no Complexity Tracking entries
required.

## Project Structure

### Documentation (this feature)

```text
specs/003-defer-new-feed-items/
├── spec.md              # Feature spec (input)
├── plan.md              # This file (/speckit.plan output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── api-items.md         # GET /api/items semantic change
│   └── api-sync.md          # /api/sync feed payload addition
├── quickstart.md        # Phase 1 output (manual test flow)
├── checklists/          # spec quality checklists (already present)
└── tasks.md             # /speckit.tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── shared/
│   └── schema.ts                 # TABLES_SQL (last_pulled_at already present)
├── server/
│   ├── index.ts                  # Hono worker entry (no change)
│   └── durable-objects/
│       └── index.ts              # CHANGE: FEED_SYNC_COLUMNS adds
│                                 # last_pulled_at; GET /items applies
│                                 # the cursor filter; verify migration
│                                 # bumps updated_at
└── client/
    ├── state.ts                  # CHANGE: addFeed handler stops calling
    │                              # loadItems() (keeps loadFeeds/loadCounts)
    ├── components/
    │   ├── feed-status.ts        # NO CHANGE (counter dot)
    │   └── sync-status.ts        # NO CHANGE (status pill)
    ├── routes/
    │   └── feed-reader.ts        # NO CHANGE (reads state.items)
    └── db/
        ├── local-adapter.ts      # CHANGE: getItems applies the cursor
        │                          # filter via JOIN feeds
        ├── remote-adapter.ts     # NO CHANGE (server applies the filter)
        ├── pull-sync.ts          # CHANGE: upsertFeed writes
        │                          # last_pulled_at
        └── bootstrap.ts          # NO CHANGE (uses upsertFeed transitively)

test/                              # add: integration tests for reading-list
                                  # filter; cover acceptance scenarios from
                                  # the spec and the edge cases.
```

**Structure Decision:** Existing `src/client/` + `src/server/` +
`src/shared/` layout is sufficient. No new packages or directories.

## Complexity Tracking

> No constitution violations identified. No entries.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_    | _none_     | _none_                               |
