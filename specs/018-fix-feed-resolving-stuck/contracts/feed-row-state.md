# Contract — Client predicate over feed row state

The client sidebar reads three states from a feed row using **only**
the columns `last_fetched` and `last_error`. The predicate lives at
`src/client/components/sidebar.ts:166-170` and is **not changed by
this feature**.

```ts
const isResolving = (
    feed.last_fetched === null && !feed.last_error
)
const hasFailed = (
    feed.last_fetched === null && !!feed.last_error
)
// resolved otherwise
```

| State     | `last_fetched`        | `last_error`     | Visual               |
|-----------|-----------------------|------------------|----------------------|
| resolving | `null`                | `null` / empty   | spinner + a11y label |
| failed    | `null`                | non-empty string | "Failed to fetch" + retry |
| resolved  | non-null              | (ignored)        | title or URL         |

## Server guarantees this feature adds

To make the predicate correct end-to-end, the server now guarantees:

1. **No `(last_fetched=null, last_error=null)` row persists past
   `RESOLVE_WINDOW_MS = 30000` measured from `created_at`.** Enforced
   by the DO `alarm()` sweep.
2. **Every successful `fetchFeed` path writes `last_fetched`.**
   Specifically the 304-on-first-fetch path and the
   parsed-but-no-metadata path now run the UPDATE.
3. **`POST /api/feeds/:id/refresh` returns the post-fetch row**, so
   the client does not need to wait for SSE or pull-sync to learn
   the terminal state.

## Client guarantees this feature adds

1. **`upsertFeed` (pull-sync) and `upsertFeedFromServer` (push-sync)
   persist `last_error` and `last_status`** to the local DB. Without
   this, any server-side terminal state is invisible on the
   local-first read path.
2. **`State.addFeed` schedules a one-shot `runSync` at
   `RESOLVE_WINDOW_MS + 5000ms`** if the just-added row is still
   classified as resolving. Defense in depth against SSE drops
   (FR-006).
3. **Legacy local DBs are migrated** to include `last_error` and
   `last_status` via idempotent `ALTER TABLE` in `local-db.ts`.

## Non-changes (deliberately preserved)

- The predicate. Sidebar logic stays.
- The visual treatment (spinner, label, retry control). Constitution
  forbids unrelated CSS changes.
- The "Resolving feed" `aria-label` / `role="status"` semantics
  (FR-009). The legitimate in-flight window keeps its accessibility
  cue.
- `POST /api/feeds` response shape and status code (201 with the
  inserted row).
- `/api/sync` GET response shape.
