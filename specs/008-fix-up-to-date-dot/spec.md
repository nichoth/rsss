# Feature Specification: Fix Up-to-Date Dot Indicator

**Feature Branch**: `008-fix-up-to-date-dot`
**Created**: 2026-05-05
**Status**: Draft
**Input**: User description: "Need to fix the dot/'up to date' indicator in the app. When the page loads, the client should fetch the status of each feed vs the local DB state. If there is no local DB (online-only mode), then the GUI should show a blue dot + 'n updates' if the UI state is behind the server state for any feeds. This should happen in a single request at page load time. After the page has loaded, the server should send SSEs to the client if a feed gets an update. Then the user will know to click 'refresh feeds', which will pull the updates to the client."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Returning reader sees accurate "n updates" pill on page load (Priority: P1)

A reader opens the app after being away (minutes, hours, or days). The header indicator should immediately and correctly reflect whether any of their subscribed feeds have items they have not yet pulled into their reading list.

If the indicator is green ("up to date"), the reader can trust that there is genuinely nothing new waiting. If it is blue with a count ("n updates"), the reader knows clicking "Refresh Feeds" will surface new items.

**Why this priority**: Core trust signal for the entire app. Today the dot can show "up to date" in situations where the reader actually has pending items waiting for them, which silently hides content and undermines confidence in the indicator. Without P1, the rest of the indicator behavior (live updates, refresh-clears-dot) is moot because the starting state is wrong.

**Independent Test**: Sign in fresh, ensure at least one subscribed feed has new items on the server beyond what the client has pulled, load the page, confirm the indicator shows the blue "n updates" pill with the correct total count. Conversely: load the page when the client is fully caught up, confirm green "up to date".

**Acceptance Scenarios**:

1. **Given** a reader has subscribed feeds and the server has new items the reader has not yet pulled into their reading list, **When** the reader loads the app, **Then** the header shows a blue dot with the label "n updates" where n equals the total count of unpulled items across all feeds.
2. **Given** a reader's client is fully caught up to the server's per-feed state, **When** the reader loads the app, **Then** the header shows a green dot with the label "up to date".
3. **Given** a reader is in online-only mode (no local cache), **When** the reader loads the app, **Then** the indicator state is computed by comparing the in-memory client state to the server state and behaves identically to the local-DB case.
4. **Given** the reader is loading the app, **When** the page initializes, **Then** the indicator status is determined from a single round-trip request — not one request per feed.

---

### User Story 2 - Live update arrives while reader has the app open (Priority: P2)

A reader has the app open and is reading. A subscribed feed publishes a new item; the server detects it. The indicator should transition from green "up to date" to blue "n updates" without the reader having to reload the page.

**Why this priority**: Important for an "always-open" reading experience but strictly less critical than P1 — without P1, the live-update transition is unreliable because the starting point is wrong. P2 lets the indicator stay accurate over time once the page is open.

**Independent Test**: Load the app while caught up (green dot). Trigger the server to detect a new item on one of the reader's feeds. Without reloading, observe the indicator transition to blue with the correct count, within a few seconds.

**Acceptance Scenarios**:

1. **Given** the reader has the app open with the indicator showing "up to date", **When** the server detects new items on a subscribed feed, **Then** the indicator transitions to "n updates" with the new total within seconds, without a page reload.
2. **Given** the reader has the app open and the indicator already shows "n updates", **When** the server detects more new items, **Then** the displayed count increases to reflect the new total.
3. **Given** the reader has the app open and the live update channel disconnects then reconnects, **When** the connection is re-established, **Then** the indicator reconciles with the current server state (re-fetching status if needed) so it does not display stale information.

---

### User Story 3 - Refreshing feeds clears the pending indicator (Priority: P2)

When the indicator shows "n updates" and the reader clicks "Refresh Feeds", the new items are pulled into the reader's view and the indicator returns to "up to date".

**Why this priority**: Closes the loop on the indicator's contract. The reader needs an obvious way to act on the prompt and see the prompt resolve — otherwise the pill feels broken even when it is correctly raised.

**Independent Test**: Load the app with the indicator showing "n updates". Click "Refresh Feeds". Observe the new items appear in the reading list and the indicator return to "up to date" with no remaining count.

**Acceptance Scenarios**:

1. **Given** the indicator shows "n updates" and there are no further updates pending on the server, **When** the reader clicks "Refresh Feeds" and the pull completes, **Then** the indicator shows "up to date".
2. **Given** the indicator shows "n updates" and additional updates arrive on the server during the refresh, **When** the pull completes, **Then** the indicator shows the remaining count for items pulled in after the refresh started (it does not falsely show "up to date").
3. **Given** the reader's refresh fails partially (some feeds error), **When** the reader is shown sync-failed state, **Then** the indicator reflects an error state rather than a misleading "up to date".

---

### Edge Cases

