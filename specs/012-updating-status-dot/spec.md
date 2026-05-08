# Feature Specification: Yellow "Updating" State for Header Status Dot During Refresh

**Feature Branch**: `012-updating-status-dot`
**Created**: 2026-05-08
**Status**: Draft
**Input**: User description: "The 'refresh feeds' flow is better. The button does spin until a response arrives. Need to change the status dot at the top. While we are waiting for the feeds to update, the dot should be yellow color, and should say 'updating'."

## Context

Feature 008 introduced the header status indicator with two
resting states: green "up to date" when the reader is caught up,
and blue "n updates" when the server holds items the reader has
not yet pulled. Feature 010 specified that the manual "Refresh
Feeds" button must enter a busy state on click and stay busy until
the user-visible result has been applied; feature 011 made that
visible chain regression-proof.

With those features in place the button now spins continuously
during a refresh, but the header status indicator at the top of
the page does not move. While the button reads "still working,"
the pill still reads "n updates" (the pre-click state) or even
"up to date" (if the indicator has been cleared optimistically).
Two adjacent controls disagree about what is happening: one says
"working," one says "settled."

This feature adds a third indicator state — yellow dot with the
label "updating" — that the header pill displays for the full
duration of an in-progress refresh. The header pill becomes part
of the refresh's visible chain (features 010/011) rather than a
silent bystander to it. When the refresh resolves, the pill
transitions out of "updating" into the appropriate post-refresh
state (up to date, n updates with the post-refresh count, or a
failure cue) at the same coherent moment as the button returns to
idle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Header dot communicates that a refresh is in progress (Priority: P1)

A reader sees the header pill say "5 updates" (blue dot) and
clicks "Refresh Feeds". From the moment the click is registered,
the header pill transitions to a yellow dot labeled "updating" and
remains in that state for the entire duration the refresh is in
flight. When the refresh resolves, the pill transitions out of
"updating" to the appropriate post-refresh state.

**Why this priority**: This is the user-reported gap. The button
already conveys "working"; the header is a second prominent cue
that should agree with the button. Without this story, the header
contradicts the button while the refresh is running, which
re-introduces the same "is this thing actually doing anything?"
ambiguity that feature 010 set out to fix.

**Independent Test**: Open the app with the header showing either
"up to date" (green) or "n updates" (blue). Click "Refresh
Feeds". Without scrolling or moving focus, observe the header
pill: it must transition to yellow with the label "updating"
within the same render frame as the click, remain yellow for the
full duration of the refresh, and transition out of yellow only
when the refresh resolves and the post-refresh pill state is ready
to display.

**Acceptance Scenarios**:

1. **Given** the header pill is in any resting state ("up to date"
   green or "n updates" blue) and Refresh Feeds is idle, **When**
   the reader clicks Refresh Feeds, **Then** the header pill
   transitions to yellow with the label "updating" within the
   same render frame as the click.
2. **Given** a refresh is in progress, **When** the reader looks
   at the header pill at any moment between click and resolution,
   **Then** the pill displays the yellow "updating" state — never
   the pre-click resting state, never the eventual post-refresh
   resting state.
3. **Given** a refresh resolves with new items, **When** the
   resolution is applied, **Then** the header pill transitions
   from yellow "updating" to the appropriate post-refresh resting
   state ("up to date" or "n updates") at the same coherent
   moment that the button returns to idle and the items list
   updates.
4. **Given** a refresh resolves with no new items, **When** the
   resolution is applied, **Then** the header pill transitions
   from yellow "updating" to green "up to date" at the same
   coherent moment that the button returns to idle.
5. **Given** the button busy state and the header "updating" state
   are both active, **When** the refresh resolves, **Then** both
   exit their active states together — neither lingers visibly
   after the other, and neither clears noticeably ahead of the
   other.

---

### User Story 2 - Header dot reflects refresh failure rather than staying yellow (Priority: P1)

