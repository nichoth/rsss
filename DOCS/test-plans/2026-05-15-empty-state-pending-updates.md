# Human Test Plan — empty-state pending-updates

Generated 2026-05-15 from the empty-state pending-updates implementation
plan and the corresponding test-requirements.md. Automated coverage is
PASS (14/14 ACs covered); this plan covers the human-verification items
that cannot or should not be asserted in code (e.g. literal label text,
end-to-end network behavior, and edge-case judgment).

## Prerequisites

- Local dev: `npm run dev`
- A signed-in user with at least one subscribed feed that has fetchable
  items
- Browser devtools available for Network throttling and Elements
  inspection
- Optional sanity reruns:
  - Phase 1 standalone:
    `npx esbuild ./test/pending-update-empty-state.ts --bundle | npx tapout`
    — expect 19/19 assertions ok (non-zero exit is the documented
    AC2.3 unhandled-rejection limitation)
  - Phase 2 standalone:
    `npx esbuild ./test/feed-reader-pending-updates.ts --bundle
    --alias:cloudflare:workers=./test/cloudflare-workers-stub.ts
    --alias:@sentry/cloudflare=./test/sentry-cloudflare-stub.ts
    --loader:.css=text --loader:.wasm=dataurl | npx tapout`
    — expect 21/21 ok, exit 0
  - `npm test` — expect exit 0

## Phase 1 — Component label text (AC2.1, AC2.2 visible-label portions)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Run `npm run dev`, sign in | App shell loads, sidebar visible |
| 2 | Subscribe to a feed (e.g. `https://hnrss.org/frontpage`) if none exists | Feed appears in sidebar with item count |
| 3 | Mark all items in that feed as read so the items list is empty | Item list shows the existing `No items in <feed title>` empty copy |
| 4 | Force a non-zero pending count: in the console, run `state.feedUpdateCounts.value = { '<feedId>': 3 }` (or wait for the background poller) | `.pending-update-empty-state` replaces the prior empty copy; text reads `3 pending updates` |
| 5 | Re-seed `feedUpdateCounts` so the selected feed has exactly `1` | Visible text reads exactly `1 pending update` (no trailing `s`) |
| 6 | Open devtools → Network, set throttling to "Slow 3G" | Throttling active |
| 7 | Click the "Click to refresh" button | While the request is in flight, the button's visible text reads exactly `Refreshing…` (single horizontal-ellipsis character `…`, not three periods `...`); the button is visibly disabled and not clickable |
| 8 | Wait for the request to settle | Label reverts to exactly `Click to refresh`; button is clickable again |
| 9 | Inspect the rendered DOM | `<button>` inside `.pending-update-empty-state` toggles `disabled` between in-flight and idle; class list contains `btn btn-small` |

## Phase 2 — Per-feed empty + pending → refresh path (AC3.1, AC3.3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a specific feed via the sidebar | Feed-reader view loads; header shows that feed's title |
| 2 | Ensure the items list is empty AND `feedUpdateCounts[<feedId>] > 0` | The `.pending-update-empty-state` appears with the pending count copy and refresh button |
| 3 | Open devtools → Network, filter to fetch/XHR | Network panel ready |
| 4 | Click the refresh button | A single network request fires to the per-feed refresh endpoint (`POST /api/feeds/<id>/refresh` or equivalent). No request fires to a "refresh all feeds" endpoint. After completion, new items appear (if any returned); empty-state disappears; pending count returns to 0 |

## Phase 3 — All Items view → refresh-all path (AC3.2, AC3.4)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to All Items (`/`) so no feed is selected | All Items view; `selectedFeedId` is null |
| 2 | Ensure items list is empty and `Σ feedUpdateCounts > 0` across two or more feeds | `.pending-update-empty-state` appears with the summed count |
| 3 | Open devtools → Network, click the refresh button | A "refresh all feeds" request fires (single fan-out, not one per feed from the client). No per-feed refresh to a specific id |
| 4 | After settle | New items appear; pending counts drop to 0; empty-state disappears |

