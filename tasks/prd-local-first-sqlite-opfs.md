# PRD: Local-First Mode with SQLite WASM + OPFS

## 1. Introduction / Overview

RSSS today reads and writes exclusively through `remoteAdapter` (`src/client/db/remote-adapter.ts`), which calls the Hono API backed by a per-user `UserDO` Durable Object. Every page load and every user interaction makes a network round-trip. The README's "Local First" section is aspirational — there is no local store yet.

This feature adds a true local-first mode in the browser. Subscriptions, items (metadata), and per-item read/starred state all live in a SQLite database stored in OPFS via `@sqlite.org/sqlite-wasm`. The Durable Object remains the source of truth and merge point; the client syncs deltas in both directions.

The `DbAdapter` interface in `src/client/db/types.ts` already abstracts the data layer, so the change is largely additive: a second adapter, a sync engine, a settings surface, and bootstrap/migration plumbing.

## 2. Goals

- Provide a per-device opt-in local-first mode that survives reload, offline use, and temporary backend outages.
- Reuse the existing `DbAdapter` contract so route components do not change.
- Keep the Durable Object as the canonical store. The client never invents data the server has not seen.
- Sync deltas, not snapshots, after the first bootstrap. Reuse the existing `/api/sync?since=...` endpoint.
- Resolve concurrent edits across devices with last-write-wins on `updated_at`.
- Degrade gracefully on browsers/contexts without OPFS — fall back to `remoteAdapter` transparently.
- Keep SQLite WASM out of the initial bundle for users who never enable the feature.

## 3. User Stories

### US-001: Extract shared SQL schema
**Description:** As a developer, I want a single `schema.sql` file shared between the Durable Object and the browser SQLite database so the two stores cannot drift.

**Acceptance Criteria:**
- [ ] New file `src/shared/schema.sql` (or `src/shared/db/schema.sql`) contains the `feeds` and `items` table definitions, indexes, and `updated_at` triggers currently defined inline in `src/server/durable-objects/index.ts`.
- [ ] `src/server/durable-objects/index.ts` imports and executes the shared schema instead of inline strings. No behavior change for the DO.
- [ ] Server-side migration logic (the `ALTER TABLE` block adding `updated_at` to pre-existing rows) stays in the DO — it is server-only.
- [ ] Existing `npm run test:db` passes against the refactored DO.
- [ ] Typecheck and lint pass.

### US-002: Configure COOP/COEP headers for OPFS
**Description:** As a developer, I need cross-origin isolation enabled so the browser exposes the synchronous OPFS access handle that sqlite-wasm needs for its OPFS VFS.

**Acceptance Criteria:**
- [ ] Vite dev server (`vite.config.js`) sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response.
- [ ] Cloudflare Worker (`src/server/index.ts` / `wrangler.jsonc`) sends the same two headers for HTML and JS responses in production.
- [ ] `self.crossOriginIsolated === true` in DevTools after `npm start`.
- [ ] Existing static assets, OAuth flow, and Bluesky login still work end-to-end after the headers are added.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-003: Add sqlite-wasm dependency, lazy-loaded
**Description:** As a developer, I want the SQLite WASM bundle to load only when local-first is enabled so users who do not opt in pay no cost.

**Acceptance Criteria:**
- [ ] Add `@sqlite.org/sqlite-wasm` to dependencies.
- [ ] The new local adapter module is reached only via dynamic `import()` from the adapter factory; static imports of it are forbidden.
- [ ] `npm run build` produces a separate chunk for the sqlite-wasm code; verify by inspecting `public/` after build.
- [ ] No regression in the size of the initial entry chunk for users with the feature disabled (compare before/after).
- [ ] Typecheck and lint pass.

### US-004: Implement OPFS-backed `localAdapter`
**Description:** As a developer, I need a `DbAdapter` implementation that satisfies every method in `src/client/db/types.ts` against a SQLite database in OPFS.