When a refresh fails (network error, server error, upstream feed
origin error), the header pill must not remain stuck on yellow
"updating," and it must not silently drop back to a misleading
green "up to date." It must transition into a state the reader
can identify as a failure, consistent with the button's failure
cue from feature 010 and the failure-resolution path from feature
011.

**Why this priority**: P1 because a stuck yellow pill is exactly
the same kind of ambiguity ("is it still working?") that this
feature is meant to eliminate. If the success path is fixed but
failure leaves the pill in "updating," the regression is just
moved from the success case to the failure case.

**Independent Test**: Force a refresh failure (offline, induced
server error). Click "Refresh Feeds". Confirm the pill transitions
to yellow "updating" on click (Story 1), then transitions out of
yellow into a state the reader can identify as a failure when the
failure is detected — not back to green "up to date" and not
stuck on yellow.

**Acceptance Scenarios**:

1. **Given** a refresh is in progress and the pill shows yellow
   "updating," **When** the refresh fails, **Then** the pill
   transitions out of yellow into the failure state defined by
   features 010/011 (indicator restored to its pre-click value
   with a failure cue), at the same moment the button exits its
   busy state.
2. **Given** a refresh has failed and the pill is showing the
   failure state, **When** the reader clicks "Refresh Feeds"
   again, **Then** the pill transitions back to yellow "updating"
   with the same contract as Story 1, replacing the failure cue.
3. **Given** a refresh fails, **When** the failure is resolved
   visually, **Then** the pill never resolves to green "up to
   date" purely as a consequence of the failure; that transition
   is reserved for confirmed-clean refreshes.

---

### User Story 3 - "Updating" state is exclusive to manual refresh, not background polling (Priority: P2)

When the system pulls feed data in the background (feature 009)
without the reader's involvement, the header pill does NOT enter
the yellow "updating" state. The yellow state is reserved for
work the reader has explicitly initiated and is waiting to see.
Background polling continues to surface its results through the
existing live-update path (feature 008): the pill transitions
from "up to date" to "n updates" when the background poll
discovers new items, with no intervening yellow flash.

**Why this priority**: P2. Story 1 fixes the user-reported issue.
Story 3 prevents over-application of the new state — turning the
pill yellow on every background tick would make "updating" feel
constant and meaningless, and would re-introduce flicker the
header is supposed to be free of.

**Independent Test**: Leave the app open without clicking Refresh
Feeds. Allow the background poller to run a normal cycle. Observe
the header pill: it must not transition to yellow at any point
during background polling. If the background poll surfaces new
items, the pill transitions directly from its prior resting state
to "n updates" without passing through yellow.

**Acceptance Scenarios**:

1. **Given** the reader has not clicked Refresh Feeds, **When**
   the background poller runs, **Then** the header pill does not
   transition to yellow "updating" at any point.
2. **Given** the background poller surfaces new items while the
   pill is "up to date," **When** the new items are reported to
   the client, **Then** the pill transitions directly to "n
   updates" (blue) without an intervening yellow state.
3. **Given** a manual refresh is in progress (pill is yellow) and
   a background poll completes during it, **When** the manual
   refresh resolves, **Then** the pill exits yellow to a single
   coherent post-refresh state that accounts for both the manual
   refresh's results and any items folded in from the background
   poll, without the yellow state flickering off and on.

---

### Edge Cases

- The reader has zero subscribed feeds and clicks Refresh: the
  pill must still transition to yellow "updating" briefly so the
  click does not appear to do nothing, and resolve cleanly to
  green "up to date" — it must not be a sub-perceptual flash.
- The refresh resolves so quickly that the yellow state would
  appear sub-perceptually: the yellow state must either be held
  long enough to be perceptible or coordinated with the button's
  busy state so the click still reads as acknowledged.
- The refresh takes longer than the typical case: the yellow
  state must remain steady throughout — it must not oscillate,
  flicker, or revert to a resting state mid-flow.
- The reader clicks Refresh while the pill is already yellow
  ("updating" because a previous click is still resolving):
  consistent with feature 011, the extra click must not start a
  parallel refresh and must not cause the yellow state to
  flicker, restart, or terminate prematurely.
