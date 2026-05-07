# Feature Specification: Background Feed Polling for Accurate Status Indicator

**Feature Branch**: `009-background-feed-polling`
**Created**: 2026-05-07
**Status**: Draft
**Input**: User description: "The 'status' indicator in the app is not working correctly. The last time I updated was yesterday. The Cloudflare backend should have seen updates since then, and the frontend should be told there are updates, and the status should change and say the number of updates."

## Context

Feature 008 ("Fix Up-to-Date Dot Indicator") fixed how the header
"n updates / up to date" pill is computed and transmitted: a single
`/feed-status` request at page load, SSE updates while the app is
open, and an explicit error state on failure. That fix is necessary
but not sufficient.

The indicator's truthfulness depends on the server having an
up-to-date view of each subscribed feed. Today the only mechanism
that brings new items from feed origins into the server's per-user
store is a user clicking "Refresh Feeds". Between manual refreshes
the server cannot know that a feed has published new items, so the
divergence query (`items.pub_date > feeds.last_pulled_at`) returns
zero and the indicator stays green — exactly the bug the user is
reporting.

This feature adds the missing piece: the server itself polls
subscribed feeds in the background so the indicator reflects reality
without requiring a manual refresh.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Returning reader sees accurate "n updates" pill after time away (Priority: P1)

A reader subscribed to several feeds opens the app a day after
their last manual refresh. Some of those feeds have published new
items in the intervening hours. The header indicator should reflect
the truth: "n updates" with the correct count, not "up to date".

**Why this priority**: This is the user-reported bug. Without it,
feature 008 is decorative — the indicator computation is correct but
operates on stale data, so it virtually always shows green between
manual refreshes. Fixing the indicator's data source is the entire
point.

**Independent Test**: Sign in, click "Refresh Feeds", wait past one
polling interval, ensure at least one subscribed feed has published
a new item upstream, reload the app (without clicking Refresh
Feeds), confirm the header shows "n updates" with the correct count.

**Acceptance Scenarios**:

1. **Given** the reader's last manual refresh was N hours ago and a
   subscribed feed has since published items, **When** the reader
   opens the app, **Then** the indicator shows the blue "n updates"
   pill with a count reflecting items the server discovered through
   background polling.
2. **Given** the reader has the app open for an extended period
   without clicking refresh, **When** a subscribed feed publishes
   new items upstream, **Then** the indicator transitions to "n
   updates" within the polling cadence plus the existing live-update
   delivery budget — no manual refresh required.
3. **Given** the reader has zero subscribed feeds, **When** the
   reader opens the app, **Then** the indicator shows "up to date"
   and no polling activity is incurred for that account.
4. **Given** the reader clicks "Refresh Feeds" and the pull
   completes, **When** background polling later runs and finds
   nothing new, **Then** the indicator stays "up to date" with no
   spurious transitions.

---

### User Story 2 - Polling does not waste feed origin resources (Priority: P2)

Background polling must be a good citizen on the open web. Repeated
polls of stable feeds should use conditional HTTP requests so the
origin can answer "nothing changed" cheaply, and feeds that are
failing should be backed off rather than retried at full rate.

**Why this priority**: Important for sustainable operation but
strictly less critical than P1. A correct-but-impolite poller is
still a fix; a polite-but-incorrect one is not. Once P1 is in
place, this story prevents the fix from becoming a problem at scale.

**Independent Test**: Observe a stable feed across multiple
polling intervals; confirm that subsequent polls send conditional
headers and that 304 responses do not trigger re-parsing or
indicator changes. Observe a feed that is failing; confirm
poll cadence lengthens after consecutive failures.

**Acceptance Scenarios**:

1. **Given** a feed responded with `Last-Modified` and/or `ETag`
   on a previous poll, **When** the next scheduled poll runs,
   **Then** the request includes the corresponding conditional
   header and a 304 short-circuits without re-ingesting items.
2. **Given** a feed has returned errors on several consecutive
   polls, **When** subsequent polls are scheduled, **Then** the
   interval between attempts grows (backoff) rather than holding at
   the base cadence.
