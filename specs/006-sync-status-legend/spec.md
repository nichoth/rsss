# Feature Specification: Sync Status Legend

**Feature Branch**: `006-sync-status-legend`  
**Created**: 2026-05-04  
**Status**: Draft  
**Input**: User description: "In the top right corner of the app, need a text explanation of what the dot color means: green = 'up to date', blue = 'n updates' (where n is the number of updates that the server has cached), yellow = 'refreshing'"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand sync state at a glance (Priority: P1)

A signed-in user looks at the top right corner of the app and sees a small
colored dot indicating the current state of feed synchronization. Today the
color is the only signal, which forces users to guess what each color means.
With a short text label rendered next to the dot, the user can read the
state directly ("up to date", "3 updates", "refreshing") and decide whether
to act (e.g., reload to pull new items) without prior knowledge of the color
code.

**Why this priority**: This is the entire feature. The dot already exists
and changes color, but the meaning is not self-evident. Adding a textual
label is the smallest, highest-value change that turns an opaque indicator
into a self-explanatory one. There is no fallback path for users who do not
recognize the color code.

**Independent Test**: Sign in, observe the indicator in the top right of
the header in each of its three primary states (synced / pending updates /
refreshing) and confirm the matching text appears alongside the dot. The
text must convey the same meaning as the color without the user having to
hover or wait for a tooltip.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose local feed cache matches the server,
   **When** they look at the top right of the header,
   **Then** they see a green dot accompanied by the text "up to date".
2. **Given** a signed-in user for whom the server has cached `n` new feed
   updates that have not yet been pulled (`n > 0`),
   **When** they look at the top right of the header,
   **Then** they see a blue dot accompanied by text that includes the count
   and the word "updates" (e.g., "3 updates"; "1 update" when `n == 1`).
3. **Given** a signed-in user whose client is actively fetching or
   refreshing feeds,
   **When** they look at the top right of the header,
   **Then** they see a yellow dot accompanied by the text "refreshing".

### Edge Cases

- **Singular vs. plural count**: When the pending update count is exactly 1,
  the label reads "1 update" (singular). For any other positive count it
  reads "`n` updates" (plural). A count of 0 cannot occur in the blue state
  by definition (zero pending updates implies the synced/green state).
- **Count transitions while visible**: If the count or color changes while
  the user is looking at the indicator, the text updates in place to match
  the new state without layout shift large enough to push neighboring
  header controls.
- **Other dot colors not covered by user input**: The component today also
  has gray (inactive) and red (error) states. These are out of scope for
  this feature and their existing presentation is preserved unchanged.
- **Narrow viewports**: On viewports where the header right cluster cannot
  fit the new text alongside the existing controls (sync status, logout
  button, user icon), the indicator falls back to the dot-only presentation
  it has today, and the text is conveyed via the existing accessible label.
- **Screen reader announcements**: The same text shown visually is the text
  exposed to assistive technology, so users relying on screen readers
  receive the same explanation as sighted users.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The header indicator in the top right of the app MUST render
  a short human-readable text label next to the colored dot whenever the
  indicator is in one of the three primary states described in this spec
  (synced, pending updates, refreshing).
- **FR-002**: When the indicator is in the synced state (green dot), the
  visible label MUST read "up to date".
- **FR-003**: When the indicator is in the pending-updates state (blue
  dot), the visible label MUST include both the integer count of cached
  server-side updates and the word "updates" (singular "update" when the
  count is exactly 1). The count shown MUST equal the same value the
  indicator already uses to drive the blue state.
- **FR-004**: When the indicator is in the refreshing state (yellow dot),
  the visible label MUST read "refreshing".
- **FR-005**: The text label MUST update reactively whenever the underlying
  sync state or the cached-updates count changes, with no manual refresh
  required.
- **FR-006**: The accessible name (announced by screen readers) for the
  indicator MUST match the visible text label for each of the three states,
  so that users of assistive technology receive the same explanation as
  sighted users.
- **FR-007**: The feature MUST NOT alter the existing presentation, color,
  or behavior of any indicator state outside the three covered here
  (specifically: the inactive/gray state and the error/red state are
  unchanged).
- **FR-008**: The text label MUST be visible to a logged-in user on
  standard desktop viewports without requiring hover, focus, or tooltip
  interaction.

### Key Entities *(include if feature involves data)*

- **Sync indicator state**: An enumerated value representing the current
  feed-sync condition the indicator reflects. The three values in scope
  are `synced`, `updates`, and `refreshing`. Other values exist
  (`inactive`, `error`) but are out of scope for this feature.
- **Cached updates count**: A non-negative integer representing how many
  feed updates the server has cached for the user that have not yet been
  pulled into the local cache. Drives both the blue dot and the numeric
  portion of the "`n` updates" label.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user, shown a screenshot of the header in each
  of the three covered states, can correctly state what each indicator
  means without any external explanation, in a usability check of at
  least 5 participants.
- **SC-002**: For each of the three covered states, the rendered visible
  text matches the wording defined in this spec on 100% of page loads
  when that state is active.
- **SC-003**: A user who refreshes the app while in the pending-updates
  state can read the exact pending count from the header text within 1
  second of the page becoming interactive, without opening any menu or
  hovering any element.
- **SC-004**: After this feature ships, support questions or anecdotal
  user confusion about "what does the colored dot mean?" trend toward
  zero (qualitative; tracked informally).

## Assumptions

- The existing in-header indicator component is the correct surface for
  this label — no new placement, panel, or tooltip is being introduced.
- The three colors and their underlying state names listed by the user
  (green/up-to-date, blue/updates, yellow/refreshing) correspond to the
  indicator's existing `synced`, `updates`, and `syncing`/refreshing
  states. No new state is being introduced.
- Pluralization follows English conventions: 1 → "update", any other
  positive count → "updates". Localization is out of scope for this
  feature.
- The numeric count shown in the "n updates" label is the same number the
  blue-dot state already uses internally; no new data source is required.
- Inactive (gray) and error (red) states are intentionally outside the
  scope of this feature. Their current presentation continues to work as
  it does today.
- Visual styling (font, spacing, color) follows existing header
  conventions and CSS variables in the project; no new design tokens are
  required.
