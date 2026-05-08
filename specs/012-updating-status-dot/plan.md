# Implementation Plan: Yellow "Updating" Pill State During Manual Refresh

**Branch**: `012-updating-status-dot` | **Date**: 2026-05-08 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/012-updating-status-dot/spec.md`

## Summary

Features 010/011 made the "Refresh Feeds" button stay busy continuously
from click to refresh-complete by introducing
`state.refreshInProgress:Signal<boolean>` and binding the controlled
`Button` `isSpinning` prop to it. The header status pill, however, is
written by several sources — `State.refreshFeeds` (sets `'syncing'` on
click), `State.loadFeedStatus` (writes `'synced'` / `'updates'` /
`'error'` on every authoritative reconcile), the SSE
`feed-updates-available` listener (writes `'updates'` / `'synced'` on
every per-feed broadcast), and the SSE `feed-updates-cleared` listener
(writes `'synced'` when counts drain). Any of those secondary writers
can fire during a manual refresh and overwrite the click-time `'syncing'`
back to a resting status, leaving the pill flickering or stuck on the
pre-click value while the button is still spinning. That is the
"contradiction between adjacent controls" the user reported.

This feature pins the pill to a single in-progress state for the exact
duration of `state.refreshInProgress`, and renames the visible label
from `"refreshing"` to `"updating"`.

The technical approach is:

1. **Derive the displayed pill status from `refreshInProgress`.** Add a
   computed signal `state.displayedFeedSyncStatus:ReadonlySignal<...>`
   that returns `'syncing'` whenever `state.refreshInProgress.value ===
   true`, and otherwise returns `state.feedSyncStatus.value`. The
   `FeedStatus` component reads from `displayedFeedSyncStatus`. Other
   writers keep writing `feedSyncStatus` freely; their writes are
   absorbed during the refresh window without flickering the pill, and
   surface naturally the moment `refreshInProgress` clears (FR-003,
   FR-007, FR-011).
2. **Drop the now-redundant `feedSyncStatus = 'syncing'` write from
   `State.refreshFeeds`.** The `'syncing'` display is owned by
   `refreshInProgress` via the computed. Keeping the explicit write
   would conflate two sources of truth and could leak a stale
   `'syncing'` underlying value after `refreshInProgress` clears (e.g.,
   if `refreshAfterSync` rejects without `loadFeedStatus` reaching its
   own catch block). The `feedSyncError = null` clear in the same
   `batch` remains, and the failure path's
   `feedSyncStatus = 'error'` / `feedUpdateCounts = priorCounts`
   restoration also remains (010/011 contract preserved).
3. **Rename the legend text.** `legendFor('syncing', _)` returns
   `{ label: 'updating', ariaLabel: 'Feed sync status: updating' }`
   instead of `'refreshing'`. The `role="status" aria-live="polite"`
   wrapper announces the new wording (FR-008).
4. **Keep the label visible when syncing, even at the medium viewport.**
   The existing responsive rule at `680px <= width < 1000px` hides
   `.feed-status-legend` to fit the header on tablet-class widths. For
   `'syncing'` the label is the only non-color cue (FR-009 /
   color-blind edge case). Add a `'syncing'` modifier class on the
   `.feed-status` wrapper and override the `display: none` for that
   class. Other states are unchanged.
5. **No server / wire / schema changes.** The DO route handlers, the
   `/feed-status` payload, the `POST /feeds/refresh` HTTP contract, the
   SSE wire format, the local-first SQLite schema, and `bootstrapLocalDb`
   / `pullSync` all stay exactly as they are. The feature is a
   pure-client display refinement built on top of the lifecycle from
   features 010 / 011.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for the
client). The Cloudflare Workers server is not touched.
**Primary Dependencies**: Preact + `@preact/signals` (client state and
rendering, including `computed`), `htm/preact` (templates),
`@substrate-system/tapzero` (test runner) and `tapout` (browser-driven
test bundler) for the click-through DOM tests. No new dependencies.
**Storage**: N/A. Client-side render-time state only. No SQLite schema,
`/api/sync` payload, or DO KV change. Per-user Durable Object SQLite
stays read-only with respect to this feature.
**Testing**: `tape`-style files under `test/` running through `tapout`
(Chromium) for browser-driven tests and `tap-spec` / `node` for
Node-side tests, the same split features 010 / 011 already used.
Tests in `test/feed-status.ts`, `test/feed-status-loader.ts`,
`test/refresh-lifecycle.ts`, and `test/sidebar-footer-refresh.ts` are
extended; one new browser-driven file covers the end-to-end pill
lifecycle for the three resolution paths (FR-013).
**Target Platform**: Modern evergreen browsers for the client;
Cloudflare Workers / Durable Objects for the server (untouched).
**Project Type**: Web application using the existing `src/server` /
`src/client` / `src/shared` layout (same as features 008-011, not the
`backend/` / `frontend/` template default).
**Performance Goals**: SC-001 — pill transitions to yellow within the
same render frame as the click; the click-time `batch` writes
`refreshInProgress = true` synchronously, the computed re-evaluates,
and Preact paints in the next frame, with no network gating. SC-002 —
the pill stays yellow continuously; secondary writers cannot flicker
the displayed value because `refreshInProgress` masks them. SC-003 —
the pill exits yellow inside the same `batch` that clears
`refreshInProgress` (the existing settle `batch` at the
`refresh-complete` SSE handler), so pill-out and button-idle land in
the same paint. SC-004 — failure transition is also batched. SC-005 —
zero pill transitions to yellow during background-only activity
because `refreshInProgress` stays `false`.
**Constraints**:
- The lifecycle contract from feature 010
  (`010-fix-refresh-feedback/contracts/refresh-lifecycle.md`) MUST be
  preserved unchanged. This feature derives display from the same
  signal, it does not redefine the lifecycle.
- The fix from feature 011 (`Button` is controlled when `isSpinning`
  is supplied) MUST remain in force. The pill's display is bound to
  `state.refreshInProgress`, which only `State.refreshFeeds` and the
  `refresh-complete` / SSE-reopen settle handlers may write.
- `loadFeedStatus` remains the single source of truth for
  `feedSyncStatus` / `feedUpdateCounts` outside the manual-refresh
  window (the 008 invariant must not regress). During the window,
  writers are free to mutate the underlying signals; only the
  *displayed* status is masked.
- The `Button` component public surface MUST stay backward-compatible
  (no change to `props.isSpinning`'s controlled semantics).
- CSS unrelated to the feed-status pill MUST NOT be modified
  (constitution Tech Stack rule). The `.feed-status` responsive rule
  is in scope because it directly governs the new state's
  perceivability.
- No emoji in source files or commit messages by Claude
  (constitution Tech Stack rule).
**Scale/Scope**: Two production files
(`src/client/state.ts`, `src/client/components/feed-status.ts`), one
small CSS adjustment (`src/client/components/feed-status.css`), and
test extensions in four files plus one new browser-driven test file
(`test/updating-pill-lifecycle.ts`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0
(principles I-V):

- **I. Local-First Reads** — PASS. The reload at the end of a
  successful manual refresh continues to run through
  `State.refreshAfterSync`, which routes through `getAdapter()`
  (`localAdapter` when capable, `remoteAdapter` otherwise). No new
  client read path. The displayed pill status is a derived view
  over signals already populated through the existing read flows.
  Render path remains identical online and offline-with-queued-pull.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutations added
  or removed. `POST /feeds/refresh` semantics are unchanged. No new
  outbox row, `client_op_id`, schema column, or pull-sync payload
  shape. The display masking is purely render-time.
- **III. Edge-Native Topology (Worker + Per-User DO)** — PASS. No
  server changes. Polling, refresh fanout, and SSE broadcasting all
  stay in `UserDO`. No external cron, queue, or worker introduced.
- **IV. Capability-Gated Progressive Enhancement** — PASS. The fix
  lives in `state.ts` and `feed-status.ts`, which both adapter modes
  share. `aria-busy` (010), the controlled-Button contract (011),
  and the new pill display all behave identically in
  `localAdapter` and `remoteAdapter` modes. No service worker
  introduced.
- **V. Bluesky-Anchored Identity** — PASS. No auth surface change.
  The 401 branch in `State.refreshFeeds` and `State.loadFeedStatus`
  retain their existing semantics (clear user, set `authError`,
  `feedSyncStatus = 'error'`, redirect to `/login`). When a 401
  forces logout mid-refresh, `refreshInProgress` is also cleared
  (010 contract) so the pill exits yellow into the failure cue
  before the redirect.

No violations; Complexity Tracking section unused.

## Project Structure

### Documentation (this feature)

```text
specs/012-updating-status-dot/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── header-pill-states.md
├── checklists/          # Pre-existing
├── spec.md              # Feature specification (Input)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── state.ts                       # CHANGED:
│   │                                  #  (a) add
│   │                                  # `displayedFeedSyncStatus`
│   │                                  # computed signal alongside
│   │                                  # `feedUpdateStatus` /
│   │                                  # `feedsWithUpdates`.
│   │                                  #  (b) drop the now-redundant
│   │                                  # `feedSyncStatus = 'syncing'`
│   │                                  # write from the click-setup
│   │                                  # `batch` in `State.refreshFeeds`.
│   │                                  # `feedSyncError = null` clear
│   │                                  # remains. Failure-path writes
│   │                                  # to `feedSyncStatus = 'error'`
│   │                                  # remain unchanged (010/011
│   │                                  # contract).
│   ├── components/
│   │   ├── feed-status.ts             # CHANGED:
│   │   │                              #  (a) consume
│   │   │                              # `state.displayedFeedSyncStatus.value`
│   │   │                              # for color / legend choice;
│   │   │                              # `feedUpdateCounts` /
│   │   │                              # `feedSyncError` reads are
│   │   │                              # unchanged.
│   │   │                              #  (b) `legendFor('syncing', _)`
│   │   │                              # returns `'updating'` instead
│   │   │                              # of `'refreshing'` (FR-001 /
│   │   │                              # FR-009).
│   │   │                              #  (c) wrapper picks up a
│   │   │                              # `syncing` modifier class so
│   │   │                              # CSS can keep the legend
│   │   │                              # visible at the medium
│   │   │                              # viewport.
│   │   └── feed-status.css            # CHANGED: extend the existing
│   │                                  # `@media (680px <= width <
│   │                                  # 1000px)` rule so
│   │                                  # `.feed-status.syncing
│   │                                  # .feed-status-legend` stays
│   │                                  # visible at all viewports
│   │                                  # (FR-009).
│   └── (no other client files change; sidebar-footer / button stay on
│       the controlled-Button + `state.refreshInProgress` binding from
│       011)
└── server/
    └── (no changes — wire, DO, and SSE behavior already correct)

