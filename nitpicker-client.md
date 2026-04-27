# Nitpicker — Client-side local-first cache & sync review
**Status**: complete
**Scope**: client-side (src/client/db, state.ts, local-first-settings.ts)
**Date**: 2026-04-27

## Top 5 things to fix before launch
See bottom of report — filled in after the area-by-area pass.

## P0 — would lose user data or break sync silently

### P0-1. `/api/sync` is not paginated; first-run bootstrap returns the entire DO into one JSON response
**Files**: `src/server/durable-objects/index.ts:549–615`, `src/client/db/pull-sync.ts:205–280`, `src/client/db/bootstrap.ts:79–86`

The brief explicitly says "first-run seed paging through `/api/sync`". There is **no paging**. The DO endpoint at `/sync` does `SELECT * FROM feeds` and `SELECT items.*, feeds.title FROM items JOIN feeds...` with **no `LIMIT`, no `cursor`, no `since`-window**, then `c.json({ feeds, items, ... })` returns the entire result set.

For a user with 200 feeds × 50 items each = 10,000 items with article content, this is an N-MB JSON blob materialized in DO memory, transferred in one shot, parsed entirely on the client, and then iterated synchronously inside one BEGIN…COMMIT transaction in `pull-sync.ts:251–268`. Failure modes:
- DO memory blow-up: CF Worker limit is 128 MB; one user with content-stored feeds will trip it.
- Network interruption mid-download: the entire sync is wasted, `last_pull_at` is never set, so next attempt starts over from full-snapshot.
- Worker CPU time: 10s/30s on paid plans. A 50,000-item array with `feeds` JOIN does not finish in 30s.
- Client-side memory: `await res.json()` materializes the whole thing before we iterate; OOMs on memory-constrained mobile.
- The bootstrap progress UI (`bootstrapItemsCount`) only ticks once we're inside the for-loop, so a user staring at "Bootstrap..." for 90 seconds while the JSON downloads has zero feedback.

The `bootstrapLocalDb` "progress signals" are a lie about progress — they only update during the post-download loop, which is the fast part.

**Fix**: Make `/sync` cursor-paginate by `(updated_at, id)` with a hard cap (e.g. 500 items/page). Client loops until the response signals `hasMore: false`. `last_pull_at` is committed only on the final page **or** the cursor is committed per-page so a resumed bootstrap doesn't redo work. Even better: stream items as NDJSON.

### P0-2. Bootstrap interruption silently destroys the local DB and disables local-first without telling the user
**Files**: `src/client/db/bootstrap.ts:92–107`

On *any* error (network blip, 500, the user closes the tab during download), the `catch` block:
1. Logs the message into `bootstrapError`.
2. Closes the DB.
3. Runs `bootstrapFailureCleanups()` which clears the adapter cache.
4. **Calls `setSyncSubscriptions(false)` and `saveLocalFirstSettings()`** — flipping the user's preference off without their consent.
5. **Calls `removeOpfsDb(did)` — wiping the OPFS file**.

This means a transient `fetch` rejection (e.g. user driving through a tunnel) silently flips local-first off. They would have to navigate to settings, find the toggle, re-enable, re-bootstrap. There is no retry. There is no "bootstrap failed, try again?" prompt. The user's intent is overwritten by a network glitch.

It's also racy with anything else relying on `syncSubscriptions`: the catch path mutates the signal *and* persists it, so any other code reading `syncSubscriptions.value` later in the same tick sees stale-then-flipped state.

**Fix**: Distinguish transient (network, 5xx) from terminal (corruption, schema mismatch) errors. On transient, leave the toggle on, leave the OPFS file alone, surface a retry button. On terminal, prompt the user before wiping.

### P0-3. Push-sync `add_feed` 2xx success path drops the response body when the optimistic local id doesn't match
**Files**: `src/client/db/push-sync.ts:192–209, 338–354`

Re-look at `reconcileSuccessfulAddFeed`:
```ts
if (row.target_id !== null) {
    await execDb(db, {
        sql: 'DELETE FROM feeds WHERE id = ?',
        bind: [row.target_id]
    })
}
await upsertFeedFromServer(db, feed)
```

This deletes the optimistic row by its **client-side id** before inserting the server-canonical row. Good, fixes nitpicker.md #9. **But**: `DELETE FROM feeds WHERE id = ?` cascades nothing because foreign keys are off in OPFS-SAH-pool unless `PRAGMA foreign_keys = ON;` is sticky per-connection. It *is* applied in `applySchema` (sqlite-worker.ts:144), so good. **But** — `items` rows that arrived for the optimistic feed (which can't happen yet because the feed was new, but on re-bootstrap of an existing DB this absolutely can happen) will be cascade-deleted along with the feed, and then `upsertItemFromServer` later re-inserts them with the new feed_id. If pull-sync is interrupted between the DELETE and the items being re-fetched, the user loses items.