3. **Given** a transient error on one feed, **When** the polling
   sweep runs, **Then** other feeds in the same sweep continue to
   be polled and the indicator state for healthy feeds is unaffected.

---

### User Story 3 - Inactive accounts do not consume polling budget (Priority: P3)

Accounts that have not been used in a long time should stop
incurring polling work, and resume polling when the user returns.

**Why this priority**: Cost and scale hygiene. Not visible to
active users; matters as the user base grows. Lowest priority
because the system can ship without it (P1 + P2 already deliver a
correct, polite poller; P3 just makes it economical at scale).

**Independent Test**: Identify an account with no recent UI
activity; observe (in operational metrics) that no polling occurs
for that account beyond the inactivity threshold. Sign in to that
account and confirm polling resumes such that the next page load
shows correct counts.

**Acceptance Scenarios**:

1. **Given** an account has had no sign-in or page load within the
   inactivity window, **When** the polling scheduler runs, **Then**
   that account's feeds are not polled.
2. **Given** the same account signs back in, **When** the page
   loads, **Then** polling resumes promptly enough that the
   indicator on that and subsequent loads is accurate per SC-001.

---

### Edge Cases

- A feed publishes a new item between two scheduled polls: the
  indicator must show the update on the next poll, not on the next
  manual refresh.
- A subscribed feed URL becomes invalid (404, DNS failure, malformed
  XML): polling errors must not corrupt the indicator and must not
  block polling of other feeds.
- Two browser tabs are open: both must converge to the same
  indicator state when the server discovers new items via polling.
- A reader subscribes to a brand-new feed: the polling schedule must
  include it promptly so the first scheduled poll happens within
  the standard cadence rather than waiting an entire long cycle.
- The user has been away for days: the first page load must surface
  correct counts — either because polling already discovered items
  during the absence, or because the page-load path triggers an
  immediate catch-up poll if recent polling did not occur.
- Network or origin is offline at poll time: the failure must be
  recorded for backoff and not surfaced as a spurious indicator
  state.
- A scheduled poll discovers zero new items: nothing should change
  in the indicator and no live-update notification should be sent.
- A scheduled poll runs concurrently with a manual "Refresh Feeds"
  for the same feed: the result must be consistent — no duplicate
  items, no lost updates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST discover new items for each subscribed
  feed independently of any user-initiated refresh, so that items
  published between manual refreshes appear in the data the
  indicator reads from.
- **FR-002**: Items discovered by background polling MUST be
  persisted into the same per-user item store the existing
  indicator query reads from, with no new fields or contracts
  required to surface them. The existing `/feed-status` endpoint
  contract from feature 008 MUST remain unchanged.
- **FR-003**: When background polling discovers new items for a
  feed and the user has open clients, the server MUST emit the same
  live-update notification used by feature 008 so live updates
  continue to work without a separate code path.
- **FR-004**: Background polling MUST run on a bounded interval. The
  interval MUST be no shorter than is polite to feed publishers
  (i.e. comparable to common RSS aggregator cadence, not
  high-frequency).
- **FR-005**: Background polling MUST send conditional HTTP requests
  (using `If-Modified-Since` / `If-None-Match` derived from prior
  responses) where the origin supports them, and MUST honor 304
  responses by skipping re-parse and re-ingestion.
- **FR-006**: Per-feed errors during a polling sweep MUST NOT halt
  polling for other feeds and MUST NOT corrupt the indicator's
  state for healthy feeds.
- **FR-007**: Feeds that fail consecutive polls MUST be subject to
  exponential backoff (longer interval after each failure, up to a
  ceiling), resetting to base cadence on the next successful poll.
- **FR-008**: Polling MUST be paused for accounts that have been
  inactive beyond a defined threshold, and MUST resume on the next
  sign-in or page load such that the indicator is accurate within
  the standard page-load latency budget.
- **FR-009**: The polling schedule MUST be persistent across the
  per-user data tier sleeping or restarting — i.e. the system must
  wake the data tier when a poll is due, not rely on an in-memory
  timer that disappears between sessions.
- **FR-010**: A scheduled poll that discovers zero new items MUST
  NOT trigger an indicator transition, MUST NOT emit a live-update
  notification, and MUST NOT modify any per-feed cursor.
