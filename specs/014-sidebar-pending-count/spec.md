# Feature Specification: Per-Feed Pending Count In Sidebar

**Feature Branch**: `014-sidebar-pending-count`
**Created**: 2026-05-09
**Status**: Draft
**Input**: User description: "I want to add the number of pending, or
non-downloaded new items to the left sidebar underneath where it says
'feeds'. Should add the number of pending items in parentheses before
the blog name. So for example 'Wired' blog with 3 un-synced articles
would be '(3) Wired'"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See Pending Count Per Feed In Sidebar (Priority: P1)

A reader scanning the left sidebar wants to know, at a glance, which
of their subscribed feeds have new items waiting to be pulled into the
reading list. For every feed in the sidebar that currently has one or
more pending (un-synced, not-yet-downloaded) items, the reader sees
the pending count in parentheses immediately before the feed name —
for example, a feed named "Wired" with 3 pending items shows as
"(3) Wired". When a feed has no pending items, the parenthesized
prefix is not shown and the feed name appears on its own.

**Why this priority**: This is the entire feature. The reader already
has an aggregate "updates available" pill in the header showing total
pending items across all feeds, but cannot tell which specific feeds
contributed to that total without clicking refresh. Surfacing the
per-feed pending count in the sidebar lets the reader decide whether
the pending batch is interesting enough to refresh — and which feeds
will change when they do. This is the single change the user asked
for.

**Independent Test**: Subscribe to two or more feeds, then trigger a
state where at least one feed has pending items (for example, by
adding a new feed that has items, or by waiting for a background poll
to discover new items in an existing feed). Open the app and look at
the sidebar. Confirm that every feed with pending items shows
"(N) feedName" where N is the number of pending items, and every feed
with zero pending items shows just "feedName" with no parenthesized
prefix. Click "Refresh Feeds"; confirm all parenthesized prefixes
disappear once the refresh completes.

**Acceptance Scenarios**:

1. **Given** the reader is subscribed to feed F with P pending items
   (P > 0), **When** the reader views the sidebar, **Then** F's
   sidebar entry shows the prefix "(P) " immediately before the feed
   name (or URL when there is no title), with a single space between
   the closing paren and the name.
2. **Given** the reader is subscribed to feed F with zero pending
   items, **When** the reader views the sidebar, **Then** F's sidebar
   entry shows the feed name with no parenthesized prefix at all
   (the slot is absent, not shown as "(0) ").
3. **Given** the reader has feeds with pending counts shown, **When**
   the reader clicks "Refresh Feeds" and the refresh completes
   successfully, **Then** all parenthesized prefixes disappear from
   the sidebar at the same moment the existing aggregate "updates"
   indicator clears.
4. **Given** a background poll discovers new items in feed F (without
   any user action), **When** the per-feed pending counts update,
   **Then** F's sidebar entry gains or updates its "(N) " prefix
   without the reader needing to reload the page.
5. **Given** the reader adds a new feed G that contributes M pending
   items (M > 0), **When** the add operation completes, **Then** G
   appears in the sidebar with prefix "(M) " before its name (per the
   existing "defer new feed items" behavior — items remain pending
   until refresh).
6. **Given** feed F has a multi-digit pending count (e.g. 153),
   **When** the reader views the sidebar, **Then** the prefix renders
   fully ("(153) feedName") without truncating the count and without
   pushing the feed-name text or the delete control off-screen on a
   typical desktop sidebar width.
7. **Given** the reader deletes feed F from the sidebar, **When** the
   sidebar re-renders, **Then** F's row (and its prefix) is gone and
   no other feed's prefix changes.

---

### Edge Cases

- **Feed with no title**: Some feeds in the sidebar are rendered using
  their URL because the feed has no `title`. The parenthesized prefix
  appears before the URL the same way: "(N) https://example.com/feed".
- **Very long feed name**: When a feed name is long enough to truncate
  on the sidebar's available width, the parenthesized prefix must
  remain fully visible at the start of the line; any truncation must
  fall on the feed name, not on the count.
- **Pending count for a feed not (yet) in the sidebar**: If the server
  reports a pending count for a feed the client does not yet know
  about (e.g. just-added in another tab, not yet replicated), the
  prefix is simply not rendered on this client until the feed itself
  appears in the sidebar. (This matches the existing client-side rule
  for the aggregate "updates available" payload.)
- **Pending count drops to zero between renders**: When a feed's
  pending count transitions from N>0 to 0 (e.g. via refresh), the
  prefix is removed in the same render pass that removes the
  contribution from the aggregate counter — the two indicators must
  not visibly disagree.
- **"All Feeds" row**: The "All Feeds" pseudo-row at the top of the
  feed list does not get a parenthesized prefix. The aggregate pending
  count is already surfaced by the existing header "updates available"
  indicator and is not duplicated here.
- **No feeds at all**: When the user has no subscribed feeds, the
  feature has no effect (no rows to prefix).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: For every subscribed feed shown in the left sidebar's
  feeds list, the system MUST render a parenthesized pending-count
  prefix of the form `(N) ` immediately before the feed's display
  name when the feed's current pending count `N` is greater than zero.
