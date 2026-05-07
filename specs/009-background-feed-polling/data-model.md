# Phase 1 Data Model: Background Feed Polling

**Feature**: 009-background-feed-polling
**Date**: 2026-05-07

This feature introduces no SQLite schema changes and no client-side
schema changes. All new state lives in per-user Durable Object
storage (the KV-style `ctx.storage.put` / `ctx.storage.get` API).

## Why no schema change

The constitution couples schema and sync (Principle II). Adding
poller-internal columns (`etag`, `last_modified`,
`consecutive_failures`, `next_due_at`) to the `feeds` table would
force matching changes to:

- shared `TABLES_SQL` in `src/shared/schema.ts`
- `bootstrapLocalDb` and the `/api/sync` payload
- the client's local SQLite mirror schema and `pullSync` upserts

…for fields the client never reads. Furthermore, the
`feeds_updated_at` trigger fires on any UPDATE, so writing
poller-internal fields would generate a sync delta on every
conditional 304, polluting the client mirror with no-op churn.

Per-user DO storage is durable across DO hibernation/restart by
design (Cloudflare guarantee), so FR-009 ("polling schedule MUST be
persistent across the per-user data tier sleeping or restarting") is
satisfied without touching tables.

## New DO storage entities

### PollerFeedState

**Storage key**: `poll:feed:<feedId>` (one record per subscribed
feed).

**Fields**:

| Field | Type | Optional | Description |
|---|---|---|---|
| `etag` | `string` | yes | Last `ETag` header observed from a 200 response. Sent on next request as `If-None-Match`. Cleared if origin stops sending it. |
| `lastModified` | `string` | yes | Last `Last-Modified` header observed from a 200 response. Sent on next request as `If-Modified-Since`. |
| `consecutiveFailures` | `number` | no | Count of consecutive failed polls. 0 after any successful poll (200 or 304). Drives the backoff schedule. |
| `lastAttemptAt` | `number` (ms epoch) | yes | Wall-clock time of the most recent poll attempt, regardless of outcome. |
| `lastSuccessfulAt` | `number` (ms epoch) | yes | Wall-clock time of the most recent successful poll (200 or 304). Used for diagnostics and the page-load catch-up trigger. |
| `nextDueAt` | `number` (ms epoch) | no | Earliest wall-clock time at which this feed should be polled again. Computed at write time as `lastAttemptAt + min(baseCadence × multiplier^consecutiveFailures, ceiling)`. The alarm sweep filters feeds by `nextDueAt <= now`. |

**Lifecycle**:

- Created lazily on the first poll attempt for a feed. A feed with no
  record is treated as `nextDueAt = 0` (immediately due).
- Updated atomically inside `fetchFeed` after each attempt, before
  any SSE broadcast. (Atomicity is per-key — the DO `ctx.storage`
  API is single-writer per record.)
- Deleted when the corresponding `feeds` row is deleted (extend
  `DELETE FROM feeds WHERE id = ?` paths to also call
  `ctx.storage.delete('poll:feed:' + id)`).

**Validation rules**:

- `consecutiveFailures` MUST be `>= 0`.
- `nextDueAt` MUST be `>= lastAttemptAt` when both present.
- `etag` and `lastModified` MUST be cleared when a 200 response
  omits the corresponding header (do not retain stale validators).

**State transitions**:

```
                 ┌────────────────────────────────┐
                 │                                │
                 ▼                                │
        ┌────────────────┐  HTTP 200    ┌─────────┴──────────┐
   ◯───▶│  no record yet ├─────────────▶│   healthy state    │
        └───────┬────────┘              │ failures = 0       │
                │ HTTP 304              │ etag / lastModified│
                ▼                       │ updated            │
        ┌────────────────┐              └────────────────────┘
        │   healthy 304  │                 ▲
        │  same content  │                 │
        └────────────────┘                 │ HTTP 200/304
                                           │
                                  ┌────────┴────────┐
                                  │ failed / 5xx /  │
                                  │ network error / │
                                  │ failures += 1   │
                                  │ next_due_at *=  │
                                  │ multiplier      │
                                  │ (clamped to     │
                                  │  ceiling)       │
                                  └─────────────────┘
```

Failing in any way (network error, non-304/non-2xx response, parse
error) increments `consecutiveFailures` and stretches `nextDueAt`.
A 200 or 304 resets `consecutiveFailures` to 0 and computes a fresh
`nextDueAt = lastAttemptAt + baseCadence`.

### AccountActivityMarker

**Storage key**: `poll:account:last_active_at` (one record per DO,
i.e. per user).

**Fields**:

| Field | Type | Optional | Description |
|---|---|---|---|
| `lastActiveAt` | `number` (ms epoch) | no | Wall-clock time of the most recent observed user activity for this account. |

**Lifecycle**:

- Updated on every `/feed-status` request and on every
  authenticated bootstrap path (e.g. `/api/sync`, the existing
  account-bootstrap routes). Updates are coalesced to "at most once
  per minute" to avoid storage churn for chatty SSE clients —
  actual implementation can simply skip the write if the existing
  value is within 60 s of `now`.
- Read by the alarm sweep at the start of every tick. If
  `now - lastActiveAt > ACCOUNT_INACTIVITY_THRESHOLD_MS`, the sweep
  re-arms the next alarm and returns immediately without polling
  any feeds.
- Read by `/feed-status` to decide whether to schedule a page-load
  catch-up sweep (see contract docs).

**Validation rules**:

- `lastActiveAt` MUST be a finite, non-negative number.

## Existing fields used (for traceability)

The poller composes with these existing columns; none change shape:

- `feeds.id` — primary key, used as the `<feedId>` in storage keys.
- `feeds.url` — fetched as-is via `fetchFeedText`.
- `feeds.last_pulled_at` — owned by the existing manual-refresh /
  page-load contract from feature 008. Background polling DOES NOT
  modify this column. The indicator's "n updates" count derives
  from `items.pub_date > feeds.last_pulled_at`, and the only
  legitimate way to advance `last_pulled_at` is the existing client-
  initiated pull/refresh flow.
- `feeds.last_fetched`, `feeds.last_error`, `feeds.last_status` —
  already updated by `fetchFeed`. The poller continues to use them
  as the human-visible "last fetch" diagnostic. They are independent
  of the new poller-internal bookkeeping above.
- `items.guid` + `UNIQUE(feed_id, guid)` — provides the dedup
  guarantee (FR-011) under concurrent manual refresh and background
  sweep. No change.

## Cleanup paths

When a user deletes a feed (`DELETE FROM feeds WHERE id = ?`), the
matching `poll:feed:<feedId>` record MUST be removed. This is a
single `ctx.storage.delete` call added next to each existing
feed-deletion code path.

When a user account is fully deleted (existing
`executeAccountDeletion` flow), the DO calls `ctx.storage.deleteAll()`
which already wipes everything including `poll:*` keys. No new code
required.