More concretely, the broader issue: this entire reconciliation runs **outside** the transaction wrapping the body deserialization (line 341-349 wraps it, OK) — but the DELETE on `feeds` will cascade to `items` (because `PRAGMA foreign_keys = ON` is set in the worker on open). The user's `is_read`/`is_starred` state for items they had on the optimistic feed is destroyed and re-created with whatever the server thinks (which is `is_read = 0`). This is silent local-state loss.

**Fix**: Don't issue raw DELETEs that cascade. Either UPDATE the feeds row in place (set id to the server's id — but PK can't be updated), or copy items first. Or: only delete the feed row when no items are attached (the new-feed case). Add a test for the "user adds a feed offline → reads some items locally → goes online → push lands" sequence and verify is_read survives.

### P0-4. Outbox payload for `update_item` includes raw boolean values; server expects JSON booleans, but the local DB stores `is_read` as `0/1`
**Files**: `src/client/db/local-adapter.ts:182–218`, `src/client/db/push-sync.ts:259–308`

`updateItem` writes `{ id, is_read: true|false, is_starred: true|false }` into the outbox payload (line 209-212). `buildRequest` then ships `{ ...payload, ...base }` to PATCH `/api/items/${id}` (line 288-294). That's correct (booleans match the existing remote-adapter contract).

But: the outbox row's `payload` JSON contains the booleans, **not** the values that were actually written to the local items row (which were `0/1`). If the server has stricter validation (it doesn't right now, but might) and rejects the payload, the local row is stuck with the new value while the outbox repeatedly fails. There's no test for `is_read: false` (unstarring or marking unread) — the only test path is `is_read: true`. Verify both directions.

