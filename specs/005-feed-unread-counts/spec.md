# Feature Specification: Per-Feed Unread Counts In Sidebar

**Feature Branch**: `005-feed-unread-counts`
**Created**: 2026-05-03
**Status**: Draft
**Input**: User description: "In the left sidebar, each feed should
have the number of unread articles in that feed to the left of the
feed name."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See Unread Count Per Feed (Priority: P1)

A reader scanning the left sidebar wants to know, at a glance, which
of their subscribed feeds have unread articles waiting and how many.
For every feed entry in the sidebar's feed list, the reader sees a
number to the left of the feed name showing how many articles in that
feed are currently unread. The reader can use this to prioritize
which feed to open next without clicking into each one.

**Why this priority**: This is the entire feature. Today the sidebar
lists every subscribed feed by name only, so the reader cannot tell
which feeds have new material without opening each one. A per-feed
unread count turns the sidebar into a useful triage view and is the
single change the user explicitly asked for.

**Independent Test**: Subscribe to two or more feeds where at least
one has unread items and at least one has none. Open the app and look
at the sidebar. Confirm a number appears to the left of every feed
name, that the number for each feed equals its actual unread article
count, and that a feed with zero unread articles shows a 0 (not
blank and not hidden).

**Acceptance Scenarios**:

1. **Given** a reader subscribed to feed F with U unread articles,
   **When** the reader views the sidebar, **Then** the sidebar entry
   for feed F shows U immediately to the left of the feed's name.
2. **Given** the reader is viewing feed F's articles and marks one
   unread article as read, **When** the action settles, **Then** the
   sidebar entry for F decrements its unread count by 1, and the
   entries for other feeds are unchanged.
3. **Given** a reader has feed F with zero unread articles, **When**
   the reader views the sidebar, **Then** F's sidebar entry shows 0
   to the left of its name (the slot is not blank).
4. **Given** new articles arrive in feed F via background sync,
   **When** the sync completes, **Then** F's sidebar unread count
   increases by the number of newly-arrived unread articles without
   the reader needing to reload the page.
5. **Given** the reader marks an article in feed F as unread again,
   **When** the action settles, **Then** F's sidebar unread count
   increments by 1.
6. **Given** the reader deletes feed F, **When** the sidebar
   re-renders, **Then** F's row (and its count) is gone and other
   feeds' counts are unchanged.
7. **Given** the reader adds a new feed G that initially has no
   fetched articles, **When** the sidebar shows G, **Then** G's
   unread count is 0; once G's first sync completes, G's count
   reflects the unread articles fetched.

---

### Edge Cases

- A feed with zero unread articles shows `0` (not blank, not hidden).
  This keeps the layout stable and confirms to the reader that the
  count is loaded, not missing.
- A feed that has not yet completed its first sync shows `0` until
  articles are fetched, then updates to the real count.
- The "All Feeds" sidebar entry (the pseudo-feed that links to the
  global reading list) is treated like a feed for display purposes:
  it shows an unread count equal to the sum of all subscribed feeds'
  unread counts, also positioned to the left of its name.
- The per-feed unread count is not affected by the global "Unread
  only" reading-list filter — it always represents that feed's
  unread total, independent of which list the reader is currently
  viewing or how it is filtered.
- When the reader is viewing a single feed's page (`/feed/<feed>`)
  and marks items there, only that feed's sidebar count changes;
  every other feed's count is untouched.
- When background sync delivers new items across multiple feeds at
  once, each affected feed's count updates; unaffected feeds do not
  re-render their counts.
- A feed whose count would be unusually large still renders as a
  plain number to the left of the name; there is no truncation rule
  in scope for this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every subscribed feed entry in the sidebar's feed list
  MUST display a numeric unread count for that feed.
- **FR-002**: The unread count MUST appear to the left of the feed's
  name within the sidebar entry.
- **FR-003**: The unread count for a feed MUST equal the number of
  articles in that feed that are currently in the unread state for
  the viewing reader.
- **FR-004**: A feed with zero unread articles MUST display the
  numeral `0` (not blank, not hidden).
- **FR-005**: Marking an article as read MUST decrement that
  article's feed's sidebar unread count by 1, and marking an article
  as unread MUST increment it by 1, without requiring a page reload.
- **FR-006**: When background sync adds new unread articles to a
  feed, that feed's sidebar unread count MUST update to reflect the
  new total without a page reload.
- **FR-007**: Adding a feed MUST cause its row to appear with an
  unread count, and deleting a feed MUST remove its row (and count)
  from the sidebar; other feeds' counts MUST be unaffected.
- **FR-008**: The "All Feeds" sidebar entry MUST display an unread
  count equal to the sum of all subscribed feeds' unread counts,
  positioned to the left of its name, and MUST update under the
  same conditions as individual feed counts (FR-005, FR-006, FR-007).
- **FR-009**: The per-feed unread count MUST be independent of the
  global "Unread only" reading-list filter; toggling that filter
  MUST NOT change any per-feed sidebar count.
- **FR-010**: Per-feed unread counts MUST agree with the underlying
  data whenever the sidebar is in a settled (non-loading) state.

### Key Entities

- **Feed**: A subscribed source of articles. For this feature, the
  attribute of interest is its current unread-article count.
- **Article**: An item belonging to exactly one feed, with a
  read/unread state. The per-feed count tallies articles in the
  unread state grouped by their feed.
- **Sidebar feed entry**: The row in the sidebar that represents a
  single feed (or the "All Feeds" pseudo-feed). It now carries one
  additional visible piece of information: the unread count, shown
  to the left of the name.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of feed entries in the sidebar (including "All
  Feeds") display an unread count to the left of the name in every
  settled sidebar state.
- **SC-002**: For any feed, the sidebar unread count equals the
  number of unread articles attributable to that feed in 100% of
  observed settled states.
- **SC-003**: After the reader marks any single article as read or
  unread, the affected feed's sidebar count and the "All Feeds" sum
  re-agree with the data within one render cycle (no perceived lag).
- **SC-004**: After a background sync that adds new unread articles,
  every affected feed's sidebar count reflects the new total within
  one render cycle of the sync settling, with no manual reload.
- **SC-005**: A reader can answer "which of my feeds have new things
  to read, and roughly how many?" by looking only at the sidebar,
  without opening any feed.

## Assumptions

- The "left of the feed name" placement applies to every row in the
  feed list section of the sidebar, including the "All Feeds" entry.
  This is consistent placement across that list. The existing "All
  Items" and "Starred" rows in the upper section keep their current
  layout and are out of scope for this feature.
- Zero is shown as `0` rather than hiding the count, to keep the
  sidebar layout stable and to make it explicit when a feed has
  nothing new (rather than ambiguous about whether the count
  loaded).
- The count represents the same notion of "unread" that the rest of
  the application already uses for the reading list and for the
  existing "All Items" badge; no new read/unread state is introduced.
- The per-feed unread count is independent of the "Unread only"
  reading-list filter introduced in feature 004. That filter changes
  what the reading list displays; the sidebar feed counts always
  describe the underlying feed totals.
- Visual styling (font, color, spacing, badge vs. plain number) is
  left to implementation as long as the count is clearly readable
  and positioned to the left of the feed name.
- No truncation, abbreviation, or maximum-display cap (e.g. "99+")
  is required for v1; large numbers render as their plain integer
  value.
