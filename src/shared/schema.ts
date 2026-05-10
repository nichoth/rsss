/**
 * Shared SQLite schema for feeds and items tables.
 * Used by both the Cloudflare Durable Object (server) and
 * the browser's OPFS-backed SQLite database (client).
 *
 * Server-only ALTER TABLE migrations (adding updated_at to
 * pre-existing rows) remain in the Durable Object and must
 * run between TABLES_SQL and INDEXES_SQL.
 */

export const MAX_FULL_CONTENT_BYTES = 256 * 1024
export const MAX_ARTICLE_FETCH_BYTES = 1 * 1024 * 1024
export const EXTRACTED_MIN_TEXT = 500
export const SUMMARY_TEXT_THRESHOLD = 1500
export const ARTICLE_FETCH_TIMEOUT_MS = 8_000
export const FETCH_FULL_MIN_INTERVAL_MS = 5_000

export type FullContentStatus =
    | 'succeeded'
    | 'failed_network'
    | 'failed_status'
    | 'failed_redirect'
    | 'failed_non_html'
    | 'failed_too_large'
    | 'failed_no_body'

export const ALL_FULL_CONTENT_STATUSES:FullContentStatus[] = [
    'succeeded',
    'failed_network',
    'failed_status',
    'failed_redirect',
    'failed_non_html',
    'failed_too_large',
    'failed_no_body'
]

export const TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        description TEXT,
        site_url TEXT,
        last_fetched TEXT,
        last_pulled_at TEXT,
        last_error TEXT,
        last_status INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        title TEXT,
        link TEXT,
        description TEXT,
        content TEXT,
        author TEXT,
        pub_date TEXT,
        thumbnail_url TEXT,
        og_image_url TEXT,
        blurhash TEXT,
        image_width INTEGER,
        image_height INTEGER,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        full_content TEXT,
        full_content_fetched_at TEXT,
        full_content_status TEXT,
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
        UNIQUE(feed_id, guid)
    );
`

export const INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS idx_items_feed_id ON items(feed_id);
    CREATE INDEX IF NOT EXISTS idx_items_is_read ON items(is_read);
    CREATE INDEX IF NOT EXISTS idx_items_is_starred ON items(is_starred);
    CREATE INDEX IF NOT EXISTS idx_items_pub_date ON items(pub_date DESC);
    CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at);
    CREATE INDEX IF NOT EXISTS idx_feeds_updated_at ON feeds(updated_at);
`

export const TRIGGERS_SQL = `
    CREATE TRIGGER IF NOT EXISTS feeds_updated_at
    AFTER UPDATE ON feeds
    FOR EACH ROW
    WHEN OLD.updated_at = NEW.updated_at OR NEW.updated_at IS NULL
    BEGIN
        UPDATE feeds SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS items_updated_at
    AFTER UPDATE ON items
    FOR EACH ROW
    WHEN OLD.updated_at = NEW.updated_at OR NEW.updated_at IS NULL
    BEGIN
        UPDATE items SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
`

export const DEAD_LETTER_OUTBOX_SQL = `
    CREATE TABLE IF NOT EXISTS dead_letter_outbox (
        id INTEGER PRIMARY KEY,
        op TEXT NOT NULL,
        target_id INTEGER,
        payload TEXT NOT NULL,
        client_op_id TEXT NOT NULL UNIQUE,
        client_updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    );
`

/** Full schema: tables + indexes + triggers. Suitable for fresh databases. */
export const SCHEMA_SQL = TABLES_SQL + INDEXES_SQL + TRIGGERS_SQL