- The reader navigates between routes (e.g. opens an article)
  while a refresh is in progress and returns: on returning to a
  view that shows the header pill, the pill must accurately
  reflect whether the refresh is still in progress (yellow
  "updating") or has resolved.
- The reader's connection drops during a refresh: the pill must
  transition out of yellow into the failure state per Story 2,
  not be stuck on yellow indefinitely.
- The pill is in the middle of a server-pushed update transition
  (feature 008) when the reader clicks Refresh: the manual click
  takes precedence — the pill goes yellow on click, and the
  pushed-update count is folded into the post-refresh resting
  state when the refresh resolves.
- The refresh resolves but, before the post-refresh state is
  applied, a server-pushed live update arrives: the pill must
  not flicker through an intermediate state; it transitions from
  yellow directly to the post-refresh resting state, with any
  concurrent pushed update folded in.
- The yellow "updating" state is shown to a reader using a
  high-contrast or color-blind-friendly theme: the label
  "updating" plus a non-color signal (icon or shape change) must
  remain distinguishable from "up to date" and "n updates" without
  relying on hue alone.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The header status pill MUST support a third state
  in addition to "up to date" and "n updates": a yellow dot with
  the label "updating", used to indicate that a manually
  initiated refresh is currently in progress.
- **FR-002**: When the reader activates the Refresh Feeds control
  (mouse, touch, or keyboard), the header pill MUST transition
  into the yellow "updating" state within the same render frame
  as the activation, regardless of which resting state the pill
  was in before the click.
- **FR-003**: The header pill MUST remain in the yellow
  "updating" state continuously for the full duration of the
  in-progress refresh. It MUST NOT revert to a resting state at
  any intermediate handoff point that does not coincide with the
  user-visible resolution of the refresh.
- **FR-004**: When the refresh resolves successfully (with or
  without new items), the header pill MUST transition out of
  yellow "updating" and into the appropriate post-refresh resting
  state ("up to date" if no items remain pending, or "n updates"
  with the post-refresh count) at the same coherent moment as the
  button returns to idle and any new items appear in the items
  list.
- **FR-005**: When the refresh fails, the header pill MUST
  transition out of yellow "updating" into the failure state
  defined by features 010/011 (indicator restored to its
  pre-click value with a failure cue), at the same moment the
  button exits its busy state. The pill MUST NOT remain stuck on
  yellow indefinitely and MUST NOT silently revert to green "up
  to date" purely as a consequence of failure.
- **FR-006**: The transition into and out of the yellow
  "updating" state MUST occur within the same coherent moment as
  the corresponding button state transition (idle → busy on
  click, busy → idle on resolution). The button and the pill MUST
  NOT visibly disagree about whether work is in progress at any
  moment the reader can sample.
- **FR-007**: The yellow "updating" state MUST NOT be triggered
  by background polling (feature 009), by the page-load status
  request (feature 008), or by any other system-initiated work
  the reader did not explicitly request. It is reserved for
  reader-initiated manual refresh.
- **FR-008**: The yellow "updating" state MUST be reachable and
  perceivable by users who rely on assistive technology. The
  state transition MUST be communicated programmatically (e.g.,
  status change announcement) so non-sighted users receive the
  same in-progress signal sighted users receive.
- **FR-009**: The yellow "updating" state MUST be distinguishable
  from "up to date" and "n updates" without relying on hue alone
  — i.e., it provides a non-color signal (the textual label
  "updating", and any iconographic change) so it remains
  identifiable in high-contrast and color-blind-friendly modes.
- **FR-010**: While the pill is in the yellow "updating" state,
  additional clicks on the Refresh Feeds control MUST NOT cause
  the pill to flicker, restart, or terminate the yellow state
  prematurely. The pill's lifecycle is bound to the in-progress
  refresh, not to each click event.
- **FR-011**: If a server-pushed live update or page-load status
  comparison (feature 008) arrives while the pill is yellow
  "updating," the resulting count change MUST be folded into the
  post-refresh resting state without causing the pill to drop out
  of yellow before the manual refresh resolves.
