# Feature Specification: Refresh Feeds Click Must Produce an Observable Response

**Feature Branch**: `011-fix-refresh-noop`
**Created**: 2026-05-08
**Status**: Draft
**Input**: User description: "I click 'refresh feeds' on the home page, and nothing happens."

## Context

Feature 010 (Faithful Visual Feedback During Refresh Feeds) specified
that clicking the "Refresh Feeds" control must immediately enter a
busy state and stay there continuously until the user-visible result
of the refresh has been applied. After 010 shipped, the reader is
again reporting that the manual refresh produces no observable change
at all — the click feels swallowed, the page does not visibly react,
and the reader has no way to tell whether the request was registered,
whether it is in progress, or whether it ever ran.

From the reader's perspective there are now three distinct "nothing
happens" failure modes that all collapse into the same complaint:

1. **No acknowledgement** — the click registers no immediate visible
   change anywhere on screen, so the reader cannot tell whether the
   click reached the system.
2. **No in-progress signal** — even if some change happens for a
   frame, the screen quickly settles back to its prior appearance
   while the actual work is still in flight, leaving a quiet idle-
   looking screen during a non-trivial work window.
3. **No conclusion** — work eventually finishes (new items arrive, or
   no change is needed, or the request fails), but the reader cannot
   tell which from looking at the page; nothing transitions, nothing
   announces a result.

This feature requires that all three be addressed: a click on the
refresh control must produce an immediate, sustained, and clearly
concluded visible chain of events, every time. It is the user-
observable contract of feature 010 expressed as a regression-proof
acceptance test rather than a narrative — if any link in that chain
is missing, the reader experiences "nothing happens," and the bug
is not fixed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reader's click is acknowledged within one frame (Priority: P1)

A reader clicks the "Refresh Feeds" control. Within one render
frame, the screen visibly changes in a way the reader can perceive
without effort: the control enters a busy/active state, or an
adjacent indicator transitions, or both. The click is unmistakably
registered.

**Why this priority**: This is the literal user complaint. If the
click does not produce an immediate visible change, the reader
concludes the app is broken regardless of what is happening
underneath. Without this story, the feature is not delivered, no
matter how correct the rest of the lifecycle is.

**Independent Test**: Open the app on the home page with at least
one subscribed feed. Click "Refresh Feeds". Without scrolling,
without focusing the devtools, and without holding up a stopwatch,
confirm that something on screen visibly changes by the time the
click physically completes. Have a second observer who did not see
the click watch a recording of the moment and identify whether a
click occurred from the visual change alone.

**Acceptance Scenarios**:

1. **Given** the home page is loaded and Refresh Feeds is in its
   idle state, **When** the reader clicks Refresh Feeds, **Then** an
   immediate visible change appears on screen (button busy state,
   indicator transition, or both) within the same render frame as
   the click and remains visible long enough for the reader to
   perceive it.
2. **Given** the system is performing the refresh, **When** any
   moment is sampled between the click and the visible result,
   **Then** the screen does NOT match its pre-click appearance — at
   least one persistent on-screen cue indicates that work is in
   progress.
3. **Given** the click is registered, **When** the reader continues
   looking at the screen, **Then** the busy cue does not flicker on
   and off in a way that reads as a glitch; it remains steady from
   click until the work concludes.

---

### User Story 2 - Reader sees a clear conclusion to the refresh (Priority: P1)

After the busy period, the refresh ends in exactly one of three
visible outcomes that the reader can identify without ambiguity:
new items appear in the items list, the header indicator transitions
to "up to date" with no new items, or a visible failure cue is
shown. In all three cases the busy state ends at the same moment as
the conclusion is shown — never earlier, never later.

**Why this priority**: P1 because "nothing happens" is also the
reader's complaint about the back end of the lifecycle, not just the
front. A click that produces a flash of busy state and then settles
silently with no visible conclusion still reads as broken. The fix
is incomplete unless conclusion is as observable as initiation.

**Independent Test**: Trigger refresh under each of three controlled
conditions: new items available upstream, no new items available,
and induced failure (offline / forced server error). For each case,
have an observer who did not see the click watch a recording and
identify (a) that a refresh ran and (b) which of the three outcomes
occurred, from visual cues alone.

**Acceptance Scenarios**:

1. **Given** a refresh that surfaces new items, **When** the work
   completes, **Then** the new items appear in the items list, the
   header indicator transitions to its post-refresh value, and the
   button returns to idle within the same perceivable update.
