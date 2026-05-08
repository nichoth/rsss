# Implementation Plan: Refresh Feeds Click Must Produce an Observable Response

**Branch**: `011-fix-refresh-noop` | **Date**: 2026-05-08 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/011-fix-refresh-noop/spec.md`

## Summary

Feature 010 wired `state.refreshInProgress:Signal<boolean>` as the
canonical "manual refresh in flight" signal and passed it to the
sidebar `Button` as the `isSpinning` prop. It then re-pointed the
SSE `refresh-complete` listener to clear that signal after
`refreshAfterSync` resolved, so the busy state would persist past
the POST acknowledgement until the visible result lands.

That fix is silently neutralised by the `Button` component's own
click handler. `Button` was originally an "uncontrolled" wrapper:
when given an async `onClick`, it managed its own busy state by
writing `isSpinning.value = true` before calling `onClick` and
`isSpinning.value = false` after the await. When feature 010 added
the controlled `isSpinning` prop, this internal write was not
removed. The result is a hard collision with the FR-008 re-entry
guard added in feature 010:

1. Reader clicks "Refresh Feeds".
2. `Button.click` writes `state.refreshInProgress.value = true`
   (`src/client/components/button.ts` line 30).
3. `Button.click` invokes `props.onClick = () => State.refreshFeeds(state)`.
4. `State.refreshFeeds` sees `state.refreshInProgress.value === true`
   and returns immediately at the re-entry guard
   (`src/client/state.ts` line 1371). **No POST is dispatched.**
5. The promise resolves; `Button.click` writes
   `state.refreshInProgress.value = false`.
6. The button briefly flickers busy then idle. No SSE arrives. The
   reader experiences "nothing happens."

The fix is a controlled-vs-uncontrolled distinction in `Button`:
when the parent supplies `isSpinning`, the parent owns the
lifecycle and `Button` is a passive renderer (read-only). When
the prop is omitted, `Button` keeps its current internal
auto-managed behavior. We then add a regression-proof test that
exercises the actual click path through the rendered `<button>`
DOM element (existing `refresh-lifecycle.ts` tests bypass `Button`
by calling `State.refreshFeeds` directly, which is why the bug
slipped past CI).

The technical approach is:

1. **Make `Button.isSpinning` controlled when supplied.** Capture
   `_isSpinning` truthiness once, expose it as
   `isControlled`. In the click handler, only write
   `isSpinning.value = true/false` when `isControlled === false`.
   When controlled, the parent's `onClick` owns the signal
   transitions. This also fixes the `aria-busy` and `disabled`
   attributes naturally — they read from the signal that the
   parent now drives.
2. **Remove the now-dead `refresh.spinning` signal in
   `routes/updates.ts`.** The per-feed `Refresh` button there was
   relying on `Button` to write its `spinning` signal. After the
   fix it would never spin (parent supplies the signal but does
   not write it). Cleanest correction: stop passing `isSpinning`
   on that callsite and let `Button` auto-manage internally
   (uncontrolled mode), since the per-feed `State.refreshFeed`
   resolves synchronously inside the POST and does not need
   external lifecycle binding. Also delete the unused `spinning`
   field from the per-feed refresh map.
3. **Add a click-through regression test (FR-012).** Mount the
   real `SidebarFooter` against the tapout-bundled DOM, stub
   `EventSource` and `fetch`, and dispatch a click event on the
   rendered `<button>`. Assert: (a) `POST /feeds/refresh` is
   dispatched (the bug suppressed it), (b) the button has
   `aria-busy="true"` and `disabled` attributes set after the
   POST resolves, (c) firing SSE `refresh-complete` (after the
   POST returns) clears `aria-busy`/`disabled` and brings the
   pill / items list to their resolved values together. Repeat
   for the no-new-items and failure paths so the suite covers
   each of the three resolution outcomes from FR-003.
4. **Strengthen the existing `refresh-lifecycle.ts` tests.** Keep
   them, but add one more case that drives `State.refreshFeeds`
   through a wrapper that mimics the broken Button (sets the
   signal `true` first, then calls `refreshFeeds`). Before the
   fix this case shows zero POSTs and is the unit-level
   reproduction. After the fix the wrapper is no longer the
   correct invocation pattern, but the test stays as a
   contract-level guard against any future caller writing the
   signal before invoking `refreshFeeds`.
5. **No state shape changes.** `state.refreshInProgress` keeps
   the contract from feature 010. The lifecycle table in
   `010-fix-refresh-feedback/contracts/refresh-lifecycle.md` is
   carried forward unchanged. We only fix who writes the signal
   on the way in: it must be `State.refreshFeeds` itself, not a
   render-component wrapper that doesn't know about FR-008.
6. **No server / wire / schema changes.** `POST /feeds/refresh`,
   `/feed-status`, the SSE event format, and the per-user DO
   storage all stay exactly as they are. The bug is entirely on
   the client.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for
the client; the Cloudflare Workers server is not touched).
**Primary Dependencies**: Preact + `@preact/signals`,
`htm/preact`, `@substrate-system/tapzero` (test runner) and
`tapout` (browser-driven test bundler) for the new click-through
test. No new dependencies.
**Storage**: N/A. Client-side render-time state only. No SQLite
schema, `/api/sync` payload, or DO KV change.
**Testing**: `tape`-style files under `test/` running through
`tapout` (Chromium) for browser-driven tests and
`tap-spec`/`node` for Node-side tests, the same split feature 010
already used. The new regression test is browser-driven so it can
mount the real `SidebarFooter` and dispatch a real click event.
**Target Platform**: Modern evergreen browsers for the client;
Cloudflare Workers / Durable Objects for the server (untouched).
**Project Type**: Web application using the existing
`src/server` / `src/client` / `src/shared` layout (same as
features 008-010, not the `backend/` / `frontend/` template
default).
**Performance Goals**: Same as feature 010. SC-001 — every click
must produce an observable visible change within one render frame.
The fix path is purely synchronous in the failing leg; no new
network traffic is introduced.
**Constraints**:
- The lifecycle contract from feature 010
  (`010-fix-refresh-feedback/contracts/refresh-lifecycle.md`)
  MUST be preserved unchanged; this feature fixes a regression
  *against* that contract, it does not redefine it.
- The `Button` component public surface MUST stay
  backward-compatible: existing callers that don't pass
  `isSpinning` (and rely on the auto-managed busy lifecycle)
  MUST keep working. The change is purely additive
  (controlled mode opt-in via the existing prop).
- The fix MUST NOT couple the Button component to
  `state.refreshInProgress` or any other application-level
  signal; the controlled-mode contract is generic.
- CSS unrelated to the refresh button MUST NOT be modified.
- No emoji in source files or commit messages by Claude
  (constitution Tech Stack rule).
**Scale/Scope**: Two production files
(`src/client/components/button.ts`,
`src/client/routes/updates.ts`), one updated existing test file
(`test/refresh-lifecycle.ts` extension), and one new browser-
driven test file (`test/sidebar-footer-refresh.ts` or similar,
wired into `test/index.ts` and the tapout bundle).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1
design.*

Evaluated against `.specify/memory/constitution.md` v1.0.0
(principles I-V):

- **I. Local-First Reads** — PASS. The reload at the end of a
  successful manual refresh continues to run through
  `State.refreshAfterSync`, which routes through `getAdapter()`
  (`localAdapter` when capable, `remoteAdapter` otherwise). No
  new client read path. The fix only changes who writes
  `state.refreshInProgress` on the way in; downstream reads are
  unchanged. The render path remains identical online and
  offline-with-queued-pull.
- **II. Idempotent, Outbox-Backed Sync** — PASS. No mutations
  added or removed. `POST /feeds/refresh` server-side semantics
  are unchanged; the fix ensures the POST is *actually
  dispatched* (the current bug suppresses it), which is a
  regression-correction to the existing contract, not a new
  surface. No `client_op_id`, outbox row, or `INSERT OR IGNORE`
  semantics are touched.
- **III. Edge-Native Topology (Worker + Per-User DO)** — PASS.
  No server changes. All polling, refresh fanout, and SSE
  broadcasting stay in `UserDO`. No external cron, queue, or
  worker introduced.
- **IV. Capability-Gated Progressive Enhancement** — PASS. The
  manual refresh flow already works through both `localAdapter`
  and `remoteAdapter`; the fix is in the render layer
  (`Button`), which is shared by both modes. No service worker
  introduced.
- **V. Bluesky-Anchored Identity** — PASS. No auth surface
  change. The 401 branch in `State.refreshFeeds` is unchanged;
  the fix ensures it is reachable (today the request never
  fires, so 401 cannot occur from the manual path).

No violations. Complexity Tracking section unused.

## Project Structure

### Documentation (this feature)

```text
specs/011-fix-refresh-noop/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── button-controlled-isspinning.md
├── spec.md              # Feature specification (Input)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── components/
│   │   └── button.ts                    # CHANGED: introduce
│   │                                    # `isControlled` distinction.
│   │                                    # When `props.isSpinning` is
│   │                                    # supplied, `click` does NOT
│   │                                    # write to it. Parent owns
│   │                                    # transitions. When omitted,
│   │                                    # behavior is unchanged
│   │                                    # (auto-managed via
│   │                                    # `useSignal<boolean>(false)`).
│   ├── routes/
│   │   └── updates.ts                   # CHANGED: drop the
│   │                                    # `refresh.spinning` field
│   │                                    # from the per-feed
│   │                                    # refresh map and stop
│   │                                    # passing `isSpinning` to
│   │                                    # the per-feed `<${Button}>`.
│   │                                    # Button auto-manages its
│   │                                    # busy state for the duration
│   │                                    # of `await
│   │                                    # State.refreshFeed(...)`.
│   ├── components/sidebar-footer.ts     # UNCHANGED. Keeps passing
│   │                                    # `isSpinning=${refreshInProgress}`;
│   │                                    # this is now a true
│   │                                    # controlled-mode binding.
│   └── state.ts                         # UNCHANGED. The
│                                        # `State.refreshFeeds`
│                                        # lifecycle from feature 010
│                                        # is correct; this fix
│                                        # restores its preconditions.
└── server/
    └── (no changes — wire and DO behavior already correct)

