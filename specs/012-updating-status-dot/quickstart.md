# Quickstart: Yellow "Updating" Pill State

This is the runbook for verifying feature 012 locally — both the
automated suite and the in-browser interactive checks. The feature
is purely client-side, so a local dev server with a stub or live
backend is sufficient.

## Automated tests

```sh
npm test
```

This builds and runs the full Node + browser bundles. Tests
specific to this feature:

| Test file                              | What it covers                                                                                                                                               |
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `test/feed-status.ts`                  | `legendFor('syncing', _)` returns `'updating'`. `<FeedStatus>` renders yellow + `'updating'` when `state.refreshInProgress.value === true`.                 |
| `test/feed-status-loader.ts`           | `loadFeedStatus` running while `refreshInProgress=true` does not change `displayedFeedSyncStatus`; underlying `feedSyncStatus`/`feedUpdateCounts` still get the new values for surfacing on settle. |
| `test/refresh-lifecycle.ts`            | `displayedFeedSyncStatus` is `'syncing'` continuously across the refresh window for all three resolution paths.                                              |
| `test/sidebar-footer-refresh.ts`       | Click-through DOM tests confirm the pill text changes from the pre-click resting label to `updating` and back, atomically with the button.                  |
| `test/updating-pill-lifecycle.ts`      | NEW. End-to-end browser test covering pill yellow-and-`updating` from click to resolution for success-with-items, success-no-items, and failure paths plus a background-poll-during-refresh case. |

A failure here regresses one of the FRs in
`spec.md` and `contracts/header-pill-states.md` — fix the failing
case before merging.

## Manual verification (dev server)

```sh
npm start
```

Open the dev server URL (default `http://localhost:5173/`), log in
with a Bluesky account that has at least one subscribed feed, and
walk through these scenarios. The header pill referenced is the one
next to the user controls in the page header, not the per-feed
indicators in the sidebar.

### Scenario 1 — Click → yellow → resting (Story 1)

1. Confirm the pill shows either green `up to date` or blue
   `n updates`. Note the value.
2. Open DevTools → Network tab so you can watch
   `POST /api/feeds/refresh` and the SSE feed.
3. Click the **Refresh Feeds** button in the sidebar footer.
4. Observe in the same paint: the button enters its spinning
   busy state *and* the header pill flips to a yellow dot with the
   text `updating`.
5. Wait for the SSE `refresh-complete` event. In the same paint:
   the button returns to idle, the items list updates if there are
   new items, and the pill transitions to the post-refresh value
   (`up to date` if no pending, or `n updates` with the post-refresh
   count). The pill MUST NOT pass through the pre-click resting
   state on the way out.

Pass criteria:

- Pill transition to yellow happens *with* the click (not after a
  network round-trip).
- Pill stays yellow for the entire button-busy window — never
  flickers.
- Pill exits yellow into the post-refresh value, never the
  pre-click value.

### Scenario 2 — Failure path (Story 2)

1. With the dev server running, simulate a failure. Easiest path:
   open DevTools → Network tab → throttle to "Offline", or set a
   request blocker on `**/api/feeds/refresh`.
2. Click **Refresh Feeds**.
3. Observe: pill flips to yellow `updating`, button starts spinning.
4. After a moment (the POST fails), observe: pill exits yellow into
   the **error** state (red dot, `sync failed`), button returns to
   idle. The pre-click count (the underlying
   `feedUpdateCounts`) is restored — the pill must not have flipped
   to green or zero before turning red.

Pass criteria:

- Pill never lands on green `up to date` as a consequence of
  failure.
- Pill never stays stuck on yellow.
- Pill and button exit their active states together.

### Scenario 3 — Background poll during refresh (Story 3)

1. Open the app. Wait for the initial pill state to settle.
2. Without clicking Refresh Feeds, wait for the background poller
   (feature 009) to run a normal cycle (alarm cadence; in dev, you
   can manually trigger it via the admin tools or just wait the
   configured interval). Observe the pill: it must transition
   directly from `up to date` (or `n updates`) to a new
   `n updates` value with no yellow flash.
3. Then click Refresh Feeds while the next background tick is due.
   The pill must turn yellow `updating` on the click. If a
   background tick lands during the refresh, the pill must stay
   yellow until the *manual* refresh resolves; the background
   tick's count update is folded into the post-refresh resting
   state.

Pass criteria:

- Background polling never produces a yellow flash.
- A background tick during a manual refresh does not flicker the
  pill out of yellow.

### Scenario 4 — Zero feeds subscribed (edge case)

1. Use an account that has no subscribed feeds, or unsubscribe from
   all feeds before the test.
2. Click **Refresh Feeds**.
3. Observe: pill briefly flips to yellow `updating`, the button
   briefly spins, both exit together. The pill should land on
   `up to date` (green). The yellow state must be visible for at
   least one paint — not a sub-perceptual flash.

Pass criteria:

- Click is acknowledged with a perceptible yellow state.
- Pill and button settle together on `up to date`.

### Scenario 5 — Re-entrant click (FR-010)

1. Click **Refresh Feeds**. While the pill is still yellow, click
   it again (and again).
2. Observe: extra clicks have no effect on the pill or the button.
   The pill stays yellow for the duration of the *first* refresh
   and exits yellow on the resolution of that refresh, regardless
   of how many times you clicked.

Pass criteria:

- Pill does not flicker, restart, or terminate the yellow state
  prematurely from extra clicks.

## Accessibility check

1. With a screen reader (VoiceOver, NVDA, or similar), navigate to
   the page.
2. Click **Refresh Feeds**.
3. Confirm the screen reader announces the change in the
   `role="status"` region — typically as `Feed sync status:
   updating`.
4. After the refresh resolves, confirm the announcement updates to
   the post-refresh value (`Feed sync status: up to date` or
   `Feed sync status: 3 updates`).

Pass criteria:

- The pill state change is announced (FR-008).
- The `aria-busy` on the **Refresh Feeds** button (carried over
  from feature 010) is also announced as the button enters / exits
  its busy state.

## High-contrast / color-blind check

1. Resize the browser window to a width between 680px and 999px.
2. Click **Refresh Feeds**.
3. Confirm the pill displays the literal text `updating` next to
   the dot — not just a colored dot. (Other states' legends may be
   hidden at this width; the `updating` legend is intentionally
   kept visible per FR-009.)
4. Optionally enable a high-contrast OS theme or browser
   color-blind simulation and re-run scenarios 1 and 2; the
   `updating` text must remain present and readable.

Pass criteria:

- Yellow state always carries the visible label `updating` at
  every supported viewport.
- Resting states (`up to date`, `n updates`) keep their existing
  responsive behavior unchanged.