2. **Given** a refresh that surfaces no new items, **When** the work
   completes, **Then** the header indicator transitions to "up to
   date", the button returns to idle, and the reader can tell from
   the screen alone that the refresh ran and resolved cleanly — not
   that the click was lost or the request never returned.
3. **Given** a refresh that fails (network, server, upstream),
   **When** the failure is detected, **Then** the button exits its
   busy state, a visible failure cue is presented, and the indicator
   is restored to its pre-click value rather than being silently
   cleared.
4. **Given** any of the three resolution paths, **When** the
   conclusion is shown, **Then** there is no preceding silent gap in
   which the busy state has ended but the conclusion has not yet
   appeared.

---

### User Story 3 - Reader can repeat refresh without confusion (Priority: P2)

After a refresh resolves, the reader can immediately click "Refresh
Feeds" again and see the same observable chain — busy state, then
conclusion — with no carry-over from the previous run. Successive
refreshes feel responsive and identical.

**Why this priority**: P2. Once Stories 1 and 2 are delivered, the
single-click case is fixed. Story 3 protects against subtle state
leakage from one run to the next, which would re-introduce a "this
time nothing happened" complaint after a previously successful
refresh.

**Independent Test**: Click Refresh Feeds, wait for the resolution,
click again. Repeat several times in quick succession (with a brief
pause between each click for the previous run to resolve). Confirm
each click produces the full visible chain from Story 1 and Story 2
and that no later run is "quieter" than the first.

**Acceptance Scenarios**:

1. **Given** a previous refresh has resolved, **When** the reader
   clicks Refresh Feeds again, **Then** Stories 1 and 2 apply in
   full to this new click — the second click is not silently
   degraded.
2. **Given** the reader clicks Refresh Feeds while a refresh is
   still in progress, **When** the extra click is received, **Then**
   it does not start a parallel refresh, does not interrupt the
   in-progress busy state, and does not leave the control in a
   state that reads as broken once the in-progress run finishes.

---

### Edge Cases

- The reader's connection is offline at click time: the click must
  still produce immediate visible feedback (Story 1) and resolve
  into a visible failure cue (Story 2.3) within a reasonable bound
  rather than appearing to do nothing.
- The reader has zero subscribed feeds: the click must still produce
  immediate visible feedback and resolve cleanly to "up to date"
  (Story 2.2). It must not silently no-op.
- The refresh completes faster than the reader's eye: the busy cue
  must not be shown so briefly it is sub-perceptual; the conclusion
  must be visible enough that the reader registers something
  happened.
- The refresh takes longer than usual: the busy cue must not silently
  time out, return the button to idle, and leave the reader staring
  at an idle button while work is still in flight.
- A background poll lands during a manual refresh: the manual
  refresh's visible chain must not be cut short, hijacked, or
  duplicated by the poll's update.
- The reader scrolls or switches view between click and resolution:
  on returning to the refresh control's region, the visible state
  must accurately reflect whether the refresh is still in progress,
  has concluded with new items, has concluded clean, or has failed.
- The reader uses keyboard activation (Enter/Space on a focused
  refresh control) rather than mouse click: the same observable
  chain must occur, and assistive technology must be informed of
  the lifecycle transitions.
- The reader has the page in a background tab when the refresh
  resolves: returning to the tab must show the resolved state
  (items, indicator, or failure cue), not a stuck busy state and
  not a cleared screen with no record that a refresh ran.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Activating the refresh control (mouse, touch, or
  keyboard) MUST produce a visible change on screen within the same
  render frame as the activation. The screen after the click MUST
  NOT be pixel-identical to the screen before the click for any
  observable interval.
- **FR-002**: The visible "in progress" cue established by FR-001
  MUST persist continuously until the refresh resolves. The system
  MUST NOT release the cue at any intermediate handoff point that
  is not also when the user-visible result is applied.
- **FR-003**: A refresh MUST conclude in exactly one of three
  observable states: (a) new items rendered into the items list and
  header indicator transitioned to its post-refresh value, (b)
  header indicator transitioned to "up to date" with the items list
  unchanged, or (c) a visible failure cue with the indicator
  restored to its pre-click value. There MUST NOT be a fourth
  silent-resolution path.
- **FR-004**: The transition from "in progress" cue to "concluded"
  cue MUST be visible to the reader. The control MUST NOT silently
  drop its busy state without simultaneously surfacing one of the
  three outcomes from FR-003.
- **FR-005**: The conclusion outcomes from FR-003 MUST NOT precede
  the cessation of the busy cue, NOR may the busy cue cease
  noticeably ahead of the conclusion outcome. The two MUST be
  perceived as one coherent moment.
