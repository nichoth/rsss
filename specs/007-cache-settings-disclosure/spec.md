# Feature Specification: Cache Settings Disclosure (Feed Reader)

**Feature Branch**: `007-cache-settings-disclosure`
**Created**: 2026-05-04
**Status**: Draft
**Input**: User description: "Should use `@substrate-system/details-summary` for the cache settings on feed reader route. Current design is confusing. It is not clear that this is an interactive element."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recognise that cache settings can be opened (Priority: P1)

A user is reading items in a selected feed on the feed reader route. They see a small label near the feed title that summarises the current cache behaviour for that feed (e.g. "Cache: Text + images (default)"). At a glance, the label clearly reads as a control that can be opened — it has an obvious affordance (such as a chevron, caret, or button-like styling) that signals "click to expand". The user clicks it and the cache settings panel reveals itself with a smooth, predictable animation.

**Why this priority**: This is the entire reason the feature exists. Today the cache summary text reads as a static decoration; users do not realise the per-feed cache controls are reachable from the feed reader route at all. Until the affordance is fixed, every downstream goal (changing cache mode, clearing the cache for a feed) is effectively hidden.

**Independent Test**: Open the feed reader, select a feed, and ask a first-time user what they think the cache label is. Success = they identify it as a clickable/expandable control without prompting. Also testable with keyboard navigation: tabbing onto the control surfaces a clear focused state and pressing Enter/Space toggles the panel.

**Acceptance Scenarios**:

1. **Given** a user has selected a feed on the feed reader route, **When** the page renders, **Then** the cache settings summary displays a visible disclosure indicator (e.g. chevron/caret) and visually reads as an interactive control rather than as plain text.
2. **Given** the cache disclosure is closed, **When** the user clicks (or activates via keyboard) the summary, **Then** the cache settings panel expands with a smooth animation and the disclosure indicator updates to reflect the open state.
3. **Given** the cache disclosure is open, **When** the user activates the summary again, **Then** the panel collapses with the same animation and the indicator returns to its closed state.
4. **Given** the user is navigating with a keyboard, **When** focus reaches the summary control, **Then** a clear focus indicator is visible and Enter/Space toggle the panel.

---

### User Story 2 - Existing cache controls keep working (Priority: P1)

When the cache disclosure is open, the user sees and uses the same controls available today — choose a cache mode (Use default / Text only / Text + images), set a max size (MB), set a retention period (days), and clear the cache for the current feed. Saving a value updates the summary label so the user can confirm their choice without expanding the panel again.

**Why this priority**: Same priority as P1 because changing the disclosure widget must not regress functionality. If any of the inner controls break, the feature is a net loss.

**Independent Test**: With the panel open, change cache mode, set a size, set a retention period, and click "Clear cache". Each interaction persists, the summary label reflects any new effective mode, and the toast/error feedback that exists today still appears.

**Acceptance Scenarios**:

1. **Given** the cache disclosure is open, **When** the user selects a cache mode, **Then** the choice is saved, the summary label updates, and the "(default)" suffix appears only when no override is set.
2. **Given** the user changes max size or retention values, **When** the input loses focus or the user submits, **Then** the new values are persisted using the same flow as today.
3. **Given** the user clicks "Clear cache" and confirms, **When** the operation completes, **Then** the cached content for that feed is removed and any existing success/error feedback is shown.

---

### Edge Cases

- The disclosure must remain usable on narrow viewports: the summary must wrap or truncate gracefully without overlapping the feed title or the unread-only / mark-all-read controls in the items header.
- When a feed is deselected or switched, an open disclosure should not "carry over" stale state into the newly selected feed.
- The animation must not block interaction: a user who clicks rapidly or activates via keyboard must not be left in an inconsistent half-open state.
- Users with `prefers-reduced-motion` should still be able to toggle the panel; motion may be reduced or removed but the open/closed state must change immediately.
- The component must be keyboard- and screen-reader-accessible: the summary must be focusable, have a clear name, and expose the expanded/collapsed state to assistive technologies.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The cache settings on the feed reader route MUST be presented as a labelled disclosure widget whose summary clearly signals (via an explicit indicator such as a chevron/caret and interactive styling) that it can be expanded.
- **FR-002**: Activating the summary by mouse, touch, or keyboard (Enter/Space) MUST toggle the cache settings panel between collapsed and expanded states.
- **FR-003**: The disclosure widget MUST animate the expand/collapse transition smoothly, while still respecting users' reduced-motion preferences.
- **FR-004**: The summary label MUST continue to communicate the effective cache mode for the current feed and indicate when the value comes from the user's default versus a per-feed override.
- **FR-005**: All existing cache controls available today MUST remain available inside the expanded panel: cache mode select (Use default / Text only / Text + images), max size, retention period, and clear-cache action.
- **FR-006**: Changes made inside the panel MUST persist using the same per-feed cache policy mechanism in use today, with no change to the user-visible feedback model (toasts, errors, confirmations).
- **FR-007**: The disclosure widget MUST be keyboard-accessible — the summary is reachable via Tab order, has a visible focus state, and exposes its expanded/collapsed state to assistive technologies.
- **FR-008**: The disclosure widget MUST not visually collide with the feed title or the items-header controls (unread-only checkbox, mark-all-read button) at any supported viewport width.

### Key Entities

- **Per-feed cache policy**: Existing entity. Includes cache mode, max size, retention period, and the "use default" indicator. Not modified by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a quick usability check, at least 4 of 5 first-time users identify the cache summary as an interactive, expandable control without being told.
- **SC-002**: 100% of cache settings actions available today on the feed reader route remain available and functional after the change (cache mode change, max size, retention, clear cache).
- **SC-003**: The disclosure can be operated end-to-end (open, change a setting, close) using keyboard only, with a visible focus indicator at every step.
- **SC-004**: Toggling the disclosure feels smooth — no visible flicker, no layout jump in the items header, and the open/close transition completes in a single frame's worth of perceived delay (under ~300 ms).
- **SC-005**: No regression in support tickets / feedback about "I can't change the cache settings on a feed" relative to the prior version.

## Assumptions

- The change is scoped to the feed reader route only. The visually similar cache controls inside the global Settings route (`settings.ts`) are out of scope for this feature and will be addressed separately if needed.
- The dependency `@substrate-system/details-summary` is already available in the project and is the intended component for this UX pattern; no new external dependency is being introduced.
- The existing per-feed cache policy data model and persistence flow are correct and do not need changes — this is a presentation-only change.
- Existing copy ("Cache:", "Use default", "Text only", "Text + images", "Clear cache", "(default)") is acceptable; rewording is out of scope.
- Visual styling will follow the project's existing CSS variables and the disclosure component's default look, customised only as needed to match the surrounding feed reader theme.
