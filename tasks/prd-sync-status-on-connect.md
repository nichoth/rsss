# PRD: Sync Status on Connect

## 1. Introduction / Overview

When the client connects (page load), the server returns a single HTTP
response that includes the per-feed count of pending updates the user has
not yet pulled. The client renders a single sync-status dot in the global
app header reflecting that state. The client never auto-syncs; the user
must click a global "Sync" button. While the sync runs, the dot reflects
progress and outcome.

This refines the previous `prd-refresh-button.md` design. Key differences:

- Source of truth on connect is a **single HTTP call**, not SSE.
- Server returns a **per-feed count**, not just feed IDs.
- The header has a **single global dot** (not per-feed dots).
- A new **dot color palette** is used: gray (default/inactive), blue
  (pending updates), yellow (sync in progress), red (error), green
  (up-to-date).
- Green is **sticky** — it remains until new updates arrive.

## 2. Goals

- On connect, the user immediately knows whether there are pending feed
  updates and how many per feed, with a single round trip.
- The user has explicit control over when sync runs (one global button).
- The header dot gives clear, low-noise feedback through every sync phase
  (idle, in progress, error, success).
- The feature reuses the existing `Dot` and `FeedStatus` components and
  the existing global "Refresh Feeds" entry point in the sidebar (or a
  header equivalent if that is where the dot now lives).

## 3. User Stories

### US-001: Extend `Dot` component to support `blue` and keep `gray`

**Description:** As a developer, I need the `Dot` component to support
the full color set used by the new sync-status indicator.

**Acceptance Criteria:**
- [ ] `Dot` accepts `color?:'gray'|'blue'|'yellow'|'red'|'green'`.
- [ ] `gray` and `blue` styles added to `dot.css` using variables from
      `_variables.css`; if a suitable variable does not exist, add one
      and reuse existing palette values where possible.
- [ ] Existing call sites compile unchanged (the new colors are additive).
- [ ] Typecheck and lint pass (`npm test && npm run lint`).

### US-002: Server returns per-feed update counts on connect

**Description:** As a backend developer, I need the bootstrap/initial-data
endpoint to return per-feed counts of pending items so the client can
render the dot and (later) detail views without an extra round trip.

**Acceptance Criteria:**
- [ ] Bootstrap response includes
      `feedUpdateCounts:Record<string,number>` (feed ID -> pending count).
- [ ] Counts are read from the server's already-cached state (populated
      by the existing background fetch loop); the bootstrap handler does
      **not** trigger a live fetch of remote feeds.
- [ ] Counts are computed against the user's per-feed cursor.
- [ ] Response shape documented in the relevant API type / schema file.
- [ ] Unit test covers: no feeds, some feeds with 0 pending, some feeds
      with N pending.
- [ ] Typecheck and lint pass.

### US-003: Client state models the full sync-status lifecycle

**Description:** As a developer, I need a single signal that captures
every state the header dot can be in, so the UI logic stays simple.

**Acceptance Criteria:**
- [ ] New (or repurposed) signal
      `feedSyncStatus:Signal<'inactive'|'updates'|'syncing'|'error'|
      'synced'>` on `AppState`.
- [ ] New signal `feedUpdateCounts:Signal<Record<string,number>>` on
      `AppState`.
- [ ] Default values: `feedSyncStatus = 'inactive'`,
      `feedUpdateCounts = {}` (before bootstrap completes).
- [ ] Existing `feedUpdateStatus` / `feedsWithUpdates` signals are
      either replaced by the new ones or kept in sync via `batch()` —
      decide and document in the implementation plan; do **not** leave
      two competing sources of truth.
- [ ] Any code that sets multiple signals in sequence uses `batch()`.
- [ ] Typecheck and lint pass.

### US-004: Hydrate sync status from the bootstrap response

**Description:** As a user, I want the header dot to be correct on first
paint, so I never see a flash of the wrong color.

**Acceptance Criteria:**
- [ ] Bootstrap handler reads `feedUpdateCounts` from the response.
- [ ] If the sum of counts is 0: set `feedSyncStatus = 'synced'`.
- [ ] If the sum of counts is > 0: set `feedSyncStatus = 'updates'`.
- [ ] If the bootstrap call fails: leave `feedSyncStatus = 'inactive'`
      (gray); show no error in the header (errors only come from sync
      attempts).
- [ ] All signal writes wrapped in `batch()`.
- [ ] Typecheck and lint pass.

### US-005: Header dot reflects all five states

**Description:** As a user, I want the header to show a single dot whose
color tells me at a glance what the sync state is.

