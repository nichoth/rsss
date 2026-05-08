# Quickstart: Refresh Feeds Click Must Produce an Observable Response

This is a client-only regression fix on top of feature 010. There
are no migrations to run, no new environment variables, no new
bindings, and no server changes.

## Prereqs

- The repo is checked out at the `011-fix-refresh-noop` branch.
- `npm install` has been run.
- A working dev environment for the client (Vite) and worker
  (Wrangler), e.g. `npm start` brings up the app at the URL
  printed by `wrangler dev`.

## Reproducing the bug (before the fix)

The point of this section is to confirm the bug is reproducible
before any code is changed, so the fix can be validated against
a known-bad starting state.

1. Sign in with a Bluesky account that has at least a few
   subscribed feeds.
2. Wait for the indicator to surface `n updates` (or use the
   admin path to stage pending updates) so there is a visible
   "before" indicator.
3. Open DevTools → Network. Filter to `feeds/refresh`.
4. Click **Refresh Feeds** in the sidebar footer.
5. Observe: no `POST /feeds/refresh` request is dispatched. The
   button visibly does nothing other than possibly a single
   sub-frame flicker. The pill does not transition. The items
   list does not update.

This is the user-reported symptom. It happens because
`Button.click` writes `state.refreshInProgress = true` before
calling `State.refreshFeeds`, which then trips the FR-008 re-
entry guard and returns without dispatching the POST.

## Manual verification (happy path — User Story 1)

After applying the fix, repeat steps 1-3 above and continue:

4. Click **Refresh Feeds**. Observe:
   - The button enters its busy state on click and stays busy
     continuously through the refresh window. There is no
     period where the button is idle while the items list still
     shows the old content.
   - In DevTools → Network, exactly one `POST /feeds/refresh`
     fires. (This was the missing request before the fix.)
5. When the refresh completes, the button returns to idle, the
   pill snaps to `up to date` (or to a new `n updates` if a
   background poll dropped more items in the meantime, per
   FR-011), and the new items appear in the items list — all in
   the same visible paint.

## Manual verification (no-new-items path — User Story 2 case b)

1. With the indicator already at `up to date`, click **Refresh
   Feeds**.
2. Confirm the button enters busy state on click. The POST
   fires. SSE `refresh-complete` arrives. The pill remains at
   `up to date` (or transitions cleanly through `syncing` and
   back). The button returns to idle.
3. There must be no fourth, silent resolution path: the cue at
   the end is `up to date`, not the absence of any cue.

## Manual verification (failure path — User Story 2 case c)

1. Stop the worker (`wrangler dev` Ctrl+C) and click **Refresh
   Feeds**.
2. Observe: the button enters busy state on click. After the
   failed POST, the button exits busy, the pill displays the
   error legend (`sync failed`), and the prior `n updates`
   count is intact. The button must not be stuck busy after the
   failure.
3. Restart the worker. Click **Refresh Feeds** again. A fresh
   busy lifecycle starts, completing per User Story 1.

## Manual verification (edge cases)

- **Rapid clicks (FR-008 / User Story 3 case 2).** Click
  **Refresh Feeds**, then immediately attempt to click it
  again 2-3 times. The first click disables the button;
  subsequent clicks are no-ops at the DOM level. Only one POST
  is dispatched (verify in DevTools → Network), and the busy
  state does not flicker.
- **Successive resolved refreshes (FR-008 / User Story 3 case 1).**
  Click, wait for resolution, click again. Each click must
  produce the full visible chain. There must be no degradation
  on the second / third / fourth click.
- **SSE drop mid-refresh (FR-010, feature 010 carries forward).**
  Click **Refresh Feeds**, then in DevTools → Network kill the
  `/api/events` connection. After it reconnects, the button
  exits busy and the pill reflects server truth, even if the
  `refresh-complete` event was lost during the drop.
- **Slow refresh.** Use a slow feed origin or a network throttle.
  The busy state must remain steady throughout (no flicker).
- **No subscribed feeds.** With zero feeds, click **Refresh
  Feeds**. The lifecycle should resolve almost immediately into
  `up to date`, with no spurious failure cue.
- **Background poll lands during manual refresh (FR-011).**
  Initiate a manual refresh, then trigger a background-poll
  `feed-updates-available` SSE event from the worker. The
  manual busy state must NOT clear until `refresh-complete`
  arrives; the poll's items appear in the post-refresh state.
- **Per-feed Refresh (regression check on `routes/updates.ts`).**
  Navigate to `/updates`. Expand a feed row and click its
  per-feed **Refresh** button. The button must enter busy
  state for the duration of the POST and return to idle when
  the request resolves. (This exercises the new uncontrolled
  mode of `Button` after the `spinning` signal binding is
  dropped from `routes/updates.ts`.)

## Automated verification

Run the standard test suite:

```bash
npm test && npm run lint
```

Test files this feature touches or owns:

- `test/refresh-lifecycle.ts` — extended with one additional
  case that simulates the broken-caller pattern (writes
  `state.refreshInProgress = true` before invoking
  `State.refreshFeeds`) and asserts zero `POST /feeds/refresh`
  requests are dispatched. Encodes the invariant that nothing
  outside `State.refreshFeeds` may write the signal high
  before the call.
- `test/sidebar-footer-refresh.ts` (NEW) — browser-driven
  end-to-end test bundled via tapout. Mounts the real
  `SidebarFooter`, stubs `EventSource` and `fetch`, dispatches
  a real `click` event on the rendered `<button>`, and
  asserts:
  - `POST /feeds/refresh` actually fires (the bug suppressed it).
  - `aria-busy="true"` after the POST resolves; `disabled` set.
  - SSE `refresh-complete` clears `aria-busy` and resolves
    items / pill in the same paint.
  - Three resolution outcomes (new items / no new items /
    failure) all transit through the visible chain.
  - A second click while the button is `disabled` does not
    fire a second POST.
- `test/index.ts` — adds the import line for the new test so it
  ships in the same `tapout` bundle that `npm test` runs.

## Accessibility check

Open the app with a screen reader (VoiceOver on macOS, NVDA on
Windows). Tab to **Refresh Feeds**. Activate it with `Enter` or
`Space`. The screen reader should announce the busy state via
`aria-busy="true"` and announce the pill transition through its
existing `role="status" aria-live="polite"` region. Activation
via `Enter` and via mouse click must both produce the same
chain (the new test dispatches a `click` event, which is what
the keyboard activation path also produces).

## Rollback

This fix touches only client code (`src/client/components/button.ts`,
`src/client/routes/updates.ts`) and tests
(`test/refresh-lifecycle.ts`, `test/sidebar-footer-refresh.ts`,
`test/index.ts`). Reverting the client commit restores the
pre-fix state — i.e. the bug returns. Server, schema, and
routing rollback is not needed.
