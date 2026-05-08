# Feature Specification: Faithful Visual Feedback During Refresh Feeds

**Feature Branch**: `010-fix-refresh-feedback`
**Created**: 2026-05-07
**Status**: Draft
**Input**: User description: "The 'refresh feeds' flow needs work. It correctly said '27 updates' and shows the blue dot in the header, but when I clicked 'refresh feeds', the button stopped spinning immediately, and it looked like the browser was doing nothing. Then after a few more seconds the screen refreshed with some new feeds."

## Context

Feature 008 fixed how the header "n updates / up to date" pill is
computed and transmitted, and feature 009 made the underlying data
fresh by polling subscribed feeds in the background. With those in
place, the manual "Refresh Feeds" button is no longer the only way
the system learns about new items — but it is still the user's
primary expression of "show me the new stuff now."

Today that flow misleads the user. After clicking "Refresh Feeds":

1. The button's spinner stops almost immediately.
2. For several seconds nothing visible changes — the items list,
   the unread counts, and the header pill all stay as they were.
3. Eventually the list updates with the new items.

Between steps 1 and 3 the user has no signal that work is in
progress. The app appears broken or idle. The user only learns
that the refresh is still happening when it finishes by surprise.

This feature realigns the visual state of the refresh control (and
any related indicators) with the actual lifecycle of the work the
user just requested, so that "still working" looks like still
working and "done" looks like done.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reader sees continuous progress until new items are on screen (Priority: P1)

A reader sees the header indicator say "27 updates" and clicks
"Refresh Feeds" to view those updates. From the moment the click
is registered until the new items are actually visible in the
items list (or the refresh has resolved with no new items / an
error), the control communicates "I am working on it." The reader
never sees a quiet, idle-looking screen during that window.

**Why this priority**: This is the user-reported bug and the entire
point of the feature. Without it, the manual refresh action looks
like a no-op for several seconds, undermining trust in the app and
in the recently shipped indicator/polling work (features 008/009).

**Independent Test**: Open the app with the indicator showing a
non-zero "n updates" pill. Click "Refresh Feeds". Observe the
control and surrounding UI continuously from click until the items
list reflects the new content; confirm there is no period during
which the control reads as idle while work is still in progress
behind the scenes.

**Acceptance Scenarios**:

1. **Given** the header shows "n updates" with n > 0, **When** the
   reader clicks "Refresh Feeds", **Then** the button enters a
   busy/active visual state immediately and remains in that state
   continuously until the items list and indicator have been
   updated to reflect the result of the refresh.
2. **Given** a refresh is underway, **When** the reader looks at
   the screen at any moment before the items list has been
   updated, **Then** at least one persistent visual cue (button
   state, inline progress, or equivalent) tells them work is in
   progress; the screen does not read as idle.
3. **Given** the refresh completes and new items have been
   surfaced, **When** the items list and indicator finish
   updating, **Then** the button returns to its idle state and the
   header pill transitions to its post-refresh value (typically
   "up to date") within the same tick that the user can see the
   new items.
4. **Given** the refresh completes and no new items were found,
   **When** the result is applied, **Then** the button returns to
   idle, the header pill transitions to "up to date", and the
   reader can tell from the UI that the refresh ran and found
   nothing — not that the click was lost.

---

### User Story 2 - Reader gets a clear signal when refresh fails (Priority: P2)

The refresh can fail for reasons outside the reader's control
(network, server, an upstream feed origin). When that happens the
reader needs to know — and needs the indicator and button state to
return to a coherent resting state, not be stuck in "working."

**Why this priority**: Important for trust and for not stranding
the user in an ambiguous state, but strictly less critical than P1.
P1 covers the everyday happy path the user already reported; P2
prevents the new visual contract from breaking the moment something
goes wrong.

**Independent Test**: Force a refresh failure (offline, induced
server error, etc.). Click "Refresh Feeds". Confirm the reader
sees a clear failure cue, that the button returns from busy to
idle, and that the header pill is not left in a misleading state.

**Acceptance Scenarios**:

1. **Given** the refresh request cannot be completed, **When** the
   failure is detected, **Then** the button exits its busy state,
   a failure cue is presented to the reader, and the indicator
   returns to its prior pre-click value (the count of pending
   updates is not silently zeroed out).
2. **Given** a refresh failure has been shown, **When** the reader
   clicks "Refresh Feeds" again, **Then** a fresh attempt begins
   with the same continuous-feedback contract as P1.

---

### Edge Cases

- The refresh is very fast and finishes before the user's eye has
  registered the busy state: the busy cue must not flicker on/off
  in a way that reads as a glitch.
- The refresh is unusually slow (slow origin, large account): the
  busy cue must remain steady; a long flow must not look like a
  hang. There must be no dead period between an early
  acknowledgement and the user-visible result.
- The reader clicks "Refresh Feeds" repeatedly while a refresh is
  already in progress: extra clicks must not fan out into parallel
  refreshes and must not extend, restart, or interrupt the
  in-progress flow in a way the reader perceives as the button
  being "broken."
- The reader navigates away from the refresh control mid-flow
  (scrolls, switches view) and comes back: on return, the visual
  state must accurately reflect whether the refresh is still in
  progress or has finished.
- A background poll (feature 009) lands during a manual refresh:
  the resulting items must appear without confusing the manual
  refresh's busy-state lifecycle (no premature "done" caused by an
  unrelated update, no stuck spinner because a manual refresh
  finished and a polled update arrived afterwards).
- The header indicator is already "up to date" when the reader
  clicks refresh: the busy state still applies until the refresh
  has been processed, so the click is not silently ignored.
