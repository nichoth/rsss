# Quickstart: Verify the Up-to-Date Dot Indicator

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This is the manual verification path a reviewer runs after the
implementation lands. It maps directly to the spec's acceptance
scenarios and success criteria. None of these steps require touching
the database directly; everything is observable from the UI plus
DevTools.

## Setup

```bash
npm install
npm start
```

Visit `http://localhost:8888/` and sign in with the dev login
(`/api/auth/dev-login`, exposed only when `NODE_ENV !== 'production'`)
or your Bluesky handle. Confirm:

- Header shows the `<FeedStatus>` pill on the right.
- DevTools -> Network shows exactly one `GET /api/feed-status` call
  fire on page load. (P1 / FR-001 / FR-010 / SC-004.)

## Scenario 1: Page load with pending items shows blue "n updates"

1. Add at least one feed (or use an existing one) and click "Refresh
   Feeds" so the indicator reads green ("up to date").
2. Wait for, or trigger, the DO alarm (or hit the admin
   `/admin/refresh-all` endpoint with `ADMIN_TOKEN`) so the server
   ingests new items.
3. Hard-reload the page.
4. **Expected**: header shows the blue dot and "n updates" with `n`
   equal to the per-feed pending sum returned by
   `/api/feed-status`. (Acceptance 1.1, FR-002, SC-001.)

## Scenario 2: Page load fully caught up shows green "up to date"

1. Click "Refresh Feeds" until the indicator reads green.
2. Reload.
3. **Expected**: green dot, "up to date" label.
   (Acceptance 1.2, FR-003.)

## Scenario 3: Online-only mode behaves identically

1. In Settings, toggle off "Sync subscriptions" (or open in a private
   window where OPFS is unavailable). Confirm `<SyncStatus>` shows
   the "Online only" pill.
2. Repeat Scenarios 1 and 2.
3. **Expected**: identical indicator behavior; the
   single `GET /api/feed-status` still drives the pill.
   (Acceptance 1.3, FR-004.)

## Scenario 4: Live update arrives via SSE

1. With the app open and the indicator green, trigger a feed fetch
   on the server (alarm tick or admin refresh).
2. **Expected**: within a few seconds, no reload, the indicator
   transitions to blue "n updates" with the correct count.
   (Acceptance 2.1, FR-005, FR-006, SC-002.)
3. Trigger another fetch on the same feed (e.g. publish a second
   item upstream) without refreshing.
4. **Expected**: the displayed count grows. (Acceptance 2.2.)

## Scenario 5: SSE reconnect reconciles state

1. With the app open and indicator green, kill connectivity in
   DevTools (`Network` -> Offline).
2. Trigger a server-side feed fetch out-of-band.
3. Restore connectivity (`Online`). Watch the EventSource reconnect.
4. **Expected**: indicator updates to the correct "n updates" without
   a reload, even though the `feed-updates-available` event was
   missed during the outage. (Acceptance 2.3, FR-007.)

## Scenario 6: Refresh Feeds clears the pill

1. With "n updates" showing, click "Refresh Feeds".
2. **Expected**: items appear in the reading list, indicator
   transitions back to green within a few seconds.
   (Acceptance 3.1, FR-008, SC-003.)
3. While refresh is mid-flight, trigger a server-side fetch that
   produces a new item.
4. **Expected**: after the refresh completes, the indicator shows the
   remaining count for the items that arrived after the refresh
   started; it does **not** falsely show "up to date". (Acceptance
   3.2.)

## Scenario 7: Page-load failure does not lie green

1. In DevTools, add a network condition that fails
   `GET /api/feed-status` (e.g. block the URL).
2. Hard-reload.
3. **Expected**: indicator shows the red "sync failed" state with a
   tooltip carrying the error; it is **not** green.
   (Edge case "request fails", FR-012, SC-006.)

## Scenario 8: Multi-tab convergence

1. Open the app in two tabs.
2. Trigger a server-side feed fetch (one new item).
3. **Expected**: both tabs converge to the same "n updates" count
   within a few seconds; refreshing in one tab returns both tabs to
   green (the second tab via SSE `feed-updates-cleared` and the
   reconcile fallback).

## Automated coverage

Run the project test suite:

```bash
npm test && npm run lint
```

These tests are added or updated as part of the feature:

- `test/do-handlers.ts` - `GET /feed-status` returns the correct
  shape for: empty, mixed pending, fully synced.
- `test/feed-status.ts` - `<FeedStatus>` renders blue/green/red for
  the new state transitions.
- `test/feed-status-loader.ts` - `State.loadFeedStatus()` is called
  on auth, on SSE reconnect, on `online`, on `refresh-complete`;
  failure path sets `feedSyncStatus = 'error'`; `feed-updates-
  available` overwrites counts (does not increment) and a `0` value
  removes the entry.