- **FR-002**: The system MUST omit the parenthesized prefix entirely
  for feeds whose current pending count is zero or undefined; such
  feeds render with the feed name only, with no leading "(0) " and
  no empty parentheses placeholder.
- **FR-003**: The pending count rendered for each feed MUST be the
  same per-feed pending value the client already uses to drive the
  aggregate "updates available" indicator, so the sum of all visible
  per-feed prefixes equals the aggregate count at any given moment.
- **FR-004**: When per-feed pending counts change at runtime (via
  background poll, feed add, or any other mechanism that already
  updates the per-feed pending state), the sidebar prefixes MUST
  reflect the new values without requiring a page reload.
- **FR-005**: When the reader successfully refreshes feeds, all
  pending-count prefixes MUST clear at the same moment the existing
  aggregate "updates available" indicator clears (no visible
  intermediate state where the aggregate has cleared but a per-feed
  prefix remains, or vice-versa).
- **FR-006**: The prefix MUST appear before the feed's display name
  in the same row, in normal reading order, and MUST NOT replace,
  reorder, or visually conflict with the existing per-feed unread
  count badge or the per-row delete control.
- **FR-007**: The "All Feeds" pseudo-row at the top of the feed list
  MUST NOT receive a parenthesized prefix; the existing aggregate
  indicator covers that case.
- **FR-008**: The prefix MUST be readable by assistive technology as
  part of the same row as the feed name (for example, screen readers
  should announce something equivalent to "3 pending, Wired" rather
  than producing a confusing or out-of-order reading).

### Key Entities

- **Feed (sidebar row)**: Represents a single subscribed feed shown
  in the sidebar. Already has: identifier, display title (with URL
  fallback), unread count badge, delete control. This feature adds a
  surfaced *pending count* attribute, derived from existing client
  state, displayed as a parenthesized prefix when greater than zero.
- **Pending count (per feed)**: An integer ≥ 0 representing the
  number of items in this feed that have arrived from the server (or
  been discovered by background poll) but have not yet been promoted
  into the reader's article list. This already exists in the client's
  state and is the same value driving the existing aggregate
  "updates available" indicator; this feature only changes how it is
  rendered.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any reader with at least one feed that currently
  has pending items, the sidebar visibly identifies which specific
  feeds contributed to the aggregate "updates available" count
  without the reader taking any action — measurable by inspection in
  100% of cases where pending items exist.
- **SC-002**: The sum of pending counts shown across all per-feed
  sidebar prefixes equals the value displayed by the existing
  aggregate "updates available" indicator at every observable
  rendering moment (no visible drift).
- **SC-003**: When the reader clicks "Refresh Feeds", every per-feed
  prefix and the aggregate indicator clear within the same UI update,
  with no flicker where one indicator shows pending and the other
  shows clear.
- **SC-004**: A returning reader can identify, in under 2 seconds of
  looking at the sidebar, which of their feeds have new items waiting
  — verifiable by user observation against today's baseline where the
  same task requires clicking refresh and scanning the reading list
  to infer the answer.
- **SC-005**: The change introduces no measurable regression in
  sidebar rendering time on a feed list of up to 200 subscribed feeds
  (rendering remains visually instantaneous on the user's current
  devices).

## Assumptions

- The per-feed pending count required to render this prefix is
  already maintained in client state (`feedUpdateCounts` keyed by
  feed ID), populated by the same server SSE channel that drives the
  aggregate "updates available" indicator. This feature is therefore
  UI-only: no new server endpoint, no schema change, no new sync
  protocol.
- A pending count of zero means "this feed has no items waiting to be
  promoted into the reading list" and is the desired default state
  for a caught-up feed; for those feeds the sidebar should show the
  feed name with no decoration. The user did not specify the zero
  case explicitly, and hiding the prefix avoids visual noise on the
  common steady-state where most feeds are caught up.
- "Pending", "un-synced", and "non-downloaded new items" all refer to
  the same concept in this codebase: items the server has observed
  for a feed but which have not yet been pulled into the reader's
  article list. This is distinct from "unread" (which is about
  already-fetched articles the reader has not yet opened); the
  existing per-feed unread badge in the sidebar is unaffected.
- The visual treatment of the prefix (font weight, color, exact
  spacing) follows the existing sidebar typography for feed-row text
  and does not introduce a new color, font, or weight token. Final
  visual placement (before the unread badge vs. before the feed name)
  will be settled in the plan phase against the actual sidebar
  markup, but the user-visible contract — "appears before the feed
  name as `(N) `" — is fixed.
- Mobile/responsive sidebar layouts inherit the same rule. If a given
  viewport hides the sidebar entirely, the feature has no effect
  there until the sidebar is shown.
- Accessibility: the parenthesized prefix is plain text in the same
  row as the feed name, so screen readers will read it inline with
  the name. No additional ARIA attributes are required for this
  feature unless implementation reveals a regression in the existing
  sidebar's a11y story.
