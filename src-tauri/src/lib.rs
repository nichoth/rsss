use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: r#"
                CREATE TABLE IF NOT EXISTS feeds (
                    id INTEGER PRIMARY KEY,
                    url TEXT NOT NULL UNIQUE,
                    title TEXT,
                    description TEXT,
                    site_url TEXT,
                    last_fetched TEXT,
                    created_at TEXT,
                    updated_at TEXT
                );

                CREATE TABLE IF NOT EXISTS items (
                    id INTEGER PRIMARY KEY,
                    feed_id INTEGER NOT NULL,
                    guid TEXT NOT NULL,
                    title TEXT,
                    link TEXT,
                    description TEXT,
                    content TEXT,
                    author TEXT,
                    pub_date TEXT,
                    is_read INTEGER DEFAULT 0,
                    is_starred INTEGER DEFAULT 0,
                    created_at TEXT,
                    updated_at TEXT,
                    feed_title TEXT,
                    UNIQUE(feed_id, guid)
                );

                CREATE INDEX IF NOT EXISTS idx_items_feed_id ON items(feed_id);
                CREATE INDEX IF NOT EXISTS idx_items_is_read ON items(is_read);
                CREATE INDEX IF NOT EXISTS idx_items_is_starred ON items(is_starred);
                CREATE INDEX IF NOT EXISTS idx_items_pub_date ON items(pub_date DESC);
                CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at);
                CREATE INDEX IF NOT EXISTS idx_feeds_updated_at ON feeds(updated_at);

                CREATE TABLE IF NOT EXISTS sync_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    last_synced_at TEXT,
                    remote_url TEXT
                );

                INSERT OR IGNORE INTO sync_state (id) VALUES (1);
            "#,
            kind: MigrationKind::Up,
        }
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:rsss.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
