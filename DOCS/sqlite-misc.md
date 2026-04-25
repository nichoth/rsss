# Learning about sqlite3 WASM

**By DeepakNess** **April 24, 2025 • 3 min read**

I love sqlite3 and have used it for a few simple projects, but I recently came to know that Notion uses sqlite3 WASM in the browser for client-side caching – they have been able to improve their page navigation times by 20% by doing so.

I found it really interesting, so started reading more about it. Basically, this post is just my notes on the topic – I will be noting down whatever I read.

## What is sqlite3 WASM?

sqlite3 WASM or WebAssembly is a version of the SQLite database that's built to run in web browsers using WebAssembly. It lets you use a full SQLite database directly in the browser, powered by JavaScript and compiled C code, without needing a server.

And this version is officially supported by the SQLite team.

## Features

- Runs the complete SQLite engine within the browser using WebAssembly while supporting standard SQL queries and database operations without server-side components.
- Supports multiple JavaScript APIs, like:
    - **Low-level C API binding** that provide direct access to SQLite's C API
    - **High-level object-oriented API** that offers a more JavaScript-friendly interface
    - **Worker-based API** that enables operations in web-workers to prevent blocking the main thread
    - **Promise-based API** that simplifies asynchronous operations with a Promise-based interface
- Utilizes the **OPFS (Origin Private File System)** for persistent storage, so that the data remains available across sessions.
- Allows the creation of virtual tables and table-valued functions directly in JavaScript and also supports custom builds with additional features or optimizations.

## How Notion is using it

Earlier, Notion was using IndexedDB for storing data in the browser but it had issues like storage limits and inconsistent performances across different browsers, so they switched to sqlite3 WASM solving all these issues.

- Notion uses OPFS to store data locally - persistent across sessions
- To avoid slowing down, they run database operations in Web Workers in the background
- Only the active tab handles all database writes, and other tabs send their request to this active tab

Here's how they explain this:

> ... only one tab is permitted to actually use its Web Worker. A SharedWorker is responsible for managing which is the “active tab.” When the active tab closes, the SharedWorker knows to select a new active tab.
>
> To execute any SQLite query, the main thread of each tab sends that query to the SharedWorker, which redirects to the active tab's dedicated Worker. Any number of tabs can make simultaneous SQLite queries as many times as they want, and it will always be routed to the single active tab.

I also found a great [discussion on the topic on GitHub](https://github.com/mnotion/sqlite3-wasm) that you must check out.

I recommend reading the blog post by Notion as they have explained all the issues they were encountering and how they fixed it.

## Who uses sqlite3 WASM

Some notable examples would be:

- **Notion**: as we already discussed in the post
- **SQLime**: an online SQLite playground that runs entirely in the browser
- **Evolu.dev**: a local-first platform designed for developers

## Resources to learn more

- [sqlite3 WebAssembly & JavaScript Documentation Index](https://sqlite.org/wasm/doc/trunk/index.md)
- [SQLite Wasm in the browser backed by the OPFS](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system/)
- [A discussion about the same on HackerNews](https://news.ycombinator.com/item?id=33301073)

That's it. I will be reading more about it, and will keep this post updated.