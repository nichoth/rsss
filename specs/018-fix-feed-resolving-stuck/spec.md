# Feature Specification: Newly Added Feeds Must Reach a Terminal State

**Feature Branch**: `018-fix-feed-resolving-stuck`
**Created**: 2026-05-10
**Status**: Draft
**Input**: User description: "The 'resolving' state when I add a new feed never resolves. Just spins forever."

## Context

When a reader subscribes to a new feed, the sidebar shows the new
entry with a spinner and the accessible label "Resolving feed". That
visual state represents an in-flight first fetch: the server has
recorded the subscription but has not yet successfully fetched and
parsed the feed at least once.

The "resolving" cue is meant to be transient. Within a short, bounded
window after the reader submits the URL the row should transition to
one of two terminal states:

1. **Resolved** — the spinner disappears, the row shows the feed
   title (not just the URL), and the reader can click into it as a
   normal subscribed feed.
2. **Failed** — the spinner is replaced by a "Failed to fetch" label
   and a retry control, so the reader knows the attempt is over and
   what they can do next.

The reader is reporting that the resolving state does not terminate.
Both freshly added feeds in the screenshot continue to display the
spinner indefinitely, including across page refresh. There is no
indication of success and no indication of failure. From the reader's
perspective, adding a feed is broken: they cannot tell whether the
system is still working on it, whether the request was lost, or
whether the feed is unreachable.

Because the "resolving" indicator was introduced in the most recent
"fix add feed flow" change, this regression is highly visible: every
newly added feed exhibits it, and there is no escape hatch in the UI
to clear or retry the stuck row except deleting and re-adding the
feed (which reproduces the same stuck state).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A newly added feed reaches a terminal state quickly (Priority: P1)

A reader clicks the "+" control, types a feed URL, and submits the
form. The new feed appears in the sidebar in its "resolving" state.
Within a short, bounded window the row transitions to either the
resolved state (with title and clickable list entry) or the failed
state (with "Failed to fetch" label and retry control). It never
remains in the resolving state indefinitely.

**Why this priority**: This is the literal user complaint. Until
every added feed is guaranteed to reach a terminal state, the
"resolving" cue is worse than no cue at all — it tells the reader
work is happening when in fact the row may be permanently stuck. No
secondary improvement matters until this is fixed.

**Independent Test**: Add a known-good feed URL (e.g. a public blog
or wire service that publishes RSS). Without taking any further
action, watch the sidebar row. Confirm that the spinner disappears
and is replaced by the feed's title within the bounded resolution
window. Repeat with multiple known-good feeds in sequence to confirm
the behaviour is reliable, not occasional.

**Acceptance Scenarios**:

1. **Given** the reader submits a valid feed URL that the server can
   successfully fetch and parse, **When** the resolution window
   elapses, **Then** the sidebar row shows the feed title (not the
   URL), the spinner is gone, and the row behaves like any other
   subscribed feed (clickable, eligible for refresh, eligible for
   delete).
2. **Given** the reader submits a feed URL that cannot be resolved
   (404, network failure, malformed feed, unsupported content),
   **When** the resolution window elapses, **Then** the sidebar row
   shows "Failed to fetch" with a retry control and the spinner is
   gone.
3. **Given** the reader submits a feed and then immediately reloads
   the page, **When** the resolution window has elapsed since the
   original add, **Then** the reloaded sidebar shows the row in its
   appropriate terminal state — never in the resolving state — and
   the terminal state matches what would have been shown without
   the reload.
4. **Given** any resolving row on screen, **When** the bounded
   resolution window elapses with no server response, **Then** the
   row transitions to the failed state (with retry control)
   regardless of why the server did not respond — there is no
   condition under which the resolving state persists past the
   window.

---

### User Story 2 - The retry control reliably re-attempts a stuck or failed resolve (Priority: P1)

A reader looking at a feed in the failed state clicks the retry
control. The row enters the resolving state again, and within the
bounded resolution window it transitions to either resolved or
failed — including the same guarantee from Story 1 that it never
sticks in resolving.

**Why this priority**: P1 because without a working retry, a reader
whose feed lands in the failed state for a transient reason
(temporary upstream outage, briefly broken DNS) has no recovery
except to delete and re-add. Worse, if retry itself can get stuck in
resolving, the reader is back to the original bug after a single
click.

