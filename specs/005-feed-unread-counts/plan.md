# Implementation Plan: Per-Feed Unread Counts In Sidebar

**Branch:** `005-feed-unread-counts` | **Date:** 2026-05-03 | **Spec:** [./spec.md](./spec.md)
**Input:** Feature specification from `/specs/005-feed-unread-counts/spec.md`

## Summary

Render a numeric unread count to the left of every feed name in the
sidebar feed list, including the "All Feeds" pseudo-feed (which shows
the sum across all subscribed feeds). The cleanest place to thread the
data is the existing `CountsResponse`: extend it with
`perFeed:Record<string, number>` and have `DbAdapter.getCounts()` on
both `localAdapter` and `remoteAdapter` return the per-feed unread
aggregate alongside the existing `{ unread, starred, total }`. The
sidebar reads `state.counts.value.perFeed[feed.id] ?? 0` for each feed
and reuses the already-present `state.counts.value.unread` for the
"All Feeds" row (the two are equal by construction — both count
`is_read = 0` across all items). No schema, sync-protocol, or outbox
changes are required: `State.loadCounts(state)` is already called
after every mutation that can change unread state and after every
sync settle, so reactivity for FR-005 / FR-006 / FR-007 is already in
place.

## Technical Context

**Language/Version:** TypeScript (Cloudflare Workers runtime, ES2022
lib). Client compiled by Vite to ES module bundles for modern
evergreen browsers.
**Primary Dependencies:** Hono (server), Preact + `@preact/signals`
(client), `htm/preact` for component templates,
`@sqlite.org/sqlite-wasm` (OPFS-SAH-pool VFS) for local-first reads,
`ky` for HTTP. No new runtime dependencies.
**Storage:** Per-user Durable Object SQLite (server-authoritative)
and OPFS-backed SQLite (local-first). **No schema change.** Per-feed
unread counts are derived at read time from existing
`items.is_read` / `items.feed_id` columns; the existing
`idx_items_is_read` and `idx_items_feed_id` indexes
(`src/shared/schema.ts:77-78`) make the `GROUP BY feed_id` aggregate
cheap.
**Testing:** Existing project tests via `npm test && npm run lint`.
Add a Preact-render unit test for the sidebar feed list and an
adapter test that asserts `getCounts()` returns the new `perFeed`
shape on both adapters. Plus the manual browser quickstart in
`./quickstart.md` (constitution Local Verification rule).
**Target Platform:** Modern evergreen browsers (Chrome/Firefox/Safari
current). Server side: Cloudflare Workers + Durable Objects.
**Project Type:** Web app — Cloudflare Worker + Durable Object
backend, Preact SPA frontend. Established directory layout under
`src/server/`, `src/client/`, `src/shared/`.
**Performance Goals:** No perceptible regression. The new aggregate
runs once per `loadCounts` call (already gated by mutations and sync
settle, not on every render). Sidebar render reads two already-resident
signals; per-feed lookup is `O(feeds_in_sidebar)` map access — flat
under any realistic feed count.
**Constraints:** Must obey CSS / TypeScript style rules in
`/Users/nick/.claude/CLAUDE.md` and the project constitution
(≤80 col, no space after `:` in type annotations, ternaries break per
branch, nested CSS selectors, font-size ≥ `1rem`, only colors from
`_variables.css`). Render path must work under both `localAdapter`
and `remoteAdapter` (Principle IV). The unread count MUST NOT be
gated by `feeds.last_pulled_at` — FR-003 / FR-009 require it to
equal "items in the unread state for the viewing reader," matching
the existing `unread` total semantics.
**Scale/Scope:** Touches one shared interface (`CountsResponse`),
both adapters, one DO route, two client files (`sidebar.ts` to
render, `state.ts` only for the initial-value default), and adds two
test files. Realistic per-user feed count is ≤ a few hundred.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0,
principles I-V.

