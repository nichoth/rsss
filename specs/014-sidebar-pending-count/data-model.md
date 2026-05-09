# Phase 1 Data Model: Per-Feed Pending Count In Sidebar

## Summary

**No data model changes.** This feature is UI-only and consumes
existing client state. There is no new entity, no new field on an
existing entity, no DO schema change, no `/api/sync` payload change,
and no local SQLite schema change.

## Existing entities consulted (read-only)

### `AppState.feedUpdateCounts` (signal)

- **Type.** `Signal<Record<string, number>>` — keyed by feed ID
  (string), value is the pending-item count for that feed.
- **Defined.** `src/client/state.ts:182` (`feedUpdateCounts:Signal<…>`),
  initialized at `src/client/state.ts:241`
  (`feedUpdateCounts: signal<Record<string, number>>({})`).
- **Producer paths (already implemented; not modified by this
  feature).**
  - SSE `feed-updates-available` event handler in `state.ts` (around
    `state.ts:644-667`), which merges the server's
    `feedUpdateCounts` payload into the signal.
  - `loadFeedStatus` reconcile path (around `state.ts:1277-1285`),
    which authoritatively replaces the signal value with the
    server's snapshot during pull-then-reconcile.
  - Refresh-feeds optimistic clear / restore around
    `state.ts:1399 / state.ts:1441 / state.ts:1691-1694` (clears
    counts inside the manual-refresh `batch()` and either keeps them
    cleared on success or restores `priorCounts` on failure).
- **Reader paths (this feature adds one).**
  - Existing: `FeedStatus` aggregate pill at
    `src/client/components/feed-status.ts:74-75`, which sums all
    values to render the "(N) updates" legend.
  - New: per-row sidebar prefix in
    `src/client/components/sidebar.ts` (the change introduced by
    this feature). Reads
    `state.feedUpdateCounts.value[String(feed.id)] ?? 0` per row.
- **Validation rules.**
  - Values are non-negative integers (producer responsibility; not
    re-validated on the read side).
  - A missing key is semantically equivalent to `0` (FR-002).
- **State transitions.** No new transitions introduced. The existing
  transitions (`{}` ↔ `{ feedId: N }` via the producer paths above)
  are sufficient to drive the new prefix. Refresh-clear and
  background-poll-bump both already happen inside `batch()`, so the
  new prefix and the existing aggregate update in the same render
  pass automatically.

### `Feed` (sidebar row)

- **Type.** Existing `Feed` shape in `src/client/state.ts`. Not
  modified.
- **Fields read by this feature.** `feed.id` (used to key into
  `feedUpdateCounts`) and `feed.title || feed.url` (used as the
  display string the prefix sits in front of). Both are already
  read by the current sidebar render at
  `src/client/components/sidebar.ts:159-181`.

## Validation / invariants the feature relies on

1. `feedUpdateCounts` is the same signal `FeedStatus` sums for the
   aggregate pill (verified in code at `feed-status.ts:74-75`). This
   is what makes FR-003 / SC-002 / SC-003 hold by construction
   without any cross-component coordination.
2. All producer paths that mutate `feedUpdateCounts` write inside a
   `batch()` (verified in the existing refresh-lifecycle and SSE
   tests, e.g. `test/updating-pill-lifecycle.ts`). This guarantees
   the new prefix and the aggregate pill update in the same paint —
   FR-005.
3. The `Feed[]` array in `state.feeds` is the authoritative list of
   feeds the sidebar renders. Deleting a feed removes it from that
   array; the new prefix logic runs per-row, so a deleted feed's
   prefix disappears with the row (FR-007 → Acceptance Scenario 7).

## Out of scope (explicit non-changes)

- DO SQLite schema (`feeds`, `items`, `outbox`, etc.) — unchanged.
- `/api/sync` payload shape — unchanged.
- Local SQLite (OPFS) schema and `bootstrapLocalDb` — unchanged.
- `pullSync` upsert logic — unchanged.
- `localAdapter` / `remoteAdapter` interface — unchanged.
- Any server route — unchanged.
