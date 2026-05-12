# Phase 1: Diagnose and Fix Stuck-Resolving Convergence

**Goal:** Make every newly added or retried feed reach a terminal state
(resolved or failed) within ~35s by fixing the live bug that prevents
the client convergence path from updating the UI signal.

**Architecture:** Spec 018 already wired up server-side alarm sweep at
~30s and client-side convergence timer at ~35s. The machinery is in
place; the bug is that the client convergence callback updates local
SQLite but never refreshes the `state.feeds` signal. UI stays in
resolving forever even after data converges. Fix in three parts:
(1) refresh signal after convergence sync, (2) defense-in-depth boot
scheduling for any feed in resolving state at page load, (3) make the
retry control flip the UI to resolving and schedule its own
convergence safety net.

**Tech Stack:** TypeScript (browser, Vite/ES2022), Preact +
`@preact/signals`, `@sqlite.org/sqlite-wasm` (client SQLite),
`@substrate-system/tapzero` test runner.

**Scope:** Phase 1 of 4. No server changes; this phase is client-only.

**Codebase verified:** 2026-05-11

---

## Diagnosis

A subagent investigation evaluated eight hypotheses against the
current source. Results, with file:line citations:

| # | Hypothesis | Verdict |
|---|------------|---------|
| 1 | POST does not set alarm | RULED OUT (`src/server/durable-objects/index.ts:858` awaits `setAlarm`) |
| 2 | Sweep WHERE clause misses fresh rows | RULED OUT (`src/shared/schema.ts:48` defaults `created_at` at INSERT time) |
| 3 | Sweep emit payload differs from happy-path emit | RULED OUT (both broadcast `{ feedId: feed.id }` at lines 1787, 1825) |
| 4 | `runSync` is a no-op for feeds | RULED OUT (`src/client/db/pull-sync.ts:394` calls `upsertFeed`) |
| 5 | Convergence runs but signal is not refreshed | **CONFIRMED** (`src/client/state.ts:157-162`: `runSync(db).catch(...)` with no `refreshAfterSync` follow-up — contrast `src/client/state.ts:587-588` which DOES call it) |
| 6 | `waitUntil` dropped before fetch completes | PARTIAL CONFIRM (covered by server sweep at 30s, but client must consume that update) |
| 7 | Reload before sweep fires | CONFIRMED (no boot-time scheduling for already-resolving feeds in `src/client/state.ts`) |
| 8 | POST returns before alarm registered | RULED OUT (line 858 awaits) |

**Primary root cause (hypothesis 5):**
`src/client/state.ts:157-162` in `scheduleResolveConvergence`:

```ts
runSync(db).catch((err) => {
    debug('resolve-convergence runSync failed', ...)
})
```

This writes converged feed rows to client SQLite but never
re-loads them into the `state.feeds` signal. The UI keeps reading
the stale resolving-state signal. Compare to the working pattern at
line 587:

```ts
runSync(db).then(() => {
    State.refreshAfterSync(state)
}).catch(...)
```

**Secondary root cause (hypothesis 7):**
`scheduleResolveConvergence` is only invoked from `State.addFeed`
(line 1545). If the page is reloaded while a feed is resolving — or
if the user closes the tab and reopens — no client timer fires the
convergence pull. The reader is dependent on either SSE
`feed-updated` delivery (best-effort) or another manual action.

**Tertiary gap:**
`State.retryResolveFeed` (line 2030) calls `await api.post(...)`,
upserts the response feed, then calls `State.loadFeeds(state)`. It
does NOT optimistically flip the local row to resolving before the
POST round-trips, and does NOT schedule a fresh convergence safety
net. The retry click is invisible until the response lands; if the
response is delayed or dropped (e.g. proxy timeout, network error),
the row stays in failed state.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### 020-add-feed-zero-unread.AC1: Adding a feed feels instant and calm
- **020-add-feed-zero-unread.AC1.2 Slow-resolving feed reaches terminal state within ~35s:**
  Given the reader submits a slow-resolving feed URL (server fetch
  exceeds 3 seconds), When the POST response arrives, Then the
  sidebar row is shown in the resolving state, AND When the bounded
  resolution window of ~35s elapses, Then the row transitions to the
  resolved state (with title, 0 unread) or failed state (with retry
  control). The row never persists in resolving past the window.
- **020-add-feed-zero-unread.AC1.3 Reload preserves terminal state:**
  Given any newly added feed has reached its resolved state, When
  the reader reloads the page, Then the row is shown in its resolved
  state with 0 unread — never in resolving, never with a backlog
  count.

