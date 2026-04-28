# docs

## SQLite

- [About SQLite](./sqlite-about.md)
- [SQLite Cookbook](./sqlite-cookbook.md)
- [SQLite, misc](./sqlite-misc.md)
- [SQLite Persistence](./sqlite-persistence.md)
- [WASM + SQLite](./sqlite-wasm.md)

The browser app uses `@sqlite.org/sqlite-wasm` in a dedicated module worker.
The worker opens the local database with SQLite's `OPFS-SAH-pool` VFS under
the `rsss-db` OPFS directory. The main thread talks to it through
`SQLiteWorkerClient`, so production local-first code must use async helpers
such as `execDb`, `queryDb`, and `queryOneDb` instead of direct `db.exec`.

Local-first mode is opt-in. It requires:

- the `syncSubscriptions` setting
- a cross-origin-isolated page
- OPFS support exposed to the SQLite worker
- no other RSSS tab already owning the local database

When any requirement is missing, `getAdapter()` falls back to `remoteAdapter`
and continues to use the user's Durable Object. v1 local-first should be
treated as a single tab feature because OPFS-SAH access handles are exclusive;
a second tab reads from the remote adapter instead of contending for the
local SQLite handle.

### Sync Conflict Resolution

Server writes use last-write-wins checks through the shared
`resolveLwwWrite` helper. A server row only rejects a client write when
`server.updated_at > client_updated_at`. Equal timestamps are accepted, so
the arriving client operation wins the tie. For local `updateItem` writes,
the client coalesces same-item outbox rows before push-sync, so multiple
updates in one tick send one final payload to the Durable Object.

---

## PWA

### PWA Manifest (`_public/manifest.json`)

* App name, icons, theme color
* Standalone display mode for installability

### Service Worker

Local-first v1 does not ship or register a service worker. The app is
installable through the manifest and can read/write subscribed data locally
after bootstrap, but the app shell itself is still loaded from the network.

### HTML (`index.html`)

* PWA meta tags (theme-color, apple-mobile-web-app-*)
* Manifest link

### How It Works

1. Default: uses `remoteAdapter`, which calls the Durable Object.
2. Opt-in: enabling local-first opens OPFS SQLite and bootstraps from
   `/api/sync`.
3. Sync: online cycles push the local outbox, then pull remote changes.
4. Fallback: unsupported browsers, failed OPFS probes, and second tabs use
   `remoteAdapter`.
5. Installable: users can install RSSS from browser UI via the manifest.

>
> !NOTE
> The use of SQLite in the browser.
>

SQLite needs to work in a browser/PWA environment and should use Web
Assembly.

* see [sqlite-wasm.md](./sqlite-wasm.md)
* see [sqlite-cookbook.md](./sqlite-cookbook.md)


## Test

```sh
npm run build
npm start
```
