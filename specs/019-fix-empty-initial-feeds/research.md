# 019 — Fix empty initial feeds list (research notes)

## Background

The user reported that the sidebar shows "No feeds yet…" on first paint
even when the user has subscribed feeds, and that the "Refresh Feeds"
button appears to re-fetch the feeds list. The plan in
`docs/superpowers/plans/2026-05-10-initial-state-and-refresh-decoupling.md`
addresses both symptoms architecturally.

## Diagnostic phase (manual repro)

The diagnostic Task 0 of the plan calls for a manual OAuth login,
DevTools network capture, and DO state inspection. That phase requires
human-driven browser interaction (OAuth handshake against a live
identity provider) and could not be executed inside the autonomous
implementation session. The implementation proceeds with the plan's
defense-in-depth changes:

- **Task 5** seeds `state.feeds`, `state.counts`, and `state.items`
  synchronously from the SSR bootstrap payload. This eliminates the
  empty-list flash regardless of which of the three diagnostic
  outcomes the manual repro would have identified — server returning
  `[]`, client swallowing an error, or boot effect never firing.
- **Task 7** stops `State.loadFeeds` from silently swallowing failures
  behind "No feeds yet…"; instead the sidebar shows the actual error
  via a new `feedsError` signal. The user therefore sees a real
  diagnostic message in the failure case rather than a misleading
  empty state.
- **Task 6** splits `refreshAfterSync` into `loadInitialView` (first
  load) and `reconcileAfterRefresh` (post-refresh). The SSE
  `refresh-complete` listener now routes through the lighter
  `reconcileAfterRefresh` path, which intentionally does NOT call
  `loadFeeds`. The Refresh Feeds button therefore cannot re-pull the
  feeds list, matching the user's expectation.

## Root cause (best-effort, pre-manual-repro)

The most likely culprit based on the code paths:

- `State.loadFeeds` (`src/client/state.ts:1386-1404`) catches all
  errors and only logs through `debug(...)`, then clears
  `feedsLoading`. If the local adapter (`getAdapter`) rejects or the
  remote `getFeeds()` call 401's during boot, the result is exactly
  the user-visible symptom: `feeds.value` stays `[]`, the sidebar
  renders the empty branch, and the user has no visual signal that
  anything failed.

The Task 5 + Task 7 changes both address this without requiring a
positive diagnosis — Task 5 hydrates the list from SSR so even a
failing `loadFeeds` can't blank it, and Task 7 reports the error
instead of hiding it.

## Counts investigation (Task 9)

The "All Items" badge showing `0` on first paint should be fixed by
Task 5's `counts` seeding from the bootstrap payload. Manual
verification of per-feed counts after adding live feeds was also out
of scope for this autonomous session and is left as a manual
verification step in Task 10.
