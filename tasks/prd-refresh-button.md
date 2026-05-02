# PRD: Sync Status Indicator & Manual Refresh

## 1. Introduction / Overview

Add a server-feed sync status indicator to the app header and a corresponding
`/updates` route so users always know whether the feeds they follow have
unpulled updates on the server. Updates are **never** synchronized
automatically -- the user must explicitly click "Refresh Feeds" (existing
sidebar button) or refresh a single feed from `/updates` to pull them.

The server announces pending updates via Server-Sent Events (SSE) and includes
the current sync status in the initial fetch response so the UI is correct
on first paint.

This is independent of the existing `SyncStatus` component (which reflects
local-first DB sync state). The two indicators live side-by-side in the header.

## 2. Goals

- Surface "do I have new things to read?" answer instantly in the header.
- Give users full control over when the client pulls server updates -- no
  silent background sync.
- Provide a dedicated `/updates` route showing exactly which feeds have
  unsynced items, including a preview of those items, with per-feed refresh.
- Push status changes in real time over SSE; ensure first-paint correctness
  via the initial fetch payload.

## 3. User Stories

### US-001: Add server feed-update status signal to client state

**Description:** As a developer, I need a `feedUpdateStatus` signal on
`AppState` so any component can react to whether the user has pending server
updates.

**Acceptance Criteria:**
- [ ] New signal `feedUpdateStatus:Signal<'synced'|'updates'>` added to
      `AppState`.
- [ ] Default value is `'synced'`.
- [ ] Updated via `batch()` when set alongside other signals.
- [ ] Typecheck and lint pass (`npm test && npm run lint`).

### US-002: Include sync status in initial fetch response

**Description:** As a user, I want the indicator to be correct the moment the
app loads, so I don't see a flash of "synced" when there are actually pending
updates.

**Acceptance Criteria:**
- [ ] Server's bootstrap/initial-data endpoint returns
      `feedUpdateStatus:'synced'|'updates'` plus `feedsWithUpdates:string[]`
      (list of feed IDs that have un-synced items for this user).
- [ ] Client hydrates `feedUpdateStatus` and a `feedsWithUpdates` signal from
      that response on app boot.
- [ ] Documented in the relevant API type / response schema.
- [ ] Typecheck and lint pass.

### US-003: Server-side detection of un-synced feed updates

**Description:** As a backend developer, I need the server to know, for each
user, which followed feeds have items the user has not yet pulled, so it can
push notifications and answer the bootstrap query.

**Acceptance Criteria:**
- [ ] Server tracks the user's last-pulled cursor per followed feed.
- [ ] Computes `feedsWithUpdates` as feeds whose latest item is newer than
      the user's cursor.
- [ ] Cursor advances only on successful manual refresh (global or per-feed).
- [ ] Unit tests cover: no updates, partial updates, all-updated states.
- [ ] Typecheck and lint pass.

### US-004: Server pushes feed-update SSE events

**Description:** As a user, I want the indicator to flip to "updates" within
seconds of new content appearing on the server, without me reloading.

**Acceptance Criteria:**
- [ ] New SSE event types on the existing user SSE channel:
      `feed-updates-available` (payload: `{ feedIds:string[] }`) and
      `feed-updates-cleared` (payload: `{ feedIds:string[] }`).
- [ ] Server emits `feed-updates-available` when a fetch/parse cycle finds
      new items for any user-followed feed.
- [ ] Server emits `feed-updates-cleared` when the user's cursor catches up
      (after a successful refresh).
- [ ] Events are scoped to the authenticated user only.
- [ ] Typecheck and lint pass.

### US-005: Client subscribes to update events and updates state

**Description:** As a user, I want my header indicator and `/updates` page
to react in real time as the server detects new feed items.

**Acceptance Criteria:**
- [ ] Client SSE handler listens for `feed-updates-available` and
      `feed-updates-cleared`.
- [ ] On `available`: merges feed IDs into `feedsWithUpdates`; sets
      `feedUpdateStatus.value = 'updates'`.
- [ ] On `cleared`: removes feed IDs; if list empty, sets
      `feedUpdateStatus.value = 'synced'`.
- [ ] Both signal updates wrapped in `batch()`.
- [ ] No automatic call to `refreshFeeds` is triggered.
- [ ] Typecheck and lint pass.