- The reader has zero subscribed feeds: clicking refresh resolves
  immediately to "up to date" with no perceivable hang and no
  spurious failure cue.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The refresh control MUST enter a busy/active visual
  state on click and MUST remain in that state continuously until
  the user-visible result of the refresh has been applied — i.e.
  any new items have been rendered into the items list and the
  header indicator reflects the refresh's outcome — or until the
  refresh has resolved as a failure.
- **FR-002**: The system MUST NOT release the busy state of the
  refresh control at an intermediate handoff point (e.g.
  acknowledgement of a request, completion of one phase) that does
  not coincide with a visible change for the reader.
- **FR-003**: At every moment between click and resolution, the
  reader MUST have at least one persistent on-screen cue indicating
  that the refresh is in progress. The screen MUST NOT appear idle
  during the work the user just initiated.
- **FR-004**: The header "n updates / up to date" indicator MUST
  remain consistent with the refresh lifecycle: it MUST NOT
  prematurely report "up to date" before the refresh's items have
  been surfaced to the reader, and it MUST NOT report a stale
  count once the refresh has completed.
- **FR-005**: When a refresh completes with new items, the button
  return-to-idle, the items-list update, and the indicator
  transition MUST occur within the same perceivable update so the
  reader sees a single coherent "done" moment rather than a
  staggered cascade.
- **FR-006**: When a refresh completes with zero new items, the
  button MUST return to idle, the indicator MUST transition to
  "up to date", and the UI MUST distinguish "ran and found
  nothing" from "click was ignored."
- **FR-007**: When a refresh fails, the button MUST exit its busy
  state, a failure cue MUST be surfaced to the reader, and the
  indicator MUST be restored to its pre-click value rather than
  being silently cleared.
- **FR-008**: While a refresh is in progress, additional clicks on
  the refresh control MUST NOT fan out into parallel refresh
  operations. Repeated clicks MUST NOT visibly disturb the
  in-progress busy state in a way that reads as malfunction.
- **FR-009**: The busy state cue MUST NOT flicker on and off for
  refreshes that complete extremely quickly; the visual contract
  is "starts on click, ends on visible result" without a sub-
  perceptual on/off pulse.
- **FR-010**: Refresh feedback MUST NOT depend on the user keeping
  the refresh control in view. If the reader scrolls, switches
  panel, or otherwise moves focus during a refresh, the resolution
  cues (items appearing, indicator transition) MUST still occur
  in the appropriate places when the reader returns to them.
- **FR-011**: Background-polling activity from feature 009 MUST NOT
  prematurely terminate or extend the manual refresh's busy state.
  A poll-driven update arriving during a manual refresh is folded
  into the post-refresh state rather than treated as the manual
  refresh's completion.
- **FR-012**: The refresh control MUST be reachable and operable by
  keyboard, and the busy state MUST be communicated to assistive
  technology so non-sighted users get the same "still working /
  done / failed" signal sighted users get.

### Key Entities

- **Refresh Control**: The user-facing button that initiates a
  manual refresh of subscribed feeds. For this feature it gains a
  more explicit lifecycle (idle → busy → idle/failed) tied to the
  visible result rather than to an internal handoff.
- **Refresh Lifecycle**: The conceptual span from the click that
  starts a manual refresh to the moment the reader can see its
  result on screen (new items, "up to date" pill, or failure cue).
  This span is what the busy state must cover.
- **Visible Result**: The set of UI changes the reader is waiting
  for: items list updated with any new items, header indicator
  transitioned to its post-refresh value, and any inline counts
  reconciled. Until all of these are applied, the refresh is not
  done from the reader's perspective.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In at least 95% of manual refresh actions, the
  refresh control communicates "in progress" continuously from the
  click until the items list reflects the result. There is no
  observable period in which the control reads as idle while
  work is still in progress.
- **SC-002**: The time between the refresh control returning to
  idle and the reader seeing the new items in the items list is
  effectively zero (within one rendering frame), so users perceive
  a single "done" moment instead of a staggered cascade.
- **SC-003**: In post-fix usability checks, zero readers describe
  the manual refresh as "broken," "doing nothing," or "stuck"
  during the period the previous behavior produced those reports.
- **SC-004**: For refreshes that fail, 100% of failures surface a
  visible failure cue and return the indicator to its pre-click
  value; no failure leaves the button stuck in busy state or the
  pill silently zeroed.
- **SC-005**: For refreshes that complete with zero new items,
  100% of sessions end with the indicator at "up to date" and a UI
  state distinguishable from "click was ignored."

## Assumptions

- The contracts and behavior introduced in features 008
  (`/feed-status` + SSE-driven indicator) and 009 (server-side
  background polling) are correct and unchanged by this feature.
  This work is purely about aligning the visual lifecycle of the
  manual refresh control with the underlying flow those features
  already produce.
- "Refresh Feeds" continues to refresh all subscribed feeds for
  the active reader; the scope of what gets refreshed is not
  changing.
- Concurrency safety (no duplicate items, no lost updates) when a
  manual refresh overlaps a background poll is already provided by
  feature 009's deduplication; this feature does not need to
  reintroduce it.
- Rendering "the result" of a refresh means at minimum: any new
  items appear in the items list, and the header pill transitions
  to its post-refresh value. Per-feed unread counts (feature 005)
  reconcile within the same update window without needing a new
  contract.
- The refresh control is a single user-facing button. The fix is
  not a redesign of refresh into a multi-control or
  progress-bar-with-cancel surface; it is a correction of the
  existing control's lifecycle.
- A user-facing "cancel refresh" affordance is out of scope for
  this feature.