- The reader has zero subscribed feeds: the indicator shows "up to date" (no feeds means nothing can be behind).
- The reader's connection is offline at page load: the indicator shows the last-known state from local cache (if available) or a clearly distinguished offline state, and reconciles when connectivity returns.
- A feed is newly added and has never been pulled: the indicator counts every item on that feed as pending until the reader refreshes.
- The single page-load status request fails (network error, server 5xx): the indicator does not silently fall back to "up to date"; it should show an error or unknown state instead of misleading green.
- A live-update notification arrives for a feed the reader has already unsubscribed from: it must not affect the indicator.
- The reader has the app open in two tabs simultaneously: both tabs should converge to the same indicator state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On every page load, the client MUST determine the indicator state from a single round-trip request that returns per-feed comparison data between the client's state and the server's state.
- **FR-002**: When that comparison shows the client is behind the server on at least one feed, the indicator MUST display a blue dot with the label "n updates", where n is the total count of items the client has not yet pulled across all feeds.
- **FR-003**: When the client is fully caught up to the server on every feed, the indicator MUST display a green dot with the label "up to date".
- **FR-004**: The behavior in FR-001 through FR-003 MUST apply identically whether the client uses a local cache or operates in online-only mode (the comparison source on the client side may differ, but the resulting indicator state is the same).
- **FR-005**: After the initial page load, the server MUST notify connected clients in near-real-time when a subscribed feed receives new items, without requiring the client to poll.
- **FR-006**: When the client receives such a notification, it MUST update the indicator's count and color without performing a full page reload.
- **FR-007**: When the live-update channel is disconnected and later reconnected, the client MUST reconcile indicator state with the server (e.g., by re-running the page-load status comparison) so it cannot display stale information.
- **FR-008**: When the reader clicks "Refresh Feeds" and the pull completes successfully with no remaining pending items, the indicator MUST return to "up to date".
- **FR-009**: When a refresh fails or partially fails, the indicator MUST reflect an error or sync-failed state rather than showing "up to date".
- **FR-010**: The status-on-load request MUST NOT scale with the number of subscribed feeds (no per-feed request fan-out from the client).
- **FR-011**: The indicator MUST treat newly subscribed feeds (never pulled) as having pending updates equal to the items the server holds for that feed.
- **FR-012**: When the page-load status request fails, the indicator MUST surface an error or unknown state — it MUST NOT silently default to "up to date".

### Key Entities

- **Feed**: An RSS/Atom subscription tied to the reader. For the indicator, the relevant attributes are its identifier, its server-side item count (or latest-item marker), and the reader's per-feed pulled-state marker.
- **Pulled-state marker**: A per-feed indicator of how far the reader's client has pulled items into its view. The marker is the basis for "is the client behind on this feed?"
- **Update notification**: A server-pushed event describing one or more feeds that have gained new items the connected client has not yet pulled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a reader who has been away from the app re-opens it and the server holds new items on at least one of their feeds, the correct "n updates" pill (with accurate count) is visible within 2 seconds of page load — measured across 95% of sessions.
- **SC-002**: When a subscribed feed gains new items while the reader has the app open, the indicator updates to reflect the new count within 5 seconds of the server detecting the change — without the reader interacting.
- **SC-003**: After the reader clicks "Refresh Feeds" with no concurrent server-side updates, the indicator returns to "up to date" within 3 seconds of refresh completion in 95% of cases.
- **SC-004**: Page load issues exactly one indicator-status request regardless of feed count (verified at any subscription size from 0 to 500 feeds).
- **SC-005**: Zero false "up to date" states observed in user-acceptance testing — if the reader is genuinely behind on any feed, the indicator never lies green.
- **SC-006**: When the page-load status request fails, the indicator visibly reflects the failure within 3 seconds and never displays a misleading "up to date".

## Assumptions

- The server is the authoritative source for "what items exist on each subscribed feed". The client's role is to consume that state, not to discover upstream items independently.
- The "client state" used in the comparison is the reader's per-feed pulled marker — i.e., how far they have pulled items into their reading list. Items the reader has read but not yet purged are still considered "pulled".
- Online-only mode means there is no persistent client cache, but the running session still maintains an in-memory view of what items it has loaded; that view supplies the client side of the comparison.
- "Refresh Feeds" remains the user-facing primitive for pulling pending items into the reader's view; this feature does not change refresh semantics, only the indicator.
- The set of subscribed feeds is small enough that the server can produce per-feed comparison data for a single user in one request without performance concern (matching today's account scales).
- Live update notifications are best-effort over an existing real-time channel; the reconcile-on-reconnect requirement (FR-007) is the safety net for missed events.
- "Behind" means the server holds items the client has not yet pulled. It does not mean the client has missed reading items already in its reading list.
- Per-feed counts in the sidebar are out of scope for this spec except where they share data with the global indicator; this feature focuses on the global header indicator's correctness.
