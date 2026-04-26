# PRD: Finish Local-First SQLite WASM Mode

## 1. Introduction / Overview

RSSS now has most of the local-first structure described in
`README.md#architecture`: a shared schema, a `DbAdapter` abstraction,
local reads and writes, pull sync, push sync, settings, and a sync status
component. The remaining work is not to start local-first from scratch.
It is to make the existing implementation production-correct, browser-safe,
and verifiably backed by SQLite WASM persisted to OPFS.

The largest open risk is the SQLite runtime boundary. The current client code
uses `@sqlite.org/sqlite-wasm` directly from `src/client/db/sqlite-init.ts`
and checks for `FileSystemSyncAccessHandle` on `globalThis`. The SQLite WASM
docs in `DOCS/*.md` say persistent OPFS SQLite must run in a Worker context,
and recommend Worker or Promise-worker APIs for browser apps. This means RSSS
needs a focused completion pass around SQLite worker initialization, OPFS
capability detection, packaging, and browser verification.

This PRD defines what still needs to be implemented for a reliable v1.

## 2. Goals

- Ensure opted-in users read and write from an OPFS-backed SQLite database.
- Keep remote API behavior unchanged for users who do not opt in.
- Run SQLite WASM work off the main UI thread.
- Preserve the existing `DbAdapter` contract used by `State`.
- Make bootstrap, pull, push, disable, and reset flows browser-verifiable.
- Keep local-first disabled when OPFS persistence is unavailable.
- Add tests and browser checks that prove data persists across reload.

## 3. Current State

The following local-first pieces already exist and should be treated as
implemented baseline:

- `@sqlite.org/sqlite-wasm` is installed.
- `src/shared/schema.ts` defines shared feed/item SQL.
- `src/client/db/local-adapter.ts` implements `DbAdapter`.
- `src/client/db/index.ts` selects local vs. remote adapters.
- `src/client/db/bootstrap.ts` runs first-time bootstrap.
- `src/client/db/pull-sync.ts` pulls `/api/sync`.
- `src/client/db/push-sync.ts` drains an `outbox` table.
- `src/client/routes/settings.ts` exposes local storage controls.
- `src/client/components/sync-status.ts` displays sync state.
- `src/server/isolation-headers.ts` and `vite.config.js` add COOP/COEP.
- Tests exist for sqlite init, local adapter, pull sync, push sync,
  bootstrap, local-first settings, adapter factory, and server LWW logic.

The following gaps remain:

- SQLite is not clearly isolated behind a Worker or promise-worker API.
- OPFS support detection is likely testing the wrong global context.
- The build explicitly adds `sqlite-init` as a separate entry, which may load
  SQLite for users who never opt in.
- No browser test proves OPFS persistence across reload or restart.
- The service worker described in `DOCS/README.md` is not present.
- Pull and push sequencing can leave the UI stale after online sync.
- Conflict, timestamp, and outbox semantics need final hardening.
- README and the existing implementation disagree in several details.

## 4. User Stories

### US-001: Move SQLite Runtime Behind a Worker Boundary
**Description:** As a user, I want local database operations to avoid blocking
the UI so reading and toggling items stays responsive.

**Acceptance Criteria:**
- [ ] Add a dedicated SQLite Worker module for browser local-first storage.
- [ ] The Worker initializes `@sqlite.org/sqlite-wasm` once per tab session.
- [ ] The Worker opens the per-user SQLite DB in OPFS.
- [ ] Main-thread code talks to the Worker through promise-based messages.
- [ ] `createLocalAdapter` keeps the `DbAdapter` interface unchanged.
- [ ] Long bootstrap and query operations do not run on the main thread.
- [ ] Typecheck and lint pass.
- [ ] Verify in browser using dev-browser skill.

### US-002: Fix OPFS Capability Detection
**Description:** As a user, I want local-first to enable only when the browser
can actually persist SQLite to OPFS.

**Acceptance Criteria:**
- [ ] Capability detection runs in, or consults, the SQLite Worker context.
- [ ] Detection checks `navigator.storage.getDirectory`.
- [ ] Detection confirms the selected SQLite VFS is available.
- [ ] Detection does not depend on main-thread-only false positives.
- [ ] Unsupported browsers fall back to `remoteAdapter`.
- [ ] Settings shows a clear unavailable state when persistence is missing.
- [ ] Unit tests cover supported, unsupported, and failed-open cases.
- [ ] Verify in browser using dev-browser skill.