### US-006: Header status component

**Description:** As a user, I want to see "status: synced" or "status: updates"
in the header with a colored dot, so I know at a glance.

**Acceptance Criteria:**
- [ ] New `FeedStatus` component rendered in header to the right of
      existing `SyncStatus`, before logout/user-icon.
- [ ] Renders text `status: synced` or `status: updates`.
- [ ] `Dot` component appears immediately to the left of the text.
- [ ] Dot color: `green` when `synced`, `yellow` when `updates`.
- [ ] When status is `updates`, the word `updates` is an `<a href="/updates">`
      that navigates client-side.
- [ ] When status is `synced`, the word is plain text (no link).
- [ ] Has appropriate `role="status"` and `aria-live="polite"` for screen
      readers.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-007: Add `/updates` client-side route

**Description:** As a user, I want a dedicated page that shows which feeds
have pending updates and what's in them.

**Acceptance Criteria:**
- [ ] New route `/updates` registered in `src/client/routes/index.ts`.
- [ ] New route component `src/client/routes/updates.ts` and
      `updates.css`.
- [ ] Route is in the existing `routes` export so it integrates with router.
- [ ] Route requires logged-in user; anonymous users get redirected to
      `/login` (matching existing protected-route pattern).
- [ ] Renders a heading and a list of feeds with pending updates.
- [ ] Empty state: "All feeds are up to date." when
      `feedsWithUpdates.length === 0`.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-008: `/updates` shows expandable item previews per feed

**Description:** As a user, I want to see the titles of pending items before
I pull them, so I can decide whether the refresh is worth my attention.

**Acceptance Criteria:**
- [ ] Each feed row on `/updates` shows: feed title, count of pending items,
      and a disclosure (collapsed by default).
- [ ] Expanding a feed row reveals titles + publish dates of pending items.
- [ ] Preview data fetched lazily on expand from a server endpoint
      (e.g. `GET /api/feeds/:id/pending`) -- not preloaded for all feeds.
- [ ] Preview list does not insert items into local feed reader state until
      a refresh is performed.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-009: Per-feed refresh button on `/updates`

**Description:** As a user, I want to refresh a single feed without pulling
everything.

**Acceptance Criteria:**
- [ ] Each feed row on `/updates` has a "Refresh" button.
- [ ] Clicking it invokes a per-feed refresh action (e.g.
      `State.refreshFeed(state, feedId)`).
- [ ] On success: server emits `feed-updates-cleared` for that feed; row
      disappears from the list (or shows "up to date").
- [ ] Button shows spinner while in flight; disabled to prevent double-click.
- [ ] If all feeds become up to date, page shows the empty state and header
      flips to `synced`.
- [ ] Errors surface a visible message; row stays in list.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-010: Existing global "Refresh Feeds" sidebar button respects new flow

**Description:** As a user, the existing sidebar "Refresh Feeds" button must
continue to pull all feeds and clear the indicator.

**Acceptance Criteria:**
- [ ] No automatic refresh paths added; `State.refreshFeeds` only runs from
      explicit user click (sidebar) or per-feed click on `/updates`.
- [ ] After a successful global refresh: client clears `feedsWithUpdates`
      and sets `feedUpdateStatus` to `'synced'` in a `batch()`.
- [ ] Server emits `feed-updates-cleared` so other tabs/devices stay in sync.
- [ ] Audit: no calling code calls `refreshFeeds` from a timer, SSE handler,
      visibility change, focus event, or route change.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

## 4. Functional Requirements

- **FR-1:** Client `AppState` must expose `feedUpdateStatus:Signal<
  'synced'|'updates'>` and `feedsWithUpdates:Signal<string[]>`.
- **FR-2:** The initial fetch (bootstrap) response must include
  `feedUpdateStatus` and `feedsWithUpdates` for the authenticated user.
- **FR-3:** The header must render a `FeedStatus` indicator separately from
  the existing `SyncStatus` component (both visible).
- **FR-4:** The `FeedStatus` indicator must render a `Dot` (green for synced,
  yellow for updates) followed by the text `status: synced` or
  `status: updates`. The word `updates` must be a client-side link to
  `/updates`.
- **FR-5:** A new client-side route `/updates` must exist and require an
  authenticated user.
