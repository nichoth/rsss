# Feature Specification: Add-feed Should Leave the Reader at Zero, Calmly

**Feature Branch**: `020-add-feed-zero-unread`
**Created**: 2026-05-11
**Status**: Draft
**Input**: User description: "When I add a new feed it spins forever. The
unread count feels like a list of chores — for a new feed it should stay
at 0. Unread should only accumulate from the time the feed is first
added."

## Context

Two problems show up at the same moment in the UI — the moment the
reader subscribes to a new feed:

1. **The "resolving" spinner never terminates.** After clicking `+` and
   submitting a URL, the new sidebar row enters a spinning "resolving"
   state and stays there indefinitely, even across page reload. The
   machinery from spec 018 (server-side 30s sweep, client-side 35s
   convergence) is in the code but is not actually clearing the state
   in practice.

2. **Unread counts feel like a backlog of chores.** A freshly subscribed
   feed should not dump 200 unread items on the reader. Subscribing
   should feel like "tell me what's new from here on," not "here are
   200 articles you haven't read."

This spec bundles both because they share the same UI surface and the
same reader moment.

## Definition of Done

- Adding a new feed never leaves the sidebar in a perpetual spinner.
  Within ~35s, the row is in a terminal state (resolved with title, or
  failed with retry control), and that terminal state survives reload.
- For fast feeds (≤3s server fetch), the row is replaced with the
  resolved title inside the POST response — no spinner is ever shown.
- A newly added feed starts at **0 unread**. The sidebar `(N)` prefix
  and the unread badge are both 0 (or absent).
- Refreshing feeds after subscription only surfaces items that arrived
  *after* the moment of subscription as unread; pre-existing items
  remain marked read.
- The underlying root cause of the current stuck-resolving symptom is
  diagnosed and fixed — not papered over with a longer timeout.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Adding a feed feels instant and calm (Priority: P1)

A reader submits a feed URL via the `+` control. For a normal,
fast-responding feed the new sidebar row appears with the feed's
title already shown — no spinner moment at all — and the unread badge
reads 0. The reader is not confronted with a wall of historical items
they "haven't read."

**Why this priority**: This is the literal user complaint, plus the
fix for the "list of chores" framing. Until both problems are fixed,
adding a feed is a frustrating, anxiety-inducing operation.

**Independent Test**: Add a known-good fast feed (e.g. a public blog
with a healthy RSS endpoint). Confirm that the sidebar row shows the
feed's title within the POST response window (no spinner observed),
and that the unread count is 0. Then add a slower feed; confirm that
even if the spinner is shown briefly, it transitions to the resolved
state with title and 0 unread within ~35s.

**Acceptance Scenarios**:

1. **Given** the reader submits a fast-resolving feed URL (server
   completes initial fetch in under 3 seconds), **When** the POST
   response arrives, **Then** the sidebar row renders directly in
   the resolved state with the feed title visible and the unread
   count at 0, with no spinner observed.
2. **Given** the reader submits a slow-resolving feed URL (server
   fetch exceeds 3 seconds), **When** the POST response arrives,
   **Then** the sidebar row is shown in the resolving state, AND
   **When** the bounded resolution window of ~35s elapses, **Then**
   the row transitions to the resolved state (with title, 0 unread)
   or failed state (with retry control). The row never persists in
   resolving past the window.
3. **Given** any newly added feed has reached its resolved state,
   **When** the reader reloads the page, **Then** the row is shown
   in its resolved state with 0 unread — never in resolving, never
   with a backlog count.

---

### User Story 2 - Unread accumulates only from subscription time forward (Priority: P1)

After subscribing to a feed, the reader sees 0 unread for that feed.
Over time, as the feed publishes new items, the reader sees the unread
count rise. Items that existed in the feed at the moment of
subscription never appear as unread — they remain browseable in the
feed's article list, but flagged read.

**Why this priority**: Without this, the "0 unread on add" rule is
nominal — the next refresh would surface every historical item as
unread. The forward-looking semantics must be persistent.

**Independent Test**: Subscribe to a feed with at least 20 existing
items. Confirm the unread badge shows 0 immediately and after the
next refresh. Wait for (or simulate) a new item being published by
that feed. Refresh or wait for the background poll. Confirm exactly
that one new item appears as unread.

**Acceptance Scenarios**:

1. **Given** the reader has just subscribed to a feed with N
   existing items, **When** the reader views the sidebar, **Then**
   the feed shows 0 unread.
2. **Given** the subscription's initial server fetch has ingested
   the feed's existing items, **When** the reader opens the feed's
   article list, **Then** those items are visible but flagged as
   already-read.
3. **Given** the reader has a subscribed feed at 0 unread, **When**
   the feed publishes a new item and the client receives it (via
   refresh or background poll), **Then** the unread count
   increments by 1 and the `(N)` prefix appears in the sidebar.
4. **Given** a subscribed feed has accumulated unread items, **When**
   the reader opens and reads those items, **Then** the unread count
   decreases accordingly and the `(N)` prefix updates or disappears
   in lockstep with the unread badge.

---

### User Story 3 - The retry control reliably re-attempts a failed resolve (Priority: P1)

