# Phase 1 Data Model: Fix OG-Image Redirect Errors

## Result: No schema changes

This feature is a behaviour fix in the server-side feed-refresh path. It
does not introduce, remove, or rename any column on either the Durable
Object SQLite store or the local OPFS SQLite store.

The two existing entities the spec references are listed below for
completeness; their definitions and validation rules are unchanged.

## Entity: Feed (unchanged)

A subscribed RSS/Atom source. Lives in `feeds` table inside the per-user
Durable Object SQLite database, and is mirrored into local SQLite via
`bootstrapLocalDb` / `pullSync`.

| Column        | Notes                                                |
|---------------|------------------------------------------------------|
| `id`          | DO-assigned integer primary key                      |
| `url`         | Idempotency key for add-feed (Constitution II)       |
| `title`       | from feed XML                                        |
| `description` | from feed XML                                        |
| `site_url`    | from feed XML `<link>`                               |
| `last_fetched`| timestamp of most recent feed-XML fetch attempt      |
| `last_error`  | last *feed-XML* error message (FR-005); NOT touched  |
|               | by article-fetch failures                            |
| `last_status` | last *feed-XML* HTTP-ish status code (FR-005)        |
| `created_at`  | row insert time                                      |
| `updated_at`  | row update time                                      |

**Behavioural note (no DDL change)**: per FR-005, `last_error` and
`last_status` remain a record of *feed-XML* state only. The fix continues
to never write OG-enrichment failures to these columns.

## Entity: Item (unchanged)

A single article inside a feed.

| Column          | Notes                                              |
|-----------------|----------------------------------------------------|
| `id`            | DO-assigned integer primary key                    |
| `feed_id`       | foreign key → feeds.id                             |
| `guid`          | per-feed dedup key                                 |
| `title`         | from feed XML                                      |
| `link`          | article URL — input to OG enrichment               |
| `description`   | from feed XML                                      |
| `content`       | from feed XML                                      |
| `author`        | from feed XML                                      |
| `pub_date`      | from feed XML                                      |
| `thumbnail_url` | nullable; set by OG enrichment when successful;    |
|                 | nullable result is a valid item state (FR-007)     |

**Behavioural note (no DDL change)**: an item with `thumbnail_url IS NULL`
is a valid, displayable item. The fix relies on this existing invariant
(FR-007) and does not introduce a separate "enrichment-failed" flag.

## Sync impact

None. Because no rendered column changes, the coupled-change rule from the
constitution ("DO schema, /api/sync payload, bootstrapLocalDb, local
SQLite schema, pullSync upsert logic") does not apply.

## Idempotency impact

None. No new mutation is introduced. The existing add-feed (URL key),
delete-feed (already-missing-is-success), item-update, and mark-all-read
mutations are untouched.
