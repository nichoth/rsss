# Phase 2: POST /api/feeds Hybrid 3-Second Synchronous Branch

**Goal:** Make adding a fast-responding feed produce the resolved row
inside the POST response, eliminating the spinner moment entirely
for the common case. Slow feeds still fall back to the existing
async + SSE + convergence path (Phase 1) with no new code paths
introduced on that side.

**Architecture:** Race the existing `fetchFeed(feed)` call against a
3-second timeout inside the POST `/feeds` handler. If `fetchFeed`
finishes first (success or failure), re-read the updated row and
return it in the response together with the canonical per-feed
unread count. If the timeout fires first, push the in-flight
`fetchFeed` promise into `ctx.waitUntil` and return the unresolved
row (same shape as today). One response shape for both branches.

**Tech Stack:** TypeScript (Cloudflare Workers, ES2022), Hono router,
Cloudflare Durable Object SQLite, `@cloudflare/workers-types`.

**Scope:** Phase 2 of 4. Server-only change to `POST /feeds`. No
client changes required because the existing `addFeed` flow
(`loadFeeds` + `loadCounts` after POST) already converges the UI on
the new state.

**Codebase verified:** 2026-05-11

---

## Investigation Findings

- POST handler is `src/server/durable-objects/index.ts:766-878`.
  Current shape: insert row, await `setAlarm(now + RESOLVE_WINDOW_MS)`,
  `ctx.waitUntil(this.fetchFeed(feed))`, return `c.json({ feed }, 201)`.
- Response shape today is `{ feed }`. `feed` is the raw `feeds`
  table row (with `last_fetched: null` and `last_error: null` for
  the just-inserted row).
- Per-feed unread is computed at `src/server/durable-objects/index.ts:681-684`
  via `SELECT feed_id, COUNT(*) as unread FROM items WHERE is_read = 0
  GROUP BY feed_id`. We reuse exactly this query (filtered to one
  feed_id) to satisfy FR-009 "single source of truth" — no new
  computation, no new column.
- `this.fetchFeed(feed)` is at `src/server/durable-objects/index.ts:1553-1830`.
  On success it writes the row's `last_fetched`, title, and other
  metadata. On failure it writes `last_error` and `last_status`. In
  both cases the row is updated by the time the returned promise
  resolves.
- Client `State.addFeed` (`src/client/state.ts:1527-1559`) calls
  `adapter.addFeed`, then `State.loadFeeds(state)`, then
  `State.loadCounts(state)`, then `scheduleResolveConvergence`. With
  the hybrid POST in place, the post-POST `loadFeeds` returns the
  already-updated row, so `scheduleResolveConvergence` will short-
  circuit at line 148 (`isFeedStillResolving` returns false) and no
  timer is scheduled. No client signal-wiring changes are needed.
- Open Item resolved: the POST fallback response shape MUST be
  identical to today's shape so the existing async/SSE/convergence
  path remains unchanged. We achieve this by always returning
  `{ feed, unread }` with the same `feed` schema (the raw `feeds`
  row), differing only in whether `last_fetched` / `last_error` are
  populated. No third response shape introduced.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### 020-add-feed-zero-unread.AC1: Adding a feed feels instant and calm
- **020-add-feed-zero-unread.AC1.1 Fast feed renders resolved in POST response:**
  Given the reader submits a fast-resolving feed URL (server
  completes initial fetch in under 3 seconds), When the POST
  response arrives, Then the sidebar row renders directly in the
  resolved state with the feed title visible and the unread count
  at 0, with no spinner observed.

This phase also strengthens the response-shape guarantees that
serve as preconditions for Phase 4 (FR-009 single source of truth)
without yet retiring the spec 014 `feedUpdateCounts` SSE field —
that retirement is Phase 4's responsibility.

---

## Implementation Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add POST_HYBRID_WAIT_MS constant and unread-helper

**Verifies:** None (infrastructure for Task 2)

**Files:**
- Modify: `src/server/durable-objects/index.ts` near the existing
  `RESOLVE_WINDOW_MS` export at line 117.

**Implementation:**

Add a sibling exported constant:

```ts
export const POST_HYBRID_WAIT_MS = 3000
```

