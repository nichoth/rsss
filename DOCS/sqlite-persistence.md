Below is the content of the [Persistent Storage Options](https://sqlite.org/wasm/doc/trunk/persistence.md) page from the SQLite WebAssembly documentation, converted to Markdown:

---

# Persistent Storage Options

This API provides database persistence via `localStorage`/`sessionStorage` and, in compatible browsers, the Origin-Private FileSystem (OPFS).

## ⚠️ Achtung: Restrictions in Incognito and Guest Browsing Modes

Most browsers offer "incognito" and/or "guest" browsing modes which intentionally change or disable certain capabilities of the browser. When running in such a mode, storage capabilities might be adversely affected, e.g. with lower quotas or a complete lack of persistence. The exact limits imposed vary per browser, but it is not entirely unexpected that the persistence features described on this page will, when run in such a "stealth" mode, either be more limited than the documentation suggests, or may even be completely unavailable.

"How do we detect these cases in advance?" is a fair question, but browser makers intentionally make it difficult to detect such modes in order to prevent, e.g., sites from restricting access to incognito-mode users. Any current manner of detecting this in any given browser may quickly become obsolete as the browser makers catch on and change things to make such modes more opaque to visited sites, so we cannot offer any advice on how to circumvent them.

## Key-Value VFS (kvvfs): localStorage and sessionStorage

For more thorough treatment of this topic see `kvvfs.md`.

`kvvfs` is an `sqlite3_vfs` implementation conceived and created to store a whole sqlite3 database in the `localStorage` or `sessionStorage` objects. Those objects are only available in the main UI thread, not Worker threads, so this feature is only available in the main thread. (Version 2 lifts that limitation but lacks persistence in Worker threads.) `kvvfs` stores each page of the database into a separate entry of the storage object, encoding each database page into an ASCII form so that it's JS-friendly.

This VFS supports only a single database per storage object. That is, there can be, at most, one `localStorage` database and one `sessionStorage` database.

To use it, pass the VFS name `"kvvfs"` to any database-opening routine which accepts a VFS name. The file name of the db must be either `local` or `session`, or their aliases `:localStorage:` and `:sessionStorage:`. Any other names will cause opening of the db to fail. When using URI-style names, use one of:

* `file:local?vfs=kvvfs`
* `file:session?vfs=kvvfs`

When loaded in the main UI thread, the following utility methods are added to the `sqlite3.capi` namespace:

* `sqlite3_js_kvvfs_size(which='')` returns an estimate of how many bytes of storage are used by `kvvfs`.
* `sqlite3_js_kvvfs_clear(which='')` clears all `kvvfs`-owned state and returns the number of records it deleted (one record per database page).

In both cases, the argument may be one of (`"local"`, `"session"`, `""`). In the first two cases, only `localStorage` resp. `sessionStorage` are acted upon and in the latter case both are acted upon.

Storage limits are small: typically 5MB, noting that JS uses a two-byte character encoding so the effective storage space is considerably less than that. When the storage is full, database operations which modify the db will fail.

### JsStorageDb: kvvfs the Easy Way

Using the `kvvfs` is much simpler with the OO1 API. See the `JsStorageDb` class for details.

### Importing Databases into kvvfs

The most straightforward way to import an existing database into the `kvvfs` is using `VACUUM INTO` from a separate database. For example:

```javascript
let db = new sqlite3.oo1.DB();
db.exec("create table t(a); insert into t values(1),(2),(3)");
db.exec("VACUUM INTO 'file:local?vfs=kvvfs'");
// Will fail if there's already a localStorage kvvfs:
// sqlite3.js:14022 sqlite3_step() rc= 1 SQLITE_ERROR SQL = VACUUM INTO 'file:local?vfs=kvvfs'

// But we can fix that by clearing the storage:
sqlite3.capi.sqlite3_js_kvvfs_clear('local');
// Then:
db.exec("VACUUM INTO 'file:local?vfs=kvvfs'");
db.close();

let ldb = new sqlite3.oo1.JsStorageDb('local');
ldb.selectValues('select a from t order by a'); // ==> [1,2,3]
```

## The Origin-Private FileSystem (OPFS)

Regarding selection of an OPFS VFS: clients which value performance more than concurrency, or are unable to set the COOP/COEP response headers, should use the "opfs-sahpool" VFS. Clients which requires multi-tab concurrency should use either the "opfs" VFS or "opfs-wl" VFS.

The Origin-Private FileSystem, OPFS, is an API providing browser-side persistent storage which, not coincidentally, sqlite3 can use for storing databases [1].

OPFS is only available in Worker-thread contexts, not the main UI thread.

As of July 2023 the following browsers are known to have the necessary APIs:

* Chromium-derived browsers released since approximately mid-2022. As of v108 (November 2022) some OPFS APIs changed from asynchronous to synchronous, which affects how client code (i.e. this library) has to deal with them.
* Firefox v111 (March 2023) and later
* Safari 16.4 (March 2023) and later

This library offers multiple solutions for storing databases in OPFS, each with distinct trade-offs.

### OPFS VFS

This support is only available when `sqlite3.js` is loaded from a Worker thread, whether it's loaded in its own dedicated worker or in a worker together with client code. This OPFS wrapper implements an `sqlite3_vfs` wrapper entirely in JavaScript.

This feature is activated automatically if the browser appears to have the necessary APIs to support it. It can be tested for in JS code using one of:

```javascript
if(sqlite3.capi.sqlite3_vfs_find("opfs")){
  // ... OPFS VFS is available ...
}
// Alternately:
if(sqlite3.oo1.OpfsDb){
  // ... OPFS VFS is available ...
}
```

If it is available, the VFS named `"opfs"` can be used with any sqlite3 APIs which accept a VFS name, such as `sqlite3_vfs_find()`, `sqlite3_db_open_v2()`, and the `sqlite3.oo1.DB` constructor, noting that `OpfsDb` is a convenience subclass of `oo1.DB` which automatically uses this VFS. For URI-style names, use `file:my.db?vfs=opfs`.

#### ⚠️ Achtung: Safari versions < 17

Safari versions less than version 17 are incompatible with the current OPFS VFS implementation because of a bug in the browser's storage handling from sub-workers for which there is no workaround. Both the SharedAccessHandle pool VFS and the WASMFS support offer alternatives which should work with Safari versions 16.4 or higher.

#### ⚠️ Achtung: COOP and COEP HTTP Headers

In order to offer some level of transparent concurrent-db-access support, JavaScript's `SharedArrayBuffer` type is required for the OPFS VFS, and that class is only available if the web server includes the so-called COOP and COEP response headers when delivering scripts:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

Without these headers, the `SharedArrayBuffer` will not be available, so the OPFS VFS will not load. That class is required in order to coordinate communication between the synchronous and asynchronous parts of the `sqlite3_vfs` OPFS proxy.

The COEP header may also have a value of `credentialless`, but whether or not that will work in the context of any given application depends on how it uses other remote assets.

### Directory Parts in DB Names

Unlike most `sqlite3_vfs` implementations, this one will automatically create any leading directory parts of a database file name if the database is opened with the "create" flag. This divergence from common conventions was made in the interest of:

1. Making life easier for web developers.
2. Avoiding having to expose OPFS-specific APIs for creating directories to client code. Ideally, client DB-related code should be agnostic of the storage being used.

For example:

```javascript
const db = new sqlite3.oo1.OpfsDb('/path/to/my.db','c');
```

will, if needed, create the `/path/to` directories. Paths without a leading slash are functionally equivalent, starting at the OPFS root.

### Concurrency and File Locking

⚠️ **Forewarning**: desktop-grade concurrency is not a real thing in browser environments. One cannot simply expect to keep a database with 8 or 10 opened tabs talking it to snappy. Even so, a moderate degree of concurrency across browser tabs and/or Workers is not only possible but hassle-free so long as one follows a few guidelines.

**Background**: OPFS offers a handful of synchronous APIs which are required by this API. A file can be opened in asynchronous mode without any sort of locking, but acquiring access to the synchronous APIs requires what OPFS calls a "sync access handle," which exclusively locks the file. So long as an OPFS file is locked, it may not be opened by any other service running in that same HTTP origin.

In essence, that means that no two database handles can have the same OPFS-hosted database open at one time. If the same page is opened in two tabs, the second tab will hit a locking error the moment it tries to open the same OPFS-hosted database!

To help alleviate contention, sqlite3 only acquires a write-mode handle when the database API requires a lock. If it cannot acquire a lock, it will wait a brief period and try again. Failure to obtain a lock will bubble up as `SQLITE_BUSY` or a generic I/O error.

**Hints to help improve OPFS concurrency**:
* Keep in mind that reading locks OPFS files; there's no "N concurrent readers".
* Do not open a database until it's known to be required.
* Open statements are fine so long as they're reset.
* Never use two database handles to the same db file within the same thread.
* Perform work in small chunks.
* Do not hold transactions open for any significant length of time.

---

### Misc. OPFS VFS Features

#### Unlock-ASAP Mode
Sometimes sqlite3 will call into a VFS without explicitly acquiring a lock in advance. When it does so, an operation which requires a sync access handle acquires the lock itself [2] and holds it until the VFS is idle for a brief period (less than half a second). This is internally called "auto-locking."

### OPFS SyncAccessHandle Pool VFS (SAHPool)

The `opfs-sahpool` VFS provides an alternative that works without COOP/COEP headers and is compatible with Safari 16.4+. It uses a pre-allocated pool of files in OPFS.

#### Pool Management
`installOpfsSAHPoolVfs()` returns a Promise which resolves to a utility object (`PoolUtil`).

* **`addCapacity(n)`**: Adds `n` entries to the pool.
* **`importDb(name, data)`**: Imports a database into the pool.
* **`wipeFiles()`**: Clears all files in the pool.

### OPFS over WASMFS

WASMFS is a newer filesystem layer for WebAssembly. It provides an OPFS backend.
**Drawbacks**:
* No concurrency support.
* COOP/COEP headers required.
* Only available as an ES6 module in a Worker.

---

### Maintaining OPFS-hosted Files

SQLite API cannot be used to traverse the list of files in OPFS or delete them directly via SQL [4].
* Use the **OPFS Explorer** extension for Chrome.
* Use the OPFS API from the browser's developer console.

### Sidebar: Cross-thread Communication via OPFS
sqlite3 over OPFS allows communication between arbitrary threads (Workers) via a shared database, provided they handle locking contention and use brief transactions.

### Sidebar: Mysterious Disappearance of Databases
Users sometimes report that OPFS databases randomly disappear. This is usually due to environment-specific reasons like:
* Virus scanners
* "Computer Cleaner" software
* Browser-level storage permission resets
* Browser-internal cleanup logic

---

**Footnotes**:
1. ^ The whole JS/WASM effort of the sqlite project initially stemmed from interest in getting it working with OPFS.
2. ^ The alternative being to fail the operation.
4. ^ Noting that the C APIs also do not expose such platform-specific APIs.