### 020-add-feed-zero-unread.AC3: Retry control reliably re-attempts
- **020-add-feed-zero-unread.AC3.1 Retry click visibly re-enters resolving:**
  Given a feed row in the failed state, When the reader clicks
  retry, Then the row visibly re-enters the resolving state.
- **020-add-feed-zero-unread.AC3.2 Retry success terminates within window:**
  Given retry was clicked and the server can now resolve the feed,
  When the resolution window elapses, Then the row transitions to
  the resolved state with title and 0 unread (per the mark-read
  rule).
- **020-add-feed-zero-unread.AC3.3 Retry failure returns to failed state:**
  Given retry was clicked and the server still cannot resolve the
  feed, When the resolution window elapses, Then the row returns to
  the failed state with the retry control still available.

---

## Implementation Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Refresh state.feeds after convergence runSync completes

**Verifies:** 020-add-feed-zero-unread.AC1.2, 020-add-feed-zero-unread.AC3.2

**Files:**
- Modify: `src/client/state.ts:141-165` (the `scheduleResolveConvergence` function body, specifically lines 157-162)

**Implementation:**

Change the convergence callback to chain `State.refreshAfterSync(state)`
after `runSync` resolves, matching the established pattern at
`src/client/state.ts:587-588`. The signature of
`scheduleResolveConvergence` already accepts `state` (it currently
only uses `state.user.value?.did` and `state.feeds.value.find(...)`)
so no signature change is needed.

The change inverts the current "catch-only" pattern to "then-then-catch":

```ts
runSync(db)
    .then(() => {
        State.refreshAfterSync(state)
    })
    .catch((err) => {
        debug(
            'resolve-convergence runSync failed',
            err instanceof Error ? err.message : err
        )
    })
```

`State.refreshAfterSync` is bound at line 751 to `State.loadInitialView`,
which calls `State.loadFeeds(state)` — exactly the signal refresh we
need. Do NOT call `State.loadFeeds` directly; always go through
`refreshAfterSync` to stay consistent with the rest of the codebase
and pick up any future cross-cutting refresh logic.

**Testing:**

Create `test/resolve-convergence-signal-refresh.ts` (new file)
following the established pattern in `test/feed-resolve-state.ts`
(import `@substrate-system/tapzero`, signal from `@preact/signals`,
the `_resolveConvergenceForTest` export, and `setTestMode` /
`openLocalDb` wasm wiring).

Tests must verify (using the AppState test harness with a fake
adapter):
- **020-add-feed-zero-unread.AC1.2:** After `addFeed(url)` is called
  for a URL whose server-side fetch never completes within
  RESOLVE_WINDOW_MS + CLIENT_GRACE_MS, advancing the timer fires the
  convergence callback, and after the callback resolves
  `state.feeds.value` reflects the server-recorded terminal state
  (last_fetched populated or last_error set). Before the fix this
  test fails because state.feeds keeps the original resolving row.

Use vitest fake timers or tapzero's existing async helpers (check
`test/_test-fixtures.ts` for the project pattern) to advance time
without real-time waits. The test must NOT wait 35 real seconds.

**Verification:**
Run: `npm test -- --grep resolve-convergence-signal-refresh`
Expected: All tests pass. Convergence callback observed to invoke
`refreshAfterSync` once.

**Commit:** `fix(state): refresh feeds signal after convergence runSync`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Schedule convergence at boot for any already-resolving feeds

**Verifies:** 020-add-feed-zero-unread.AC1.3

**Files:**
- Modify: `src/client/state.ts` — the boot/auth-success path that
  finishes its first `State.loadFeeds(state)`. The `loadInitialView`
  function definition is around `src/client/state.ts:688-720`
  (it calls `State.loadFeeds(state)` at line 695). Post-auth
  paths that also call into this branch live around lines
  509-527 and 587-602. Add a single call that walks
  `state.feeds.value`, finds any feed where
  `last_fetched === null && !last_error`, and invokes
  `scheduleResolveConvergence(state, feed.url)` for each.

**Implementation:**

Export the existing `scheduleResolveConvergence` for module-internal
use (it's currently a `function` declaration in the same file, so
already accessible within state.ts). Add a new private helper
`scheduleConvergenceForResolvingFeeds(state)` that iterates
`state.feeds.value` and schedules a convergence timer for any feed
in the resolving state:

```ts
function scheduleConvergenceForResolvingFeeds (state:AppState):void {
    for (const feed of state.feeds.value) {
        if (feed.last_fetched === null && !feed.last_error) {
            scheduleResolveConvergence(state, feed.url)
        }
    }
}
```

