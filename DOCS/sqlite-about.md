# About the sqlite3 WASM/JS Subproject

WebAssembly, a.k.a. WASM, is a standard defining a low-level programming language suitable (A) as a target for cross-compilation from many other languages and (B) for running via a virtual machine in a browser. Designed with scriptability via JavaScript in mind, it provides a way to compile C code (among others) to WASM and script it via JavaScript with relatively little friction despite the vast differences between JavaScript and C.

Folks have been building sqlite3 for the web since as far back as 2012 but this subproject is the first effort "officially" associated with the SQLite project, created with the goal of making WASM builds of the library first-class members of the family of supported SQLite deliverables.

## Specific Goals of this Project

The concrete goals of this project include...

* Except where noted in the non-goals, provide a more-or-less feature-complete wrapper to the sqlite3 C API, insofar as WASM feature parity with C allows for. In fact, provide at least the following APIs:
    1.  **Bind a low-level sqlite3 API** which is as close to the native one as feasible in terms of usage.
    2.  **A higher-level OO API**, more akin to `sql.js` and `node.js`-style implementations. This one speaks directly to the low-level API. This API must be used from the same thread as the low-level API.
    3.  **A Worker-based API** which speaks to the previous APIs via Worker messages. This one is intended for use in the main thread, with the lower-level APIs installed in a Worker thread, and talking to them via Worker messages. Because Workers are asynchronous and have only a single message channel, some acrobatics are needed here to feed async work results back to the client.
    4.  **A Promise-based variant of the Worker API** (#3, above) which entirely hides the cross-thread communication aspects from the user.
* Insofar as possible, **support persistent client-side storage** using available JS APIs. As of this writing, that includes the Origin-Private FileSystem (OPFS) and (very limited) storage via the `window.localStorage` and `window.sessionStorage` backend.

## Specific Non-goals

Things we specifically do not aim to achieve:

* **UTF16 support:** As WASM is a web-centric technology and UTF-8 is the King of Encodings in that realm, there are no current plans to support the UTF16-related sqlite3 APIs.
* **Non-browser WASM runtimes:** Although support for out-of-browser WASM runtimes is widespread, this project is currently focused only on browser targets.
* **Supporting old or niche-market platforms:** WASM is built for a modern web and requires modern platforms. Similarly, sqlite3 library options which have been deprecated are not included in the WASM interface.

## Attribution

Several projects have helped us considerably along the way. We are greatly indebted to:

* **Emscripten** ([https://emscripten.org](https://emscripten.org))
    The Emscripten WASM toolchain is the only full-featured WASM toolchain available. It offers several "killer features," most notably transparent emulation of POSIX file I/O APIs.
* **sql.js** ([https://github.com/sql-js/sql.js](https://github.com/sql-js/sql.js))
    Alon Zakai's `sql.js` was an essential stepping stone, demonstrating how to handle WASM-related "voodoo" like handling pointers-to-pointers.
* **absurd-sql** ([https://github.com/jlongster/absurd-sql](https://github.com/jlongster/absurd-sql))
    James Long's `absurd-sql` demonstrated persistent browser-side SQLite databases by storing them in IndexedDB.
* **wa-sqlite** ([https://github.com/rhashimoto/wa-sqlite](https://github.com/rhashimoto/wa-sqlite))
    Roy Hashimoto's `wa-sqlite` was the first project to publish an OPFS storage option for sqlite3.