A reader looking at a feed in the failed state clicks retry. The row
re-enters resolving and within ~35s lands in either resolved or
failed — never sticks in resolving.

**Why this priority**: Same reasoning as spec 018 Story 2. Without a
working retry that respects the bounded window, transient upstream
failures become permanent dead ends.

**Acceptance Scenarios**:

1. **Given** a feed row in the failed state, **When** the reader
   clicks retry, **Then** the row visibly re-enters the resolving
   state.
2. **Given** retry was clicked and the server can now resolve the
   feed, **When** the resolution window elapses, **Then** the row
   transitions to the resolved state with title and 0 unread (per
   the mark-read rule).
3. **Given** retry was clicked and the server still cannot resolve
   the feed, **When** the resolution window elapses, **Then** the
   row returns to the failed state with the retry control still
   available.

---

### Edge Cases

- **Feed has zero items on initial fetch**: row reaches resolved
  state with 0 unread; nothing to mark as read.
- **Feed parses but has no title metadata**: row reaches resolved
  state, display label falls back to URL, 0 unread.
- **Delete and re-add the same feed**: a fresh subscription. The
  re-add restarts the mark-read boundary; items present in the
  re-add's initial fetch are marked read again, even if they were
  unread in the previous subscription.
- **Subscribe twice to the same URL in quick succession**: existing
  server-side dedup applies; the second add resolves to the existing
  row's terminal state. No new mark-read boundary is established.
- **POST 3s wait succeeds but the fetch result is a failure**:
  response carries the failed state; sidebar shows the failed
  terminal state immediately, no spinner moment.
- **POST 3s wait elapses, background fetch later succeeds, SSE
  drops**: client convergence at ~35s must still surface the
  resolved state. This is precisely the failure mode that motivates
  fixing the underlying async-path bug.
- **Background poll surfaces items with pub_date older than
  subscribed_at**: per the chosen fetch-time boundary rule, those
  items count as unread. We do not use pub_date to derive
  read/unread.
- **Reader had feeds before this change ships**: pre-existing feeds
  retain whatever read state they had on the date of deploy. The
  new mark-read-on-initial-fetch rule applies only to feeds added
  after the change ships.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** (Hybrid POST): The POST `/api/feeds` handler MUST block
  for up to 3 seconds awaiting the server-side initial fetch of the
  newly subscribed feed. If the fetch completes within that window,
  the handler MUST return the feed in its resolved state (with
  `last_fetched` populated, title and other metadata reflected) and
  with the unread count for the feed (which, by FR-003, will be 0).
  If the window elapses first, the handler MUST return the feed in
  its unresolved state as today and let the existing async/SSE/
  convergence path take over.
- **FR-002** (Terminal state by bounded window): Every feed shown in
  the resolving state MUST transition to either resolved or failed
  within ~35s of submission. The resolving state MUST NOT persist
  past this window under any condition. (Inherits and extends spec
  018 FR-001 through FR-009.)
- **FR-003** (Mark-read on initial fetch): When the server-side
  initial fetch of a newly subscribed feed ingests items into the
  user's per-user store, every such item MUST be flagged as
  already-read for that user. This applies only to the initial
  fetch — the one triggered by POST `/api/feeds`. Every subsequent
  fetch (refresh, background poll, retry) MUST NOT auto-mark any
  newly discovered item as read.
- **FR-004** (Forward-looking unread semantics): The unread count
  shown for a feed MUST count only items that were ingested by a
  fetch *other than* the initial subscription fetch and have not
  been marked read by the reader. Pre-existing items ingested by
  the initial fetch MUST NOT contribute to the unread count.
- **FR-005** (`(N)` prefix semantics): The `(N) FeedName` prefix
  introduced in spec 014 MUST be interpreted as the feed's unread
  count. The previous "pending download" semantics from spec 014
  are retired. The visual format, placement, and accessibility
  treatment of the prefix MUST remain unchanged from spec 014.
- **FR-006** (Reload durability of unread state): Read/unread state
  for items in a subscribed feed MUST persist across page reload,
  client restart, and re-authentication. Reloading MUST NOT cause
  pre-existing items to revert to unread.
- **FR-007** (Reload durability of terminal state): A feed whose
  resolve attempt has terminated server-side MUST be rendered in
  its server-recorded terminal state on every subsequent client
  load. (Inherits spec 018 FR-008.)
- **FR-008** (Convergence must actually fire): The client-side
  convergence path that re-syncs feed state at ~35s after submission
  when no terminal-state SSE event has arrived MUST be diagnosed and
  fixed so that it reliably terminates the resolving state in the
  field. This work MUST identify the root cause of the current
  stuck-resolving symptom rather than relying on longer timeouts.
- **FR-009** (Single source of truth for unread count): The unread
  count flowing through the POST `/api/feeds` response (when the 3s
  branch succeeds) MUST be the same per-feed count value that drives
  the `(N)` prefix and that is delivered by the SSE channel for
  ongoing updates. There MUST NOT be a second field or computation
  for the same number.

### Key Entities

