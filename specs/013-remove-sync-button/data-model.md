# Phase 1 Data Model: Remove Redundant Sync Button

**Feature**: 013-remove-sync-button
**Date**: 2026-05-08

## Entities

None.

The spec's "Key Entities" section explicitly states: *"This feature
is UI-only and does not introduce, change, or remove any data
entities, schemas, or persisted client/server state."*

Concretely:

- **No DO SQLite schema change.** No tables, columns, or indices
  are added, dropped, or altered in the per-user Durable Object.
- **No client SQLite schema change.** `bootstrapLocalDb` and
  `pullSync` upsert paths are untouched.
- **No `/api/sync` payload change.** The pull/push contract,
  `since` cursor, and conflict-row wrappers are unchanged.
- **No `localStorage` / setting-key change.** The
  `local-first-settings.ts` shape is unchanged; the
  `syncSubscriptions` and `storeContent` keys still exist and still
  drive the two retained toggles.
- **No outbox change.** No mutation is added or removed; the
  `client_op_id` / `client_updated_at` schema is unchanged.
- **No new client signals or signal contract changes.**
  `syncStatus` / `syncError` (in `src/client/db/sync-status.ts`)
  remain the same; the Settings route simply stops *reading* them.
  Other consumers (`<sync-status>` global indicator,
  `sync-cycle.ts`) are unaffected.

## State Transitions

Not applicable. There is no state machine being added, removed, or
modified. The Local Storage section's existing toggle state machine
(off → pending → applied; on → confirm-then-disable) is preserved
exactly as-is.

## Validation Rules

Not applicable. No new fields are introduced and no existing fields
are reinterpreted. The only "validation" is structural: the Local
Storage section, after this change, contains exactly two
configuration toggles (sync-subscriptions, store-content) plus the
existing bootstrap progress / error / retry / warning surfaces, and
nothing else. That is enforced by the manual verification steps in
`quickstart.md`, not by data-layer rules.