Smaller correctness issue: if the user toggles read → unread → read on the same item before push drains, you create three outbox rows. Push will replay them in order, which is correct for LWW. But if the second one fails persistently and goes to dead_letter_outbox, the third one can succeed and now the local-vs-server state is: local = read, server = read, but the unread intent is in DLQ forever. Not data loss, but dead letters need a UI surface (currently they're a count only).

### P0-5. Pull-sync uses string > comparison on `last_pull_at` while the timestamp format is mixed across paths
**Files**: `src/client/db/pull-sync.ts:213–217, 267`, `src/client/db/local-adapter.ts:44, 200, 234`, `src/server/durable-objects/index.ts:596–607`

This is the same bug noted in `nitpicker.md #19`, and it has been **partially fixed** (the new `formatSqliteTs` helper at `src/client/db/time.ts` is now used by `addFeed` and the `now` constants in `updateItem` / `markAllRead`). But the SQL itself still mixes `datetime('now')` directly:

- `local-adapter.ts:200`: `fields.push("updated_at = datetime('now')")` — this still uses sqlite's space-format, *not* the `formatSqliteTs(new Date())` value computed two lines above.
- `local-adapter.ts:227, 234`: same.

The `now` variable computed via `formatSqliteTs` is bound to the **outbox `client_updated_at`** but the actual `items.updated_at` row column is set with `datetime('now')`. These will not be byte-identical (millisecond skew, plus `datetime('now')` is always UTC space-format, while `formatSqliteTs` is constructed from `new Date()` and could differ by ±1 second).

Result: `last_pull_at` is set to whatever the server sends back as `latestUpdatedAt` (server-formatted with the space), and on the next pull, the client sends `since=<that value>`. The DO uses `WHERE updated_at > ?` which is a string compare. If a feed was updated locally after pull but before next pull, then push lands and the server updates the row, the server's `updated_at` could now be a value slightly *less than* `last_pull_at` (within the same second), and the next incremental pull misses it.

The fix from #19 is half-applied. Either commit fully (replace every `datetime('now')` with a passed-in `formatSqliteTs(new Date())` value) or revert and live with sqlite's clock everywhere.

### P0-6. Tab coordination has a TOCTOU race that loses the lock on second-tab close
**Files**: `src/client/db/tab-coordination.ts:32–60, 87–100`

Walk this: Tab A opens, becomes primary. Tab B opens, sends `hello`, sees `primary`, sets state to `blocked`. User closes Tab A. Tab A's `pagehide` posts `released`. Tab B's `handleMessage` receives it: `tabState === 'blocked'`, transitions to `'waiting'`. **Tab B never re-attempts to acquire the OPFS lock.** It stays in `waiting`, the user has to refresh.

That's not a correctness bug — it's user-hostile UX, but data is safe. Now the actual bug:

Two tabs open at once (Tab A primary, Tab B blocked). User closes the browser. Both `pagehide` handlers fire. Tab A posts `released`. Tab B receives `released`, transitions `blocked → waiting`. **But Tab B is also in `pagehide`, about to die.** Whichever tab dies *last* might or might not have flushed its `pagehide` listener. The `BroadcastChannel` is closed when the tab dies; messages in flight are lost.

Now: user reopens browser, restores both tabs. Both tabs run `startTabCoordination`. Both post `hello`. Neither knows it's primary. *Both* tabs go into `waiting`. Both call `getAdapter`. **Both call `openLocalDb` simultaneously.** OPFS-SAH gives the lock to one, the other gets a `locked` error and falls back to remoteAdapter — fine in isolation. But the now-primary tab's `markLocalTabPrimary` posts `primary`, which the now-blocked tab catches and sets `tabState = 'blocked'`. The fallback path at `index.ts:198` calls `setLocalTabBlocked()`. So far OK.

The actual bug: there is **no Web Lock API**. The single source of truth for "who has the OPFS handle" is the SAH-pool itself, which can throw at any time, and the `BroadcastChannel` is just a hint. The hint gets out of sync constantly:
- A tab that crashes (not gracefully closed) never sends `released`. Its lock dies with it. The other tab(s) stay `blocked` forever — until refresh.
- The constructor-side `markLocalTabPrimary()` is called *only* on success in `getAdapter` (`index.ts:189`) and *only* on bootstrap success (`bootstrap.ts:90`). If the DB opens fine but the caller never enters the local-first branch (e.g. `bootstrapInProgress.value === true` at first call, the cache miss path skips it), the tab holds the OPFS lock without telling other tabs it's primary. Other tabs' `hello` would get no response, they'd happily try to acquire the lock, and lose.

Run the bootstrap-in-progress race: Tab A `getAdapter` returns `remoteAdapter` because `bootstrapInProgress` is true. Tab B `getAdapter` returns the same. Bootstrap finishes in Tab A. Tab A's bootstrap calls `markLocalTabPrimary()`. Tab B is still on remote. Tab B's next `getAdapter` call sees `bootstrapInProgress = false`, tries `openLocalDb`, **fails because Tab A holds the lock**. Falls back to remote. Fine — but now Tab B will never use local-first until refresh.

**Fix**: Use `navigator.locks.request('rsss-opfs', { mode: 'exclusive' }, ...)` for actual lock semantics. The Web Locks API is supported everywhere OPFS-SAH-pool is. The current `BroadcastChannel` dance is an advisory hint at best.

### P0-7. SQLite worker is stateful (single global `db`) but `client.open` is called per-DID without `close()` between them
**Files**: `src/client/db/sqlite-worker.ts:47, 119–141, 188–192`, `src/client/db/sqlite-init.ts:134–164`

The worker module has `let db:WorkerDb|null = null` at module scope. `openDb()` calls `closeDb()` first (line 121), so successive opens within the same worker are safe. But in `openLocalDb`, on *any* exception, the entire `client.dispose()` is called (line 155) which terminates the worker. Next `openLocalDb` starts a fresh worker. That's safe but wasteful — the entire OPFS-SAH-pool is re-installed on every retry, which involves walking the directory and acquiring all the SAH handles again.

Bigger problem: `installOpfsSAHPoolVfs` is called *both* in `probeOpfs` (line 113) *and* in `openDb` (line 136). The probe runs in a separate worker (different `client` from `_workerClientFactory()` in `probeOpfsSupport`). When the probe-client is `dispose()`d, the SAH handles it acquired are released by the OPFS file system. Then `openLocalDb` spins up a new worker and reacquires them. That's two full directory walks per page load, plus one for every `getAdapter` call when the cache misses. Latency bloat, and visible to users on slow filesystems (mobile Safari).

**Fix**: Reuse a single worker across probe + open. Or cache the probe result for the session and skip re-probing.

### P0-8. `getAdapter` falls back to remote on lock errors but never retries; user is stuck on remote forever in the browser session
**Files**: `src/client/db/index.ts:166–205`, `src/client/db/tab-coordination.ts:107–111`

When `openLocalDb` throws `locked`, `getAdapter` calls `setLocalTabBlocked()` and returns `remoteAdapter`. Subsequent calls hit `if (isLocalTabBlocked()) return remoteAdapter` (line 175). The `released` BroadcastChannel message transitions tab state `blocked → waiting` and **clears `localTabLockError`**, but `tabState` is `waiting`, not `idle`, and `getAdapter` does not re-evaluate or retry. The cached `_cachedAdapter` is still null because the open failed — but next call hits the `await isLocalFirstSupported()` branch and falls through to `startTabCoordination` → `isLocalTabBlocked` returns `false` (we're in `waiting`) → `openLocalDb`. So actually this *does* recover, accidentally, because `isLocalTabBlocked()` only returns true for `tabState === 'blocked'`. OK.

But: there is no signal that bumps when `released` arrives. The UI does not re-render anything. The user must refresh or trigger a `getAdapter` call (which happens on every State action). Race: user marks an item read while the released message arrives. The `toggleItemRead` calls `getAdapter` → returns local adapter → writes locally → enqueues outbox. Fine. But the items they previously marked read via remote adapter? Those went to the server but not to the local DB. Next pull-sync will pull them down. OK in steady state.

**Fix**: Trigger `pullSync` automatically when the lock becomes available. Surface the transition in the UI.

## P1 — significant correctness/security risk, not yet data-loss

### P1-1. `pull-sync` writes `last_pull_at = data.latestUpdatedAt` even when feeds/items were skipped due to outbox refs
**Files**: `src/client/db/pull-sync.ts:251–268`

`getPendingOutboxRefs` filters out feeds/items that have pending writes. The skipped rows are not upserted. Then `setLastPullAt(db, data.latestUpdatedAt)` records the server's high-water mark. Next pull sends `since=<that>`, server returns rows with `updated_at > since`, **but the rows we skipped are no longer in the response** — they had `updated_at <= latestUpdatedAt`, which is now the floor. The client has stale data for those skipped rows, which won't update again until the server touches them.

After the corresponding outbox row drains and is removed, the local row should reflect the user's intent merged with anything the server changed. As-is: the user's intent wins (correct LWW client side), but the server fields like `last_fetched`, `description` updates from re-parsing the feed, etc., never land. The local row drifts.

**Fix**: After the outbox row clears, force-pull that specific feed/item. Or: track a per-row "needs-pull-after-clear" flag.

### P1-2. Concurrent `runSync` invocations are not serialized
**Files**: `src/client/state.ts:283–320, 322–342`, `src/client/db/sync.ts:23–66`

Three triggers fire `runSync(db)`:
1. The auth `effect` (line 283) — runs whenever `state.user.value` changes.
2. The `online` event handler (line 322) — runs on every browser online event.
3. Indirectly, anything that re-enters the auth effect.

There is no mutex. Two concurrent `runSync`s share the same `db` connection (via the SQLite worker). Both call `getOutboxRows` simultaneously, both iterate, both POST, both delete the row by `id`. The DELETE is idempotent, so no harm there. But the in-flight HTTP request for the same client_op_id is sent twice. The server's idempotency on `client_op_id` (assuming it has any — that's the server reviewer's problem) covers this, but you're double-billing the user's network.

More concerning: `pullSync` inside `runSync` does `BEGIN ... COMMIT` (line 251–268). Two concurrent transactions on the same connection: SQLite serializes them, but the second's BEGIN fails ("cannot start a transaction within a transaction") because the first hasn't committed yet. The error from the failed second BEGIN propagates up to `runSync`'s catch, which calls `setSyncError`, which clobbers the `syncedAt` of the *first* sync that's still in flight. UI shows error followed by "synced just now" or vice versa, depending on timing.

**Fix**: Wrap `runSync` in a per-DB `Promise` mutex. Serialize, don't reject — coalesce.

### P1-3. `online` event handler triggers sync without checking `isLocalFirstActive`
**Files**: `src/client/state.ts:322–342`

`handleOnline` does `runSync(db)` if `getLocalDb(did)` returns non-null. But `getLocalDb` returns the cached DB regardless of `syncSubscriptions.value`. If the user toggles local-first off (via Settings), the cached DB persists until `_resetAdapterCache()` is called by `disableLocalFirst`. Between the toggle and the cache reset (which is sequential, not atomic across a network round-trip), an `online` event fires and triggers a sync against a DB that's about to be deleted. The push will succeed, the pull will land into a DB that's then immediately closed and removed. Wasted work, possible logspam.

**Fix**: `if (!isLocalFirstActive.value) return` at top of `handleOnline`.

### P1-4. `addFeed` outbox row uses optimistic local id as `target_id`, but `delete_feed` for that same feed before push drains will use the same id
**Files**: `src/client/db/local-adapter.ts:43–66, 68–86`

User adds feed → row in local feeds with id `5` → outbox `add_feed target_id=5`. Then user immediately deletes feed `5` (for whatever reason). Local row deleted, outbox `delete_feed target_id=5`. Push runs:
1. POST `/api/feeds {url}` → server creates feed id `42`, returns `{ feed: {id:42, ...} }`. Client `reconcileSuccessfulAddFeed` deletes local feed id `5` (already deleted, no-op) and upserts feed id `42`.
2. DELETE `/api/feeds/5` → server has no feed `5`. Returns 404 or 200?

If the server returns 404, push records a failure attempt on the delete row. After 10 attempts, dead letters. The user sees feed `42` reappear in the list (because `reconcileSuccessfulAddFeed` upserted it) and stays there — orphaned, the user already wanted it gone.

**Fix**: When push processes `add_feed` 2xx, scan the outbox for any `delete_feed target_id=<old_local_id>` and rewrite it to `target_id=<new_server_id>`. Or: serialize add_feed → wait for response → only then enqueue delete_feed against the canonical id. Better: don't allow delete-before-push-drain at the UI layer.

### P1-5. `updateItem` outbox payload merges `is_read` and `is_starred` but partial updates are sent on PATCH
**Files**: `src/client/db/local-adapter.ts:208–212`, `src/client/db/push-sync.ts:288–294`

`updateItem({ is_read: true })` enqueues `{ id, is_read: true }`. `updateItem({ is_starred: true })` on the same item enqueues `{ id, is_starred: true }`. Two separate outbox rows. Two separate PATCHes. If the server uses partial-merge semantics (it should, that's what PATCH means), fine.

But: if the user toggles read+star atomically in some future UI flow, the function only handles one update at a time per call. Each call writes its own `now` timestamp. Two calls in the same millisecond produce identical `client_updated_at` values, both with different `client_op_id`s. LWW server-side ties on equal timestamps are ambiguous — what wins? Whatever the server's ordering does. Document this or break the tie with a monotonic counter.

### P1-6. `is_read = 1` from server can trample user's pending unread mark via mark-all-read race
**Files**: `src/client/db/pull-sync.ts:184–192`

`shouldSkipItem` skips items if `markAllReadAll` is true OR the feed's id is in `markAllReadFeedIds`. Good. But: an `update_item` outbox row that flips `is_read` to **false** (re-mark unread) is in `refs.itemIds`, so the item is skipped in pull. Also good.

The problem: the server's response includes items the user *didn't* touch but whose feed had `mark_all_read` queued. With `markAllReadAll = true`, all items are skipped — including new items the server sent down that the client has never seen. The user marks all read, then closes their laptop. Server keeps fetching feeds, new items arrive on server. Client comes online, push runs `mark_all_read` first, server marks ALL existing items as read — but the new items the user never saw also get marked read. Then pull runs, sees all the new items (they have `is_read = 1` server-side now), but client skips them because `markAllReadAll` is still in the outbox refs *until* the push completes and removes the row.

Wait — `getPendingOutboxRefs` is called once at line 249, before push runs. Then pull runs after push (`sync.ts:31-36`). After push drains, the outbox rows are gone, so on the *next* cycle `getPendingOutboxRefs` returns empty. But within the *current* cycle, push and pull use the same snapshot — actually no, `runSync` calls `pushSync` then `pullSync`, and `pullSync` calls `getPendingOutboxRefs` after push completes. So the refs at pull-time are correct (post-push).

OK, that's fine. But the order matters and is documented exactly nowhere. A future refactor that runs them in parallel breaks the invariant silently.

**Fix**: Comment the invariant in `sync.ts` and `pull-sync.ts`. Add a regression test for the "mark_all_read offline, server has new items, come online" flow.

### P1-7. Outbox attempt limit doesn't reset between transient and permanent failures
**Files**: `src/client/db/push-sync.ts:10, 109–120, 391`

A 5xx server blip during an early session counts toward the limit. After 10 such failures (over arbitrary time), the row dies. The cap doesn't distinguish between "server is briefly down" and "this payload is poison."

**Fix**: Differentiate. `5xx → exponential backoff with reset on success`, `4xx other than 401/402/409 → immediate dead-letter` (no point retrying a malformed payload). 401/402 already throw out of the loop.

### P1-8. `isOpfsSupported` check is module-load-time + `crossOriginIsolated`-only; doesn't probe storage quota
**Files**: `src/client/db/sqlite-init.ts:72–80`

Silently skips a real probe. The probe path (`probeOpfsSupport`) does spin up a worker and call `installOpfsSAHPoolVfs`, which is a real check. Good. **But** `isLocalFirstSupported` caches the result for the session. If the user's storage estimate changes (private mode → permanent, granted persistent storage, freed up disk), the cache is stale. Refresh required.

Also: there's no check for `storage.estimate()` quota before bootstrapping a 50,000-item DB. User on iOS with 50 MB free will OOM the OPFS write halfway through bootstrap and end up in the catastrophic recovery path (`catch` in `bootstrapLocalDb` deletes the OPFS file and disables the toggle).

**Fix**: Before bootstrap, call `navigator.storage.estimate()`. If `quota - usage < 100 MB`, surface a "low storage" warning before committing.

### P1-9. `disableLocalFirst` does not protect against concurrent sync
**Files**: `src/client/db/index.ts:266–281`, `src/client/state.ts:283–320`

`disableLocalFirst`:
1. `pushPendingWritesBeforeRemoval` — fine.
2. `closeDb(db)` — but `_cachedDb` might be in use by an in-flight `runSync` triggered by the auth effect.
3. `_resetAdapterCache()` — tells future calls to use remote, but in-flight `runSync` already has the closed-db reference.

In-flight `runSync` will call `pushSync(db, ...)` on a closed DB. Promise rejects with "SQLite worker client is closed" or similar. `setSyncError` fires. UI flickers an error.

Worse: `removeOpfsDb(did)` happens after `_resetAdapterCache`. If the in-flight pushSync somehow re-opens a worker on the OPFS file before removal (race), the file is opened, drained, then removed.

**Fix**: Set a "disable in progress" flag that `runSync` checks before starting. Or implement an actual cancel via an AbortController on the sync.

### P1-10. `setSyncSubscriptions(true)` checks `billingStatus` but `loadBillingStatus` is async; race on settings open
**Files**: `src/client/local-first-settings.ts:30–40`, `src/client/state.ts:283–320`

`loadBillingStatus` is fire-and-forget in the auth effect. The settings UI opens; user toggles `syncSubscriptions` to `true`. `setSyncSubscriptions` checks `billingStatus.value?.entitled`. If the load hasn't completed yet, `billingStatus.value` is `null`, the toggle silently no-ops. User sees the toggle stay off, no error message.

**Fix**: Show a loading state until billing status loads. Or queue the toggle and apply once status arrives.

## P2 — robustness/UX gaps that real users will hit

### P2-1. `formatSqliteTs` doesn't handle non-UTC dates correctly
**Files**: `src/client/db/time.ts:1–6`

`new Date().toISOString()` is always UTC. So `formatSqliteTs(new Date())` is fine. But the type signature accepts any `Date`, and `formatSqliteTs(new Date('2026-04-27T10:00:00-04:00'))` works fine because `toISOString` normalizes to UTC. Good. But you should add a comment that the string is always UTC. A future caller using `new Date(...)` from a user-input local string will be confused.

### P2-2. `bootstrapLocalDb` flushes `bootstrapError` but never the `localDbError` signal
**Files**: `src/client/db/bootstrap.ts:96–100`, `src/client/db/index.ts:75, 130–140`

If `bootstrapLocalDb` fails, `bootstrapError` gets set. `localDbError` (the signal that `getAdapter` sets for the LOCAL_TAB_LOCK or quota errors) is left untouched. Two error signals for the same conceptual surface. The UI presumably shows both, leading to confusing duplicate banners.

### P2-3. `getAdapter` re-evaluates `isLocalFirstSupported()` on every call (for the cached path)
**Files**: `src/client/db/index.ts:166–205`

The `await isLocalFirstSupported()` resolves from cache after the first call, so this is fast. But the function is in the gate condition above the early-return for `_cachedAdapter`. So even when the cache is hot, every `getAdapter` waits one microtask for the support check. Reorder: check cache first, then gates.

### P2-4. `markLocalTabPrimary` and `setLocalTabBlocked` both call `startTabCoordination` — no idempotence guarantee on `tabState` writes
**Files**: `src/client/db/tab-coordination.ts:62–85, 87–111`

Re-entry into `startTabCoordination` returns the existing channel reference but sets `tabState = 'waiting'` ONLY in the first call (line 73). Subsequent calls bail at line 67. Good. But `markLocalTabPrimary` writes `tabState = 'primary'` *unconditionally*, including from `blocked` — meaning a tab that thinks it's blocked and then somehow enters `markLocalTabPrimary` (e.g. via bootstrap success after all) overwrites the lock. The state machine isn't enforced.

### P2-5. `pull-sync.ts` `keepContent` decision is taken once and applied to all items, including when `storeContent` flips during sync
**Files**: `src/client/db/pull-sync.ts:248–265`

`storeContent.value` is read once, used in a long loop. If the user toggles "store content" off mid-sync, items already processed have content; later items don't. Inconsistent. Probably no real user impact (sync is fast usually), but the inconsistency is noted by anyone who reads the code.

### P2-6. `runSync` swallows all non-auth errors with a debug log
**Files**: `src/client/state.ts:298–313`

`runSync(db).catch((err) => { ... debug('sync cycle error:', err) })`. Errors disappear into the console. Quota exceeded mid-sync, network 500s, JSON parse errors — all silent unless the user has DEBUG enabled. The `setSyncError` inside `pull-sync.ts` *does* set a UI signal, but only when `trackStatus` is true, which the orchestrator passes as `false`! So `runSync` runs `pullSync(db, fetchFn, { trackStatus: false })` which skips the error signal, and the orchestrator's own error handling only fires `setSyncError` for non-auth errors *after* the catch — but the error is already lost by then because pull's catch propagated the error up, and runSync's catch handles it.

Trace:
- pullSync catches network error, `trackStatus=false`, skips setSyncError, throws.
- runSync catches in its outer try. `trackStatus=true` from line 27. Calls `setSyncError` at line 51.
- OK, the error does reach the UI.

But: `pushSync` when called from `runSync` is also `trackStatus=false`, but its inner catch (`pushSync.ts:392-398`) calls `setSyncError(errMsg)` regardless — line 397 only checks `if (trackStatus)`. So push errors are silently swallowed by trackStatus check, then re-thrown only for auth/billing. Other errors are recorded as outbox attempts and not surfaced. User sees nothing.

**Fix**: Audit the trackStatus plumbing. Either every level surfaces errors or none do, but the current half-and-half is bug-prone.

### P2-7. `addFeed` flow does double-load
**Files**: `src/client/state.ts:841–866`

`adapter.addFeed(url)` returns the new feed. `state.addFeed` immediately calls `loadFeeds`, `loadItems`, `loadCounts`. Three more adapter calls. With remote adapter, that's 4 round-trips (1 add + 3 reload). Use the returned feed to update `state.feeds.value` directly and skip `loadFeeds`. `loadCounts` is the only one you actually need for the new feed's items.

### P2-8. `markAllRead` calls `loadItems` and `loadCounts` but not `loadFeeds`, even though feed-level unread counts may have changed
**Files**: `src/client/state.ts:1085–1099`

OK actually feeds don't carry unread counts in this schema. So this is fine. Nit retracted.

### P2-9. Outbox dead-letter queue has no UI for inspection or retry
**Files**: `src/client/db/push-sync.ts:79–107`, sync-status surfaces a count but nothing else

Once a row is in `dead_letter_outbox`, there's nowhere to look at it, no "retry" button, no "discard" button. The user has a permanent bad-sync warning forever. The README/docs do not mention this state.

### P2-10. `isBrowserOnline` is called in `fillMissingRouteBody` but `navigator.onLine` is unreliable per the brief
**Files**: `src/client/state.ts:59–64, 66–86`

`navigator.onLine` returns true even when DNS resolution fails, captive portal, etc. It's a coarse hint, not a fact. The `online`/`offline` event has the same issue. The brief explicitly flags this as an edge case; the code uses it as a gate without a fallback to "try anyway." Better: try the request, time it out, fall back gracefully on failure.

## P3 — nits, style, polish, doc drift

### P3-1. `local-adapter.ts:200` mixes `formatSqliteTs(new Date())` with `datetime('now')` in the same SQL block
See P0-5. Cosmetic part: even if you don't fix the correctness issue, the inconsistency is jarring to read.

### P3-2. `WorkerBackedLocalDb.selectValue/selectValues` throw "is unavailable" but the `Sqlite3Db` interface implies they exist
**Files**: `src/client/db/local-db.ts:52–58`

The cast `as unknown as Sqlite3Db` (sqlite-init.ts:153) hides this. If anyone calls `db.selectValue` thinking it's a real method, they'll get a runtime error in production. Either implement them via `query` underneath, or split the type so `Sqlite3Db` doesn't expose them.

### P3-3. `SQLiteWorkerClient.dispose` and `close` don't agree on whether to wait for pending requests
**Files**: `src/client/db/sqlite-worker-client.ts:57–72`

`close()` awaits the close round-trip. `dispose()` rejects all pending and terminates synchronously. Two functions, two semantics, one type signature distinguishes them by name. A reader has to guess. Document it.

### P3-4. `setTestMode` and `setSQLiteWorkerClientFactoryForTests` are exported as runtime functions, not gated by NODE_ENV
**Files**: `src/client/db/sqlite-init.ts:46–55`

Production bundle ships these. Not exploitable, but it's a tell that the test surface leaks.

### P3-5. `getOpfsFilename` is duplicated
**Files**: `src/client/db/sqlite-init.ts:201–203`, `src/client/db/sqlite-worker.ts:213–215`

Same function, two places. The worker version exists because the worker can't import from the main bundle's module without bundler hassle, but you can import the helper from a shared module. Or just centralize and pass the filename through the protocol.

### P3-6. `OutboxRow.payload` is `string` but most callers immediately `JSON.parse`
**Files**: `src/client/db/push-sync.ts:26–35, 266`

Move the parse closer to the source, or change the type to `unknown` after parse.

### P3-7. Comment "Use the DB opened by bootstrap if available; otherwise open it" describes obvious code
**Files**: `src/client/db/index.ts:181`

Fine, but the surrounding logic — that `bootstrapInProgress` is a gate that returns `remoteAdapter` and yet `getBootstrappedDb()` may return a non-null DB — is the actually interesting bit. Document the lifecycle, not the if-statement.

### P3-8. `bootstrap.ts:73` has `??` chained with parentheses oddly
```ts
throw new Error(localTabLockError.value ?? (
    LOCAL_TAB_LOCK_ERROR
))
```
The parentheses do nothing. Style.

### P3-9. `local-first-settings.ts:32–39` `setSyncSubscriptions(false)` already inside `batch` — caller in `bootstrap.ts:104` doesn't need to wrap it again
Good news: the current code doesn't wrap. Fine.

But `index.ts:277-279` does:
```ts
batch(() => {
    setSyncSubscriptions(false)
})
```
The function already batches internally. Outer `batch` is a no-op wrapper. Remove for clarity.

### P3-10. `state.ts` is now 1100+ lines and continues to grow
nitpicker.md #46 already flagged. Still true.

## Test coverage gaps

### TC-1. Several test files exist but are NOT included in `npm test`
**Files**: `test/run-all-tests.mjs:3–22` vs `test/index.ts:1–32`

Looking at `package.json`, there are scripts for `test:tab-coordination`, `test:pull-sync`, `test:push-sync`, `test:bootstrap`, `test:local-adapter`, `test:adapter-factory`, `test:sqlite-init`, `test:local-first` — eight scripts. **None of them are imported in `test/index.ts`** which is what `run-all-tests.mjs` ultimately runs via the `esbuild test/index.ts` step.

The CI spawns commands listed in `run-all-tests.mjs`. The big bundle test imports `test/index.ts`. `test/index.ts` imports a curated subset that does not include push-sync, pull-sync, bootstrap, local-adapter, adapter-factory, tab-coordination, or local-first-settings. **None of the highest-risk client-side modules are exercised by `npm test`**.

If a contributor runs `npm test` and it passes, they have *not* tested the local-first stack. They have tested in-memory sync, the LWW conflict simulation, header components, and a handful of other surfaces. The push-sync attempt-cap, the bootstrap recovery, the tab coordination state machine, the OPFS support probe — none of it runs in CI by default.

**Fix**: Add the missing imports to `test/index.ts` or commands to `run-all-tests.mjs`. This is the kind of thing where you ship believing you have coverage and the CI sticker is a fiction.

### TC-2. No test for bootstrap interruption / resumption
The catastrophic recovery path in `bootstrap.ts:92-107` (which trashes the OPFS file on any error, see P0-2) has no regression test. There should be at least:
- Network error mid-bootstrap leaves no OPFS file behind (current behavior, but not asserted).
- The user can re-toggle and re-bootstrap after a failure (currently broken: `setSyncSubscriptions(false)` is auto-applied).
- Bootstrap with a partial outbox already present (shouldn't happen but a reset+bootstrap can leave outbox rows).

### TC-3. No test for the dead-letter outbox path
`push-sync.ts:79–120` introduces the dead-letter logic. There's no test that:
- After 10 failures, a row is moved to `dead_letter_outbox`.
- The `setSyncDone` path includes `deadLetters` count.
- The dead-letter row is not retried.

### TC-4. No test for `add_feed` reconciliation cascading items via `PRAGMA foreign_keys = ON`
See P0-3. The reconcile path deletes the feed, which cascades items. Test the scenario where the optimistic feed already has items (which can happen on bootstrap-from-existing-outbox).

### TC-5. No test for clock skew / timestamp format mismatches
See P0-5. There should be a test that:
- Server sends `latestUpdatedAt = '2026-04-25 10:00:00'`.
- Client immediately writes a feed locally (before next pull).
- Next pull's `since` parameter doesn't lose data.

### TC-6. No test for concurrent `runSync` invocations
See P1-2. There's no test that triggers two `runSync` calls in parallel and asserts the in-flight HTTP requests are not duplicated, or that the SQLite transactions don't conflict.

### TC-7. No test for `disableLocalFirst` while a sync is in flight
See P1-9. The test would have to: start a sync that hangs on a fetch, call `disableLocalFirst`, assert no error is thrown to the user.

### TC-8. No test for the `online` event firing during a sync
See P1-3. The `handleOnline` re-entrant case is untested.

### TC-9. No test for storage quota exceeded
The `classifyLocalDbError` has a `'quota'` branch but nothing in the test suite throws QuotaExceededError. Easy mock; no test.

### TC-10. No test asserting `runSync` errors surface to the UI through `setSyncError`
See P2-6. The trackStatus plumbing has a bug-prone half-and-half flow that nothing tests end-to-end.

### TC-11. The wa-sqlite tests in package.json exist but the suite shipped to `npm test` doesn't run them
The `test:pull-sync` and `test:push-sync` scripts use `--loader:.wasm=dataurl` which loads the actual sqlite-wasm in a browser-like env. These do exist (per package.json) but are run only when explicitly invoked. They should be in CI.

## Top 5 things to fix before launch

1. **`/api/sync` is unbounded and unpaginated** (P0-1). One user with a few hundred feeds and content storage on will OOM either the DO (during read) or the browser (during parse) on first bootstrap. Page the response. Without this, "local-first" is a feature that doesn't survive a real user's data.
2. **Bootstrap interruption silently disables the feature and wipes OPFS** (P0-2). Network blips happen. Right now they punt the user back to the remote-only experience and they don't know why. Distinguish transient from terminal errors.
3. **Tab coordination is BroadcastChannel-only and races on tab crash** (P0-6, sibling of `nitpicker.md #6`). Use `navigator.locks.request` for actual exclusivity. The current advisory hint will produce sporadic "Local data is open in another tab" errors that won't reproduce in dev.
4. **Push-sync `add_feed` reconciliation cascade-deletes items** (P0-3). When `PRAGMA foreign_keys = ON` is on, `DELETE FROM feeds WHERE id = ?` cascades. The user's local read/star state on items attached to the optimistic feed is lost.
5. **`npm test` does NOT exercise push-sync, pull-sync, bootstrap, local-adapter, or tab-coordination** (TC-1). The CI green checkmark is a lie about what was tested. Wire these into the suite before any prod traffic.

**Status**: complete
