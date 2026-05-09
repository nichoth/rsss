# Implementation Plan: Per-Feed Pending Count In Sidebar

**Branch**: `014-sidebar-pending-count` | **Date**: 2026-05-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-sidebar-pending-count/spec.md`

## Summary

For every subscribed feed shown in the left sidebar's feeds list, render
a parenthesized prefix `(N) ` immediately before the feed's display name
when `state.feedUpdateCounts.value[String(feed.id)] > 0`. Omit the
prefix entirely (no `(0) ` placeholder) when the count is zero or
undefined. The "All Feeds" pseudo-row does not get a prefix; the
existing aggregate "updates available" pill (the `FeedStatus` component
in `sidebar-footer`) already covers that case.

This is a pure-UI change. The pending count signal
(`feedUpdateCounts`) already exists in client state, is already
populated by the SSE `feed-updates-available` channel, and is already
the sum-of-values that drives the aggregate `FeedStatus` count
(`feed-status.ts:74-75`). No new state, no new sync path, no server
change. Reactivity, refresh-clears-everything semantics, and
background-poll updates fall out of using the same signal the
aggregate already reads — the two indicators cannot disagree because
they are the same source.

The single non-trivial decision is *where in the row's DOM* the prefix
lives. See `research.md` (Decision 1) — outcome: prepend the prefix as
leading text inside the existing `<a class="feed-select">` anchor,
which keeps the row's flex layout, click target, and reading order
intact without introducing a new DOM node or class.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for the
client; Cloudflare Workers ES2022 for the server — not touched here)
**Primary Dependencies**: Preact + `@preact/signals`, `htm/preact`
(rendering); no new dependencies
**Storage**: N/A. Client-side render-time state only. No SQLite schema
change, no DO schema change, no `/api/sync` payload change.
**Testing**: `@substrate-system/tapzero` browser tests under `test/`,
plus `npm test && npm run lint` per project commands. New per-feed
sidebar prefix tests extend the existing `test/sidebar-feed-counts.ts`
pattern.
**Target Platform**: Browser (Preact SPA). Mobile/responsive sidebar
layouts inherit the same rule.
**Project Type**: Web application — frontend (`src/client/`) +
backend (`src/server/`). Only the frontend is modified here.
**Performance Goals**: Sidebar rendering remains visually instantaneous
on a 200-feed list (SC-005). Reading one extra `Record<string, number>`
lookup per row is O(1) and well below any perceptible threshold.
**Constraints**: Must not regress the existing per-feed unread badge,
the per-row delete control, or the "All Feeds" row. Aggregate
`FeedStatus` and per-feed prefixes must clear in the same render pass
on refresh success (SC-003) — guaranteed automatically because both
read `feedUpdateCounts`, which is cleared in a single `batch()`.
**Scale/Scope**: One file changed (`src/client/components/sidebar.ts`),
plus tests. Touches a single function-component render path. No state,
type, or API surface changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against principles I–V from `.specify/memory/constitution.md`:

- **I. Local-First Reads** — PASS. No new read path. The render
  reads `state.feedUpdateCounts`, an in-memory signal. `localAdapter`
  / `remoteAdapter` are not involved (the signal is populated by the
  SSE channel already, independent of read adapter).
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutations. No
  outbox entries. No new server handler.
- **III. Edge-Native Topology** — PASS. No server change. DO schema,
  alarms, and Hono routes are untouched.
- **IV. Capability-Gated Progressive Enhancement** — PASS. The render
  works identically under both `localAdapter` and `remoteAdapter`
  because it does not call either; it reads a signal that both
  adapters' SSE/refresh paths already populate.
- **V. Bluesky-Anchored Identity** — PASS. No auth change.

No violations. No Complexity Tracking entries needed.

**Re-check after Phase 1 design**: PASS. Phase 1 introduces no new
entities, no new contracts, no new schemas — see `data-model.md`
(empty deltas) and the absent `contracts/` directory. The decision in
`research.md` Decision 1 (prepend inside the existing anchor) does not
introduce a new render path or new data dependency, so all five gates
remain satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/014-sidebar-pending-count/
├── plan.md              # This file
├── research.md          # Phase 0 output: prefix placement decision
├── data-model.md        # Phase 1 output: notes that no new entities exist
├── quickstart.md        # Phase 1 output: how to verify in a browser
└── tasks.md             # Phase 2 output (NOT created here)
```

No `contracts/` directory: this feature exposes no new external
interface. The only "contract" is the user-visible string format
`(N) <feedName>`, which is captured in spec FR-001 / Acceptance
Scenario 1 and verified by the new tests in
`test/sidebar-feed-counts.ts`.

### Source Code (repository root)

```text
src/
├── client/
│   ├── components/
│   │   ├── sidebar.ts         # MODIFIED: prepend "(N) " inside
│   │   │                      #   <a class="feed-select"> when
│   │   │                      #   feedUpdateCounts[String(feed.id)] > 0
│   │   ├── sidebar.css        # NOT MODIFIED (per global "never change
│   │   │                      #   CSS unrelated to the task" rule —
│   │   │                      #   inline text inherits row typography)
│   │   ├── sidebar-item.ts    # NOT MODIFIED
│   │   ├── sidebar-footer.ts  # NOT MODIFIED
│   │   └── feed-status.ts     # NOT MODIFIED — same feedUpdateCounts
│   │                          #   signal it already sums for the
│   │                          #   aggregate pill
│   └── state.ts               # NOT MODIFIED (signal already exists)
├── server/                    # NOT MODIFIED
└── shared/                    # NOT MODIFIED

test/
├── sidebar-feed-counts.ts     # EXTENDED: add prefix-rendering cases
│                              #   covering the seven Acceptance
│                              #   Scenarios + Edge Cases
└── (other tests unaffected)
```

**Structure Decision**: Existing `src/client/` + `src/server/` +
`src/shared/` web-app layout. Only `src/client/components/sidebar.ts`
and `test/sidebar-feed-counts.ts` are touched.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. No entries.
