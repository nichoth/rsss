# Contract: `GET /api/sync` (payload addition + one-time bump)

**Status:** Existing endpoint, additive change. No URL or query
parameter changes.

## Payload addition

`FEED_SYNC_COLUMNS` (server, currently
`src/server/durable-objects/index.ts:104-107`) MUST be widened to
include `last_pulled_at`:

```text
id, url, title, description, site_url, last_fetched, last_pulled_at,
last_error, last_status, created_at, updated_at
```

Each `feed` row in the response's `feeds` array gains a
`last_pulled_at` field of type `string | null`.

## Client upsert (must change in the same change set)

`src/client/db/pull-sync.ts:upsertFeed` MUST include
`last_pulled_at` in both:

1. The INSERT column list and bind vector.
2. The `ON CONFLICT(id) DO UPDATE SET` list, set to
   `excluded.last_pulled_at`.

`src/client/db/bootstrap.ts` does NOT require direct edits because
it delegates to the same `upsertFeed`.

## One-time migration: bump `updated_at` on existing feeds

To ensure existing client SQLite databases receive the
newly-projected `last_pulled_at` column, the server MUST perform a
one-time, idempotent migration step on first request after deploy
(or inside the existing schema-version migration block):

```sql
UPDATE feeds SET updated_at = datetime('now')
```

The migration MUST be guarded by a `migration_version` storage key
so it runs at most once per UserDO. After the bump, the next
incremental `pullSync(since=<lastSyncTime>)` from each client picks
up every feed row and writes the freshly-projected
`last_pulled_at`. Subsequent pulls remain incremental.

This is a pure read-side bump from the client's perspective: every
upserted column is ON CONFLICT-merged with values the client already
has, plus the newly-projected `last_pulled_at`.

## Backward compatibility

Old clients (pre-deploy) that read the new payload simply ignore the
`last_pulled_at` field in their `upsertFeed`. They do not regress
because their reading-list query also predates the visibility rule.

New clients (post-deploy) that hit an old server (impossible in a
single-deploy stack, listed for completeness) treat the missing
field as NULL, which would suppress the entire reading list. We are
deploying server and client together, so this case does not occur in
practice; no code is written for it.

## Out of scope

- Conflict semantics (`{feed}`, `{item}`, `{items}` wrappers) are
  unchanged.
- The sync cursor encoding is unchanged.
- The `/feeds/:id/pending` endpoint payload is unchanged.
