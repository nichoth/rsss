# RSSS

__Really Simple Syndication Service__

See [rsss.space](https://rsss.space/).

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Develop](#develop)
- [Architecture](#architecture)
  * [Local First](#local-first)
  * [Sync (remote <-> local)](#sync-remote---local)
  * [Worker (Hono) - Main entry point](#worker-hono---main-entry-point)
  * [Durable Object per user (UserDO)](#durable-object-per-user-userdo)
  * [Frontend](#frontend)
- [Files](#files)
- [Running Locally](#running-locally)
- [Deploy](#deploy)
- [Notes](#notes)
  * [Generate a Secret](#generate-a-secret)

<!-- tocstop -->

</details>


## Develop

```sh
npm start
```

## Architecture                                                                  

### Local First

Local-first reads use a `SQLite` database (`@sqlite.org/sqlite-wasm`)
persisted to `OPFS` via `FileSystemSyncAccessHandle`.

* `loadFeeds()`, `loadItems()`, `loadCounts()` read from the local
  SQLite DB through `localAdapter`.
* Works identically whether online or offline.
* Opt-in and gated on capability: requires the `syncSubscriptions`
  setting plus a cross-origin-isolated context with OPFS support.
  When either is missing, `getAdapter()` falls back to `remoteAdapter`,
  which calls the user's Durable Object directly.

### Sync (remote <-> local)

- **Bootstrap** (`bootstrapLocalDb`) seeds the OPFS database on first
  use by paging through `/api/sync` and writing rows into SQLite.
- **Pull sync** (`pullSync`) hits `/api/sync?since=<lastSyncTime>` and
  upserts any new/updated feeds and items into the local SQLite DB.
- **Push sync** (`pushSync`) drains a local outbox of pending writes
  (read/star toggles, feed add/delete, etc.) back to the server.
- `State.sync()` triggers pull + push automatically on app startup
  (when authenticated + online) and when the browser fires the
  `online` event.


### Worker (Hono) - Main entry point

* Bluesky OAuth authentication (AT Protocol)
* Session management with encrypted cookies
* Route requests to user-specific Durable Objects
* Static asset serving for the Preact frontend


### Durable Object per user (UserDO)

* Uses SQLite storage for feeds and items
* Uses the Hibernation API (extends DurableObject)
* Alarms for periodic feed refreshing (every 10 minutes)
* Complete RSS/Atom feed parser

### Frontend

* Login page with Bluesky OAuth
* Feed management (add/delete/refresh)
* Item list with filtering (unread/starred/by feed)
* Item reader with read/star toggles
* Responsive design

-------

## Files

```
src/
├── server/
│   ├── index.ts                    # Main Hono worker
│   ├── auth/                       # Bluesky OAuth implementation
│   └── durable-objects/
│       └── index.ts                # Per-user DO (UserDO) with SQLite
└── client/
    ├── index.ts                    # Main Preact entry
    ├── state.ts                    # State management & API client
    ├── style.css                   # All styles
    ├── db/                         # Local-first SQLite (OPFS) layer
    │   ├── sqlite-init.ts          # wa-sqlite + OPFS open/remove
    │   ├── local-adapter.ts        # Reads/writes against local DB
    │   ├── remote-adapter.ts       # Fallback: calls the DO directly
    │   ├── bootstrap.ts            # First-run seed of local DB
    │   ├── pull-sync.ts            # Server -> local
    │   └── push-sync.ts            # Local outbox -> server
    └── routes/
        ├── login.ts                # Login page component
        └── feed-reader.ts          # Main feed reader UI
```

## Running Locally

```sh
npm run start           # Start dev server
```

Then access `http://localhost:8888` and use the "Dev Login" button in
development mode.

---

## Deploy

1. Create a KV namespace for sessions:
```sh
wrangler kv:namespace create SESSIONS
```
2. Update wrangler.jsonc with the KV ID
3. Set secrets:
```sh
wrangler secret put SESSION_SECRET
```
4. Deploy:
```sh
wrangler deploy
```

---

## Notes

### Generate a Secret

```sh
openssl rand -base64 32
```

### Local Durable Object

```sh
sqlite3 /Users/nick/code/rsss/.wrangler/state/v3/do/rsss-UserDO/5ccaac5db5efdc5e2ac84cd63b9141cf9dcf247c7a410cc13ce1f9d1ebbc1410.sqlite
```

### Storage use vs quota

```js
const { usage, quota } = await navigator.storage.estimate();
  
console.log(usage / (1024 * 1024).toFixed(2));
console.log(quota / (1024 * 1024).toFixed(2));
```
