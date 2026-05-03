# Feature Specification: Defer New Feed Items Until Refresh

**Feature Branch**: `003-defer-new-feed-items`
**Created**: 2026-05-02
**Status**: Draft
**Input**: User description: "UX improvement: when I add a new feed, as soon as I click 'add' the client UI updates with new feed items. That should not happen. I should click add, and then the count of updates should update and tell me that I have N un-synced posts. Then after I click 'refresh feeds' button, then the GUI should update to show the new articles in the list."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Adding a feed surfaces posts in the un-synced counter, not the reading list (Priority: P1)

When the reader adds a new feed via the "Add" form, the application should record that the feed has been added and stage all of that feed's posts as "un-synced". The reading list (main article view) must NOT change to display the new posts until the reader explicitly chooses to sync. Instead, the existing un-synced posts indicator (the small blue dot with a count, shown in the header area) should reflect the additional pending posts contributed by the newly added feed.

**Why this priority**: This is the core defect described by the user. Today the reading list jumps immediately when a feed is added, which is jarring and breaks the established mental model that "Refresh Feeds" is the action that brings new content into the list. Without fixing this, all other behaviors in this feature are moot.

**Independent Test**: Open the app, note the current contents of the reading list and the value of the un-synced counter. Add a new feed that has at least one item. Verify that the reading list contents are visually unchanged immediately after the "Add" action completes, and that the un-synced counter increases by the number of items the new feed contributes. Delivers immediate UX value as a self-contained MVP.

**Acceptance Scenarios**:

1. **Given** the reader has the application open with a reading list showing a fixed set of articles and the un-synced counter shows N, **When** the reader successfully adds a new feed that contains M new posts, **Then** the reading list contents remain visually unchanged and the un-synced counter shows N + M.
2. **Given** the reader has the application open and the un-synced counter is hidden because there are no pending updates, **When** the reader successfully adds a new feed with at least one post, **Then** the un-synced counter becomes visible and reflects the count of posts contributed by the newly added feed.
3. **Given** the reader successfully adds a feed, **When** the system finishes recording the feed but before the reader clicks "Refresh Feeds", **Then** the sidebar list of subscribed feeds shows the new feed (so the reader can see the subscription took effect) but no posts from that feed are inserted into the reading list.
4. **Given** the reader adds a feed whose URL points to a source with zero current posts, **When** the add operation completes, **Then** the un-synced counter remains unchanged and the reading list remains unchanged.

---

### User Story 2 - "Refresh Feeds" promotes the un-synced posts (including from newly added feeds) into the reading list (Priority: P1)

After adding one or more feeds and accumulating un-synced posts, the reader clicks the "Refresh Feeds" button. The application must perform the existing refresh action and, when refresh completes, the reading list must be updated to include the previously un-synced posts (including those contributed by feeds added during this session). The un-synced counter must then return to zero (or hide).

**Why this priority**: The whole point of deferring the visual update is to give the reader a single, predictable trigger ("Refresh Feeds") for content changes. If the refresh doesn't actually surface the deferred posts, the deferral becomes a regression rather than an improvement. Tied with US1 because together they form the minimum viable change.

**Independent Test**: Add a feed (US1 already verified), confirm the un-synced counter reflects the new posts and the reading list is unchanged. Click "Refresh Feeds". After refresh completes, verify the reading list now contains the new feed's posts in the correct chronological position and the un-synced counter has cleared.

**Acceptance Scenarios**:

