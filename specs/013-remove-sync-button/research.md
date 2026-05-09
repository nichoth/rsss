# Phase 0 Research: Remove Redundant Sync Button

**Feature**: 013-remove-sync-button
**Date**: 2026-05-08

The spec contained no `NEEDS CLARIFICATION` markers and the
Assumptions section already pinned the open product questions
(canonical refresh entry point, no replacement control needed,
strictly UI-only, the "Sync subscriptions" toggle stays). The
remaining decisions are technical: which exact code/CSS is in scope,
and whether removing the button can affect background sync or
existing tests. Each was resolved by reading the current source.

## R1. Identify the exact code to remove

**Decision**: Remove from `src/client/routes/settings.ts`:

- the JSX block `<div class="sync-local-data">…</div>` (currently
  lines 539-554) plus the immediately-following
  `${syncError.value && html\`<p class="bootstrap-error">…</p>\`}`
  fragment (lines 555-557) that only renders inside the Sync
  button's gate;
- the `handleSync` async function (currently lines 376-386);
- the import `import { runSyncCycle } from '../db/sync-cycle.js'`
  (line 41); and
- the import `import { syncStatus, syncError } from
  '../db/sync-status.js'` (line 42).

A grep over `src/client/routes/settings.ts` confirms `runSyncCycle`,
`syncStatus`, and `syncError` are only used by the block being
removed, so the imports become dead.

**Rationale**: Spec FR-001/FR-002/FR-003 forbid the button, the
"Pull updates from the server" caption, and the sync-error banner
inside the Local Storage section. Those map 1:1 onto the
`sync-local-data` block (FR-001/FR-002) and the adjacent
`syncError`-gated paragraph (FR-003). `handleSync` exists solely as
the button's `onClick` and is dead once the button is removed.

**Alternatives considered**:

- *Hide via CSS* (`display:none`). Rejected: leaves dead JSX, dead
  imports, and dead `syncStatus`/`syncError` reads on the Settings
  page that re-render on every status change. Violates the spirit
  of FR-003 (UI must be gone, not visually hidden) and SC-002 (no
  user-reported "Sync button does nothing" — a hidden button still
  counts as code surface that can leak through DevTools and
  accessibility tools).
- *Disable the button instead of removing it.* Rejected: the spec
  explicitly says "get rid of the 'sync' button" (User Story 1) and
  the Local Storage section should be limited to configuration
  toggles.

## R2. Identify the exact CSS to remove

**Decision**: Remove from `src/client/routes/settings.css` the
nested `.local-first-section .sync-local-data` rule (currently
~lines 110-122) and the top-level `.btn-sync` rule (currently
~lines 125-142). Leave everything else — including
`.bootstrap-error`, `.bootstrap-warning`, `.btn-retry-bootstrap`,
the Subscription/Cache/Subscribed-Feeds/Danger-Zone rules — alone.

**Rationale**: Constitution §"Technology Stack & Coding Standards"
mandates "CSS unrelated to the current task MUST NOT be modified."
A grep for `sync-local-data`, `sync-desc`, and `btn-sync` shows
they are referenced only by the JSX being deleted. `.bootstrap-error`
is shared with bootstrap status messaging (and the
`${dbError && …}` and `${bError && …}` banners above it), so it
stays.

**Alternatives considered**:

- *Leave the CSS in place.* Rejected: produces dead rules,
  trips future readers, and conflicts with the project's
  reuse-before-redefine norm.

## R3. Will removing the button regress automatic sync?

**Decision**: No. `State.sync()` in `src/client/state.ts` runs
pull-then-push on startup when authenticated/online and rebinds to
the browser `online` event (see the `'sync cycle online error'`
debug path around `state.ts:467`). `runSyncCycle` continues to be
exported from `src/client/db/sync-cycle.ts` and consumed by
`State.sync()`; only the user-facing entry point in Settings is
removed. FR-005 (home-route "Refresh feeds" still works) and the
spec's "Background sync … is unaffected" assumption are therefore
preserved without code changes.

**Rationale**: The button is one of several entry points into the
same `runSyncCycle` machinery; Principle II's idempotency
guarantees are unchanged because the protocol and outbox are
unchanged.

**Alternatives considered**:

- *Also remove `sync-cycle.ts` / the `syncStatus` signal.*
  Rejected: still used by automatic startup-sync and by the global
  `<sync-status>` indicator component
  (`src/client/components/sync-status.ts`). Removing them would
  break unrelated features and violate FR-003's "out of scope for
  background sync error surfacing" boundary.

## R4. Are any tests asserting on the Sync button?

**Decision**: No tests currently click, assert on, or render the
Sync button.

- `test/settings-route.ts` references `pendingSyncSubscriptions`
  (the *toggle*'s pending state) only — not the standalone Sync
  button.
- `test/local-first-settings.ts` only exercises
  `setSyncSubscriptions`, which is the toggle handler.
- `test/sync-cycle.ts` exercises `runSyncCycle` directly and is
  unaffected because we are not modifying the cycle itself.

So no test edits are required by this feature. Re-running
`npm test && npm run lint` should pass on the modified tree without
churn. If any lint or type-check picks up the now-unused imports,
removing them (per R1) preempts that.

**Rationale**: This bounds the diff and matches the spec's "no
regressions" success criterion (SC-003).

**Alternatives considered**:

- *Add a regression test that asserts the button is absent.*
  Rejected for now: the existing `test/settings-route.ts` works
  off rendered output and could be extended, but the spec's
  Independent Tests are framed as manual browser checks (see
  `quickstart.md`) and the constitution's "Local verification" gate
  is the primary signal here. Adding a snapshot/DOM assertion is
  a reasonable follow-up if `/speckit.tasks` decides to formalize
  it; it is not required to satisfy the spec.

## R5. Console-error budget (FR-007)

**Decision**: After the change, the Settings route should log no
new warnings. Specifically check, in the browser console, that:

- no "unused import" / "declared but never read" warnings appear
  (TS strictness already enforces this; the imports are removed in
  R1),
- no `ReferenceError` for `runSyncCycle`, `syncError`, or
  `syncStatus` is thrown when toggling the Local Storage switches,
  and
- no Preact "key prop" or "missing function" warnings appear from
  the now-shorter Local Storage section.

**Rationale**: FR-007 explicitly forbids new console errors. This
is the verification budget the manual quickstart enforces.

**Alternatives considered**: None — this is a verification step,
not a design choice.
