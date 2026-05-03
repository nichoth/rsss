# Feature Specification: Sync "All Items" Count With Unread-Only Filter

**Feature Branch**: `004-unread-only-count`
**Created**: 2026-05-02
**Status**: Draft
**Input**: User description: "The 'All Items' number should update when I
check the 'unread only' checkbox, because there is a smaller number of
feeds visible."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Count Reflects Active Filter (Priority: P1)

A reader viewing their reading list sees a numeric badge next to the
"All Items" entry in the sidebar. When the reader toggles the "Unread
only" filter on the reading list, that badge MUST change to reflect the
size of the list that is now visible: the total of all items when the
filter is off, and the count of unread items when the filter is on.
The badge and the visible reading list MUST agree at all times.

**Why this priority**: This is the entire feature. Today the badge
shows a single fixed value regardless of the filter, so the number a
reader sees in the sidebar contradicts the list they are looking at.
That is a basic credibility problem for any counter in the UI and is
the thing the reader explicitly noticed.

**Independent Test**: With at least one read and one unread item in
the reading list, open the app, observe the number on the "All Items"
sidebar entry, toggle the "Unread only" checkbox, and confirm the
number changes to match the count of items now showing in the list.
Toggle it back off and confirm the number returns to the full total.

**Acceptance Scenarios**:

1. **Given** a reader with N total items, of which U are unread, and
   "Unread only" is unchecked, **When** the reader looks at the
   sidebar, **Then** the "All Items" badge shows N (matching the
   visible list).
2. **Given** the same reader with "Unread only" unchecked, **When**
   the reader checks "Unread only", **Then** the "All Items" badge
   updates to U (matching the visible list).
3. **Given** the reader has "Unread only" checked, **When** the reader
   unchecks it, **Then** the "All Items" badge returns to N.
4. **Given** the reader has "Unread only" checked and U > 0, **When**
   the reader marks one of the visible items as read, **Then** the
   "All Items" badge decrements by 1 and the item disappears from the
   visible list, and both numbers stay in agreement.
5. **Given** the reader has "Unread only" unchecked, **When** the
   reader marks an item as read, **Then** the visible list still
   contains that item and the "All Items" badge stays at N.

---

### Edge Cases

- When there are zero items at all, the "All Items" badge shows 0
  regardless of the filter state.
- When there are zero unread items and the reader checks "Unread only",
  the "All Items" badge shows 0 and the reading list is empty; both
  agree.
- When the reader is on a single-feed route (`/feed/<feed>`) the "All
  Items" sidebar entry is not the active selection; its badge still
  represents the global reading list (all feeds), not the currently
  visible feed. The filter still applies to that global value, so the
  badge reads N (total) when "Unread only" is off and U (unread) when
  it is on, even when the reader is looking at a single feed.
- When new items arrive in the background (via sync), the badge MUST
  re-evaluate against the same filter rule so it stays in step with
  the reading list.
- The "Starred" sidebar entry is unaffected by the "Unread only"
  filter; its badge MUST continue to show the starred count.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The "All Items" sidebar entry MUST display a numeric
  badge whose value reflects the size of the corresponding visible
  reading list under the current "Unread only" filter state.
- **FR-002**: When the "Unread only" filter is OFF, the "All Items"
  badge MUST display the total count of items in the reader's reading
  list across all feeds.
- **FR-003**: When the "Unread only" filter is ON, the "All Items"
  badge MUST display the count of unread items in the reader's
  reading list across all feeds.
- **FR-004**: Toggling the "Unread only" filter MUST cause the "All
  Items" badge to update without requiring a page reload or other
  navigation.
- **FR-005**: Marking items as read or unread MUST keep the "All
  Items" badge in agreement with the currently visible reading list
  size under the active filter.
- **FR-006**: The "Starred" sidebar entry's badge MUST continue to
  display the starred-item count and MUST NOT be affected by the
  "Unread only" filter.
- **FR-007**: The displayed badge value MUST agree with the visible
  reading list size at all times the reading list is in a settled
  (non-loading) state.

### Key Entities

- **Reading list item**: The unit being counted. Each item has a
  read/unread state and a starred state. The badge tallies items only;
  it does not tally feeds.
- **Filter state**: The on/off value of the "Unread only" control,
  which restricts the visible reading list to unread items.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a reading list containing both read and unread items,
  toggling "Unread only" causes the "All Items" badge value to change
  100% of the time.
- **SC-002**: The "All Items" badge value equals the number of items
  currently rendered in the reading list (across pages) in 100% of
  observed states after the list has finished loading.
- **SC-003**: After marking any single item as read or unread, the
  "All Items" badge re-agrees with the visible reading list within
  one render cycle (no perceived lag for the reader).
- **SC-004**: A reader can answer the question "how many items am I
  looking at?" using the sidebar number alone, without scrolling
  through or counting the list.

## Assumptions

- The "All Items" sidebar entry is the only counter in scope. The
  per-feed sidebar entries (e.g., individual feed names) are out of
  scope for this change; their visual treatment, if any, is not
  changed by this feature.
- The "All Items" entry counts items across all feeds in the reader's
  reading list, not the currently selected feed. This matches the
  current semantics of that sidebar entry.
- The "Unread only" filter is the only filter that affects this
  badge. The "Starred only" filter is owned by the "Starred" sidebar
  entry and is out of scope here.
- "Items in the reading list" means items the reader can currently
  see and page through under the existing reading-list rules
  (including the existing deferral of newly-fetched items until a
  manual refresh, which is unchanged by this feature).
- The total count and unread count are both available from existing
  data; no new data needs to be persisted.