src/shared/
└── (no changes)

test/
├── refresh-lifecycle.ts                 # EXTENDED: add a new case
│                                        # that simulates the broken-
│                                        # Button invocation pattern
│                                        # (writes `refreshInProgress`
│                                        # = true before calling
│                                        # `State.refreshFeeds`) and
│                                        # asserts zero POSTs in that
│                                        # case. Encodes the
│                                        # contract that nothing
│                                        # outside `refreshFeeds` may
│                                        # set the signal high before
│                                        # the call.
├── sidebar-footer-refresh.ts            # NEW: browser-driven
│                                        # (tapout) end-to-end test.
│                                        # Mounts the real
│                                        # `SidebarFooter` against
│                                        # the test DOM, stubs
│                                        # `EventSource` and `fetch`,
│                                        # dispatches a real click on
│                                        # the rendered `<button>`,
│                                        # asserts:
│                                        #  - POST /feeds/refresh
│                                        #    fires (FR-001 root
│                                        #    cause).
│                                        #  - aria-busy="true" and
│                                        #    disabled set after the
│                                        #    POST resolves
│                                        #    (FR-001 / FR-002 /
│                                        #    FR-009).
│                                        #  - SSE refresh-complete
│                                        #    clears aria-busy and
│                                        #    items / pill update
│                                        #    in the same paint
│                                        #    (FR-003.a / FR-005).
│                                        #  - No-new-items path:
│                                        #    pill goes to 'synced'
│                                        #    inside the same batch
│                                        #    (FR-003.b).
│                                        #  - Failure path: POST
│                                        #    rejects → aria-busy
│                                        #    cleared, error legend
│                                        #    surfaced, prior counts
│                                        #    restored
│                                        #    (FR-003.c / FR-006 /
│                                        #    FR-007).
└── index.ts                             # CHANGED: import
                                         # './sidebar-footer-refresh.js'
                                         # so the new test ships in
                                         # the bundled tapout run.
