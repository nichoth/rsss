# Implementation Plan: Faithful Visual Feedback During Refresh Feeds

**Branch**: `010-fix-refresh-feedback` | **Date**: 2026-05-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/010-fix-refresh-feedback/spec.md`

## Summary

The "Refresh Feeds" button stops spinning the moment the
`POST /feeds/refresh` request returns. The server intentionally
acknowledges that request immediately and runs the actual feed
fetches in `ctx.waitUntil`, broadcasting per-feed `feed-updated`
events as fetches finish and a final `refresh-complete` event when
the batch is done (see `src/server/durable-objects/index.ts` lines
873-888). The client today treats the POST response as "done" — it
clears `feedsLoading`, zeroes `feedUpdateCounts`, and flips the pill
to `synced` — even though no new items have rendered yet
(`src/client/state.ts` lines 1356-1363). The result is a perceptible
dead window in which the button is idle but no work is visible to
the user.

This feature realigns the client's "manual refresh in progress"
visual contract with the server-side lifecycle. The fix is purely
client-side and does not touch the worker, the durable object, the
SSE wire format, the `/feeds/refresh` HTTP contract, the
`/feed-status` payload, or the local-first SQLite schema.

The technical approach is:

1. **Introduce a dedicated lifecycle signal**
   `state.refreshInProgress:Signal<boolean>`, separate from the
   existing `state.feedsLoading` (which the sidebar already uses to
   render "Loading feeds...", `src/client/components/sidebar.ts`
   line 152, and which `loadFeeds` toggles on every read). The
   "Refresh Feeds" button binds its `isSpinning` prop to
   `refreshInProgress` instead of `feedsLoading`. This separates the
   manual-refresh visual contract from initial-load and
   per-feed-load chrome and makes the lifecycle observable in
   isolation.
2. **Don't release `refreshInProgress` on POST acknowledgement.**
   `State.refreshFeeds` only sets the signal `true`, captures the
   pre-click `feedUpdateCounts` snapshot (for failure restoration),
   arms a safety timeout, and POSTs. On a successful POST it does
   *not* zero `feedUpdateCounts` and does *not* flip
   `feedSyncStatus` to `synced`. The pill stays in `syncing`, the
   button stays busy.
3. **Tie release to the visible result.** The existing SSE
   `refresh-complete` listener becomes the completion bound: it
   awaits a forced `State.refreshAfterSync(state)` (which loads
   feeds, items, counts, and feed-status), then in a single `batch`
   clears `refreshInProgress`. Because `loadFeedStatus` is the sole
   writer of `feedSyncStatus` / `feedUpdateCounts` (see lines
   1233-1239), the pill and the new-items list snap to their
   post-refresh values together — the perceivable single "done"
   moment FR-005 requires.
4. **Fail closed on the unhappy path.** POST failure restores the
   pre-click `feedUpdateCounts` (FR-007 — counts are not silently
   zeroed), sets `feedSyncStatus = 'error'`, and clears
   `refreshInProgress`. The safety timeout (already present at
   `REFRESH_FEEDS_SAFETY_TIMEOUT_MS = 60_000`) clears
   `refreshInProgress` if `refresh-complete` never arrives. SSE
   reconnection during a refresh triggers an authoritative
   reconciliation: `refreshAfterSync` runs and `refreshInProgress`
   clears, since `loadFeedStatus` is now the source of truth.
5. **De-bounce duplicate clicks (FR-008).** If
   `refreshInProgress.value === true`, `State.refreshFeeds` returns
   immediately, so repeated clicks do not fan out into parallel
   POSTs nor restart the busy state. The Button component continues
   to set `disabled` while `isSpinning`, so the click is also
   blocked at the DOM level.
6. **Communicate busy to assistive tech (FR-012).** Add
   `aria-busy=${isSpinning}` to the `<button>` rendered by the
   `Button` component so screen readers announce "busy" during the
   refresh window. The pill already has `role="status"
   aria-live="polite"` and updates atomically with the visible
   result.
7. **Background polls cannot mis-resolve the manual refresh
   (FR-011).** Per-feed `feed-updated` SSE events keep their
   existing debounced `refreshAfterSync` behavior, but they do not
   touch `refreshInProgress`. Only `refresh-complete` (the
   manual-batch completion event) clears the busy state. A poll
   that drops new items during the manual refresh window will
   appear in the post-refresh state under the existing
   `feed-updates-available` indicator update path.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for
client; Cloudflare Workers ES2022 lib for server, but server is
unchanged in this feature).
**Primary Dependencies**: Preact + `@preact/signals` (client state
and rendering), `htm/preact` (templates), `ky` (HTTP), the existing
`EventSource` SSE channel hooked up in `State.openEventStream`. No
new dependencies.
**Storage**: N/A. The feature is UI-state lifecycle only — no
schema change, no `/api/sync` payload change, no local SQLite
mirror change. Per-user Durable Object SQLite (the existing
`feeds`/`items` tables) is read-only with respect to this feature.
**Testing**: `tape` test files under `test/` (Node-side stubs of
Cloudflare Workers + DOM as in feature 008/009); browser-driven
runs through `npm test`. Tests in `test/state-auth-storage.ts` and
`test/feed-status-loader.ts` already exercise `State.refreshFeeds`
lifecycle and will be extended.
**Target Platform**: Modern evergreen browsers for the client;
Cloudflare Workers / Durable Objects for the server (unchanged).
**Project Type**: Web application (Cloudflare Worker + Preact SPA
in the same repo; layout is `src/server`, `src/client`,
`src/shared` — not the `backend/`/`frontend/` split shown in the
template).
**Performance Goals**: SC-001 — in ≥95% of manual refreshes the
control communicates "in progress" continuously from click to
items list reflecting the result. SC-002 — the time between the
button returning to idle and the items list reflecting the new
content is within one rendering frame (the `batch` boundary at
`refresh-complete` after `await refreshAfterSync`). No new wire
traffic; the dead window we are removing is purely visual.
**Constraints**:
- The `/feeds/refresh` HTTP contract MUST remain unchanged
  (`POST /feeds/refresh` → `{ success, queued }`).
- The SSE wire format MUST remain unchanged (`feed-updated`,
  `feed-updates-available`, `feed-updates-cleared`,
  `refresh-complete`).
- The `/feed-status` payload MUST remain unchanged.
- The local-first SQLite schema MUST remain unchanged.
- `loadFeedStatus` remains the sole authoritative writer of
  `feedSyncStatus` and `feedUpdateCounts` after the manual-refresh
  window closes (the existing single-source-of-truth invariant
  from feature 008 must not regress).
- The fix MUST NOT introduce a per-click polling loop or any
  client-side fetch fan-out to feed origins (server-only origin
  contact, per spec assumption).
- CSS unrelated to the refresh control / pill MUST NOT be modified
  (constitution Tech Stack rule).
**Scale/Scope**: Single user, single tab, single refresh in flight
at a time (FR-008). The new signal is a per-app-instance boolean.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0
(principles I-V):

- **I. Local-First Reads** — PASS. The reload at the end of a
  successful manual refresh runs through the existing
  `State.refreshAfterSync` pipeline, which already reads through
  `getAdapter()` (`localAdapter` when capable, `remoteAdapter`
  otherwise). No new client read path. No new network fetch for
  data the local store owns; happy-path reads after the refresh
  remain identical online and offline-with-queued-pull.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutations
  added. The manual refresh is a server-side server-side action
  initiated by `POST /feeds/refresh` and is unchanged in this
  feature; no outbox impact, no `client_op_id` changes, no schema
  coupling. The existing `INSERT OR IGNORE INTO items` server-side
  idempotency continues to cover overlap with background polls
  (FR-011).
- **III. Edge-Native Topology (Worker + Per-User DO)** — PASS. No
  server changes. All polling and refresh fanout continue to live
  in `UserDO`. No external cron, queue, or worker introduced.
- **IV. Capability-Gated Progressive Enhancement** — PASS. The
  manual refresh flow already works through both `localAdapter`
  and `remoteAdapter` because it triggers the server and the
  server broadcasts SSE; this feature only changes how the client
  *renders* the lifecycle. The visual contract is identical in
  both modes. No service worker introduced.
- **V. Bluesky-Anchored Identity** — PASS. No auth surface change.
  The 401 branch in `State.refreshFeeds` (`src/client/state.ts`
  lines 1366-1376) keeps its existing semantics: clear user, set
  `authError`, redirect to `/login`. We only ensure
  `refreshInProgress` is also cleared in that branch so the busy
  state does not survive a forced logout.

No violations; Complexity Tracking section unused.

## Project Structure

### Documentation (this feature)

```text
specs/010-fix-refresh-feedback/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── refresh-lifecycle.md
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── state.ts                       # add refreshInProgress signal;
│   │                                  # rewrite refreshFeeds lifecycle
│   │                                  # (no clear-on-POST-ack;
│   │                                  # snapshot priorCounts;
│   │                                  # safety timeout clears
│   │                                  # refreshInProgress); rewrite
│   │                                  # `refresh-complete` SSE handler
│   │                                  # to await refreshAfterSync then
│   │                                  # batch-clear refreshInProgress;
│   │                                  # extend SSE `open` reconnect
│   │                                  # path to clear refreshInProgress
│   │                                  # after authoritative reconcile
│   ├── components/
│   │   ├── sidebar-footer.ts          # bind Button isSpinning to
│   │   │                              # state.refreshInProgress
│   │   │                              # (was state.feedsLoading)
│   │   └── button.ts                  # add aria-busy=isSpinning
│   │                                  # (FR-012)
│   └── (no other client files change; sidebar.ts continues to use
│       state.feedsLoading for "Loading feeds..." chrome — that path
│       is unchanged)
└── server/
    └── (no changes — wire and DO behavior already correct)

