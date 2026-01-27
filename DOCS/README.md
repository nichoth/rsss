# docs

## PWA

### PWA Manifest (`_public/manifest.json`)

* App name, icons, theme color
* Standalone display mode for installability

### Service Worker (_public/sw.js)

* Caches static assets for offline use
* Network-first strategy for pages
* Cache-first for static assets (JS, CSS, images)
* Skips caching API requests

### IndexedDB Adapter (`src/client/db/local-adapter.ts`)

* Uses idb library for Promise-based IndexedDB
* Three object stores: feeds, items, sync_state
* Full sync support from remote server

### Updated HTML (index.html)

* PWA meta tags (theme-color, apple-mobile-web-app-*)
* Manifest link
* Service worker registration script

### How It Works

1. Online: Uses remote API adapter (existing behavior)
2. Offline sync: Click "Pull from Server" in sidebar to sync data to IndexedDB
3. Installable: Users can install as PWA from browser menu
4. Offline capable: Service worker caches the app shell

### Test

```sh
npm run build
npm start
```










-------------------------------------------------





This is obsolete below here.


## Desktop App

### 1. Server-side sync endpoint (src/server/durable-objects/collie-user.ts)

* Added updated_at columns to feeds and items tables
* Added auto-update triggers for updated_at
* Added migration logic for existing databases
* New endpoint: `GET /api/collie/sync?since=<timestamp>` returns all
  changed data

### 2. Tauri app structure (`src-tauri/`)

* Cargo.toml - Rust dependencies (tauri, tauri-plugin-sql, tauri-plugin-http)
* tauri.conf.json - App configuration
* src/lib.rs - SQLite migrations and plugin setup
* src/main.rs - Entry point

### 3. Database abstraction layer (src/client/db/)

* types.ts - Shared interfaces
* remote-adapter.ts - API adapter for web app
* local-adapter.ts - SQLite adapter for Tauri with sync
* index.ts - Exports appropriate adapter based on environment

### 4. UI sync controls (src/client/components/sidebar-footer.ts)

* "Pull from Server" button (only in Tauri mode)
* Server URL configuration
* Last synced timestamp display
* Error handling

### 5. Build configuration

* vite.config.tauri.js - Vite config without Cloudflare plugins
* Updated package.json with Tauri scripts and dependencies

## To use

### Install dependencies (including Tauri)

```sh
npm install
```

### Run the Tauri desktop app in dev mode

```sh
npm run tauri dev
```

### Build the Tauri app for production

```sh
npm run tauri build
```

In the desktop app, click "Pull from Server", enter your remote URL (e.g.,
https://your-rsss.workers.dev), and it will sync all feeds and items to your
local SQLite database.


--------------------------------


## Tests

Test Files

### test/sync.ts (47 tests)

Tests for the sync workflow:

* Sync endpoint logic: Full sync, incremental sync with since parameter,
  boundary conditions
* Response structure: Validates feeds, items, timestamps
* Client-side upsert logic: Insert, update, preserve unchanged records
* Sync state management: Initial state, shouldFullSync behavior, state
  preservation

### test/db-adapter.ts (33 tests)

Tests for the database adapter interface contract.

* Feed operations: addFeed, getFeeds (sorted), deleteFeed (cascade)
* Item operations: getItems with pagination, filtering by
  feedId/isRead/isStarred
* Update operations: updateItem (read/starred), markAllRead (all or by feed)
* Counts: getCounts accuracy, empty database edge case


### Running Tests

```sh
npm test
```

The tests use `@substrate-system/tapzero` and run in a browser environment via
`tapout`. They test the sync logic by simulating the endpoint behavior and
adapter interface.