Call it once after the first `loadFeeds` completes in the boot path.
The exact call site is the post-auth branch in `loadInitialView` (the
function `State.refreshAfterSync` is bound to). Add the call
immediately after the loadFeeds-equivalent inside `loadInitialView`
so the freshly-loaded `state.feeds.value` is the iteration source.

The existing `scheduleResolveConvergence` already protects against
duplicates: line 150 `clearResolveConvergenceTimer(feedId)` ensures
only one timer per feed. So if `loadInitialView` is called multiple
times during a session (which it is via the SSE refresh-complete
path), the timers reset rather than stack.

**Why this matters per FR-007:** The spec says the server-recorded
terminal state MUST be rendered on every subsequent client load. The
existing alarm + SSE pipeline gets us most of the way, but if the
client loads at exactly t+25s relative to subscription (server hasn't
swept yet, no SSE arrived because there's nothing terminal yet to
broadcast), the client must have its own t+35s convergence safety
net. Without this task, the client only schedules convergence in
`addFeed` — never on reload.

**Testing:**

Add to `test/resolve-convergence-signal-refresh.ts`:
- **020-add-feed-zero-unread.AC1.3:** Simulate a client boot where
  `state.feeds` is hydrated from the server with at least one feed
  in resolving state. Confirm that `_resolveConvergenceForTest.pendingTimerCount()`
  reports a non-zero count after `loadInitialView` completes.
  Confirm that advancing the timer triggers a runSync that ultimately
  refreshes the signal to terminal state.

**Verification:**
Run: `npm test -- --grep resolve-convergence-signal-refresh`
Expected: All tests pass.

**Commit:** `feat(state): schedule resolve convergence for resolving feeds at boot`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Retry flips row to resolving and schedules convergence

**Verifies:** 020-add-feed-zero-unread.AC3.1, 020-add-feed-zero-unread.AC3.2, 020-add-feed-zero-unread.AC3.3

**Files:**
- Modify: `src/client/state.ts:2030-2057` (the `State.retryResolveFeed`
  function)

**Implementation:**

Two changes inside `retryResolveFeed`, before the `api.post(...)`
call:

1. Optimistically flip the local row to resolving so the UI updates
   instantly. Find the feed in `state.feeds.value` by id, write a new
   array (immutable update preserved) where that feed has
   `last_fetched: null` and `last_error: null`. Use `batch(() => {...})`
   from `@preact/signals` if writing more than one signal (only
   needed if we touch others; for a single signal write the batch
   wrapper is optional but harmless and matches the user CLAUDE.md
   guidance).
2. Capture the feed's `url` from that row before the POST so we can
   call `scheduleResolveConvergence(state, url)` after the
   optimistic update.

After the existing `await State.loadFeeds(state)` at line 2055
succeeds, do NOT re-schedule convergence — by that point the POST
response has already returned and `loadFeeds` reflects the server's
terminal state (the retry endpoint at
`src/server/durable-objects/index.ts:958-995` awaits `fetchFeed`
synchronously, so the response carries the post-retry state).

Re-schedule convergence ONLY in the case where the POST throws or
returns no `feed` field. Wrap the existing logic in a try/catch.
Inside the catch (or the else-branch when `!body?.feed`), DO
schedule a convergence timer for the feed.url — this covers the
"proxy timeout / network error during retry but server actually
completed the fetch eventually" case. If schedule fires at +35s and
the server has completed, refreshAfterSync (from Task 1) brings the
UI in sync.

The resulting flow:

```ts
State.retryResolveFeed = async function (
    state:AppState,
    feedId:string
):Promise<void> {
    const numericId = parseInt(feedId, 10)
    const row = state.feeds.value.find((f) => f.id === numericId)
    if (!row) return
    const url = row.url

    state.feeds.value = state.feeds.value.map((f) => (
        f.id === numericId ?
            { ...f, last_fetched: null, last_error: null } :
            f
    ))

    let res:Response | null = null
    try {
        res = await api.post(`feeds/${feedId}/refresh`)
    } catch (err) {
        debug(
            'retryResolveFeed: POST failed, scheduling convergence',
            err instanceof Error ? err.message : err
        )
        scheduleResolveConvergence(state, url)
        return
    }
    let body:{ feed?:Record<string, unknown> } | null = null
    try {
        body = await res.json<{ feed?:Record<string, unknown> }>()
    } catch {
        body = null
    }
    const feed = body?.feed
    if (feed) {
        const did = state.user.value?.did
        const db = did ? getLocalDb(did) : null
        if (db) {
            try {
                await upsertFeedFromServer(db, feed)
            } catch (err) {
                debug(
                    'retryResolveFeed: failed to write back row',
                    err instanceof Error ? err.message : err
                )
            }
        }
        await State.loadFeeds(state)
    } else {
        scheduleResolveConvergence(state, url)
    }
}
```

