The following is the Markdown content of the
[SQLite Wasm/JS Cookbook](https://sqlite.org/wasm/doc/trunk/cookbook.md)
page from the official SQLite repository.

---

# SQLite Wasm/JS Cookbook

This page provides "recipes" for common tasks in the SQLite Wasm/JS
environment.

- [Loading the Library](#loading)
- [Basic Usage (Main Thread)](#basic-usage-main)
- [Persistent Storage (OPFS)](#opfs)
- [Using the Worker API](#worker-api)
- [Using the Promise-based Worker API ("Promiser")](#promiser)

<a id="loading"></a>
## Loading the Library

The library is typically loaded as an ES6 module. The `sqlite3.mjs` file
is the entry point.

```javascript
import sqlite3InitModule from './sqlite3.mjs';

const sqlite3 = await sqlite3InitModule({
  print: console.log,
  printErr: console.error,
});
```

The `sqlite3` object returned by the promise contains the various APIs
(OO1, C-style, etc.).

---

<a id="basic-usage-main"></a>
## Basic Usage (Main Thread)

Using the "OO1" (Object-Oriented) API for simple, in-memory database operations.

```javascript
const db = new sqlite3.oo1.DB(); // Defaults to ':memory:'
try {
  db.exec("CREATE TABLE t(a,b)");
  db.exec("INSERT INTO t(a,b) VALUES(1,2),(3,4)");
  
  // Select values using a callback:
  db.exec({
    sql: "SELECT a, b FROM t",
    callback: (row) => {
      console.log("Row:", row);
    }
  });
  
  // Select values into an array:
  const rows = db.exec("SELECT a, b FROM t", {returnValue: "resultRows"});
  console.log("Result rows:", rows);
} finally {
  db.close();
}
```

---

<a id="opfs"></a>
## Persistent Storage (OPFS)

The Origin Private File System (OPFS) is the primary way to get persistent,
high-performance storage in the browser. This **must** be run in a Web Worker.

```javascript
// Inside a Web Worker:
const sqlite3 = await sqlite3InitModule();

if ('opfs' in sqlite3) {
  const db = new sqlite3.oo1.OpfsDb('/mydb.sqlite3');
  console.log("Opened OPFS database:", db.filename);
  db.exec("CREATE TABLE IF NOT EXISTS users(id, name)");
  // ...
  db.close();
} else {
  console.error("OPFS is not available in this browser context.");
}
```

---

<a id="worker-api"></a>
## Using the Worker API

SQLite provides a pre-built Worker implementation that handles the communication
logic for you.

**worker.js:**
```javascript
import sqlite3InitModule from './sqlite3.mjs';

sqlite3InitModule().then((sqlite3) => {
  // This automatically starts the worker message listener
  sqlite3.initWorker1API();
});
```

**main.js:**
```javascript
const worker = new Worker('worker.js', {type: 'module'});

worker.onmessage = (event) => {
  const data = event.data;
  if (data.type === 'open') {
    console.log("Database opened via worker!");
  }
};

worker.postMessage({
  type: 'open',
  args: { filename: ':memory:' }
});
```

---

<a id="promiser"></a>
## Using the Promise-based Worker API ("Promiser")

The "Promiser" API wraps the Worker communication in a Promise-based interface,
making it much easier to use with `async/await`.

```javascript
import { sqlite3Worker1Promiser } from './sqlite3-worker1-promiser.mjs';

const promiser = await new Promise((resolve) => {
  const p = sqlite3Worker1Promiser({
    onready: () => resolve(p)
  });
});

// Open a database
await promiser('open', { filename: ':memory:' });

// Execute SQL
let response = await promiser('exec', {
  sql: "CREATE TABLE t(a,b); INSERT INTO t VALUES(1,2); SELECT * FROM t"
});

console.log("Results:", response.result);
```

---

## Important Deployment Notes

To use OPFS or SharedArrayBuffer (required for certain features), your server
**must** send the following HTTP headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these, the `sqlite3` object will not expose the `opfs` VFS, and WASM memory cannot be shared between the main thread and workers effectively.