src/shared/
└── (no changes)

test/
├── feed-status.ts                     # CHANGED: rename / update the
│                                      # `legendFor: syncing returns
│                                      # "refreshing"` test to assert
│                                      # `'updating'` (label + aria);
│                                      # add a new test that mounts
│                                      # `<FeedStatus>` with a state
│                                      # whose `refreshInProgress=true`
│                                      # and verifies the dot is yellow
│                                      # and the legend reads
│                                      # "updating", regardless of the
│                                      # underlying `feedSyncStatus`
│                                      # value.
├── feed-status-loader.ts              # CHANGED: extend the
│                                      # `loadFeedStatus` tests to
│                                      # assert that running it while
│                                      # `refreshInProgress=true` does
│                                      # not change
│                                      # `displayedFeedSyncStatus`
│                                      # (FR-007 / FR-011), but the
│                                      # underlying
│                                      # `feedSyncStatus` /
│                                      # `feedUpdateCounts` writes
│                                      # still happen so they surface
│                                      # when `refreshInProgress`
│                                      # clears.
├── refresh-lifecycle.ts               # CHANGED: where existing
│                                      # assertions read
│                                      # `state.feedSyncStatus.value
│                                      # === 'syncing'` to mean "pill
│                                      # is yellow during refresh",
│                                      # update them to read
│                                      # `state.displayedFeedSyncStatus.value`.
│                                      # Add a case for "background
│                                      # SSE feed-updates-available
│                                      # arrives during refresh: the
│                                      # underlying counts move but
│                                      # `displayedFeedSyncStatus`
│                                      # stays `'syncing'` until
│                                      # `refresh-complete` settles".
├── sidebar-footer-refresh.ts          # CHANGED: extend the existing
│                                      # click-through tests to also
│                                      # assert the rendered pill
│                                      # text + dot color across the
│                                      # three resolution paths
│                                      # (success-with-items,
│                                      # success-no-items, failure).
│                                      # The "syncing" assertion
│                                      # changes its expected text
│                                      # from "refreshing" to
│                                      # "updating".
├── updating-pill-lifecycle.ts         # NEW: browser-driven (tapout)
│                                      # focused regression test.
│                                      # Mounts the real
│                                      # `<SidebarFooter>` and
│                                      # `<FeedStatus>` together,
│                                      # stubs `EventSource` /
│                                      # `fetch`, and walks through
│                                      # the click-to-resolution
│                                      # lifecycle for each of the
│                                      # three resolution paths.
│                                      # Asserts (a) the pill is
│                                      # yellow with text "updating"
│                                      # and `aria-label="Feed sync
│                                      # status: updating"` from the
│                                      # click frame onward; (b) it
│                                      # remains yellow when a
│                                      # background `feed-updates-
│                                      # available` SSE event
│                                      # arrives mid-flight (FR-007 /
│                                      # FR-011); (c) it transitions
│                                      # out of yellow inside the
│                                      # same paint as the button
│                                      # returns to idle (FR-006 /
│                                      # SC-003); (d) the failure
│                                      # path lands on the error pill
│                                      # rather than yellow or green
│                                      # (FR-005 / SC-004); (e) the
│                                      # zero-feeds-subscribed edge
│                                      # case still flashes yellow
│                                      # before settling on green.
└── index.ts                           # CHANGED: import
                                       # './updating-pill-lifecycle.js'
                                       # so the new test ships in the
                                       # bundled tapout run.
