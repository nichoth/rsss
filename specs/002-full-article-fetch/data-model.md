# Phase 1 Data Model: Fetch Full Article Body When Feed Provides Only a Summary

## Schema delta

The feature adds three columns to the existing `items` table. The
columns are added in `src/shared/schema.ts` so the DO and the client's
OPFS SQLite use a single source of truth.

```sql
ALTER TABLE items ADD COLUMN full_content TEXT;
ALTER TABLE items ADD COLUMN full_content_fetched_at TEXT;
ALTER TABLE items ADD COLUMN full_content_status TEXT;
```

Every existing item row gets `NULL` for all three columns until a
fetch is attempted (or never; an item that is already full will never
trigger a fetch and so its three columns stay `NULL` forever).

No new indexes are required — the columns are looked up by item id
(primary key) on every read, never scanned.

The existing `items_updated_at` trigger continues to fire on every
UPDATE that changes a non-`updated_at` column, so a successful fetch
bumps `updated_at` and the row appears in the next `/api/sync` page
without any new sync surface.

## Entities

### `Item` (extended)

| Field | Type | Origin | Notes |
|---|---|---|---|
| `id` | `INTEGER` | existing | Primary key. |
| `feed_id` | `INTEGER` | existing | Foreign key. |
| `guid` | `TEXT` | existing | Unique within feed. |
| `title` | `TEXT` | existing | |
| `link` | `TEXT` | existing | The article URL. Drives both the publisher link and the fetch target. |
| `description` | `TEXT` | existing | Feed-supplied summary. Used as fallback. |
| `content` | `TEXT` | existing | Feed-supplied `content:encoded`, when present. Preferred over `description`. |
| `author` | `TEXT` | existing | |
| `pub_date` | `TEXT` | existing | |
| `thumbnail_url` | `TEXT` | existing (spec 001) | |
| `is_read` | `INTEGER` | existing | |
| `is_starred` | `INTEGER` | existing | |
| `created_at` | `TEXT` | existing | |
| `updated_at` | `TEXT` | existing | Bumps on successful fetch (via trigger). |
| **`full_content`** | `TEXT` | NEW | Sanitised, extracted body HTML. `NULL` until a successful fetch. Bounded by `MAX_FULL_CONTENT_BYTES = 256 * 1024` bytes (UTF-8). |
| **`full_content_fetched_at`** | `TEXT` | NEW | ISO-8601 / SQLite-format timestamp of last successful fetch. `NULL` until first success. |
| **`full_content_status`** | `TEXT` | NEW | One of the literal values in [Fetch Status](#fetch-status). `NULL` means "never attempted". |

### Fetch Status

`full_content_status` is a small enum (stored as a literal `TEXT`
value, no DB-level CHECK so the schema stays migration-free if a new
status ships later). The set of values is:

| Value | Meaning | UI behaviour |
|---|---|---|
| `NULL` (column unset) | Never attempted. | If `isSummaryOnly(item)` and online, auto-trigger a fetch on open. |
| `succeeded` | Fetch + extraction succeeded; body in `full_content`. | Render `full_content` (after `sanitizeHtml`). No notice. |
| `failed_network` | DNS / connection / timeout / blocked host. | Show "Couldn't load the full article." + Retry button. |
| `failed_status` | Publisher returned non-2xx. | Same as `failed_network`. |
| `failed_redirect` | Exceeded `MAX_ARTICLE_REDIRECTS = 5` (spec 001 cap). | Same. |
| `failed_non_html` | Response Content-Type was not HTML / XHTML. | Same. |
| `failed_too_large` | Response > `MAX_ARTICLE_FETCH_BYTES` and could not be truncated to a usable body. | Same. |
| `failed_no_body` | Extracted text < `EXTRACTED_MIN_TEXT = 500` chars (paywall stub, empty page). | Same. |

State transitions (driven by the fetch-full endpoint):

```text
NULL  --(success)-->         succeeded
NULL  --(failure of kind k)--> failed_<k>

failed_*  --(success)-->        succeeded
failed_*  --(failure of kind k)--> failed_<k>      (kind may change)

succeeded --(force=true success)-->     succeeded   (refresh)
succeeded --(force=true failure of k)--> failed_<k> (the previous body
                                                     is overwritten with
                                                     the new failure)
```

The auto-trigger only acts when the current status is `NULL`. Re-tries
require an explicit user click on the Retry button (which sends
`force: true`).

## Validation rules

- `full_content` MUST pass server-side `sanitiseExtractedHtml`
  (strip `<script>`, `<style>`, inline `on*=` handlers,
  `javascript:` URLs, etc.) before being written.
- `full_content` length (UTF-8 bytes) MUST be ≤
  `MAX_FULL_CONTENT_BYTES`.
- `full_content_fetched_at`, when non-NULL, MUST satisfy `pub_date >=
  '1970-01-01'` (ie. a valid timestamp). The DO writes this through
  `datetime('now')`.
- `full_content_status` MUST be one of the values listed above, or
  NULL.
- The DO MUST refuse to fetch when `item.link` is empty or fails
  `validateFeedUrl` (URL-level SSRF check). The status MUST be set to
  `failed_network` in that case.
- The pull-sync upsert MUST treat `full_content` exactly the same way
  it treats `content` and `description`, including the `storeContent`
  privacy gate (when the user has disabled local content storage,
  `full_content` is dropped on the way into the local DB; see
  `pullSync.upsertItem` `keepContent` branch).

## Migration

`USER_DO_MIGRATION_VERSION` bumps from 4 to 5. New migration
`migrateAddItemFullContent` runs once and idempotently:

```ts
private migrateAddItemFullContent () {
    const cols = this.sql.exec('PRAGMA table_info(items)').toArray()
    const has = (name:string) => cols.some(
        (col:unknown) => (col as { name:string }).name === name
    )
    if (!has('full_content')) {
        this.sql.exec(
            'ALTER TABLE items ADD COLUMN full_content TEXT'
        )
    }
    if (!has('full_content_fetched_at')) {
        this.sql.exec(
            'ALTER TABLE items ADD COLUMN full_content_fetched_at TEXT'
        )
    }
    if (!has('full_content_status')) {
        this.sql.exec(
            'ALTER TABLE items ADD COLUMN full_content_status TEXT'
        )
    }
}
```

The local-side OPFS SQLite picks up the new columns from `TABLES_SQL`
on first open. Existing OPFS DBs do not have the columns. To handle
upgrade in place, `pullSync` calls a small idempotent
`ensureItemFullContentColumns(db)` (mirrors the existing
`ensureSyncCursorColumn`) before its first upsert.

## Wire format (`/api/sync` payload)

`ITEM_SYNC_COLUMNS` in the DO is extended:

```text
items.id, items.feed_id, items.guid, items.title, items.link,
items.description, items.content, items.author, items.pub_date,
items.thumbnail_url, items.is_read, items.is_starred, items.created_at,
items.updated_at,
items.full_content, items.full_content_fetched_at,
items.full_content_status,
feeds.title AS feed_title
```

The shape of the `/api/sync` JSON response is unchanged — the items
array gets three extra string-or-null fields per row. Older clients
that don't know about the columns simply ignore the extras.