**Acceptance Criteria:**
- [ ] New file `src/client/db/local-adapter.ts` exports `localAdapter:DbAdapter`.
- [ ] First call initializes sqlite-wasm with the OPFS VFS (`opfs-sahpool` or the standard `opfs` VFS — whichever is supported in the target browsers) and runs the shared schema from US-001.
- [ ] All read methods (`getFeeds`, `getItems`, `getItemByRoute`, `getCounts`) return the same shapes as `remoteAdapter`.
- [ ] All write methods (`addFeed`, `deleteFeed`, `updateItem`, `markAllRead`) update the local DB and stamp `updated_at = datetime('now')` on every affected row, and enqueue an outbound sync record (see US-008).
- [ ] New file `test/local-adapter.ts` runs in a browser test runner against an in-memory SQLite (skip OPFS in CI) and exercises every method of the adapter.
- [ ] Typecheck and lint pass.

### US-005: Adapter factory with OPFS detection and fallback
**Description:** As a user on a browser without OPFS support, I want the app to keep working — falling back silently to the remote adapter — rather than breaking.

**Acceptance Criteria:**
- [ ] New `src/client/db/index.ts` exports `getAdapter():Promise<DbAdapter>` (or similar) that returns `localAdapter` when (a) the user has opted in **and** (b) feature detection reports OPFS + `crossOriginIsolated`; otherwise returns `remoteAdapter`.
- [ ] Feature detection probes `navigator.storage?.getDirectory`, `crossOriginIsolated`, and the presence of `FileSystemSyncAccessHandle`. Result cached for the session.
- [ ] When the user has opted in but support is missing, the settings page shows a clear "Local storage unavailable in this browser" notice (see US-006).
- [ ] `state.ts` is refactored to call `await getAdapter()` once and reuse the result, instead of importing `remoteAdapter` directly.
- [ ] Existing routes (feeds, items, item-by-route) still function for users who never enable the feature.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-006: Settings UI with two toggles
**Description:** As a user, I want to opt in to local storage of my subscriptions and, separately, the content of items, so I can choose how much disk I'm willing to spend.

**Acceptance Criteria:**
- [ ] New settings route or settings panel exposes two toggles: "Sync subscriptions and read state to this device" and "Also store article content locally for offline reading".
- [ ] Subscriptions toggle is independent of and a prerequisite for the content toggle. Disabling subscriptions disables and greys out content.
- [ ] Settings persist in `localStorage` under a single namespaced key (e.g. `rsss.localFirst`).
- [ ] Toggling on triggers the bootstrap flow (US-010); toggling off triggers the reset flow (US-011) after a confirmation dialog.
- [ ] When OPFS is unavailable, both toggles are disabled and an explanatory notice is shown.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-007: Pull-sync (server -> local) using existing `/api/sync`
**Description:** As a user, I want my local database to receive changes made on other devices or by the server's feed-refresh alarm.

**Acceptance Criteria:**
- [ ] `localAdapter.sync()` calls `/api/sync?since=<lastPullAt>` and upserts returned feeds and items into the local SQLite DB.
- [ ] `lastPullAt` is stored in a small `sync_meta` table inside the local DB (single-row).
- [ ] When the "store content locally" toggle is off, item rows are stored with `content` and `description` set to `NULL` and re-fetched on demand from `/api/items/by-route` for the currently-open item.
- [ ] Pull-sync runs on app startup (when authenticated) and on the `online` window event.
- [ ] On the first sync after opt-in, `since` is omitted so the server returns the full snapshot (see US-010).
- [ ] Typecheck and lint pass.

### US-008: Push-sync (local -> server)
**Description:** As a user, I want changes I make offline (toggling read/starred, adding/removing feeds) to be uploaded once I'm back online.

**Acceptance Criteria:**
- [ ] Local writes append a record to a local `outbox` table containing the operation, target row id, payload, and a client-generated `client_updated_at`.
- [ ] A push step drains the outbox by calling the matching existing API endpoints (`POST /api/feeds`, `DELETE /api/feeds/:id`, `PATCH /api/items/:id`, `POST /api/items/mark-all-read`).
- [ ] Push runs after every successful pull, and on the `online` event.
- [ ] If a push call fails with 5xx or network error, the outbox row is retained and retried on the next cycle. 4xx responses other than 401 mark the row as failed and surface a notification.
- [ ] On 401, the user is redirected through the login flow; outbox is preserved.
- [ ] New file `test/sync.ts` covers happy path, retry, and 4xx-rejection.
- [ ] Typecheck and lint pass.

### US-009: Last-write-wins conflict resolution
**Description:** As a user using the same account on multiple devices, I want the most recent edit to a row to win, with the server arbitrating.