Place it directly adjacent to `RESOLVE_WINDOW_MS` so the two related
window constants live together. Use `3000` (not `3 * 1000` and not
`3_000`) to match `RESOLVE_WINDOW_MS = 30_000` style; if the existing
constant uses the `_000` underscore-numeric style, follow it.
Either way, do NOT introduce a new helper for milliseconds. Add a
brief one-line comment ONLY if it explains WHY 3s was chosen (spec
FR-001 threshold below which an interactive submit still feels
instant) — leading with the WHY is the user CLAUDE.md rule. No
comment is also acceptable per CLAUDE.md "Default to writing no
comments."

Next, add a private helper method on `UserDO` to compute the per-
feed unread count using exactly the same SQL pattern as the
existing /counts query at lines 681-684:

```ts
private getFeedUnreadCount (feedId:number):number {
    const row = this.sql.exec(
        'SELECT COUNT(*) as unread FROM items ' +
        'WHERE feed_id = ? AND is_read = 0',
        feedId
    ).one() as { unread:number } | null
    return row?.unread ?? 0
}
```

Place this near the other private query helpers in the class.
Search for `private getFeedUpdateCounts` or similar helpers and
place adjacent. This helper is callable from both POST and any
future caller that needs single-feed unread without pulling the
full perFeed map.

Also add a private race helper to be used in Task 2 and tested
with a small waitMs in Task 3:

```ts
private async awaitFetchOrTimeout (
    fetchPromise:Promise<void>,
    waitMs:number
):Promise<'done'|'timeout'> {
    let timeoutHandle:ReturnType<typeof setTimeout>|undefined
    const winner = await Promise.race([
        fetchPromise
            .then(() => 'done' as const)
            .catch(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(
                () => resolve('timeout'),
                waitMs
            )
        })
    ])
    if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle)
    }
    return winner
}
```

This isolates the timing logic so Task 3's slow-path test can
call `awaitFetchOrTimeout(neverResolves, 50)` and observe the
`'timeout'` outcome in 50ms of real time, rather than 3000ms.
Production callers pass `POST_HYBRID_WAIT_MS`.

**Verification:**

Run: `npm run lint`
Expected: Lint passes, no new errors.

Run: `npm run build` (or whatever the project uses to type-check
the workers code — check `package.json` scripts for `tsc` /
`wrangler types` / similar).
Expected: TypeScript compiles cleanly with the new export and the
new private method.

**Commit:** `chore(do): add POST_HYBRID_WAIT_MS constant and per-feed unread helper`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement hybrid POST /feeds with 3s race

**Verifies:** 020-add-feed-zero-unread.AC1.1

**Files:**
- Modify: `src/server/durable-objects/index.ts:766-878` (the POST
  `/feeds` handler body, specifically the success branch starting
  at line 794).

**Implementation:**

Refactor the success branch of the POST `/feeds` handler. The
shape and edge cases to preserve unchanged:
- Body parsing, `validateFeedUrl`, LWW conflict handling (line
  794-829) — keep verbatim.
- Existing-feed-409 / LWW return paths (line 810-828) — keep verbatim.
- Alarm forward-pull logic (line 853-858) — keep verbatim.
- Error catch at the bottom (line 866-877) — keep verbatim.

Change only the block between "Insert the feed" (line 832) and the
final `return c.json({ feed }, 201)` (line 862-865).

After the existing alarm setup at line 858 (and the existing read
of the newly-inserted row at line 841-844), replace
`this.ctx.waitUntil(this.fetchFeed(feed as unknown as Feed))` with
a race. Pseudocode:

```ts
// Race fetch against a 3s window via the awaitFetchOrTimeout
// helper (Task 1). Both outcomes converge on "re-read the row +
// compute unread + respond". On timeout we also push the in-
// flight promise to waitUntil so the fetch completes in the
// background.

const fetchPromise = this.fetchFeed(feed as unknown as Feed)
const winner = await this.awaitFetchOrTimeout(
    fetchPromise,
    POST_HYBRID_WAIT_MS
)

let respondedFeed = feed
if (winner === 'done') {
    const updated = this.sql.exec(
        'SELECT * FROM feeds WHERE id = ?',
        (feed as { id:number }).id
    ).one()
    if (updated) {
        respondedFeed = updated
    }
} else {
    // 3s elapsed; let the fetch finish in the background so the
    // alarm + SSE + Phase 1 convergence pipeline can deliver
    // terminal state to the client.
    this.ctx.waitUntil(fetchPromise.catch(() => undefined))
}

const unread = this.getFeedUnreadCount(
    (respondedFeed as { id:number }).id
)

return c.json({ feed: respondedFeed, unread }, 201)
```