- **FR-6:** The `/updates` route must list each feed with pending updates,
  with expandable previews of pending item titles + publish dates fetched
  on-demand from the server.
- **FR-7:** The `/updates` route must provide a per-feed "Refresh" button
  that pulls only that feed.
- **FR-8:** The existing global "Refresh Feeds" sidebar button remains the
  only global refresh entry point.
- **FR-9:** No code path may automatically pull feed updates -- all syncs
  must originate from a user click (global or per-feed).
- **FR-10:** The server must emit `feed-updates-available` SSE events
  (payload `{ feedIds:string[] }`) when new items are discovered for any
  followed feed, and `feed-updates-cleared` events when the user's cursor
  catches up.
- **FR-11:** The client must subscribe to those SSE events and update
  `feedUpdateStatus` / `feedsWithUpdates` accordingly, using `batch()` for
  combined updates.
- **FR-12:** The server must track per-user, per-feed cursors so it can
  compute the un-synced delta on bootstrap and after each refresh.
- **FR-13:** SSE events must be scoped to the authenticated user only.
- **FR-14:** No SSE polling fallback is required (per scope decision).
- **FR-15:** Anonymous users must not see the `FeedStatus` indicator and
  must be redirected from `/updates` to `/login`.

## 5. Non-Goals (Out of Scope)

- No automatic background sync, alarm-driven refresh, or focus/visibility-
  triggered refresh.
- No SSE polling fallback for browsers without SSE support.
- No replacement of the existing `SyncStatus` component (local-first DB
  sync); the two indicators coexist.
- No notifications outside the app (push, email, badge counts in title).
- No bulk operations on `/updates` beyond the existing global "Refresh Feeds"
  button.
- No partial-refresh of items within a single feed; per-feed refresh pulls
  the whole feed.
- No anonymous-user support for this indicator.

## 6. Design Considerations

- Reuse `Dot` component (`src/client/components/dot.ts`) -- already supports
  `green` and `yellow`.
- New header component should sit in the existing
  `.header.header-right.desktop-nav` group, ordered after `SyncStatus`.
- Mirror the visual language of `SyncStatus` (text + ARIA semantics) for
  consistency.
- `/updates` page should reuse existing list/row styling patterns where
  possible (e.g. `item-row` or `sidebar-item`) rather than introducing new
  ones.
- Per-feed Refresh button should use the existing `Button` component with
  `isSpinning` to match the sidebar behavior.

## 7. Technical Considerations

- The existing client SSE handler in `src/client/state.ts` already listens
  for events like `refresh-complete`; add the new event listeners alongside.
- `State.refreshFeeds` already has safety timeouts and debounce constants;
  do not reuse those for the new SSE flow -- the new events are signal-only,
  not refresh-triggers.
- A new `State.refreshFeed(state, feedId)` action is required for per-feed
  refresh.
- A new server endpoint (e.g. `GET /api/feeds/:id/pending`) is required for
  the previews on `/updates`.
- Server-side cursor storage needs a migration if not already present;
  confirm existing schema before adding.
- The bootstrap/initial-data endpoint must be updated to include the new
  fields; ensure backward compatibility for any older client (none expected
  in production but worth confirming).
- Multi-tab consistency: the `feed-updates-cleared` event ensures that
  refreshing in tab A clears the indicator in tab B.

## 8. Success Metrics

- Header indicator reflects correct state on first paint (no flash).
- Indicator flips from `synced` to `updates` within ~2s of server
  detecting new items.
- After clicking sidebar "Refresh Feeds" or any `/updates` per-feed
  Refresh, indicator returns to `synced` once all updates are pulled.
- Zero automatic refresh calls in the codebase (audit confirmed).
- `/updates` page loads with feed list in <500ms on a warm session.

## 9. Open Questions

- Should the header text show a count when status is `updates`
  (e.g. `status: updates (3)`), or stay minimal? Current spec says minimal.
- Should the per-feed pending-preview endpoint paginate, and if so what
  default page size?
- Do we need to persist `feedsWithUpdates` to local-first storage so the
  indicator survives a reload while offline, or is the bootstrap fetch
  sufficient on every reload?
- Should clicking the `updates` link in the header preserve a "return to"
  reference, or always behave as a plain navigation?
- For the per-feed Refresh button on `/updates`, should success briefly
  show "Refreshed" feedback before the row disappears, or remove silently?
