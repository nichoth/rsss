export const SYNC_META_SQL = `
    CREATE TABLE IF NOT EXISTS sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_pull_at TEXT,
        pull_cursor TEXT
    );
    INSERT OR IGNORE INTO sync_meta (id, last_pull_at) VALUES (1, NULL);
`

export const OUTBOX_SQL = `
    CREATE TABLE IF NOT EXISTS outbox (
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

export const FEED_CACHE_POLICY_SQL = `
    CREATE TABLE IF NOT EXISTS feed_cache_policy (
        feed_id INTEGER PRIMARY KEY,
        cache_mode TEXT CHECK (
            cache_mode IN ('text', 'text_images')
        ),
        max_size_bytes INTEGER,
        max_age_seconds INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
`

export const CACHED_IMAGES_SQL = `
    CREATE TABLE IF NOT EXISTS cached_images (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        feed_id INTEGER NOT NULL,
        item_id INTEGER,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS cached_images_feed_idx
        ON cached_images (feed_id);
    CREATE INDEX IF NOT EXISTS cached_images_item_idx
        ON cached_images (item_id);
`