1. **Given** the reader has just added a feed and the un-synced counter shows N posts pending (all from the newly added feed), **When** the reader clicks "Refresh Feeds" and the refresh completes successfully, **Then** the reading list shows the N additional posts in their correct chronological positions and the un-synced counter clears to zero.
2. **Given** the reader had M un-synced posts from previously subscribed feeds plus N un-synced posts from a feed they just added, totaling M + N pending, **When** the reader clicks "Refresh Feeds" and refresh completes, **Then** the reading list displays all M + N posts in chronological order and the un-synced counter clears to zero.
3. **Given** the reader adds a feed and the un-synced counter shows N pending posts, **When** the "Refresh Feeds" action is in progress, **Then** the sync status indicator shows the existing "syncing" visual state until refresh completes.
4. **Given** the reader adds a feed but never clicks "Refresh Feeds", **When** the reader leaves and later returns to the app in a new session, **Then** the deferred posts are surfaced according to the application's existing rules for cross-session un-synced posts (i.e., this feature does not invent a new persistence story; it reuses the existing un-synced-post mechanism).

---

### User Story 3 - Sync status indicator reflects "updates available" after a feed is added (Priority: P2)

The header sync status indicator (the pill/dot that today distinguishes "synced", "syncing", "updates available", etc.) must enter the "updates available" visual state immediately after a feed is successfully added that contributes at least one un-synced post. This gives the reader a visual cue, consistent with the existing un-synced behavior for other feeds, that there is something to refresh.

**Why this priority**: This is a polish behavior that ensures the new flow is consistent with the existing "updates available" UX. The application already changes the sync status indicator when the "updates available" condition occurs in other contexts; adding a feed should produce the same visual state. P2 because US1 and US2 cover the user-visible primary flow; this story is necessary for consistency but slightly less critical.

**Independent Test**: With the sync status indicator in the "synced" state, add a new feed. Verify that the indicator transitions to the "updates available" state and the un-synced counter dot becomes visible (or updates). Click "Refresh Feeds" and verify the indicator returns to "synced" after the refresh completes.

**Acceptance Scenarios**:

1. **Given** the sync status indicator currently shows "synced" and the un-synced counter is empty, **When** the reader adds a new feed that has at least one post, **Then** the indicator transitions to the "updates available" visual state.
2. **Given** the sync status indicator already shows "updates available" because there were previously un-synced posts, **When** the reader adds another new feed, **Then** the indicator remains in the "updates available" state and the counter increases by the new feed's contribution.

---

### Edge Cases

- **Adding a duplicate feed**: When the reader submits a URL for a feed they are already subscribed to, the application returns the existing duplicate response. In that case the reading list MUST NOT change and the un-synced counter MUST NOT change, since no new content is added.
- **Add operation fails**: When the add operation fails (network error, invalid feed URL, server rejection), the reading list MUST NOT change, the un-synced counter MUST NOT change, and the existing add-feed error message UX is preserved.
- **Add succeeds but no items are returned for the feed**: The reading list and counter are unchanged. The sidebar shows the new feed (subscription succeeded) but with a count of zero pending posts.
- **Reader adds multiple feeds in rapid succession before clicking "Refresh Feeds"**: All un-synced posts from all newly added feeds accumulate into the counter. A single click on "Refresh Feeds" surfaces all of them at once.
- **A background update arrives between "Add" and "Refresh Feeds"**: Any additional un-synced posts surfaced by background updates during this window are added to the counter and held back from the reading list, the same way as in the existing un-synced flow. They are surfaced together with the newly added feed's posts on the next refresh.
- **Reader navigates away from the reading list (e.g., to settings) and returns after adding a feed but before refreshing**: The reading list still does not include the new feed's posts on return. The counter still reflects the pending count. (This is the normal behavior of the existing un-synced flow; we are reusing it.)
- **The newly added feed's items are older than what the reading list currently shows**: After "Refresh Feeds", those items are inserted into the reading list at their correct chronological positions (which may be off-screen for the reader's current scroll position). This is the existing behavior of refresh and is not changed by this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST treat posts contributed by a newly added feed as "un-synced" by default, identical in behavior to posts surfaced through the existing "updates available" mechanism.
- **FR-002**: After a successful "add feed" operation, the application MUST NOT modify the visible contents of the reading list until the reader explicitly triggers a refresh.
- **FR-003**: After a successful "add feed" operation that contributes at least one post, the un-synced posts counter MUST increase by the number of posts contributed by that feed.
- **FR-004**: After a successful "add feed" operation, the sidebar list of subscribed feeds MUST be updated to include the new feed so the reader has confirmation that the subscription was added.
- **FR-005**: When the reader clicks "Refresh Feeds", the application MUST surface all currently un-synced posts (including any contributed by feeds added in the same session) into the reading list and clear the un-synced counter to zero on successful completion.
- **FR-006**: After a successful "add feed" operation that contributes at least one post, the sync status indicator MUST reflect the "updates available" visual state if it is not already in a more dominant state (e.g., "syncing", "error", "offline").
- **FR-007**: When an "add feed" operation fails or the feed is a duplicate, the application MUST NOT change the reading list, the un-synced counter, or the sync status indicator.
- **FR-008**: The application MUST preserve the existing error and success messaging in the add-feed form (i.e., this feature does not change how add-feed errors are communicated to the reader).
- **FR-009**: The application MUST preserve the existing per-feed unread count behavior in the sidebar (i.e., the sidebar's per-feed counts may update to reflect the new feed's post count without affecting the reading list).