**Independent Test**: Add a feed URL that fails on first attempt
(e.g. simulate by temporarily pointing it at a 404 URL, then making
that URL respond correctly). Click retry. Confirm the row transitions
through resolving and lands in the resolved state with the feed
title. Then induce another failure on a different row, click retry,
and confirm the row lands back in failed with a retry control still
available — the bug from Story 1 must not reappear via the retry
path.

**Acceptance Scenarios**:

1. **Given** a feed row in the failed state, **When** the reader
   clicks retry, **Then** the row visibly re-enters the resolving
   state and the spinner returns.
2. **Given** retry was clicked and the server can now resolve the
   feed, **When** the resolution window elapses, **Then** the row
   transitions to the resolved state with title.
3. **Given** retry was clicked and the server still cannot resolve
   the feed, **When** the resolution window elapses, **Then** the
   row returns to the failed state with the retry control still
   present, and the resolving state does not persist past the
   window.

---

### User Story 3 - The terminal state survives reload, navigation, and SSE interruption (Priority: P2)

The resolved or failed state of a feed is durable. Once the system
has recorded a terminal outcome, that outcome is what the reader
sees on every subsequent visit — even if the reader reloads, closes
and reopens the app, navigates away and back, or has a flaky live-
event connection during the resolution window.

**Why this priority**: P2 because Story 1 already requires a
bounded resolution window per session. This story protects against
a subtler failure mode: the server may have actually completed the
fetch successfully, but the client's view of "did it resolve?"
depends on a live-update channel that can drop. If the client can
get permanently confused about a server-side fact, the resolving
spinner can come back forever on the next page load even after a
successful fetch.

**Independent Test**: Add a feed. Before the resolution window
elapses, disable the network briefly (or otherwise interrupt the
live-event channel), then re-enable. Reload the page. Confirm the
row is now in its correct terminal state on the reloaded view, not
back in resolving. Repeat with the failed terminal state.

**Acceptance Scenarios**:

1. **Given** the server has successfully fetched a newly added
   feed, **When** the reader reloads the page at any later time,
   **Then** the row is shown in the resolved state — never in the
   resolving state — regardless of whether the client previously
   received the live-update event for that feed.
2. **Given** the server has recorded a failure for a newly added
   feed, **When** the reader reloads the page, **Then** the row is
   shown in the failed state with the retry control.
3. **Given** the live-event channel disconnects during the
   resolution window, **When** the channel reconnects or the reader
   reloads, **Then** the client recovers and shows the correct
   terminal state without manual intervention.

---

### Edge Cases

- **Feed parses successfully but has no title, description, or link
  metadata**: row must still reach the resolved terminal state
  (showing the feed URL as the display label), not stay in
  resolving.
- **Server responds with "not modified" / no new content on the
  first fetch**: counts as a successful initial resolve; the row
  must reach the resolved terminal state.
- **Feed payload exceeds size limits**: row must reach the failed
  terminal state with a retry control, not persist as resolving.
- **Item-insertion error after metadata fetch succeeded**: row must
  reach a terminal state (resolved or failed); the partially-
  ingested row must not be left as resolving.
- **Server-side fetch throws an unhandled exception**: row must
  reach the failed terminal state; an internal crash must not leave
  the row in resolving.
- **Reader subscribes to the same URL twice in quick succession**:
  the second add must not produce an additional stuck resolving row;
  it should resolve to the existing row's terminal state.
- **Reader adds many feeds in rapid succession**: every row must
  individually reach a terminal state within the bounded window;
  none may remain in resolving.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every feed shown in the resolving state MUST
  transition to either the resolved state or the failed state within
  a bounded resolution window measured from the moment the
  subscription was first submitted. The resolving state MUST NOT
  persist past this window under any condition (success, failure,
  partial success, network interruption, server crash).
- **FR-002**: When the server successfully completes the initial
  fetch of a newly added feed (the fetch returns a usable response
  and the feed is parseable), the feed's resolved state MUST be
  recorded server-side in a way that survives client reload — i.e.
  loading the feed list at any later point MUST surface the row in
  the resolved state.
- **FR-003**: When the server cannot complete the initial fetch
  (network failure, non-2xx response, unparseable feed, timeout,
  exceeded size limits, unhandled internal error), the feed's
  failed state and the failure reason MUST be recorded server-side
  so that subsequent client loads MUST surface the row in the
  failed state with the retry affordance.