| Principle | Status | Notes |
|---|---|---|
| **I. Local-First Reads** | PASS | The new per-feed aggregate is added to `getCounts()` on both adapters. `localAdapter.getCounts()` runs the new aggregate against the local SQLite database; `remoteAdapter.getCounts()` consumes the same shape from `GET /api/items/count`. The render path reads `state.counts.value.perFeed`, which is populated identically online and offline. No UI code calls the network for data the local store already owns. |
| **II. Idempotent, Outbox-Backed Sync** | PASS | No mutations introduced. No outbox entries. `/api/sync` payload unchanged. `pullSync` upsert logic unchanged. `bootstrapLocalDb` unchanged. |
| **III. Edge-Native Topology (Worker + Per-User DO)** | PASS | The change is one extra aggregate query inside the existing `GET /items/count` DO route. No alarm cadence change, no Hibernation API change, no new cross-user state, no external cron/queue. |
| **IV. Capability-Gated Progressive Enhancement** | PASS | Both `localAdapter` and `remoteAdapter` return the new shape; the sidebar render path is adapter-agnostic. No service worker introduced. |
| **V. Bluesky-Anchored Identity** | PASS | Auth and session paths untouched. |

**Schema-and-sync coupling rule (Workflow):** N/A. The client renders
a count *derived* from existing columns (`items.is_read`,
`items.feed_id`). No new column is rendered, so the rule that requires
DO schema + `/api/sync` payload + `bootstrapLocalDb` + local schema +
`pullSync` to move together does not fire.

**Idempotency review:** N/A — no new mutations.

**Capability fallback review:** Both adapters are extended in
lockstep; neither becomes local-first-only.

**Local verification:** Will run `npm test && npm run lint`, then
exercise the feature in a browser per `./quickstart.md` before
claiming the work done. Type-check + tests alone are not sufficient
(constitution Development Workflow & Quality Gates).

**TypeScript / CSS style:** New TypeScript respects ≤80 columns and
the `key:type` no-space style. CSS additions live in
`sidebar-item.css` / `sidebar.css` (or inline-nested under existing
selectors), reuse colors from `_variables.css`, and keep font-size
≥ `1rem`. CSS unrelated to this feature is not modified.

**Result:** All gates pass. Complexity Tracking section is empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-feed-unread-counts/
├── plan.md                       # This file
├── spec.md                       # Feature spec (input)
├── research.md                   # Phase 0 output
├── data-model.md                 # Phase 1 output
├── quickstart.md                 # Phase 1 output (manual browser test)
├── contracts/
│   ├── counts-response.md        # Phase 1 output (CountsResponse shape)
│   └── sidebar-feed-counts.md    # Phase 1 output (sidebar render contract)
├── checklists/                   # Pre-existing; not modified by /plan
└── tasks.md                      # Phase 2 output (created later by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── components/
│   │   ├── sidebar.ts            # CHANGE: render unread count to the left
│   │   │                         #   of every feed name and "All Feeds"
│   │   └── sidebar.css           # CHANGE: styling for the leading count
│   ├── db/
│   │   ├── types.ts              # CHANGE: add perFeed:Record<string,number>
│   │   │                         #   to CountsResponse
│   │   ├── local-adapter.ts      # CHANGE: getCounts() runs perFeed aggregate
│   │   └── remote-adapter.ts     # CHANGE: getCounts() returns perFeed
│   └── state.ts                  # CHANGE: initial counts signal carries
│                                 #   perFeed:{} (one-line default)
├── server/
│   └── durable-objects/
│       └── index.ts              # CHANGE: GET /items/count returns perFeed
├── shared/
│   └── schema.ts                 # UNCHANGED — no column added
└── (sync paths)                  # UNCHANGED — no payload or upsert change

test/
├── (add) test/sidebar-feed-counts.ts  # NEW: Preact render unit test for
│                                      #   per-feed count rendering, "All
│                                      #   Feeds" sum, and 0-shows-as-0
└── (extend) test/db-adapter.ts        # ADDS: assertion that getCounts()
                                       #   returns perFeed on both adapters
```

**Structure Decision:** Established two-tier web app layout
(`src/client/` Preact SPA, `src/server/` Hono+DO worker,
`src/shared/` cross-edge code). This feature adds rendering plus a
small adapter-and-DO data extension; no new directories, no new
modules.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(Empty — no violations.)*
