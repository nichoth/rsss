# RSSS

__Really Simple Syndication Service__

See [rsss.space](https://rsss.space/).

## Example Feeds

* [brittanyellich.com](https://brittanyellich.com/index.xml)
* [404media.co](https://www.404media.co/rss/)
* [interconnected.org](https://interconnected.org/home/feed)
* [piccalil.li](https://piccalil.li/feed.xml)
* [piccalil.li articles](https://piccalil.li/articles.xml)
* [piccalil.li the index](https://piccalil.li/the-index/feed.xml)
* [Wired Top Stories](https://www.wired.com/feed/rss)
* [Wired Gear](https://www.wired.com/feed/category/gear/latest/rss)
* [Wired Culture](https://www.wired.com/feed/category/culture/latest/rss)

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Develop](#develop)
- [Architecture](#architecture)
  * [Local First](#local-first)
  * [Sync (remote/local)](#sync-remotelocal)
  * [Worker (Hono) - Main entry point](#worker-hono---main-entry-point)
  * [Durable Object per user (UserDO)](#durable-object-per-user-userdo)
  * [Frontend](#frontend)
- [Files](#files)
- [Running Locally](#running-locally)
- [Deploy](#deploy)
  * [Rotate `SESSION_SECRET`](#rotate-session_secret)
- [Notes](#notes)
  * [Generate a Secret](#generate-a-secret)
  * [Local Durable Object](#local-durable-object)
  * [Storage use vs quota](#storage-use-vs-quota)

<!-- tocstop -->

</details>


## Develop

```sh
npm start
```

## Architecture

### Local First

Local-first reads use a `SQLite` database (`@sqlite.org/sqlite-wasm`)
persisted to `OPFS` through SQLite's `OPFS-SAH-pool` VFS in a
cross-origin-isolated worker.

* `loadFeeds()`, `loadItems()`, `loadCounts()` read from the local
  SQLite DB through `localAdapter`.
* Works identically whether online or offline.
* Opt-in and gated on capability: requires the `syncSubscriptions`
  setting plus a cross-origin-isolated context with OPFS support.
  When either is missing, `getAdapter()` falls back to `remoteAdapter`,
  which calls the user's Durable Object directly.
* v1 is a single tab local-first mode. If another tab owns the OPFS
  SQLite handle, the second tab falls back to `remoteAdapter`.
* RSSS ships a web app manifest for installability, but v1 does not
  register a service worker or cache the app shell offline.

### Sync (remote/local)

- **Bootstrap** (`bootstrapLocalDb`) seeds the OPFS database on first
  use by paging through `/api/sync` and writing rows into SQLite.
- **Pull sync** (`pullSync`) hits `/api/sync?since=<lastSyncTime>` and
  upserts any new/updated feeds and items into the local SQLite DB.
- **Push sync** (`pushSync`) drains a local outbox of pending writes
  (read/star toggles, feed add/delete, etc.) back to the server.
- Outbox pushes include `client_op_id` and `client_updated_at`. v1 does
  not store a processed-op table on the server: add-feed retries use the
  unique feed URL as the idempotency key, delete-feed retries treat
  already-missing rows as success, and item updates plus mark-all-read
  are idempotent value assignments.
- Conflict responses use wrapped authoritative rows: feed conflicts
  return `{ feed }`, item conflicts return `{ item }`, and mark-all-read
  conflicts return `{ items }`.
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
    │   ├── sqlite-init.ts          # sqlite-wasm OPFS open/remove
    │   ├── sqlite-worker.ts        # OPFS-SAH-pool SQLite worker
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
wrangler kv namespace create SESSIONS
```

2. Add the returned namespace `id` to `wrangler.jsonc`.

   For local `wrangler dev`, also set the namespace `preview_id`. The
   Worker requires `compatibility_flags` to include `nodejs_compat`.

3. Configure the required environment variables:

| Name | Purpose |
| --- | --- |
| `APP_ORIGIN` | Canonical app origin (e.g. `https://rsss.space`). Required; CORS/CSRF allowlist fails closed when unset. |
| `ADMIN_TOKEN` | Bearer token for admin-only routes. |
| `SESSION_SECRET` | Secret used to encrypt session cookies. |
| `OAUTH_CLIENT_ID` | Bluesky OAuth client id. |
| `AUTUMN_SECRET_KEY` | Autumn billing API key. |
| `RESEND_API_KEY` | Resend API key for transactional email. |
| `RESEND_FROM` | Verified sender address for email. |

```sh
wrangler secret put ADMIN_TOKEN
wrangler secret put SESSION_SECRET
wrangler secret put OAUTH_CLIENT_ID
wrangler secret put AUTUMN_SECRET_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_FROM
```

Keep secret bindings out of `wrangler.jsonc` `vars`. In production,
`AUTUMN_SECRET_KEY` must be set with `wrangler secret put` or
`/api/health` returns a configuration error.

4. Deploy:

```sh
wrangler deploy
```

5. Verify the deployment:

```sh
curl https://<your-domain>/api/health
curl https://<your-domain>/oauth/client-metadata.json
```

### Rotate `SESSION_SECRET`

Generate a replacement secret, then run:

```sh
wrangler secret put SESSION_SECRET
wrangler deploy
```

Rotating `SESSION_SECRET` invalidates active sessions because existing
session cookies can no longer be decrypted. Users need to sign in again.

---

## Notes

### Generate a Secret

```sh
openssl rand -base64 32
```

### Local Durable Object

```sh
sqlite3 \
  /Users/nick/code/rsss/.wrangler/state/v3/do/rsss-UserDO/\
5ccaac5db5efdc5e2ac84cd63b9141cf9dcf247c7a410cc13ce1f9d1ebbc1410.sqlite
```

### Storage use vs quota

```js
const { usage, quota } = await navigator.storage.estimate();
  
console.log(usage / (1024 * 1024).toFixed(2));
console.log(quota / (1024 * 1024).toFixed(2));
```
