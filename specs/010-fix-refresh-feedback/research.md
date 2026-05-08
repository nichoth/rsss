# Phase 0 Research: Faithful Visual Feedback During Refresh Feeds

This feature is a UI-state lifecycle correction. There are no
unknown technologies, no new dependencies, and no novel server
behavior to investigate. The only research the plan needs is to
nail down the *current* lifecycle so the proposed fix is precise
about which existing behaviors stay and which change.

## Decision: Bound the manual-refresh busy state to the SSE `refresh-complete` event, not to the POST acknowledgement

**Rationale.** The server's `/feeds/refresh` handler already does
the right thing: it returns `{ success, queued }` synchronously and
runs the actual fetches in `ctx.waitUntil`, broadcasting
`refresh-complete` over SSE when the batch finishes
(`src/server/durable-objects/index.ts` lines 873-888). The dead
window the user reported is created entirely by the client tying
the visual lifecycle to the wrong event — the POST resolve instead
of the SSE batch completion. Re-binding to `refresh-complete`
eliminates the dead window without any new wire format.

`refresh-complete` is broadcast from inside the same `waitUntil`
that runs `Promise.all(feeds.map(f => fetchFeed(f)))`, so by the
time the event fires, every feed-level fetch has settled and any
new items are already in the per-user DO's `items` table. The
client-side `refreshAfterSync` reload at that point is guaranteed
to read state that includes the refresh's results.

**Alternatives considered.**