```

**Structure Decision**: Reuses the existing `src/server`,
`src/client`, `src/shared` layout (same as features 008-010).
All implementation lives in `src/client/components/button.ts`
and `src/client/routes/updates.ts`. The new regression test is
browser-driven and wired into the existing `test/index.ts`
bundle so it runs as part of `npm test` with no per-file
script changes.

## Complexity Tracking

> Not applicable. Constitution Check passes without violations.

## Post-Design Constitution Re-check

After Phase 1 (data-model, contracts, quickstart) the design
holds the same five principles:

- **I**: confirmed — no new client-side network read introduced
  by the fix; the failing path now performs the *intended*
  read (`refreshAfterSync`) which already routes through
  `getAdapter()`.
- **II**: confirmed — no mutation surface change. The fix
  ensures the existing `POST /feeds/refresh` is dispatched at
  all; idempotency semantics (URL-keyed for add-feed,
  value-assignment for read state, etc.) are unaffected
  because they apply to the request payload, not its presence.
- **III**: confirmed — no DO changes, no new alarm or queue.
  The DO already broadcasts `refresh-complete` correctly; the
  client just needs to actually fire the request that triggers
  the broadcast.
- **IV**: confirmed — the fix lives in `Button` (a generic
  render-layer component), so it works under both
  `localAdapter` and `remoteAdapter` modes without branching.
  The `aria-busy` invariant from feature 010 is preserved.
- **V**: confirmed — no auth surface change. The 401 branch
  in `State.refreshFeeds` becomes reachable from the manual
  click path again (currently unreachable because no POST is
  sent); its behavior is unchanged.

No design surprise pulled the feature into a constitutional
gray zone. Complexity Tracking remains empty.