src/shared/
└── (no changes)

test/
├── state-auth-storage.ts              # update existing
│                                      # `refreshFeeds marks feed sync
│                                      # as syncing while request is in
│                                      # flight` to assert
│                                      # refreshInProgress (the new
│                                      # signal) instead of
│                                      # feedsLoading; update
│                                      # `refreshFeeds clears update
│                                      # counts and marks feed sync as
│                                      # synced` so completion is
│                                      # driven by simulated SSE
│                                      # `refresh-complete`, not the
│                                      # POST resolve; update error
│                                      # tests for prior-counts
│                                      # restoration + busy clear.
├── feed-status-loader.ts              # update
│                                      # `refreshFeeds failure leaves
│                                      # feedSyncStatus = error` to
│                                      # also assert refreshInProgress
│                                      # is cleared on failure.
└── refresh-lifecycle.ts               # NEW: end-to-end lifecycle
                                       # tests — busy persists past
                                       # POST ack until SSE
                                       # refresh-complete; safety
                                       # timeout fallback; SSE
                                       # disconnect/reopen mid-flight
                                       # reconciles via
                                       # refreshAfterSync; rapid
                                       # duplicate clicks (FR-008);
                                       # background poll's
                                       # feed-updated does not clear
                                       # busy (FR-011); zero
                                       # subscribed feeds resolves
                                       # immediately via
                                       # refresh-complete with empty
                                       # batch (edge case).
