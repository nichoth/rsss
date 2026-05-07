# Phase 0 Research: Background Feed Polling

**Feature**: 009-background-feed-polling
**Date**: 2026-05-07

This document resolves the implementation unknowns surfaced in the
spec's Functional Requirements and Assumptions. Each section follows
the Decision / Rationale / Alternatives format.

## 1. Polling cadence (FR-004)

**Decision**: Keep the existing base cadence of 10 minutes
(`FEED_REFRESH_INTERVAL_MS = 10 * 60 * 1000` in
`src/server/durable-objects/index.ts`). No new constant introduced.

**Rationale**: The constitution (Principle III) already locks the v1
cadence at 10 minutes. The DO alarm is already wired to that constant.
Common RSS aggregators (Feedly, Inoreader free tier, NetNewsWire) sit
in the 10-60 minute range; 10 minutes is on the polite side of that
band. No spec requirement asks for a different default.

**Alternatives considered**:

- 30 or 60 minutes — politer but stretches SC-002 ("within one
  polling cadence + 5 s") to a worse user experience while open.
  Rejected.
- Adaptive cadence per feed (faster for high-volume, slower for low-
  volume) — interesting but unnecessary complexity for v1; backoff on
  failure already covers the only required adaptive case (FR-007).

## 2. Per-feed backoff schedule (FR-007)

**Decision**: Exponential backoff keyed on a per-feed
`consecutive_failures` counter, applied as
`nextDueAt = lastAttemptAt + min(baseCadence * 2^consecutive_failures, ceiling)`
with a ceiling of **24 hours**. Reset to base cadence on the next
successful poll (HTTP 200 or 304).

**Rationale**: 2× per failure is the standard exponential-backoff
default and matches what most aggregators do for dead feeds. A 24-
hour ceiling keeps a permanently dead feed from spamming the origin
indefinitely while still allowing recovery within a day. Resetting
on either 200 or 304 is correct because a 304 is a *successful*
poll — the conditional GET worked and the feed is reachable.

**Alternatives considered**:

- Fixed N-attempt cap before disabling the feed — rejected. We do
  not want to silently drop a user's subscription; a slow recovery
  is better than a silent disappearance.
- Linear backoff (cadence × n) — rejected. Diverges too slowly for
  a feed that has been gone for a week; ends up generating ~1000
  pointless requests over that span.
- Jitter on backoff intervals — useful in fleet polling to avoid
  thundering herds, but redundant here: each user's DO has its own
  alarm phase and the per-feed sweep already serializes within a DO,
  so origins do not see a synchronized fleet.

## 3. Account inactivity threshold (FR-008)

**Decision**: An account that has not signed in nor loaded a page in
**30 days** is considered inactive. While inactive, the alarm sweep
finds zero due feeds (because the inactivity gate short-circuits the
sweep) and re-arms itself to the standard cadence — there is no need
to disable the alarm itself. On the next sign-in or page load, the
inactivity gate flips and the next alarm tick (within the cadence) or
the page-load catch-up (see §6) discovers the new items.

**Rationale**: 30 days matches typical "dormant user" billing/
re-engagement boundaries and is long enough that it cannot be
accidentally tripped by a user simply taking a vacation. It is short
enough that genuinely abandoned accounts stop incurring origin
requests on the order of weeks rather than months, satisfying SC-005.

**Alternatives considered**:

- 7 days — too aggressive. Vacation-length absence would falsely
  pause polling and trigger the catch-up path on every return.
- 90 days — too lax for cost discipline at scale. Rejected.

## 4. Where to store poller bookkeeping (FR-009 + Constitution II/III)

**Decision**: Per-feed poller state (`etag`, `last_modified`,
`consecutive_failures`, `next_due_at`, `last_attempt_at`,
`last_successful_at`) lives in **per-user DO storage (KV-style API,
`ctx.storage.put` / `ctx.storage.get`)**, keyed as
`poll:feed:<feedId>`. Per-account inactivity marker lives at the
single key `poll:account:last_active_at`. None of these fields are
added to the SQLite `feeds` table.

**Rationale**:

1. The `feeds` table is mirrored to the client via `/api/sync`. Any
   column added there must flow through the schema-and-sync coupling
   contract from Constitution II ("Schema and sync changes are
   coupled" — README, plan-template). Poller bookkeeping is server-
   internal; the client has no use for `etag` or
   `consecutive_failures`. Putting it on the table forces a client
   schema migration and bootstrap/pullSync changes for data the
   client will never read.
2. The `feeds_updated_at` trigger fires on any `UPDATE feeds`. If
   poller fields lived on that table, every conditional 304 would
   bump `feeds.updated_at` and produce a meaningless sync delta to
   the client. KV-style DO storage avoids that entirely.
3. Cloudflare DO `ctx.storage` is durable across hibernation and
   restart by design, so FR-009 ("persistent across the per-user data
   tier sleeping or restarting") is satisfied by construction.

**Alternatives considered**:

- New columns on `feeds` (`etag`, `last_modified_header`,
  `consecutive_failures`, `next_due_at`) — simpler to query in SQL
  but blows up the surface (shared schema, bootstrap, pullSync,
  client schema, client trigger), and pollutes the client mirror
  with poller-internal fields. Rejected.
- A new SQLite table `poller_state(feed_id, ...)` inside the DO,
  *not* synced to the client — workable and queryable, but the join
  against `feeds` to filter "due now" gives no real win over a
  per-feed KV read inside the existing batch loop, and KV avoids
  introducing a new schema migration. Rejected for v1; can be
  revisited if the per-feed KV reads become a hotspot.

## 5. Conditional HTTP requests (FR-005)

**Decision**: Extend `fetchFeedText` (in `src/server/feed-fetch.ts`)
to accept an optional `validators` input
(`{ etag?:string; lastModified?:string }`) and to return a richer
result that includes (a) whether the response was 304, (b) the new
validators read from the response headers, and (c) the body text
(empty string on 304). The caller (`UserDO.fetchFeed`) reads the
prior validators from DO storage, passes them in, and on a 304
returns early without re-parsing or re-ingesting items.

**Rationale**: Conditional GETs are an HTTP-layer concern; surfacing
them at the `fetchFeedText` boundary keeps the DO logic clean and
keeps `fetchValidatedResponse` (the redirect/security loop) unchanged.
A 304 must pass the redirect security checks just like any other
response, so threading the conditional headers through the existing
loop is mandatory.

**Concrete behavior**:

- Request adds `If-None-Match: <etag>` and/or
  `If-Modified-Since: <last_modified>` when validators are provided.
- A 304 response is treated as success (not as `!response.ok`-throws),
  short-circuiting the bounded-text read.
- The new ETag/Last-Modified headers from a 200 response are returned
  to the caller for storage.

**Alternatives considered**:

- Build conditional GET inside the DO instead of in `feed-fetch.ts`
  — would duplicate the redirect loop's response handling. Rejected.
- Use the Cloudflare `Cache` API instead of explicit conditional GETs
  — harder to reason about freshness for per-feed semantics, and
  doesn't actually answer "are there new items" without a parse step.
  Rejected.

## 6. Page-load catch-up after inactivity / cold start (FR-008 + spec edge case "user away for days")

**Decision**: On `/feed-status` (the page-load indicator endpoint
from feature 008), after computing and returning the response, the
DO writes `poll:account:last_active_at = now` and, if either of the
following is true, schedules a non-blocking sweep via
`ctx.waitUntil`:

1. The previously-stored `last_active_at` was older than the
   inactivity threshold (i.e. the account was paused), OR
2. There has been no successful poll across any feed within the past
   base cadence (e.g., DO was hibernated for hours and the alarm
   didn't fire for whatever reason).

The sweep itself is the same `refreshFeedBatches` machinery used by
the alarm, run as background work — so the page response is *not*
delayed.

**Rationale**: SC-001 requires correct counts within 2 s of page
load in the "returning after a day" scenario. Two complementary
mechanisms cover this:

- The DO alarm fires on the cadence and accumulates new items
  proactively, which is the steady-state correctness path.
- The catch-up trigger handles the cold-start edge: a user who has
  been inactive past the threshold has no recent alarm activity (the
  inactivity gate skipped sweeps), and the first page load needs to
  prime the pump immediately rather than waiting for the next 10-min
  alarm. Same for an alarm that for any reason hasn't run recently.

The catch-up is *background work*; the page load completes against
whatever is already in the DO, then the SSE channel from feature 008
delivers the count update once the catch-up finds new items. This
preserves the SC-001 2-second budget by design.

**Alternatives considered**:

- Block the `/feed-status` response on a synchronous catch-up — would
  break the 2-second SC-001 budget on returning users, who are the
  exact case this feature targets. Rejected.
- Trigger catch-up on auth bootstrap instead — works for the sign-in
  edge but not the case where a user keeps the app open across
  multiple cadences and the alarm somehow lapses. The `/feed-status`
  call is the right hook because it is the indicator's freshness
  contract by feature 008.

## 7. New-subscription prompt polling (FR-013)

**Decision**: No code change required. The existing
`POST /feeds` handler already runs `this.ctx.waitUntil(this.fetchFeed(...))`
synchronously on add (line 710 in
`src/server/durable-objects/index.ts`). After this initial fetch,
the per-feed `next_due_at` is set to `now + baseCadence`, so the
feed enters the standard rotation immediately. We document this
behavior and add a regression test rather than implementing new
logic.

**Rationale**: The spec's FR-013 is about avoiding a long initial
wait, which is already satisfied. Documenting + testing it ensures
that future refactors to the add-feed path do not break the
property.

**Alternatives considered**: none material.

## 8. Concurrency between manual refresh and background sweep (FR-011 + spec edge case)

**Decision**: Rely on the existing dedup mechanisms:

- `INSERT OR IGNORE INTO items (...)` plus the `UNIQUE(feed_id, guid)`
  constraint guarantee no duplicate items (FR-011) regardless of
  which path inserted first.
- The existing `manualRefreshClaims` map already coalesces in-flight
  manual refreshes for the same feed. We extend the same mechanism
  to also dedupe the alarm sweep against a concurrent manual refresh
  — if a manual refresh is in flight for a feed when the alarm
  reaches it, the alarm skips that feed and lets the manual refresh
  complete.

**Rationale**: This costs nothing (we already have the map) and
prevents two simultaneous outbound requests for the same feed, which
would be a politeness violation (FR-004 spirit) even though it would
not produce duplicate rows.

**Alternatives considered**: A SQLite advisory lock per feed —
overkill for this scale (per-user DO, single execution context).

## 9. SSE broadcast and indicator no-op on 304/zero-new (FR-010)

**Decision**: Keep the existing rule: only broadcast
`feed-updates-available` and only update item counts when
`newItems.length > 0`. On a 304 response, return early before reaching
that code path; on a 200 response with zero new items (everything
matched the unique constraint), the existing `if (newItems.length >
0)` guard already suppresses the broadcast.

**Rationale**: This is a property of the existing implementation
that we preserve. Documented here to make FR-010 traceable.

**Alternatives considered**: Always emit a tick — rejected, would
defeat FR-010.

## Summary of constants introduced

Stored next to existing constants in
`src/server/durable-objects/index.ts`:

| Name | Value | Purpose |
|------|-------|---------|
| `FEED_REFRESH_INTERVAL_MS` | `10 * 60 * 1000` (existing) | Base cadence for alarm and per-feed `next_due_at`. |
| `FEED_BACKOFF_MULTIPLIER` | `2` (new) | Exponential factor per consecutive failure. |
| `FEED_BACKOFF_CEILING_MS` | `24 * 60 * 60 * 1000` (new) | Maximum interval between attempts for a failing feed. |
| `ACCOUNT_INACTIVITY_THRESHOLD_MS` | `30 * 24 * 60 * 60 * 1000` (new) | Inactivity window after which the sweep is skipped for an account. |

All four are operator-tunable constants, not user-facing settings
(per spec Assumptions).