- **FR-004**: A feed whose initial fetch succeeds but yields no
  parseable title, description, or link metadata MUST still be
  recorded as resolved (not failed, not perpetually resolving). The
  sidebar MUST render such rows in the resolved state using the
  feed URL as the display label.
- **FR-005**: A feed whose initial fetch is short-circuited by a
  conditional-response path (e.g. server-cached "no new content"
  result on first contact) MUST still be recorded as resolved if
  the underlying response indicates the feed was reachable; the
  resolving state MUST NOT be the outcome of a successful
  conditional fetch.
- **FR-006**: When the live-event channel that normally signals
  "fetch complete" is unavailable or delayed, the client MUST still
  arrive at the correct terminal state for any resolving row within
  the bounded resolution window — either by re-querying the server
  for the row's status, by reload, or by another mechanism. The
  client MUST NOT depend solely on receiving a live event.
- **FR-007**: The retry control on a failed feed MUST trigger a
  new resolve attempt that is itself subject to FR-001 through
  FR-006. Retry MUST NOT be able to leave a row stuck in resolving.
- **FR-008**: When the reader reloads the page or navigates away
  and back, any feed whose resolve attempt has terminated server-
  side MUST be rendered in its server-recorded terminal state.
  Reload MUST NOT cause a row that previously reached a terminal
  state to revert to resolving.
- **FR-009**: When the resolving state is rendered, an
  accessibility cue MUST continue to communicate "resolving feed"
  to assistive technology, exactly as it does today; the
  introduction of a bounded fallback to failed MUST NOT regress
  the existing screen-reader experience for the legitimate
  in-flight window.

### Key Entities

- **Feed subscription record**: per-user persistent record of a
  feed URL. Carries fields that distinguish resolving, resolved,
  and failed states. The client renders the sidebar row from this
  record, so the record's state at server-load time is what the
  reader sees after reload.
- **Resolve attempt**: the server-side initial fetch triggered when
  a feed is first added (or when retry is invoked). Has exactly
  one outcome per attempt: success (record marked resolved),
  failure (record marked failed with reason), or in-flight (record
  marked resolving). "In-flight" MUST be a transient state with a
  bounded lifetime; it is not a valid persistent outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of feeds added via the add-feed form reach a
  terminal state (resolved or failed) within the bounded resolution
  window. Zero rows persist in the resolving state past the window
  across a representative set of feed URLs covering success, 404,
  network failure, slow upstream, malformed content, redirect,
  empty-metadata, and oversized cases.
- **SC-002**: After a page reload, 100% of rows that previously
  reached a terminal state in a prior session are shown in their
  correct terminal state on first paint. Zero rows revert to the
  resolving state after reload.
- **SC-003**: The retry control returns a previously failed row to
  resolved (when the upstream condition is fixed) or back to failed
  (when it is not) on 100% of attempts. Zero attempts leave the row
  in resolving past the window.
- **SC-004**: A reader watching the screen after submitting a new
  feed can identify, without scrolling or opening developer tools,
  whether the feed succeeded or failed within the bounded
  resolution window. No outcome requires the reader to wait
  indefinitely or refresh the page to discover the result.

## Assumptions

- The bounded resolution window is short enough to feel responsive
  for normal feeds and long enough to absorb a slow but successful
  upstream. A specific numeric ceiling will be decided during
  planning; the spec requires only that such a bound exist and be
  enforced.
- The existing visual treatments — spinner with "Resolving feed"
  label, "Failed to fetch" label with retry control, and resolved
  feed row with title — are unchanged by this feature. The fix is
  to the state machine that governs transitions between them, not
  to the visual design.
- The existing live-event ("feed-updated") channel continues to
  serve as the optimistic fast path. The new requirement is that
  the client does not depend on it for correctness — it must still
  converge on the correct terminal state when the channel is
  delayed, dropped, or never delivers the event.
- Per-user server-side storage already records `last_fetched` and
  `last_error` on the feed row. The fix may extend these fields,
  introduce additional fields, or change which code paths write
  them, but the client's rule for distinguishing the three states
  from the feed row can be adjusted as part of the work.
- Subscribing twice to the same URL is already deduplicated server-
  side; this feature does not change that behaviour.