```

**Structure Decision**: Reuses the existing `src/server`,
`src/client`, `src/shared` layout (same as features 008-011). All
implementation lives in `src/client/state.ts`,
`src/client/components/feed-status.ts`, and
`src/client/components/feed-status.css`. No server file is modified.
The new regression test is browser-driven and wired into the existing
`test/index.ts` bundle so it runs as part of `npm test` with no
per-file script changes.

## Complexity Tracking

> Not applicable. Constitution Check passes without violations.

## Post-Design Constitution Re-check

After Phase 1 (data-model, contracts, quickstart) the design holds the
same five principles:

- **I**: confirmed — no new client-side network read introduced. The
  computed signal is a pure derivation over signals populated by
  existing read paths (`refreshInProgress` from the manual-refresh
  flow, `feedSyncStatus` from `loadFeedStatus` / SSE listeners). The
  render path remains identical online and offline.
- **II**: confirmed — no mutation surface change. The fix is purely
  render-time. `INSERT OR IGNORE INTO items` server-side idempotency,
  `client_op_id` outbox semantics, and `/api/sync` payload shape are
  all untouched.
- **III**: confirmed — no DO changes, no new alarm or queue. The
  `refresh-complete` event sequence in `UserDO` is unchanged.
- **IV**: confirmed — the fix lives in shared client state and a
  shared component, so it works under both `localAdapter` and
  `remoteAdapter` modes without branching.
- **V**: confirmed — no auth surface change. The 401 branches in
  `refreshFeeds` and `loadFeedStatus` keep their existing batches;
  `refreshInProgress = false` already lands in the 401 batch (010
  contract) so the pill exits yellow before the `/login` redirect.

No design surprise pulled the feature into a constitutional gray
zone. Complexity Tracking remains empty.
