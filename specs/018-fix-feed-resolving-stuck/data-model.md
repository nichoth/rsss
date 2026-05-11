# Data Model — 018-fix-feed-resolving-stuck

This feature does **not** add or remove columns. It clarifies and
enforces the existing feed-row state machine on both sides of the
client/server boundary.

## Entity: `feeds` row

Server-side and client-side definitions are aligned through
`src/shared/schema.ts:38-50`:

| Column         | Type     | Nullable | Notes                                          |
|----------------|----------|----------|------------------------------------------------|
| `id`           | INTEGER  | NO       | PK                                             |
| `url`          | TEXT     | NO       | unique; idempotency key for add-feed           |
| `title`        | TEXT     | YES      | parsed feed title                              |
| `description`  | TEXT     | YES      | parsed feed description                        |
| `site_url`     | TEXT     | YES      | parsed feed link / site URL                    |
| `last_fetched` | TEXT     | YES      | ISO timestamp; **terminal-success marker**     |
| `last_pulled_at` | TEXT   | YES      | client-set; orthogonal to this feature         |
| `last_error`   | TEXT     | YES      | error message; **terminal-failure marker**     |
| `last_status`  | INTEGER  | YES      | HTTP / synthetic status code paired with error |
| `created_at`   | TEXT     | NO       | row insert time; used by sweep predicate       |
| `updated_at`   | TEXT     | NO       | trigger-maintained                             |

## State machine

The triple (`last_fetched`, `last_error`) encodes the three observable
states. The client predicate is the source of truth for rendering and
already exists at `src/client/components/sidebar.ts:166-170`:

```text
            last_error IS NULL    last_error IS NOT NULL
          ┌─────────────────────┬──────────────────────────┐
last_     │  RESOLVING          │  FAILED                  │
fetched   │  (sidebar.ts:166-7) │  (sidebar.ts:169-70)     │
IS NULL   │  show spinner       │  show "Failed to fetch"  │
          │  + "Resolving feed" │  + retry control         │
          ├─────────────────────┼──────────────────────────┤
last_     │  RESOLVED           │  RESOLVED                │
fetched   │  (everything else)  │  (stale error;           │
IS NOT    │  show title         │   ignored once we have   │
NULL      │                     │   a successful fetch)    │
          └─────────────────────┴──────────────────────────┘
```

### Allowed transitions

```text
   POST /api/feeds (server INSERT)
         │
         ▼
   ┌───────────┐  fetchFeed success (metadata or none, parsed or 304)
   │ RESOLVING │ ──────────────────────────────────────────────► RESOLVED
   │ created_  │       fetchFeed failure / sweep / item-insert err
   │ at = T    │ ──────────────────────────────────────────────► FAILED
   └───────────┘       T + RESOLVE_WINDOW_MS elapsed, sweep ──►  FAILED
                       (synthetic 504, "Initial fetch did not
                        complete")

   ┌──────────┐  retry (POST /api/feeds/:id/refresh) success ─►  RESOLVED
   │  FAILED  │  retry failure (different reason) ─────────────► FAILED
   └──────────┘  retry transitions back through RESOLVING for ~window

   ┌──────────┐  refresh success ─────────────────────────────► RESOLVED
   │ RESOLVED │  refresh failure ─────────────────────────────► RESOLVED
   │          │  (last_error written, but last_fetched stays set,
   │          │   so client still classifies as RESOLVED)
   └──────────┘
```

Two invariants this feature enforces:

1. **No row stays in `RESOLVING` past `RESOLVE_WINDOW_MS`** measured
   from `created_at`. Enforced by the DO `alarm()` sweep
   (`research.md` Decision 3).
2. **Every successful `fetchFeed` writes `last_fetched`**, regardless
   of whether the feed has metadata or returned 304. Enforced by
   `fetchFeed` itself (`research.md` Decisions 6 and 7).

### Synthetic terminal value: `RESOLVE_TIMEOUT`

When the sweep marks a row failed:

```sql
UPDATE feeds SET
    last_error  = 'Initial fetch did not complete',
    last_status = 504
WHERE id = ?
  AND last_fetched IS NULL
  AND last_error IS NULL
  AND created_at < datetime('now', '-30 seconds');
```

The client treats this row identically to any other failed row.
The retry control (`State.retryResolveFeed`) is wired to
`POST /api/feeds/:id/refresh`, which re-enters the state machine at
`RESOLVING` and is subject to the same bounded window (FR-007).

## Sync payload

The `/api/sync` GET response already serializes all columns above via
`FEED_SYNC_COLUMNS` (`src/server/durable-objects/index.ts:117-120`).
This feature changes how the client *persists* the payload but not
the payload itself. The new `POST /api/feeds/:id/refresh` response
shape is documented in `contracts/refresh-response.md`.

## Local SQLite migration (idempotent)

Legacy local DBs (pre-commit 7189ddc) lack `last_error` and
`last_status`. `local-db.ts` runs:

```sql
ALTER TABLE feeds ADD COLUMN last_error TEXT;
ALTER TABLE feeds ADD COLUMN last_status INTEGER;
```

guarded by a `PRAGMA table_info(feeds)` lookup so the migration is a
no-op on already-current DBs. No data loss; no cache invalidation;
no re-bootstrap required (the next pull-sync naturally populates the
columns with server-authoritative values).