### US-003: Prove OPFS Persistence Across Reload
**Description:** As a user, I want local data to survive page reloads and app
restarts after I enable local-first.

**Acceptance Criteria:**
- [ ] Add a browser test that enables local-first and bootstraps data.
- [ ] The test reloads the page and verifies feeds/items load offline-capable
  from the local SQLite DB.
- [ ] The test confirms no full bootstrap repeats after reload.
- [ ] The test disables local-first and verifies the OPFS file is removed.
- [ ] Document any browser that cannot run this test reliably in CI.
- [ ] Verify in browser using dev-browser skill.

### US-004: Keep SQLite WASM Out of the Initial App Path
**Description:** As a user who does not enable local-first, I should not pay
the SQLite WASM download or parse cost.

**Acceptance Criteria:**
- [ ] Remove `sqlite-init` as a standalone Vite build input unless required.
- [ ] Confirm `@sqlite.org/sqlite-wasm` is loaded only after opt-in.
- [ ] Confirm the Worker and WASM files are emitted as lazy assets.
- [ ] Compare the initial client bundle before and after the change.
- [ ] Add a small build note documenting how to inspect the chunks.
- [ ] Typecheck and lint pass.

### US-005: Harden Pull/Push Ordering and UI Refresh
**Description:** As a user, I want the visible list, counts, and reader state
to converge after startup and after coming back online.

**Acceptance Criteria:**
- [ ] Startup sync runs in a deterministic order.
- [ ] Online-event sync refreshes feeds, items, counts, and route item state.
- [ ] Push runs after local writes when online, or is scheduled promptly.
- [ ] Pending outbox count is updated after every push attempt.
- [ ] Pull and push errors update sync status without hiding local data.
- [ ] Tests cover startup sync and online-event refresh behavior.

### US-006: Finish Server/Client Conflict Semantics
**Description:** As a multi-device user, I want edits to converge without
duplicate feed rows or lost read/star state.

**Acceptance Criteria:**
- [ ] Every outbox operation includes `client_op_id`.
- [ ] Server mutations treat duplicate `client_op_id` retries idempotently,
  or the PRD documents why URL/row constraints are sufficient for v1.
- [ ] Server conflict responses return authoritative rows in a consistent
  shape for feed, item, and mark-all-read operations.
- [ ] Client 409 handling updates local rows and clears the outbox row.
- [ ] Ties and stale client timestamps are covered by tests.
- [ ] Tests cover feed add retry, feed delete conflict, item update conflict,
  and mark-all-read conflict.

### US-007: Clarify Content Storage Behavior
**Description:** As a user, I want the content storage toggle to have clear,
predictable behavior when I turn it on or off.

**Acceptance Criteria:**
- [ ] Define whether disabling content storage deletes existing local content.
- [ ] If disabling deletes content, implement a local SQL cleanup.
- [ ] If disabling only affects future pulls, document that in settings copy.
- [ ] Reader route fetches missing content from the server when online.
- [ ] Offline reader state handles missing content without a crash.
- [ ] Tests cover `storeContent` true, false, and toggled-off behavior.
- [ ] Verify in browser using dev-browser skill.

### US-008: Reconcile PWA Documentation with Reality
**Description:** As a developer, I want docs to match the app so future work
does not chase nonexistent files or wrong architecture.

**Acceptance Criteria:**
- [ ] Decide whether v1 includes a service worker.
- [ ] If yes, add the service worker and registration described in docs.
- [ ] If no, update `DOCS/README.md` and README to remove that claim.
- [ ] Update README file tree comments to match `@sqlite.org/sqlite-wasm`.
- [ ] Document the chosen SQLite VFS and Worker approach.
- [ ] Document browser support and fallback behavior.

### US-009: Add Local-First Operational Recovery
**Description:** As a user, I want a clear recovery path when the local DB is
corrupt, locked, unavailable, or too full.

**Acceptance Criteria:**
- [ ] Opening the local DB handles SQLite open errors distinctly.
- [ ] Corruption or incompatible schema shows a reset-local-data path.
- [ ] Quota errors show an actionable settings error.
- [ ] Reset drains outbox best-effort before wiping.
- [ ] Reset closes the Worker DB handle before OPFS deletion.
- [ ] Tests cover failed open, failed bootstrap, and reset after failure.

