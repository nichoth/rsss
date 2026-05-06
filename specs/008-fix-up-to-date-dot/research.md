# Phase 0 Research: Fix Up-to-Date Dot Indicator

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Date**: 2026-05-05

The Technical Context in plan.md introduced no `NEEDS CLARIFICATION`
markers. This document records the (mostly defensive) research that
validated the chosen approach.

## Decision 1: Source the indicator from a dedicated server endpoint

**Decision**: Add `GET /api/feed-status` (proxied to DO `/feed-status`)
that returns `{ feedUpdateCounts:Record<feedId,number>, totalPending:
number }`, computed from the existing
`UserDO.getFeedUpdateCounts()` query.

**Rationale**: The indicator is intrinsically a server-vs-client
divergence question; the local DB cannot answer it. Today the data
flow is split:

- The remote adapter's `getFeeds()` returns `feedUpdateCounts`.
- The local adapter's `getFeeds()` returns only `{ feeds }`. So in
  local-first mode the indicator state defaults to `{}` -> 'synced' ->
  green, even when the server holds new items the client has not
  pulled. (This is the primary observed bug.)
- Consolidating into one endpoint removes the bifurcation and gives
  us a single point to call on reconcile (online, SSE reconnect,
  refresh-complete).

**Alternatives considered**:

- *Extend `/api/feeds` to always return counts and have local-first
  also call it.* Workable, but couples the indicator to a
  feeds-list refresh, and would force every reconcile to also
  re-shuttle the feeds list. Rejected for cost and coupling.
- *Compute the count in the local DB by tracking a per-feed
  `last_known_server_max_pub_date`.* Requires a new local schema
  column and a migration in `bootstrapLocalDb`/`pullSync`, plus
  server cooperation to ship the marker. Heavier change for the same
  user-visible result; rejected.
- *Per-feed status requests fanned out from the client.* Directly
  forbidden by FR-010 / SC-004.

## Decision 2: Authoritative pulled-state marker is `feeds.last_pulled_at`

**Decision**: Reuse the existing `feeds.last_pulled_at` column, set
by `advanceFeedCursor()` after a feed-level pull, as the per-feed
pulled-state marker. Pending count = `COUNT(items WHERE pub_date >
last_pulled_at OR last_pulled_at IS NULL)`.

**Rationale**: The migration is already in place
(`migrateAddLastPulledAt`), `getFeedsWithUpdates()` and
`getFeedUpdateCounts()` already use this comparison, and the existing
SSE clear-path (`feed-updates-cleared`) is wired to it. Reusing it
keeps the change limited to "expose this number through one new
endpoint".

**Alternatives considered**:

- A new `last_seen_item_id` cursor: more precise on backdated items
  but overkill for the indicator and would require a backfill.

## Decision 3: SSE `feed-updates-available` carries counts and fires per insert

**Decision**: Change the broadcast to include the per-feed pending
count (`{ feedUpdateCounts: { [feedId]: number } }` for the affected
feed(s)) and remove the `wasAlreadyUnsynced` short-circuit so a feed
already in the unsynced set still triggers a count update when
additional items arrive.

**Rationale**: Acceptance Scenario 2.2 requires the count to grow as
more items arrive. Today the client increments by `1` per `feedId`
seen, and the server suppresses re-broadcasts once a feed is in the
unsynced set, so the displayed total drifts arbitrarily far from
reality. Sending the canonical count from the server makes the client
a passive renderer of state and removes the increment-arithmetic
class of bug.

**Alternatives considered**:

- *Keep the current event shape, have the client refetch
  `/feed-status` on every event.* More round trips, slower feel for
  the typical case where the server already knows the answer.
- *Send a delta (`{ feedId, delta }`).* Requires client and server to
  agree on every operation that mutates the count; more failure
  modes than just sending the absolute number.

## Decision 4: Reconcile on SSE reconnect via `loadFeedStatus()`

**Decision**: Reconcile by calling `State.loadFeedStatus(state)` on
every successful `EventSource` `open` after the first one (i.e.
auto-reconnect). The same function runs on the `online` event and
after `refresh-complete`.

**Rationale**: FR-007 requires reconciliation after disconnect/
reconnect because best-effort SSE may drop events. Re-running the
single status call is cheap and the simplest correct option.

**Alternatives considered**:

- Server-side "missed event replay" with sequence numbers:
  significantly larger change for a feature whose authoritative
  answer is already one query away.

## Decision 5: Page-load failure surfaces an error, never green

**Decision**: When `loadFeedStatus()` rejects, set
`feedSyncStatus = 'error'` and `feedSyncError = <message>`. The
existing `<FeedStatus>` component already renders an `error` state
("sync failed", red dot); this is a wiring change, not a new visual.

**Rationale**: FR-012 / SC-006 forbid the indicator from defaulting to
green on failure. The current code path falls through to whatever was
there before (initially `inactive`, after a successful load
`synced`), which is exactly the "silently lying green" failure mode
the spec calls out.

**Alternatives considered**:

- A new `unknown` state with a distinct visual: defensible but adds
  surface area without obvious user benefit; the existing `error`
  state already communicates "do not trust this number".

## Decision 6: No schema or migration change

**Decision**: Ship without altering the DO schema, the
`/api/sync` payload, `bootstrapLocalDb`, the local SQLite schema, or
`pullSync`.

**Rationale**: All the required server data is already columns in
`feeds` (`last_pulled_at`) and `items` (`pub_date`). The constitution's
"schema and sync changes are coupled" rule (Principle II / Workflow)
applies only when adding or modifying a column the client renders,
which we are not doing.