- **FR-011**: Background-discovered items MUST be deduplicated
  against the existing item store so that a scheduled poll
  overlapping with a manual "Refresh Feeds" cannot produce
  duplicates or double counts in the indicator.
- **FR-012**: Background polling MUST NOT be gated by entitlement
  tier (free vs. paid). The indicator's accuracy is a baseline
  product requirement and applies to all users.
- **FR-013**: Brand-new subscriptions MUST be incorporated into the
  polling rotation promptly enough that the first scheduled poll
  occurs within the base cadence — they MUST NOT have to wait for a
  full long cycle to be polled the first time.

### Key Entities

- **Subscribed Feed**: An RSS/Atom feed URL associated with a reader
  account. For this feature it gains polling-related metadata:
  the time of the last poll attempt, the time of the last
  successful poll, conditional-request validators returned by the
  origin (`Last-Modified` / `ETag`), and the consecutive-failure
  count used for backoff.
- **Polling Schedule**: The per-account (or per-feed) state
  describing when the next poll is due, adjusted by base cadence,
  per-feed backoff, and account inactivity rules.
- **Discovered Item**: A feed item ingested by a background poll.
  Indistinguishable from an item ingested by a manual refresh once
  stored — the indicator query already counts it correctly.
- **Account Activity Marker**: A per-account "last seen" signal
  (last sign-in or page load) used by the polling scheduler to
  decide whether to skip polling for that account this cycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a reader returns to the app at least one polling
  cadence after their last manual refresh, and any subscribed feed
  has published items in the interim, the indicator shows the
  correct "n updates" pill on first page load in at least 95% of
  sessions, within 2 seconds (preserving feature 008's SC-001
  budget).
- **SC-002**: When a subscribed feed publishes a new item while the
  reader has the app open, the indicator updates to reflect the new
  count within one polling cadence plus the existing 5-second live
  update budget — without any user action.
- **SC-003**: For a steady-state population of stable feeds,
  conditional-GET hit rate (304 responses honored without
  re-parsing) is at least 80% over a typical week, demonstrating
  that polling is not wastefully re-downloading unchanged content.
- **SC-004**: For an account with up to 500 subscribed feeds, a
  full polling sweep completes within the configured base cadence,
  and per-feed origin requests per cadence do not exceed 1 except
  for genuine retry-after-failure cases.
- **SC-005**: Accounts inactive beyond the inactivity threshold
  consume zero polling activity; this is verifiable in operational
  metrics.
- **SC-006**: The share of page loads that incorrectly show "up to
  date" while the server actually has pending items (the reported
  bug) drops to effectively zero, measurable by comparing page-load
  `/feed-status` responses with ground-truth feed origin state
  across a sample.

## Assumptions

- The contract and behavior introduced in feature 008 — single
  round-trip `/feed-status`, SSE-driven live updates, error state
  on failure — are correct and unchanged by this feature. This
  feature only adds the missing data-freshness mechanism behind
  that contract.
- The existing feed-fetch / feed-parse code path used by manual
  "Refresh Feeds" is reusable by the background poller. No new
  parser, no new feed-validation logic.
- Default polling cadence is on the order of minutes to tens of
  minutes (not seconds), aligned with common RSS aggregator
  practice. The exact default is an operator-tunable constant set
  during implementation, not a user-facing setting.
- Inactivity threshold for pausing polling is on the order of
  weeks. Exact value set during implementation; not user-facing.
- Backoff for failing feeds is exponential up to a ceiling; exact
  multipliers and ceiling are implementation details.
- Polling runs entirely server-side. The client does not poll feed
  origins directly; the client continues to rely solely on
  `/feed-status` at page load and SSE while open.
- This feature does not introduce a user-facing settings surface
  for polling cadence or backoff. Cache-policy disclosure from
  feature 007 is read-only and remains as-is.
- The per-user data tier (the user's Durable Object) is the natural
  owner of polling state and the natural place to schedule polls
  for that user's feeds, since per-user item storage already lives
  there. Implementation may choose between per-user scheduling and
  a global scheduler that fans out to users, provided FR-008 and
  FR-009 are satisfied.