## Phase 4 — Branch precedence (AC4.1, AC4.2, AC4.3, AC4.4)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Fresh user with zero feeds; seed `state.feedUpdateCounts.value = { '99': 5 }` in console | `.empty-state` shows `Maybe add some feeds to start reading.`; `.pending-update-empty-state` NOT in DOM (no-feeds wins over pending) |
| 2 | Subscribe to a feed; while items are still loading | `.loading-text` ("Loading items...") shown; neither `.empty-state` nor `.pending-update-empty-state` in DOM |
| 3 | After items load, mark all read, ensure per-feed pending=0 | Per-feed: `.empty-state` shows `No items in <feed title>`; component NOT in DOM |
| 4 | Switch to All Items with all feeds read, Σ pending=0 | `.empty-state` shows `No items to show.`; component NOT in DOM |

## Edge cases for human judgment

| Scenario | Steps | Expected |
|----------|-------|----------|
| Rapid double-click during refresh | While throttled, click refresh, then immediately click again before the first request settles | Only one network request fires (re-entrancy guard); button stays disabled until first promise settles |
| Refresh that errors (network 5xx or offline) | Toggle devtools "Offline" mode, click refresh | Button briefly disables, then re-enables; user can retry; existing error UI handles the failure; no silent swallow |
| Count boundary rendering | Seed `feedUpdateCounts` with count=1, 2, 11, 999 | Singular only for exactly `1`; plural otherwise; large numbers render without truncation |
| Component unmounts mid-refresh | Start a slow refresh, click another sidebar feed before it settles | No console errors; no `setState on unmounted` warnings; new view renders correctly |
| Pending count drops to 0 while component visible | Have another tab refresh the same feed | Component disappears (replaced by generic empty copy) on next state update; no stuck state |

## Human verification required

| Criterion | Why manual | Steps |
|-----------|------------|-------|
| AC2.1 (label `Refreshing…`) | House-style forbids asserting HTML text; user-visible string is presentation | Phase 1 Step 7 |
| AC2.2 (label revert `Click to refresh`) | Same constraint | Phase 1 Step 8 |
| AC1.2 (singular vs plural visual) | Boundary text is presentation | Phase 1 Step 5 |

## Traceability

| AC | Automated test | Manual step |
|----|----------------|-------------|
| AC1.1 | `test/pending-update-empty-state.ts:9` | — |
| AC1.2 | `test/pending-update-empty-state.ts:14-27` | Phase 1 Step 5 |
| AC1.3 | `test/pending-update-empty-state.ts:57` | Edge case: rapid double-click |
| AC1.4 | `test/feed-reader-pending-updates.ts:294,342` | Phase 4 Steps 3-4 |
| AC2.1 (disabled) | `test/pending-update-empty-state.ts:100` | — |
| AC2.1 (label) | — | Phase 1 Step 7 |
| AC2.2 (re-enable) | `test/pending-update-empty-state.ts:153` | — |
| AC2.2 (label) | — | Phase 1 Step 8 |
| AC2.3 | `test/pending-update-empty-state.ts:190` | Edge case: error during refresh |
| AC3.1 | `test/feed-reader-pending-updates.ts:103` | Phase 2 Steps 1-4 |
| AC3.2 | `test/feed-reader-pending-updates.ts:180` | Phase 3 Steps 1-4 |
| AC3.3 | `test/feed-reader-pending-updates.ts:103` (args captured) | Phase 2 Step 4 (network panel) |
| AC3.4 | `test/feed-reader-pending-updates.ts:180` | Phase 3 Step 3 (network panel) |
| AC4.1 | `test/feed-reader-pending-updates.ts:252` | Phase 4 Step 1 |
| AC4.2 | `test/feed-reader-pending-updates.ts:294` | Phase 4 Step 3 |
| AC4.3 | `test/feed-reader-pending-updates.ts:342` | Phase 4 Step 4 |
| AC4.4 | `test/feed-reader-pending-updates.ts:392` | Phase 4 Step 2 |
