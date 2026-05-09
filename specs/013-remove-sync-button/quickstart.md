# Quickstart: Verify Sync Button Removal

**Feature**: 013-remove-sync-button
**Date**: 2026-05-08

This quickstart is the constitution's "Local verification" gate for
this feature: type-check + tests passing are not sufficient on
their own — the change must be exercised in a browser. Each step
maps to a Functional Requirement or Acceptance Scenario from
`spec.md`.

## Pre-flight

```bash
npm install   # only if dependencies are stale
npm run lint
npm test
npm start     # start the dev server (Wrangler + Vite)
```

`npm test && npm run lint` must be clean before browser checks
begin. They are necessary, not sufficient.

## Manual verification

Sign in as a Local-first-entitled user with local storage enabled.
A second pass with local storage *disabled* (and a third
unauthenticated, if `/settings` is reachable) covers the edge cases
in the spec.

### Step 1 — Local Storage section is configuration-only (FR-001, FR-002, US1 AS-1)

1. Open the app and navigate to `/settings`.
2. In the "Local Storage" section, confirm:
   - The toggle "Sync subscriptions and read state to this device"
     is present.
   - The toggle "Store article content locally for offline reading"
     is present.
   - There is **no** "Sync" button.
   - There is **no** "Pull updates from the server" caption.
3. Open DevTools → Elements and search the rendered DOM for
   `class="btn-sync"`, `class="sync-local-data"`, and the literal
   string "Pull updates from the server". All three searches must
   return zero hits inside the Local Storage section.

### Step 2 — Local-storage-disabled rendering (FR-001, US1 AS-2)

1. Toggle "Sync subscriptions and read state to this device" off.
2. Confirm the Local Storage section still does not show any Sync
   button or related caption.
3. Reload the page; confirm the same.

### Step 3 — No leftover sync-error banner (FR-003, US2 AS-3)

1. With DevTools open, in Application → Local Storage, simulate a
   prior error state if reachable (or simply load `/settings` with
   any value of `syncError` in memory by toggling offline/online
   on a separate tab).
2. Confirm the Local Storage section never shows a red error
   message tied to sync. Bootstrap errors (during initial setup)
   are still allowed and unrelated.
3. Confirm the global sync-status indicator (out of scope for this
   feature) continues to render in the header / wherever it lives.

### Step 4 — Toggles still work (FR-004, US2 AS-1)

1. Flip "Sync subscriptions and read state to this device" off,
   confirm the confirmation dialog, accept; reload — toggle is
   still off.
2. Flip it back on; reload — toggle is still on. Bootstrap kicks
   off and progress messages appear as before.
3. Flip "Store article content locally for offline reading" off
   while the first toggle is on; verify any locally stored content
   is purged (per the existing `purgeStoredContent` flow).
4. Flip it back on; reload — toggle is still on.

### Step 5 — Refresh feeds still works (FR-005, US1 AS-3, US2 AS-2)

1. Navigate to the home route `/`.
2. Click the existing "Refresh feeds" action.
3. Confirm new items load and the action completes without error.

### Step 6 — Cache and Subscription sections unchanged (FR-006)

1. On `/settings`, scroll to the Cache section.
2. Adjust default cache mode, max size per feed, total cache size,
   and keep-for (days). Confirm each persists across reload.
3. Adjust a per-feed cache override under "Subscribed Feeds" → a
   feed's "Cache settings" disclosure. Confirm it persists.
4. Confirm the Subscription section still renders the user's plan
   label and the Manage / Upgrade button correctly.

### Step 7 — Console budget (FR-007, SC-001)

1. With DevTools Console open, repeat steps 1, 4, 5, and 6.
2. Confirm zero new errors or warnings. Pre-existing warnings
   unrelated to this change are acceptable but should be noted.

### Step 8 — Discoverability (SC-004)

Have a fresh user (or a teammate) open the app and find how to
"refresh my feeds" with no prompting. They should land on the
home-route "Refresh feeds" action within 10 seconds.

## What "done" looks like

All eight steps pass. `npm test && npm run lint` is green. Diff is
limited to:

- `src/client/routes/settings.ts` (~25-30 lines removed),
- `src/client/routes/settings.css` (~30 lines removed),
- `specs/013-remove-sync-button/` (this feature's docs).

No other files are modified.
