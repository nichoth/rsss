# RSSS

__Really Simple Syndication Service__

See [rsss.space](https://rsss.space/).

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Develop](#develop)
- [Architecture](#architecture)
  * [Local First](#local-first)
  * [Sync (remote -> local)](#sync-remote---local)
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

Reads are always via `IndexedDB`.

* `loadFeeds()`, `loadItems()`, `loadCounts()` read exclusively
  from `IndexedDB`.
* Works identically whether online or offline


### Sync (remote -> local)

- `State.sync()` calls `localAdapter.sync()` which hits
  `/api/sync?since=<lastSyncTime>` and upserts any new/updated feeds and items
  into `IndexedDB`
- Called automatically on app startup (when authenticated + online)
- Called automatically when the browser comes back online (online event)


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
│   ├── auth/oauth.ts               # Bluesky OAuth implementation
│   └── durable-objects/
│       └── collie-user.ts          # Per-user DO with SQLite
└── client/
    ├── index.ts                    # Main Preact entry
    ├── state.ts                    # State management & API client
    ├── style.css                   # All styles
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