- **FR-012**: An end-to-end test MUST exercise the full
  click-to-resolution lifecycle of the header pill for each of
  the three resolution paths (new items / no new items / failure)
  and assert that the pill is yellow "updating" throughout the
  in-progress phase and transitions to the correct post-refresh
  state at resolution, so the regression that prompted this spec
  cannot silently return.

### Key Entities

- **Header Status Pill**: The user-facing indicator at the top
  of the page that today displays "up to date" (green) or "n
  updates" (blue). This feature adds a third visual state —
  yellow with the label "updating" — and a transition contract
  for entering and leaving it.
- **Updating State**: The new in-progress visual state of the
  pill. Bound to the lifecycle of a manual refresh: enters on
  Refresh Feeds activation, exits on refresh resolution. Has no
  resting position — the pill is never yellow when no manual
  refresh is in flight.
- **Pill Lifecycle**: The conceptual sequence of header pill
  states across a manual refresh: prior resting state → yellow
  "updating" (on click) → post-refresh resting state or failure
  cue (on resolution). This lifecycle runs in lockstep with the
  refresh button's idle → busy → idle/failed lifecycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of manual refresh actions, the header pill
  visibly transitions to yellow "updating" within the same render
  frame as the Refresh Feeds activation. There is no observable
  interval after the click in which the pill still displays the
  pre-click resting state.
- **SC-002**: In 100% of manual refresh actions, the header pill
  remains in the yellow "updating" state continuously from
  activation until the refresh resolves. Zero refreshes show the
  pill flickering out of yellow mid-flow or settling on a resting
  state before the refresh is done.
- **SC-003**: The time between the header pill transitioning out
  of yellow "updating" and the button returning to idle is
  effectively zero (within one rendering frame) in 100% of
  refresh resolutions. Readers perceive a single coherent "done"
  moment, not a staggered cascade.
- **SC-004**: For refreshes that fail, 100% of failures
  transition the pill out of yellow into the failure state. Zero
  failures leave the pill stuck on yellow and zero failures
  silently transition the pill to green "up to date".
- **SC-005**: In an observation period of typical background
  poller activity with no manual refresh, zero pill transitions
  to yellow "updating" occur. The yellow state is not raised by
  any work the reader did not explicitly initiate.
- **SC-006**: In post-fix usability checks, zero readers describe
  the header pill as "stuck" or "ignoring" the refresh during
  scenarios where the pre-fix behavior produced a static pill
  while the button was spinning.

## Assumptions

- The contracts and behaviors specified by features 008
  (`/feed-status` + SSE-driven indicator), 009 (server-side
  background polling), 010 (refresh feedback lifecycle), and 011
  (refresh visible chain) remain in force. This feature extends
  the header pill's state space and binds it to the manual refresh
  lifecycle; it does not redesign the underlying contracts.
- The header status pill is the indicator visible at the top of
  the home page next to the user controls (Logout, avatar). The
  yellow "updating" state applies wherever the pill is rendered;
  if it is rendered on additional surfaces, the same contract
  applies.
- "Refresh Feeds" continues to refresh all subscribed feeds for
  the active reader; the scope of what gets refreshed is
  unchanged.
- The yellow color and "updating" label are the design direction
  the user has specified. The specific yellow used should match
  any existing in-progress/warning color already defined in the
  product's design tokens; a new color is introduced only if no
  suitable existing color is available.
- "Within the same render frame" means the visible transition
  occurs synchronously with the click handler and is observable
  in the next paint, not on a delayed schedule (e.g., not gated on
  a network round-trip).
- Background polling (feature 009) continues to be invisible to
  the reader except through its eventual updates to the pending-
  updates count; it does not gain an in-progress visual signal of
  its own as part of this feature.
- The pill's transitions must be coherent with the refresh button
  state, but this feature does not alter the button's appearance —
  it only requires the pill change in lockstep with it.
- A user-facing "cancel refresh" affordance remains out of scope.