### US-010: Verify Styling and Settings UX
**Description:** As a user, I want local-first controls and status to fit the
existing UI and remain accessible.

**Acceptance Criteria:**
- [ ] Settings controls remain keyboard accessible.
- [ ] Sync status is announced through useful text and tooltip copy.
- [ ] CSS follows project rules: variables for colors and no border radius
  except icon/icon-button cases.
- [ ] Text fits on mobile and desktop.
- [ ] Browser verification covers settings, bootstrap progress, sync status,
  reset, and unsupported-browser state.

## 5. Functional Requirements

- **FR-1:** Local-first reads must use browser SQLite persisted to OPFS.
- **FR-2:** SQLite initialization and query execution must happen in a Worker.
- **FR-3:** Main-thread app code must keep using `DbAdapter`.
- **FR-4:** `getAdapter(did)` must return `remoteAdapter` unless the user has
  opted in and OPFS-backed SQLite is verified available.
- **FR-5:** The first local sync must seed the DB from `/api/sync` without a
  `since` parameter.
- **FR-6:** Later pull syncs must call `/api/sync?since=<last_pull_at>`.
- **FR-7:** Local writes must update SQLite first and enqueue an outbox row.
- **FR-8:** Online push sync must drain outbox rows in FIFO order.
- **FR-9:** Failed network or 5xx push attempts must preserve outbox rows.
- **FR-10:** Auth or billing failures must preserve local data and outbox rows.
- **FR-11:** Conflict responses must update local SQLite with server truth.
- **FR-12:** Disabling local-first must remove the OPFS database after a
  confirmation prompt.
- **FR-13:** Reset must wipe and re-bootstrap local data.
- **FR-14:** SQLite WASM must not be part of the default initial app bundle.
- **FR-15:** Docs must accurately describe the implemented local-first path.

## 6. Non-Goals

- No CRDT merge system for v1.
- No client-side RSS fetching or parsing.
- No encryption-at-rest for OPFS in this pass.
- No multi-tab leader election in v1 unless Worker/OPFS locking forces it.
- No migration from IndexedDB.
- No native desktop or mobile wrapper.
- No background sync API unless a service worker is explicitly added.

## 7. Design Considerations

- Reuse the existing settings route and `@substrate-system/check-box`.
- Keep local-first controls in the Settings page.
- Keep status compact in the existing header.
- Avoid adding explanatory in-app text beyond actionable state and errors.
- Follow AGENTS.md CSS rules: global color variables and no border radius
  except icon or icon-button cases.
- Use `@preact/signals` for state and attach mutating app behavior to `State`.

## 8. Technical Considerations

- `DOCS/sqlite-persistence.md` says OPFS is Worker-context storage. This should
  drive the implementation shape.
- `opfs-sahpool` may avoid COOP/COEP in some cases, but this app already sends
  COOP/COEP. Keep the headers unless they break OAuth or assets.
- The current `isLocalFirstSupported()` and `isOpfsSupported()` checks should
  be revalidated because they inspect the main `globalThis`.
- The current `removeOpfsDb()` may fail if a Worker still holds the database.
  Close the DB before removing the OPFS entry.
- The shared schema is TypeScript SQL strings, not a `.sql` file. That is fine
  if tests prevent server/client drift.
- The Durable Object remains the canonical merge point.
- Browser tests should be preferred for OPFS behavior. Unit tests can keep
  using in-memory SQLite.

## 9. Success Metrics

- After opt-in and bootstrap, feed and item read paths work after reload with
  the network disabled.
- Toggling read/star state updates UI in under 50 ms on a normal local device.
- SQLite WASM assets do not load for a fresh user who never opens local-first.
- Coming back online drains pending outbox rows without manual refresh.
- Unsupported browsers continue to use the remote adapter without data loss.
- Browser verification shows local-first enable, reload, offline read, reset,
  and disable flows all work.

## 10. Open Questions

- Should local-first v1 support multiple open tabs, or is single-tab behavior
  acceptable with a clear fallback on lock errors?
- Should disabling `storeContent` purge existing local content immediately?
- Should `/api/sync` paginate before launch, or can v1 assume one response?
- Should the OPFS filename include a schema version suffix?
- Should a service worker be implemented now, or should PWA docs be corrected
  to state that offline data requires an already-loaded app tab?