- **Feed subscription record (per-user)**: existing per-user feed row
  in the Durable Object SQLite. Retains the resolving/resolved/failed
  state machinery from spec 018. No new top-level fields required
  by this spec — the mark-read rule operates on the item-level
  read state, not on the feed row itself.
- **Item read state (per-user)**: existing per-user, per-item
  read/unread flag in the user's Durable Object SQLite. This spec
  changes the *write rule* at initial-fetch time (auto-flag as
  read), not the storage shape.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of newly added feeds reach a terminal state
  (resolved or failed) within 35 seconds of submission, across a
  representative set of feed URLs covering success, 404, network
  failure, slow upstream, malformed content, redirect,
  empty-metadata, and oversized cases. Zero feeds persist in the
  resolving state past the window.
- **SC-002**: 100% of newly added feeds show an unread count of 0
  immediately after the POST response and after the next refresh.
  Zero newly added feeds surface their historical items as unread.
- **SC-003**: For fast feeds (server fetch ≤3s), the resolved row
  with title appears in the sidebar inside the POST response window
  — the reader observes no spinner moment.
- **SC-004**: After a page reload taken at any point after a feed
  has reached its terminal state, the row is shown in its terminal
  state on first paint. Zero rows revert to resolving.
- **SC-005**: After a page reload, the read/unread state of every
  item is preserved exactly as before the reload. Zero items
  previously marked read revert to unread.
- **SC-006**: When the feed subsequently publishes a new item and
  the client receives it, the unread count for that feed
  increments by 1 within one refresh/poll cycle, and the `(N)`
  prefix updates accordingly.

## Assumptions

- The bounded resolution window (~35s, inherited from spec 018) is
  short enough to feel responsive and long enough to absorb a slow
  but successful upstream. The 3s synchronous wait in the POST
  handler is chosen as the threshold below which an interactive
  submit still feels instant; above 3s the user perceives a stall,
  so the async fallback takes over.
- Per-user read state is already stored server-side in the user's
  Durable Object SQLite. This spec changes when items are flagged
  read on initial fetch; it does not change the storage shape, the
  sync protocol, or the data model for read state.
- The free / current tier stores read state server-side
  exclusively. A future paid-tier spec will add local-first storage
  and a sync protocol (likely modeled around monotonic high-water
  marks on per-feed item ids, since unread counts themselves are
  not monotonic). That future work is explicitly out of scope here.
- The existing visual treatments — spinner with "Resolving feed",
  failed state with retry control, resolved row with title, and the
  `(N) FeedName` prefix from spec 014 — are unchanged. This spec
  changes meaning, not appearance.
- The existing live-event (SSE `feed-updated`) channel continues to
  serve as the optimistic fast path. The new requirement is that
  the client converges on the correct state even when that channel
  is delayed or dropped — i.e. FR-008's diagnosis must identify and
  fix the live failure mode, not just add fallback paths.
- Pre-existing feeds at the moment of deploy retain their current
  read state. The forward-looking mark-read rule applies only to
  feeds added after the change ships. No backfill is performed.
- Subscribing twice to the same URL is already deduplicated on the
  server (spec 018 assumption); this spec does not change that.

## Out of Scope

- Local-first storage of read state for the paid tier; sync protocol
  design for the monotonic counter. (Future spec.)
- Visual changes to the spinner, failed-state, resolved-state, or
  `(N)` prefix treatments.
- Pub_date-based derivation of unread state. (Rejected in favor of
  fetch-time boundary.)
- Backfilling read state for users' pre-existing feeds at deploy.
- Changes to the refresh-feeds mechanism beyond what is required to
  honor the new mark-read rule.

## Relationship to Existing Specs

- **Spec 018 (`feed-resolving-stuck`)**: extended. The terminal-state
  contract stays; this spec adds the 3s synchronous branch in POST
  `/api/feeds` (FR-001) and requires diagnosing the live convergence
  bug (FR-008) rather than only relying on the timeout fallback.
- **Spec 014 (`sidebar-pending-count`)**: semantics superseded. The
  `(N) FeedName` prefix's visual treatment is preserved exactly,
  but the number it shows now means unread count (forward-looking)
  rather than items-not-yet-downloaded. FR-005 is the explicit
  retirement of the previous semantics.

## Open Items for Design Phase

- **Root cause of the current stuck-resolving symptom.** Diagnose
  before designing the fix. Candidates worth investigating: SSE
  subscription timing on new-add, durable-object alarm scheduling,
  client convergence path triggers, message-format mismatches
  between server emit and client handler.
- **Mark-read implementation point.** Whether to flag items as read
  at item-insert time inside the initial fetch handler, or as a
  follow-up pass after ingest. The former is simpler if the fetch
  path is well-isolated.
- **POST response shape when the 3s wait elapses.** Confirm the
  response shape matches what the existing async path expects today
  — i.e. don't introduce a third response shape; reuse the existing
  unresolved-state shape for the fallback branch.
- **Future paid-plan sync model.** Capture a design note (not in
  this spec) that the monotonic counter is likely a high-water-mark
  on per-feed item ids, not the unread count itself, since unread
  counts go down when items are read. Defer to the paid-plan spec.