- **FR-006**: When a refresh fails, the system MUST NOT zero out the
  pending-updates indicator or otherwise reflect "completed
  successfully" semantics. It MUST surface a failure cue distinct
  from the success cues.
- **FR-007**: While a refresh is in progress, additional activations
  of the refresh control MUST NOT spawn parallel refreshes and MUST
  NOT degrade the visible-chain contract of the in-progress run.
- **FR-008**: After a refresh resolves, the next activation of the
  refresh control MUST produce the full visible chain anew — FR-001
  through FR-005 apply to every activation, not only the first one
  in a session.
- **FR-009**: The refresh control MUST be operable by keyboard, and
  every state transition (idle → busy → resolved) MUST be
  communicated to assistive technology so that non-sighted readers
  receive the same observable chain that sighted readers receive.
- **FR-010**: A safety net MUST exist such that no refresh can leave
  the control stuck in a busy state indefinitely, even if the
  expected resolution signal fails to arrive. Any safety-net
  recovery MUST itself produce a visible conclusion (a failure cue
  or equivalent) — it MUST NOT silently restore the idle state.
- **FR-011**: Background-polling activity MUST NOT prematurely
  conclude or visually interfere with the manual refresh's
  observable chain. Updates produced by background polling during
  a manual refresh fold into the manual refresh's resolution rather
  than competing with it.
- **FR-012**: An automated end-to-end test MUST exercise each of the
  three resolution paths (new items / no new items / failure) and
  assert that the visible chain from FR-001 through FR-005 occurs
  in each, so that the regression that produced this report cannot
  silently return.

### Key Entities

- **Refresh Control**: The user-facing button labeled "Refresh
  Feeds" in the sidebar of the home page. Its observable lifecycle
  is the unit under specification.
- **Visible Chain**: The ordered, perceivable sequence of: click →
  immediate cue (FR-001) → sustained in-progress cue (FR-002) →
  concluded cue (FR-003/004/005). When any step is missing, the
  reader experiences "nothing happens."
- **Resolution Outcome**: One of new-items, up-to-date, or failure
  — the three valid terminal states of a refresh from the reader's
  perspective. Any other terminal state (silent settle, stuck busy,
  cleared indicator without explanation) is a defect.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of clicks on the refresh control produce a visible
  on-screen change within the same render frame as the click. There
  is no observable interval after a click in which the screen is
  pixel-identical to its pre-click appearance.
- **SC-002**: 100% of refreshes resolve into exactly one of the three
  defined outcomes (new items / up to date / failure) with a
  matching visible cue. Zero refreshes resolve silently.
- **SC-003**: In a usability check with readers unfamiliar with the
  recent feedback fix, zero readers describe the refresh as "doing
  nothing," "swallowed," or "broken" during scenarios that
  previously produced those reports.
- **SC-004**: An end-to-end test suite covers all three resolution
  paths and asserts on the visible chain. The suite catches a
  regression that removes any link in the chain, and it must be
  green before the fix can be considered shipped.
- **SC-005**: For refreshes that take longer than the busy-state
  safety net, 100% of sessions still end with a visible cue (success
  or failure) — zero end with the control silently returning to
  idle.
- **SC-006**: For repeated refreshes within a single session, the
  Nth click produces the same observable chain quality as the 1st
  click, measured by the same SC-001 / SC-002 criteria. There is
  no degradation across successive runs.

## Assumptions

- The contracts and behaviors specified by features 008
  (`/feed-status` + SSE-driven indicator), 009 (server-side
  background polling), and 010 (refresh feedback lifecycle) remain
  in force. This feature does not redesign any of those contracts;
  it ensures that the contract surface they collectively define is
  honored end-to-end so that the reader does not experience
  "nothing happens."
- "Refresh Feeds" continues to refresh all subscribed feeds for the
  active reader; the scope of what gets refreshed is unchanged.
- The home page is the primary surface where the refresh control is
  exercised. If the control is reachable from any other surface,
  the same observable contract applies, but designing additional
  surfaces is out of scope.
- Concurrency safety (no duplicate items, no lost updates) when a
  manual refresh overlaps a background poll is provided by feature
  009; this feature does not need to reintroduce it.
- A user-facing "cancel refresh" affordance is out of scope; the
  fix is about making the existing refresh observable, not about
  giving the reader a new way to interrupt it.
- The bug producing this report is reproducible on the home page in
  a normal browser environment with at least one subscribed feed
  and the indicator showing a non-zero pending-updates count.
  Reproducing the bug is part of the implementation team's intake;
  this spec defines the post-fix observable contract, not the
  diagnosis.