- *Long-poll / promise-tied response.* Hold the POST open until all
  feeds are fetched and respond when the batch is done. Rejected:
  Cloudflare Workers have a request CPU budget, and feed origins
  are slow and unreliable. Pinning a client request to that wall
  clock undermines the existing `waitUntil` design (which is what
  isolates the user's request from origin latency) and risks
  request-timeout failures that look worse than the dead window
  this feature is fixing.
- *Client polling of `/feed-status` after POST.* Repeatedly poll
  the server until counts/`last_pulled_at` indicate the refresh is
  done. Rejected: SSE already delivers the exact event we need
  (`refresh-complete`); polling would duplicate that channel,
  introduce extra network traffic, and add jitter to the "single
  done moment" FR-005 requires.
- *Tie completion to per-feed `feed-updated` events.* The first
  `feed-updated` could clear the busy state, since at least one
  feed has refreshed by then. Rejected: this re-introduces the
  same class of premature-completion bug. A background poll's
  `feed-updated` arriving during a manual refresh would
  prematurely clear busy (FR-011 violation). `refresh-complete` is
  the only event semantically scoped to the manual batch.

## Decision: Track manual-refresh visual state in a new signal, separate from `feedsLoading`

**Rationale.** `state.feedsLoading` is currently used by
`State.loadFeeds` (toggles per call, `src/client/state.ts` lines
1188-1206) and by the sidebar to render "Loading feeds..." when no
feeds have loaded yet (`src/client/components/sidebar.ts` line
152). If we keep the refresh button bound to `feedsLoading`,
`loadFeeds` calls during the refresh window — for example the
`loadFeeds` invoked inside `refreshAfterSync` after the SSE
`feed-updated` debounce fires — would briefly flip
`feedsLoading=true` then `=false`, which visibly toggles the
button's busy state inside what is supposed to be a single
continuous busy window (FR-001, FR-009).

A dedicated `state.refreshInProgress:Signal<boolean>` makes the
manual-refresh lifecycle a single cleanly observable transition:
`false → true` on click, `true → false` on visible result / error.
The button's `isSpinning` binds to this signal alone. The sidebar
"Loading feeds..." chrome continues to use `feedsLoading` and is
not affected.

**Alternatives considered.**

- *Repurpose `feedsLoading` and stop calling `loadFeeds` during the
  refresh window.* Rejected: `refreshAfterSync` calls `loadFeeds`
  alongside `loadItems`/`loadFeedStatus`/`loadCounts`; suppressing
  it during the refresh window risks stale feed metadata after a
  manual refresh that touched feed-level fields. Cleaner to leave
  `feedsLoading` semantics alone.
- *Computed `isRefreshing` derived from `feedSyncStatus === 'syncing'`.*
  Rejected: `feedSyncStatus` is owned by `loadFeedStatus` after
  feature 008, and `loadFeedStatus` resets it to `synced`/`updates`
  whenever it lands. Driving the button off the pill state would
  recreate the same race the bug is about, just in a different
  signal.

## Decision: Reuse the existing 60-second safety timeout

**Rationale.** `REFRESH_FEEDS_SAFETY_TIMEOUT_MS = 60_000` already
exists (`src/client/state.ts` line 66) and is armed at the start of
`State.refreshFeeds`. Today it clears `feedsLoading` if the SSE
`refresh-complete` never arrives. We extend the same timeout to
also clear `refreshInProgress` in the new design. Keeping the
existing constant and arming-point reduces the change surface and
preserves the worst-case bound on a stuck busy state.

**Alternatives considered.**

- *Shorter / per-feed timeouts.* Rejected: feed origins can be slow;
  60s is calibrated against observed worst cases and matches the
  feature 008 / 009 work. The user-visible cost of an early
  fallback is silently switching from "still working" to "done"
  while work is in fact still in progress — exactly the bug we
  are removing. 60s plus the `refresh-complete` event together
  give us a bounded, accurate signal.
- *No timeout (rely on SSE only).* Rejected: an SSE outage
  combined with a server-side `waitUntil` failure could leave the
  button stuck busy indefinitely. The fallback is part of "fail
  closed."

## Decision: SSE-reconnect path also clears `refreshInProgress`

**Rationale.** The existing `source.addEventListener('open', …)`
path already triggers `loadFeedStatus` on a *non-first* reconnect
(`src/client/state.ts` lines 685-694). If a manual refresh is in
flight when SSE drops and reopens, the server might have broadcast
`refresh-complete` while the connection was down — it is lost
forever. Without a reconciliation path the button would only
recover via the 60-second safety timeout.

We extend the reconnect path to: when reconnecting *and*
`refreshInProgress.value === true`, run the full `refreshAfterSync`
(not just `loadFeedStatus`) and then clear `refreshInProgress` in
the same batch. This mirrors what the `refresh-complete` handler
does, just driven by reconnection instead of an event arrival. The
authority remains `loadFeedStatus`'s view of `feedSyncStatus` /
`feedUpdateCounts`.

**Alternatives considered.**

- *Issue a "is my refresh done?" query to the server.* Rejected:
  this would require a new endpoint or a new payload field on
  `/feed-status`. The existing reconcile is sufficient — it tells
  us whether the server thinks the refresh has settled (counts are
  zero or new ones are present). The button's busy state was
  always meant to be authoritative-on-server-truth, and reconcile
  reads exactly that.
- *Wait only for next `refresh-complete`.* Rejected: the
  broadcast we missed is gone; waiting forever (or 60s) needlessly
  extends the busy window when authoritative server state already
  shows the refresh has settled.

## Decision: ARIA / keyboard semantics

**Rationale.** FR-012 requires the busy state to be communicated
to assistive technology. The button is already keyboard-reachable
and `disabled={isSpinning}` blocks duplicate keyboard activation
(`src/client/components/button.ts` line 39). Adding
`aria-busy={isSpinning}` to the rendered `<button>` is the minimal
change that lets screen readers announce the busy state. The pill
already has `role="status" aria-live="polite"`
(`src/client/components/feed-status.ts` lines 84-104), and it
announces transitions naturally; no change needed there.

**Alternatives considered.**

- *Use a separate live region next to the button.* Rejected:
  redundant with `aria-busy` and the pill's existing live region.
  More noise for screen-reader users without more information.
- *Render visually hidden status text inside the button.*
  Rejected: `aria-busy` already covers the semantic.

## Decision: Restore prior `feedUpdateCounts` on refresh failure

**Rationale.** FR-007 requires that on failure the indicator is
restored to its pre-click value, not silently zeroed. The current
implementation does *not* zero `feedUpdateCounts` on failure (it
only zeroes on success at line 1360); but the success path *does*
zero before any visible result is rendered. After this fix, the
success path stops zeroing eagerly (it lets `loadFeedStatus`
inside `refreshAfterSync` do that authoritatively), and the
failure path doesn't need to zero anything at all. To make this
robust against future code paths that might zero before failure
detection, `State.refreshFeeds` snapshots `feedUpdateCounts.value`
into a local `priorCounts` at the start and restores it inside the
failure `batch`. This is a no-op today but encodes FR-007 against
regressions.

**Alternatives considered.**

- *Don't snapshot; rely on the current code path's incidental
  preservation.* Rejected: the value of FR-007 is not reproducing
  current behavior, it is encoding the invariant. Snapshot +
  restore is one line per failure branch and makes the test
  obvious to write.

## Open questions resolved

- *What constitutes "visible result"?* Per spec Key Entity #3, the
  set of UI changes the reader is waiting for is: items list
  updated with any new items, header indicator transitioned to its
  post-refresh value, per-feed counts reconciled. All of those land
  inside `State.refreshAfterSync`'s `Promise.all([loadFeeds,
  loadFeedStatus, loadItems, loadCounts])`. Awaiting that promise
  before clearing `refreshInProgress` therefore satisfies "ends on
  visible result" in one perceivable update.
- *Does the manual refresh interact with the local-first sync
  cycle?* No. `runSync(db)` is the local-first DB sync (pull then
  push) and is independent of `/feeds/refresh`. Per the existing
  code comment at line 499, those are deliberately separate. This
  feature does not touch `runSync`.
- *Does the user reach the manual refresh control from anywhere
  other than the sidebar footer?* No. `grep -rn 'refreshFeeds'
  src/client` shows two call sites: `sidebar-footer.ts` (the
  user-facing button) and an audit guard (`test/state-refresh-audit.ts`).
  The single-button assumption holds.