```

**Structure Decision**: Reuses the existing `src/server`,
`src/client`, `src/shared` layout (same as features 008/009). All
implementation is contained inside `src/client/state.ts`,
`src/client/components/sidebar-footer.ts`, and
`src/client/components/button.ts`. No server file is modified.

## Complexity Tracking

> Not applicable. Constitution Check passes without violations.

## Post-Design Constitution Re-check

After Phase 1 (data-model, contracts, quickstart) the design holds
the same five principles:

- **I**: confirmed during contract design — completion still hangs
  off `refreshAfterSync`, which routes through `getAdapter()`. No
  new client-side network read.
- **II**: confirmed — no mutation surface change. The
  `refresh-complete` SSE handler does not write to the outbox; the
  client's view of `feedUpdateCounts` after refresh is reconciled
  from authoritative `/feed-status`, not from an optimistic local
  guess. Item-level overlap with background polls remains covered
  by server-side `INSERT OR IGNORE` semantics.
- **III**: no DO changes, no new alarm or queue.
- **IV**: the new signal lives in `state.ts`, which both adapter
  modes share. The `aria-busy` change is universal.
- **V**: 401 branch explicitly clears `refreshInProgress` in the
  same `batch` that nulls `state.user.value` and routes to
  `/login`, so the busy state cannot survive a session expiry.

No design surprise pulled the feature into a constitutional gray
zone. Complexity Tracking remains empty.