**Acceptance Criteria:**
- [ ] Push payloads include `client_updated_at`. The server (DO) compares against the row's current `updated_at` and applies the change only if `client_updated_at > existing.updated_at`. This requires extending the existing PATCH/POST endpoints in `src/server/durable-objects/index.ts`.
- [ ] Rejected pushes are returned to the client with the server's authoritative row, which the client then upserts locally.
- [ ] On pull, every returned row replaces its local counterpart unconditionally (server is source of truth at pull time).
- [ ] New unit tests in `test/sync.ts` cover: (a) local edit wins over older server row, (b) server edit wins over older local row, (c) ties go to the server.
- [ ] Typecheck and lint pass.

### US-010: First-time bootstrap
**Description:** As a user enabling local-first for the first time on a device, I want to see a clear progress indicator while my data is downloaded and my reads continue to work.

**Acceptance Criteria:**
- [ ] When the subscriptions toggle is turned on, the app initializes OPFS, runs the schema, and performs one `/api/sync` call without `since`.
- [ ] During bootstrap, reads continue to be served from `remoteAdapter` so the UI is never blank.
- [ ] A non-blocking progress indicator shows row counts as they land (feeds, items).
- [ ] Bootstrap is idempotent — re-running it on an existing local DB causes upserts, not duplicates or errors.
- [ ] If bootstrap fails, the toggle reverts to off and an error notice is shown; the local DB file is deleted.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-011: Reset / disable local-first
**Description:** As a user, I want to turn local-first off and have my local SQLite file deleted so I'm not leaving data on a shared machine.

**Acceptance Criteria:**
- [ ] Disabling the subscriptions toggle prompts a confirmation dialog naming what will be deleted.
- [ ] On confirm, any pending outbox rows are flushed (best-effort; offline = abandon with warning), the OPFS file is removed via `FileSystemDirectoryHandle.removeEntry`, and the adapter selection flips to `remoteAdapter` for the rest of the session.
- [ ] A "Reset local data" button in settings is available even when the toggle is on, performing a full wipe + re-bootstrap.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-012: Sync status indicator
**Description:** As a user, I want to see whether the app is online, when it last synced, and whether there are pending local changes.

**Acceptance Criteria:**
- [ ] A small status element (e.g. in the header or footer) displays one of: "Synced HH:MM", "Offline — N pending", "Syncing…", "Sync error" with a tooltip showing the last error message.
- [ ] The element is hidden when local-first is disabled.
- [ ] Status is driven by signals (`@preact/signals`) updated by the sync engine; multiple signal writes use `batch()` per the project style.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

## 4. Functional Requirements

- **FR-1:** A new `localAdapter` MUST implement every method of the `DbAdapter` interface in `src/client/db/types.ts`.
- **FR-2:** `localAdapter` MUST persist its data in a single OPFS-backed SQLite database file scoped to the authenticated user (e.g. filename derived from a stable user id).
- **FR-3:** The client MUST NOT load `@sqlite.org/sqlite-wasm` until the user has explicitly opted in **and** OPFS is detected as available.
- **FR-4:** The client MUST share the table-creation SQL with the Durable Object via a single source-of-truth file. Schema drift is a build/test failure.
- **FR-5:** The client MUST send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers on document responses in both dev and production.
- **FR-6:** When OPFS is unavailable, the adapter factory MUST return `remoteAdapter` regardless of the user's toggle state, and the settings UI MUST inform the user.
- **FR-7:** Pull sync MUST request only the delta since `lastPullAt` after the first bootstrap, using the existing `/api/sync?since=` endpoint.
- **FR-8:** Push sync MUST send `client_updated_at` with every mutating call. The server MUST reject the change when its current `updated_at` is greater, returning the authoritative row.
- **FR-9:** On a successful pull, the local copy of every returned row MUST be replaced by the server copy.
- **FR-10:** Local writes MUST be buffered in an `outbox` table while offline and drained automatically when the browser fires the `online` event.
- **FR-11:** Disabling the subscriptions toggle MUST delete the OPFS file after a flush attempt and a confirmation prompt.
- **FR-12:** When the "store content locally" toggle is off, item rows in the local DB MUST omit `content`/`description`; the reader view MUST fetch the body on demand.
- **FR-13:** The status indicator MUST reflect online/offline state, last successful sync time, pending outbox count, and last error.

## 5. Non-Goals (Out of Scope)