Notes on subtleties:

1. **Error handling lives inside the helper.** `awaitFetchOrTimeout`
   (Task 1) wraps `.catch(() => 'done')` around the fetch so the
   race always resolves cleanly. We then re-read the row to
   surface the new `last_error`/`last_status` to the client. This
   is correct behavior for the spec edge case "POST 3s wait
   succeeds but the fetch result is a failure" — the response
   carries the failed state and the sidebar shows the failed
   terminal state immediately, no spinner moment.
2. **waitUntil-on-timeout**: We push the same `fetchPromise` to
   waitUntil (with a `.catch` swallow so an unhandled rejection in
   the background doesn't surface as a worker error). The fetch
   continues to run; on completion the existing in-fetchFeed
   broadcast at line 1787 fires `feed-updated` so any connected
   SSE client (including the same client that POSTed) sees the
   resolution. Additionally, the alarm sweep at line 1805-1827 will
   catch the row at +30s if `fetchFeed` itself silently stalls.
3. **clearTimeout lives inside the helper.** Promise.race does not
   abort the losing promise, so `awaitFetchOrTimeout` clears the
   pending timer once the race settles to prevent an unreferenced
   timer holding the worker alive beyond the response.
4. **Response shape**: We add `unread` to the response object. The
   `feed` field's schema is unchanged: it's the same `feeds` row
   we returned today. The fallback branch (timeout) returns the
   freshly-inserted row exactly as today, just with `unread: 0`
   appended (per FR-009 single source of truth). No "third response
   shape" is introduced — both branches return `{ feed, unread }`.
5. **Client compatibility**: `State.addFeed` at
   `src/client/state.ts:1535` calls `adapter.addFeed(url)` and
   discards the return value; subsequent `loadFeeds` and
   `loadCounts` calls are the canonical UI refresh path. So the
   additive `{ feed, unread }` shape is safe — existing client
   parsers continue to work.
6. **Type cast**: The existing code uses `feed as unknown as Feed`
   and `(feed as { id:number }).id` — match that pattern. Don't
   restructure the typing in this task; it can be cleaned up
   independently of spec 020.

**Verification:**

Run: `npm run lint`
Expected: No lint errors.

Run: `npm run build`
Expected: TypeScript compiles.

**Commit:** `feat(do): hybrid POST /feeds with 3s synchronous wait (FR-001)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for hybrid POST

**Verifies:** 020-add-feed-zero-unread.AC1.1

**Files:**
- Create: `test/post-feed-hybrid.ts` (new file)

**Implementation:**

Mirror the style and harness pattern used by
`test/feed-resolve-state.ts`. Reuse the existing
`createFetchHarness` test fixture if it can be adapted; if not,
create a new fixture that:
1. Instantiates `UserDO` via `Object.create(UserDO.prototype)`.
2. Mocks `sql.exec` to return canned row sequences for the INSERT
   and the subsequent SELECT.
3. Mocks `doFetchFeedText` to either resolve fast (well under 3s)
   or never resolve (test only — keep deterministic by controlling
   the promise externally).
4. Mocks `ctx.storage.getAlarm` / `setAlarm`.
5. Captures `ctx.waitUntil` calls so the test can assert whether
   the timeout branch was hit.

Tests required (each maps to AC1.1 or to the fallback contract):

**Test 1 — fast path returns resolved state:** A fetch that
resolves in <3s; assert the POST response is 201 with `{ feed, unread }`
where `feed.last_fetched` is non-null, `feed.last_error` is null,
and `unread === 0`. Verifies AC1.1.

**Test 2 — fast path returns failed state:** A fetch that rejects
in <3s; assert the response is 201 with `feed.last_error` populated
and `unread` accurate for the failed-state row (0, since no items
were ingested). Verifies the "POST 3s wait succeeds but the fetch
result is a failure" edge case from spec.

**Test 3 — slow path returns 'timeout' from helper:** Drive a
hand-controlled `fetchPromise` that never resolves. Call
`awaitFetchOrTimeout(neverResolves, 50)` (Task 1's helper) directly
against an instance of `UserDO` constructed via the test harness'
`Object.create(UserDO.prototype)` pattern. Assert the helper
resolves to `'timeout'` within ~100ms of real time. No production-
code test hatch is required because the helper IS the unit of
behavior: Test 1 and Test 2 already exercise the full handler
path on the fast branch (with `POST_HYBRID_WAIT_MS = 3000`); the
slow-branch contract is the helper's `'timeout'` return value,
which is what this test asserts.

**Test 4 — alarm is set before the race begins:** Independent of
the race outcome, the alarm at `now + RESOLVE_WINDOW_MS` MUST be
registered before the response returns. Capture `setAlarm` calls;
assert exactly one call with a target time within 30s of `Date.now()`.

This test drives the full POST handler. To avoid waiting 3s in
the slow branch, use a parser stub that resolves quickly so the
fast branch wins — the alarm is set unconditionally before the
race, so it does not matter which branch fires.

**Test 5 — `unread` field uses the same SQL query as /counts:**
Either (a) drive both endpoints in the same test and assert
equality of the returned unread value, or (b) snapshot the SQL
query string used by `getFeedUnreadCount` and confirm it matches
the pattern at lines 681-684. (a) is preferred: it tests behavior,
not implementation, per the user CLAUDE.md "DO NOT WRITE BRITTLE
TESTS" rule.

If the test runner does not support fake-timer control of CF
Workers' `setTimeout`, gate the slow-path test behind a small
override of `POST_HYBRID_WAIT_MS` via an optional injectable
parameter on the handler (NOT a global mutable — pass via a class
field set by the test harness). Prefer the cleaner approach of
extracting the race into a small testable helper if needed.

**Verification:**

Run: `npm test -- --grep post-feed-hybrid`
Expected: All five tests pass. No test should wait 3+ real
seconds.

Run: `npm test`
Expected: Full suite passes. No regressions in
`test/feed-resolve-state.ts` or `test/do-handlers.ts`.

**Commit:** `test(do): hybrid POST /feeds covers fast/slow paths and unread`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Manual UI smoke verification

**Verifies:** 020-add-feed-zero-unread.AC1.1

**Files:** None (manual verification only)

**Implementation:**

After Tasks 1-3 land:
1. Start dev server: `npm run dev`.
2. Log in.
3. Add a known-fast feed (e.g., a well-cached public RSS endpoint).
   Confirm the row appears in the sidebar with the feed's title
   already displayed and an unread badge of 0 (or no badge).
   Confirm no spinning resolving indicator is observed at any
   point. The transition should be effectively instant from the
   reader's perspective.
4. Add a deliberately slow feed (or use dev tools to throttle the
   outbound network for the duration of the POST). Confirm the
   row appears in resolving state (spinner visible). Combined
   with Phase 1's convergence fix, the row should reach terminal
   state within ~35s.

If the fast-path test passes but the user perceives a spinner
flash, investigate whether the client's `loadFeeds` round-trip is
introducing a render flicker. If so, file a follow-up; do not
block Phase 2 on it because AC1.1 is "the sidebar row renders
directly in the resolved state with the feed title visible" —
the row enters resolved state, no spinner, even if there's a
sub-frame loading moment.

**Verification:**
Visual inspection matches AC1.1.

**Commit:** No code change.
<!-- END_TASK_4 -->

---

## Phase 2 Done When

- `npm test` passes including the new `post-feed-hybrid` suite.
- `npm run lint` passes.
- Manual smoke (Task 4) confirms no spinner moment for fast feeds.
- Phase 2 commits land on the `020-add-feed-zero-unread` branch.

## Out of Scope for Phase 2

- Client-side optimization to consume `unread` from POST response
  and skip the redundant `loadCounts` call — defer.
- Retiring spec 014 `feedUpdateCounts` SSE field — Phase 4.
- Mark-read on initial fetch — Phase 3 (the `unread === 0` result
  in Test 1 depends on items being ingested as read; until Phase 3
  lands, an initial fetch with items WILL produce nonzero unread).
  This is why Test 1's harness mocks the parsed-feed to have zero
  items: we want to test the response shape, not the mark-read
  rule, in this phase. Test for unread = 0 with non-zero items is
  Phase 3's responsibility.