Notes:
- `batch` is not required here because the only signal being written
  is `state.feeds.value` once. The user CLAUDE.md says to use `batch`
  when sequentially setting *multiple* signals.
- Do not change the server endpoint. Per recon, the retry endpoint
  awaits the full fetch — server side is already correct for User
  Story 3.

**Testing:**

Add to `test/resolve-convergence-signal-refresh.ts` (or a new file
`test/retry-resolve-feed.ts` — keep tests focused per project
patterns; check what `test/feed-resolve-state.ts` covers before
deciding):

- **020-add-feed-zero-unread.AC3.1:** Given a feed in failed state in
  `state.feeds`, calling `State.retryResolveFeed(state, String(feed.id))`
  immediately (synchronously, before awaiting) updates
  `state.feeds.value` such that the targeted row has `last_fetched`
  null and `last_error` null. Use a deferred-promise mock for
  `api.post` to keep the call pending while assertions run.
- **020-add-feed-zero-unread.AC3.2:** After the retry POST resolves
  with a feed body carrying `last_fetched` set, the row in
  `state.feeds.value` reflects resolved state.
- **020-add-feed-zero-unread.AC3.3:** If the POST throws or returns
  no `feed` field, the row stays in optimistic resolving state AND a
  convergence timer is scheduled
  (`_resolveConvergenceForTest.pendingTimerCount() > 0`). Advancing
  the timer triggers a runSync that refreshes the signal; if the
  server returns the feed still in failed state, the row converges
  to failed and the retry control remains visible.

**Verification:**
Run: `npm test`
Expected: All tests pass, including any pre-existing tests in
`test/feed-resolve-state.ts`.

Also run: `npm run lint`
Expected: No lint errors introduced.

**Commit:** `feat(state): retry flips row to resolving and schedules convergence on failure`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Manual UI smoke verification

**Verifies:** 020-add-feed-zero-unread.AC1.2, 020-add-feed-zero-unread.AC1.3, 020-add-feed-zero-unread.AC3.1

**Files:** None (manual verification only)

**Implementation:**

This is a manual verification task. After Tasks 1-3 land and unit
tests pass, run the dev server and confirm the UI behavior:

1. Start dev server: `npm run dev`
2. Log in, navigate to the sidebar.
3. **AC1.2 (slow feed):** Add a feed URL that is known to be slow
   (e.g., a known-slow public RSS host, or use the dev tools network
   throttling on the outbound `/api/feeds` request). The row should
   show resolving briefly, then within ~35s flip to either resolved
   (with title) or failed (with retry control). Verify no
   indefinite spinning.
4. **AC1.3 (reload):** With the previous feed now in resolved state,
   reload the page. Confirm the row is shown in resolved state on
   first paint (no spinner moment, no backlog count).
5. **AC1.3 (mid-resolve reload):** Add a slow feed. Within the first
   10 seconds, reload the page. Confirm that within ~35s of the
   original add, the row reaches terminal state on the reloaded
   page.
6. **AC3.1 (retry click):** For any feed in failed state, click
   retry. Confirm the row visibly flips to the resolving spinner
   within one animation frame (≤16ms perceived).

If any of the above fail, document the failure mode and return to
the relevant earlier task. Type checking and unit tests verify code
correctness, not feature correctness — this task closes that gap.

**Verification:**
Visual inspection of dev-server browser session matches the above
acceptance scenarios.

**Commit:** No code change; verification only. Do NOT skip this
task — if it fails, fix the underlying cause and amend the prior
commits.
<!-- END_TASK_4 -->

---

## Phase 1 Done When

- `npm test` passes including new convergence/retry tests.
- `npm run lint` passes.
- Manual smoke (Task 4) confirms no indefinite resolving spinner under
  the three scenarios (slow add, reload mid-resolve, retry click).
- Phase 1 commits land on the `020-add-feed-zero-unread` branch.

## Out of Scope for Phase 1

- POST `/api/feeds` 3s synchronous wait — Phase 2.
- Mark-read on initial fetch — Phase 3.
- Forward-looking unread + (N) prefix retirement — Phase 4.
- Server-side sweep changes — confirmed correct by investigation; do
  not modify.