### Key Entities

- **Reading List**: The main central article view the reader sees. The set of posts currently rendered. This must change only as a result of explicit refresh actions.
- **Un-synced Counter**: The header indicator (small dot with a numeric badge) that communicates how many posts are pending and waiting to be surfaced into the reading list. This already exists for posts surfaced via SSE updates; this feature extends it to include posts from newly added feeds.
- **Sync Status Indicator**: The header pill that conveys the overall sync state (synced / syncing / updates available / error / offline). This already exists; this feature changes the trigger conditions so that adding a feed places it in "updates available".
- **Subscribed Feed**: An entry in the sidebar list of feeds the reader follows. Adding a feed adds an entry here immediately on success.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a reader adds a new feed, 100% of the reader's open sessions show no change to the reading list contents until the reader explicitly clicks "Refresh Feeds".
- **SC-002**: After a reader adds a new feed that contributes N posts, the un-synced counter accurately reflects N additional posts within 1 second of the add operation completing.
- **SC-003**: After a reader clicks "Refresh Feeds" following an add, the reading list reflects the deferred posts and the un-synced counter clears within the time it takes the existing refresh action to complete (no slower than today's refresh).
- **SC-004**: 0% of acceptance test scenarios exhibit a visible change in the reading list between the "Add" click and the "Refresh Feeds" click.
- **SC-005**: When tested with a feed that has zero new items, 0% of test runs show any change in the reading list or the un-synced counter.
- **SC-006**: Behavior for failed and duplicate add-feed operations is unchanged from current behavior, validated by re-running the existing add-feed error scenarios with no regressions.

## Assumptions

- The application already has an "un-synced posts" mechanism (the counter dot and the "updates available" status) that today is driven by background update notifications. This feature extends that mechanism to also be driven by the local "add feed" action; it does not introduce a new mechanism.
- "Refresh Feeds" is the only reader-initiated trigger for promoting un-synced posts into the reading list. Background refreshes that today complete a refresh automatically continue to do so (this feature does not change background-driven refresh behavior).
- The sidebar list of subscribed feeds is allowed to update immediately on add, since the sidebar is conceptually about subscriptions, not about the article content being read.
- The per-feed unread count shown in the sidebar may update immediately to reflect the new feed's post count. This does not contradict the goal — the reading list (the main reading surface) is what must remain stable until refresh.
- "Posts contributed by a newly added feed" is interpreted as the set of items the system records for that feed at the time the add is processed. If the system later discovers more items for that feed via a background sync, those additional items follow the existing un-synced mechanism (counter increases, deferred until refresh).
- This feature does not require new persistence: the existing storage of the subscribed feed and its items is sufficient. Only the rule for when those items appear in the reading list changes.
