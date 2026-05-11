# Quickstart — Verify 018-fix-feed-resolving-stuck

This document walks an engineer (or reviewer) through end-to-end
verification of the fix. Assumes a local `npm start` environment with
Bluesky OAuth configured.

## Prerequisites

```bash
npm install
npm start
```

Open the app in a browser, sign in with Bluesky.

## Scenario 1 — Known-good feed reaches RESOLVED within the window

Maps to spec User Story 1, Acceptance 1; SC-001, SC-004.

1. Click the **+** add-feed control in the sidebar.
2. Submit `https://hnrss.org/frontpage` (a fast, reliable RSS feed).
3. **Expect**: spinner appears immediately on a new sidebar row with
   `aria-label="Resolving feed"`.
4. **Within 30 seconds**: spinner disappears, the row shows the feed
   title (e.g. "Hacker News: Front Page"), and the row is clickable.
5. Click the row. Items should load.

If the row stays spinning past 35 seconds, the fix has regressed.

## Scenario 2 — Known-bad feed reaches FAILED within the window

Maps to User Story 1, Acceptance 2.

1. Click **+**.
2. Submit `https://example.com/this-feed-does-not-exist.xml` (404).
3. **Within 30 seconds**: spinner is replaced by "Failed to fetch"
   label and a retry control (↻ button).
4. The row's `last_error` should be a 404 message (visible by
   inspecting the local SQLite `feeds` table or via DevTools).

## Scenario 3 — Reload preserves terminal state

Maps to User Story 1, Acceptance 3; User Story 3; FR-008.

1. After Scenario 1 or 2 has reached terminal state, hit reload
   (cmd-R / ctrl-R).
2. **Expect**: the row paints in its terminal state on first paint.
   Not the spinner. (May briefly show skeleton, but **never** the
   resolving spinner for a row that previously resolved.)

## Scenario 4 — Bounded window holds when the server cannot respond

Maps to User Story 1, Acceptance 4; FR-001, FR-006.

This scenario tests the alarm sweep.

1. Open DevTools Network tab. Throttle to "Offline".
2. Submit a new feed URL via **+**.
3. **Expect**: the POST /api/feeds request may fail or hang. The
   sidebar shows the row in resolving (best-effort optimistic write
   to local DB).
4. Restore network ("No throttling").
5. **Expect**: within ~30 seconds of the original add timestamp, the
   row transitions to either resolved (if the upstream is good and
   the server happened to receive the original POST) or failed
   (otherwise). It never persists indefinitely.

For a more controllable test, point a feed URL at a server that
hangs indefinitely (e.g. `https://httpbin.org/delay/60`). The row
should transition to failed at ~30 seconds with `last_status = 504`.

## Scenario 5 — Retry from FAILED works and is subject to the same
guarantees

Maps to User Story 2; FR-007.

1. From Scenario 2's failed row, click the retry control (↻).
2. **Expect**: the row visibly re-enters resolving (spinner returns).
3. **Within 30 seconds**: row returns to failed (same upstream is
   still 404).
4. Modify the feed URL on the server side so it now responds with a
   valid feed (or pick a different known-good URL and use the retry
   on a different failed feed).
5. Click retry. **Expect**: row transitions through resolving and
   ends in resolved with the feed title.

The retry path must never leave the row stuck in resolving.

## Scenario 6 — 304 Not Modified on first fetch counts as RESOLVED

Maps to FR-005.

This is harder to reproduce manually (requires controlling upstream
ETag behavior). Covered by the unit test for `fetchFeed` in
`test/feed-resolve-state.test.ts`. Manual verification optional.

## Scenario 7 — Feed with no metadata still RESOLVES

Maps to FR-004.

1. Submit a feed URL that returns a valid feed XML but with empty
   `<title>`, `<description>`, and `<link>` elements at the channel
   level. (For example, a hand-crafted local mock.)
2. **Within 30 seconds**: row reaches resolved state. The visible
   label falls back to the feed URL (sidebar already does this; no
   visual change).

## Local DB inspection

To verify columns on the client side, open the browser console:

```js
// In the app's tab, with OPFS local-first enabled:
const dbWorker = await navigator.serviceWorker.ready
// or use the existing exposed debug hooks — see CLAUDE.md
```

Or run `SELECT * FROM feeds` against the OPFS SQLite using the
worker debug endpoint (`State.debugQuery`). Expect `last_error` and
`last_status` columns to exist and to match server values after sync.

## Automated checks

```bash
npm test           # vitest: includes new test/feed-resolve-state.test.ts
npm run lint       # eslint: no new violations
```

A green `npm test && npm run lint` is necessary but not sufficient.
The browser scenarios above are the constitutional verification
gate (Development Workflow: "UI changes MUST be exercised in a
browser before being claimed complete").