- No CRDT-based merging. Last-write-wins is sufficient for v1.
- No client-side feed fetching or RSS parsing. The Durable Object alarm remains the only entity that pulls from upstream feeds.
- No background sync via Service Worker / Background Sync API. The sync engine runs only when a tab is open.
- No cross-account or shared-device profile management. One OPFS file per authenticated identity per browser profile.
- No encryption-at-rest for the OPFS database in v1. Document the implication in settings copy.
- No migration from any existing IndexedDB store (none exists).
- No native (mobile/desktop) packaging. Browser only.
- No undo / version history for synced rows.

## 6. Design Considerations

- Reuse the existing settings page pattern and the project's `@substrate-system/check-box` component for the two toggles.
- The status indicator should fit the existing header style — small, monochrome, with a tooltip.
- Confirmation dialog for reset should reuse whatever dialog primitive the project already has (or document if a new one is required — keep it minimal).
- Adhere to the user's CSS conventions: nested selectors, variables in `_variables.css` / `_vars.css`, no font sizes below 1rem, ternary and type-annotation style as per global CLAUDE.md.

## 7. Technical Considerations

- **OPFS access:** `@sqlite.org/sqlite-wasm` ships two OPFS VFSes — the older synchronous-handle one (requires worker) and `opfs-sahpool`. Pick `opfs-sahpool` for simplicity unless concurrency requires otherwise. The decision should be documented in code, not this PRD.
- **Cross-origin isolation:** Adding COOP/COEP can break embeds and any third-party resource without `Cross-Origin-Resource-Policy` headers. Audit current third-party assets (Bluesky avatars, etc.) and add `crossorigin="anonymous"` where needed; OAuth popups must still work.
- **Existing sync endpoint:** `src/server/durable-objects/index.ts` already exposes a sync endpoint that filters by `updated_at > since`. Confirm response shape and pagination behavior before reuse; extend if needed.
- **`updated_at` semantics:** The DO already auto-stamps via triggers. The client must do the same — either by trigger or by explicit update — and must send a `client_updated_at` field that the server uses for LWW comparison.
- **Outbox idempotency:** Adding a feed twice (offline retry) should not create duplicates. The server's existing dedup-on-URL behavior should be confirmed; if absent, push payloads should include a `client_op_id` to make replays safe.
- **User-scoped filename:** Use the AT Protocol DID as the OPFS filename so logging in/out across accounts on the same browser does not cross-contaminate.
- **Service Worker (`src/sw/`):** Verify that adding COOP/COEP doesn't break the existing SW registration; SWs are subject to their own COEP rules.
- **Bundle size:** sqlite-wasm is ~1MB compressed. Lazy-loading is required — confirm no static reference creeps in via the factory.
- **Testing:** OPFS is hard to exercise headlessly. Unit-test against in-memory SQLite (`:memory:`); cover OPFS-specific paths with a single manual playwright test or document the gap.

## 8. Success Metrics

- After opt-in, navigating between feed/items/reader views performs zero blocking network requests for read paths (verified in DevTools network tab).
- Cold reload time on opted-in devices drops by at least 50% vs. baseline (current measurement TBD as part of US-002).
- Toggling read/starred state shows up in the UI in under 50ms, regardless of network latency.
- Two browsers signed in to the same account converge within one sync cycle (~ next online event) on conflicting edits, with the more recent edit winning.
- Users on browsers without OPFS see no functional regression relative to today.

## 9. Open Questions

- Does the existing `/api/sync` endpoint return a single page or paginate? If single-page, large initial bootstraps may need explicit chunking — should that be added now or deferred until a real user hits the limit?
- For the "content stored locally" toggle, do we evict existing locally-stored content when the user toggles it off, or only stop fetching new content?
- Should the OPFS file name include a schema version suffix (e.g. `rsss-{did}-v1.sqlite3`) so future incompatible schema changes can sidestep migration entirely?
- Do we want a "force full re-sync" debug action visible to all users or hidden behind a query param?
- Cloudflare Workers static asset response headers — is the right place to add COOP/COEP `wrangler.jsonc` (`assets.headers`) or middleware in `src/server/index.ts`? Decide during US-002.
- Reference docs: https://sqlite.org/wasm/doc/trunk/index.md — confirm browser support matrix matches our browserslist config before locking in `opfs-sahpool`.
