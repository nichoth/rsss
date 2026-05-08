# Quickstart: Faithful Visual Feedback During Refresh Feeds

This is a client-only feature. There are no migrations to run, no
new environment variables, no new bindings, and no server changes.

## Prereqs

- The repo is checked out at the `010-fix-refresh-feedback` branch.
- `npm install` has been run.
- A working dev environment for the client (Vite) and worker
  (Wrangler), e.g. `npm start` brings up the app at the URL
  printed by `wrangler dev`.

## Manual verification (happy path — User Story 1)

The point of this feature is to remove the dead window the user
reported. Verify on a real browser, not in unit tests.

1. Sign in with a Bluesky account that has at least a few
   subscribed feeds. If the indicator is showing `up to date`,
   wait for the background poller (feature 009) to surface
   `n updates`, or temporarily pause the worker so you can stage
   pending updates.
2. With the header pill showing `n updates`, click **Refresh
   Feeds** in the sidebar footer.
3. Observe the button continuously from click to result. You
   should see exactly one busy state: spinner appears on click and
   stays through the entire refresh window. There must be no
   period where the button is idle while the items list still
   shows the old content.
4. When the refresh completes, the button returns to idle, the
   pill snaps to `up to date` (or to a new `n updates` if a
   background poll dropped more items in the meantime, per FR-011),
   and the new items appear in the items list — all in the same
   visible paint.

## Manual verification (failure path — User Story 2)

1. With the app open and signed in, simulate a refresh failure.
   Easiest: stop the worker (`wrangler dev` Ctrl+C) and click
   **Refresh Feeds**.
2. The button should enter busy state on click. After the failed
   POST, it should exit busy state, the pill should display the
   error legend (`sync failed`), and the prior `n updates` count
   should be intact (FR-007). The button must not be stuck busy
   after the failure.
3. Restart the worker. Click **Refresh Feeds** again. A fresh
   busy lifecycle starts, completing per User Story 1.

## Manual verification (edge cases)

- **Rapid clicks (FR-008).** Click **Refresh Feeds**, then
  immediately click it again 2-3 times. The button should ignore
  the duplicate clicks: only one POST is dispatched (verify in
  DevTools → Network), and the busy state does not flicker.
- **SSE drop mid-refresh.** Click **Refresh Feeds**, then in
  DevTools → Network kill the `/api/events` connection. After it
  reconnects, the button should exit busy and the pill should
  reflect server truth, even if the `refresh-complete` event was
  lost during the drop.
- **Slow refresh.** Use a slow feed origin or a network throttle.
  The busy state must remain steady throughout (no flicker).
- **No subscribed feeds.** With zero feeds, click **Refresh
  Feeds**. The lifecycle should resolve almost immediately into
  `up to date`, with no spurious failure cue.
- **Background poll lands during manual refresh (FR-011).**
  Initiate a manual refresh, then trigger a background-poll
  `feed-updates-available` SSE event from the worker (e.g. by
  letting an alarm tick during the refresh window). The manual
  busy state must NOT clear until `refresh-complete` arrives;
  the poll's items appear in the post-refresh state.

## Automated verification

Run the standard test suite:

```bash
npm test && npm run lint
```

Test files this feature owns:

- `test/state-auth-storage.ts` — updated to bind to
  `refreshInProgress` instead of `feedsLoading`, and to drive
  completion with a simulated SSE `refresh-complete` rather than
  the POST resolve.
- `test/feed-status-loader.ts` — updated to also assert the busy
  state is cleared on failure (not only `feedSyncStatus = error`).
- `test/refresh-lifecycle.ts` (new) — end-to-end lifecycle:
  `refreshInProgress` stays `true` past POST ack until SSE
  `refresh-complete`; safety timeout fallback; SSE
  disconnect/reopen mid-flight; rapid duplicate clicks (FR-008);
  background poll's `feed-updated` does not clear busy (FR-011);
  zero subscribed feeds resolves cleanly.

## Accessibility check

Open the app with a screen reader (VoiceOver on macOS, NVDA on
Windows). Tab to **Refresh Feeds**. Activate it with `Enter` or
`Space`. The screen reader should announce the busy state via
`aria-busy="true"` and announce the pill transition through its
existing `role="status" aria-live="polite"` region. No additional
narration noise compared to the pre-fix version is acceptable —
this should be a tightening of semantics, not new chrome.

## Rollback

This feature touches only client code (`src/client/state.ts`,
`src/client/components/sidebar-footer.ts`,
`src/client/components/button.ts`) and tests. Reverting the
client commit restores the prior visual contract; no server or
schema rollback is needed.