**Acceptance Criteria:**
- [ ] `FeedStatus` (header component) renders a single `Dot` based on
      `feedSyncStatus`:
        - `inactive` -> gray
        - `updates`  -> blue
        - `syncing`  -> yellow
        - `error`    -> red
        - `synced`   -> green
- [ ] When status is `updates`, the dot is followed by a count of pending
      items (sum of `feedUpdateCounts` values), e.g. `<dot> 3`.
- [ ] When status is `error`, the dot is followed by short text such as
      `sync failed` and a `title=` attribute carrying the error message.
- [ ] Component has `role="status"` and `aria-live="polite"` so screen
      readers announce transitions.
- [ ] Anonymous users do not see the indicator.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-006: Single global "Sync" button drives the flow

**Description:** As a user, I want one obvious button that pulls all
feed updates.

**Acceptance Criteria:**
- [ ] A single global "Sync" / "Refresh Feeds" button exists (reuse the
      existing sidebar button; do not introduce a second one).
- [ ] Clicking the button transitions
      `feedSyncStatus` -> `'syncing'` (yellow dot) using `batch()`.
- [ ] The button is disabled / shows a spinner while in flight to
      prevent double-click.
- [ ] On success: clear `feedUpdateCounts` to `{}` and set
      `feedSyncStatus = 'synced'` (green dot).
- [ ] On error: set `feedSyncStatus = 'error'` (red dot) and surface
      the error message in a visible spot (header `title` attr + an
      existing toast / error region if available).
- [ ] No code path triggers sync automatically (no timer, no SSE, no
      visibility-change, no route-change). Audit confirmed.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-007: Green is sticky until new updates arrive

**Description:** As a user, I want a "synced" indicator that stays put,
so I can trust the header rather than having to remember when I last
synced.

**Acceptance Criteria:**
- [ ] After a successful sync, `feedSyncStatus` stays `'synced'`
      indefinitely — no timeout reverts it to `'inactive'`.
- [ ] The next time `feedUpdateCounts` becomes non-empty (next bootstrap
      or any future server-pushed update — see open questions),
      `feedSyncStatus` flips to `'updates'`.
- [ ] If the user reloads the page and the bootstrap returns no pending
      counts, the header remains green (`'synced'`), not gray.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-008: Error state recovers cleanly

**Description:** As a user, when a sync fails, I want to be able to
retry and have the header recover correctly.

**Acceptance Criteria:**
- [ ] Clicking the global Sync button while in `'error'` re-attempts
      the sync and transitions to `'syncing'` (yellow).
- [ ] After a successful retry, status moves to `'synced'` (green).
- [ ] After a second consecutive failure, status returns to `'error'`
      (red) with the latest message.
- [ ] The previous error message is replaced, not stacked.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

## 4. Functional Requirements

- **FR-1:** The bootstrap (initial-data) HTTP response must include
  `feedUpdateCounts:Record<string,number>` mapping each followed feed ID
  to the number of pending items for the authenticated user.
- **FR-2:** The server must compute `feedUpdateCounts` from already-cached
  state populated by its existing background fetch loop. The bootstrap
  request must not trigger a live fetch of remote feeds.
- **FR-3:** The client must expose `feedSyncStatus:Signal<'inactive'|
  'updates'|'syncing'|'error'|'synced'>` and
  `feedUpdateCounts:Signal<Record<string,number>>` on `AppState`.
- **FR-4:** The header must render a single `FeedStatus` indicator with
  one `Dot` whose color is derived from `feedSyncStatus`:
  inactive=gray, updates=blue, syncing=yellow, error=red, synced=green.
- **FR-5:** When `feedSyncStatus === 'updates'`, the indicator must show
  a numeric badge equal to the sum of `feedUpdateCounts` values.
- **FR-6:** The `Dot` component must support `gray`, `blue`, `yellow`,
  `red`, and `green` colors, styled via variables in `_variables.css`.
- **FR-7:** A single global "Sync" button (existing sidebar button) must
  be the only entry point for sync. No automatic sync paths are allowed.
- **FR-8:** Clicking the global Sync button must:
  (a) set `feedSyncStatus = 'syncing'` (yellow);
  (b) call the existing refresh action;
  (c) on success, set `feedUpdateCounts = {}` and
      `feedSyncStatus = 'synced'` (green) using `batch()`;
  (d) on failure, set `feedSyncStatus = 'error'` (red) and expose the
      error message.
- **FR-9:** Once `feedSyncStatus === 'synced'`, it must remain `'synced'`
  until either a fresh bootstrap reports a non-empty `feedUpdateCounts`,
  or another mechanism (out of scope here) reports new updates.
