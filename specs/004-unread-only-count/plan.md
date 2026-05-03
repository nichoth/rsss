# Implementation Plan: Sync "All Items" Count With Unread-Only Filter

**Branch:** `004-unread-only-count` | **Date:** 2026-05-02 | **Spec:** [./spec.md](./spec.md)
**Input:** Feature specification from `/specs/004-unread-only-count/spec.md`

## Summary

The "All Items" sidebar badge currently shows
`state.counts.value.unread` regardless of the "Unread only" filter
state. The reading list itself respects the filter, so the badge and
the visible list disagree whenever any item is read. The fix is a
purely client-side, render-only change: in `SidebarItem`, drive the
badge from `state.showUnreadOnly` — show `counts.total` when the
filter is off and `counts.unread` when it is on. Both values are
already returned by `DbAdapter.getCounts()` on both adapters and are
already refreshed after every mutation that could change them, so no
adapter, schema, sync, server, or new state work is required.

## Technical Context

**Language/Version:** TypeScript (Cloudflare Workers + ES2022 lib),
client compiled by Vite to ES module bundle.
**Primary Dependencies:** Preact + `@preact/signals` for client
state; `htm/preact` for the affected component's templates. No new
dependencies.
**Storage:** N/A for this change. Reads through existing
`@sqlite.org/sqlite-wasm` (OPFS) for `localAdapter` or `fetch` to
`/api/items/count` for `remoteAdapter`. No schema changes.
**Testing:** Existing unit/integration tests via the project's `npm
test` script (see `test/`). Plus the manual browser quickstart in
`./quickstart.md` per constitution Local Verification rule.
**Target Platform:** Modern evergreen browsers (the rest of the
client). Server side untouched.
**Project Type:** Web app (Cloudflare Worker + Durable Object backend
+ Preact SPA frontend). Established structure under `src/server/` and
`src/client/`.
**Performance Goals:** No regression. Render-only change reads two
already-resident signals; the filter toggle path stays at O(1)
client work plus the existing `loadItems` call (unchanged).
**Constraints:** Must obey CSS / TypeScript style rules in
`CLAUDE.md` (≤80 col, no space after `:` in type annotations, nested
selectors when CSS is touched — though no CSS changes are planned
here). Render path must work under both `localAdapter` and
`remoteAdapter`.
**Scale/Scope:** One file change (`src/client/components/sidebar-item.ts`)
plus one or two test additions. ~5 lines of production code.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0,
principles I-V.

| Principle | Status | Notes |
|---|---|---|
| **I. Local-First Reads** | PASS | No new reads. The badge reads `state.counts`, which is populated by `State.loadCounts()` going through `getAdapter()` → `localAdapter`/`remoteAdapter`. Both adapters already return `total` (`local-adapter.ts:219-239`, `remote-adapter.ts:129-132`). Render path is identical online and offline. |
| **II. Idempotent, Outbox-Backed Sync** | PASS | No mutations. No outbox entries added. No `/api/sync` payload changes. No `pullSync` upsert changes. |
| **III. Edge-Native Topology (Worker + Per-User DO)** | PASS | No worker, DO, alarm, or hibernation changes. `GET /api/items/count` is unchanged. |
| **IV. Capability-Gated Progressive Enhancement** | PASS | The badge's data source (`state.counts`) is populated identically by both adapters; the change works without modification under fallback to `remoteAdapter`. No service worker introduced. |
| **V. Bluesky-Anchored Identity** | PASS | Auth and session paths untouched. |

**Schema-and-sync coupling rule (Workflow):** N/A — no rendered
column is added. This rule applies only when the client begins
rendering a column it did not before.

**Idempotency review:** N/A — no new mutations.

**Capability fallback review:** Both `localAdapter` and
`remoteAdapter` already return `{ unread, starred, total }`. Render
path is adapter-agnostic.

**Local verification:** Will run `npm test && npm run lint`, then
exercise the feature in the browser per `./quickstart.md` before
claiming the work done. Type-check + tests alone are not sufficient
(constitution requirement).

**TypeScript / CSS style:** No CSS edits planned. The
`sidebar-item.ts` edit will keep ≤80 columns, follow the project's
ternary line-break style, and use no-space-before-type style for any
new annotations.

**Result:** All gates pass. Complexity Tracking section is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-unread-only-count/
├── plan.md                 # This file
├── spec.md                 # Feature spec (input)
├── research.md             # Phase 0 output
├── data-model.md           # Phase 1 output
├── quickstart.md           # Phase 1 output (manual browser verification)
├── contracts/
│   └── sidebar-badge.md    # Phase 1 output (internal UI contract)
├── checklists/             # Pre-existing; not modified by /plan
└── tasks.md                # Phase 2 output (created later by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── components/
│   │   └── sidebar-item.ts      # CHANGE: drive badge from showUnreadOnly
│   ├── routes/
│   │   └── feed-reader.ts       # READ-ONLY ref: filter checkbox handler
│   ├── db/
│   │   ├── types.ts             # READ-ONLY ref: CountsResponse shape
│   │   ├── local-adapter.ts     # READ-ONLY ref: getCounts populates total
│   │   └── remote-adapter.ts    # READ-ONLY ref: getCounts returns CountsResponse
│   └── state.ts                 # READ-ONLY ref: counts/showUnreadOnly signals
├── server/                      # UNCHANGED
└── shared/                      # UNCHANGED

test/
└── (add) test/sidebar-item.ts   # NEW: unit render covering both filter states
```

**Structure Decision:** Established two-tier web app layout
(`src/client/` Preact SPA, `src/server/` Hono+DO worker). This
feature touches `src/client/components/sidebar-item.ts` only.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(Empty — no violations.)*