- **FR-10:** The bootstrap response must drive the initial value of
  `feedSyncStatus` deterministically: empty counts -> `'synced'`,
  non-empty counts -> `'updates'`, request failure -> `'inactive'`.
- **FR-11:** Anonymous users must not see the header dot and must not
  receive sync-status data on bootstrap.
- **FR-12:** All signal writes must use `batch()` when more than one
  signal is updated together.

## 5. Non-Goals (Out of Scope)

- No SSE channel for live "new updates" notifications. (Bootstrap-only.)
- No per-feed dot in the header — only a single global dot.
- No `/updates` route changes in this PRD (covered by
  `prd-refresh-button.md`); this PRD only covers the header dot,
  the bootstrap shape, and the sync button flow.
- No auto-sync triggers of any kind (timers, focus, visibility, route
  change, SSE, etc.).
- No partial / per-feed sync from the header — the global button pulls
  all feeds.
- No persistence of `feedSyncStatus` across reloads beyond what bootstrap
  reports. (A reload of a page with no pending counts shows green; a
  reload that lands while pending counts exist shows blue.)
- No animation / transition design beyond what `Dot` already provides.
- No anonymous-user support.

## 6. Design Considerations

- Reuse the existing `Dot` (`src/client/components/dot.ts`) and
  `FeedStatus` (`src/client/components/feed-status.ts`) components.
- Reuse the existing global "Refresh Feeds" sidebar button as the single
  Sync entry point. Do not introduce a competing button in the header.
- Add `gray` and `blue` styles to `dot.css` using existing color
  variables in `_variables.css`. If new variables are needed (e.g.
  `--color-dot-blue`, `--color-dot-gray`), follow the project's
  `_variables.css` conventions.
- Match the existing `SyncStatus` component's ARIA semantics
  (`role="status"`, `aria-live="polite"`).
- Header layout: keep the dot to the right of `SyncStatus` as today;
  anonymous users still see nothing in that slot.

## 7. Technical Considerations

- The current state in `src/client/state.ts` already defines
  `feedUpdateStatus:Signal<'synced'|'updates'>` and
  `feedsWithUpdates:Signal<string[]>` (lines 170-171, 201-202). The
  implementation should either:
    (a) replace these with the richer `feedSyncStatus` +
        `feedUpdateCounts`, updating all call sites; or
    (b) keep them as derived views over the new signals.
  Whichever is chosen, there must be only one source of truth.
- The existing bootstrap hydration block (around lines 1091-1095 in
  `state.ts`) is the place to read `feedUpdateCounts` and derive the
  initial `feedSyncStatus`.
- The existing `State.refreshFeeds` action is the right place to drive
  the `'syncing'` -> `'synced'` / `'error'` transitions; do not create
  a parallel sync function.
- The existing `Button` component's `isSpinning` prop should drive the
  in-flight state on the sidebar Sync button.
- Counts are server-authoritative: the client should never increment or
  decrement them locally based on its own actions other than clearing
  them on a successful sync.
- Multi-tab consistency: out of scope here (no SSE). Two tabs that load
  at the same time will agree; a sync in tab A will not update tab B
  until tab B reloads or independently syncs.
- Audit point: confirm no caller of `refreshFeeds` runs from a timer,
  visibility / focus event, route change, or SSE handler.

## 8. Success Metrics

- Header dot reflects correct state on first paint, with no flash, on
  every reload.
- Sum of `feedUpdateCounts` shown in the header matches the items the
  user actually pulls when they click Sync (off-by-one or stale-count
  bugs are caught).
- Yellow appears within one frame of the Sync click; green or red
  appears within one frame of the underlying request resolving.
- Green persists across many minutes of idle without flipping to gray.
- Zero automatic refresh paths in the codebase (audit confirmed).

## 9. Open Questions

- Should the header dot show a numeric count when status is `'updates'`
  (current proposal: yes, sum of `feedUpdateCounts`), or stay minimal?
- When `feedSyncStatus === 'error'`, should the sidebar Sync button
  visually reflect the error (e.g. red border) in addition to the
  header dot, or is the header alone sufficient?
- Should `feedSyncStatus` ever revert from `'synced'` to `'inactive'`
  on long idle (e.g. > 30 minutes), or stay green forever until a
  bootstrap / explicit signal says otherwise? Current proposal: stay
  green forever.
- If a future PRD adds SSE-driven "new updates available" events
  (cf. `prd-refresh-button.md`), how should those interact with this
  state machine? Likely: such an event sets
  `feedSyncStatus = 'updates'` and increments `feedUpdateCounts`. Out
  of scope here, but worth noting before implementation.
- Where exactly should the error message render in detail (header
  `title=` only, an inline message, or an existing toast region)?
