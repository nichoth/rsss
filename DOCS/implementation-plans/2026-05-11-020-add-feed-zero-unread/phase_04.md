# Phase 4: Forward-Looking Unread Count and (N) Prefix Semantics

**Goal:** Make the sidebar `(N) FeedName` prefix reflect the feed's
unread count (forward-looking semantics per spec 020) instead of
the spec 014 pending-download count, and wire a server→client SSE
channel that keeps the unread count current under ongoing fetches.
Achieve FR-009's single-source-of-truth invariant: POST response
unread (Phase 2), the `(N)` prefix value, and the SSE-delivered
ongoing unread update all derive from the same per-feed
`SELECT COUNT(*) FROM items WHERE feed_id = ? AND is_read = 0`
computation.

**Architecture:** Extend the existing `feed-updates-available` SSE
event payload with a new `feedUnreadCounts` field carrying the
per-feed unread map. The legacy `feedUpdateCounts` (pending) field
stays in place because it still drives spec 014's refresh-tracking
UI (`feedSyncStatus`, etc.) and "Changes to the refresh-feeds
mechanism beyond what is required to honor the new mark-read rule"
are explicitly out of scope. The client SSE handler reads both
fields, merging `feedUnreadCounts` into `state.counts.value.perFeed`
(the canonical unread per-feed signal). The sidebar `(N)` prefix
changes its data source from `state.feedUpdateCounts` to
`state.counts.value.perFeed`.

**Tech Stack:** TypeScript (Cloudflare Workers DO server +
Preact/signals client), `@preact/signals`, `htm/preact`.

**Scope:** Phase 4 of 4. Both server (new SSE payload field) and
client (handler + sidebar binding).

**Codebase verified:** 2026-05-11

---

## Investigation Findings

- The `(N)` prefix is rendered at
  `src/client/components/sidebar.ts:185`:
  ```
  ${pending > 0 ? `(${pending}) ` : ''}
  ```
  where `pending = state.feedUpdateCounts.value[String(feed.id)] ?? 0`
  (line 165-166). This is the spec 014 pending-download count.
- The unread badge at
  `src/client/components/sidebar.ts:182-184` already shows
  `feedUnread = counts.value.perFeed[String(feed.id)] ?? 0`
  (line 163-164). So the unread channel is already live on the
  client — Phase 4 just changes which signal drives the prefix.
- Server-side, `getFeedUpdateCounts` at
  `src/server/durable-objects/index.ts:570-593` queries pending
  via `LEFT JOIN items ... WHERE pub_date > last_pulled_at`. That
  method is also referenced by legacy GET endpoints at lines
  740-744 and 752-760, and by the SSE broadcast at lines 1723-1729.
  We leave it alone and add a new method for unread.
- Server-side, the canonical unread query is at lines 681-684:
  `SELECT feed_id, COUNT(*) as unread FROM items WHERE is_read = 0
  GROUP BY feed_id`. We mirror this SQL into a new method.
- The client SSE handler for `feed-updates-available` is at
  `src/client/state.ts:839-887`. It parses
  `{ feedUpdateCounts, feedIds }`. We extend the parse to also
  read `feedUnreadCounts` and merge it into
  `state.counts.value.perFeed`.
- The mark-as-read client flow at `src/client/state.ts:1762-1793`
  already calls `State.loadCounts(state)` after PATCH, which
  refreshes `state.counts.value.perFeed`. So AC2.4 (mark-read →
  prefix updates in lockstep) is automatically satisfied once Task
  3 changes the prefix data source.
- FR-009 invariant: the unread number returned by Phase 2's POST
  response, the per-feed entries in `state.counts.value.perFeed`,
  the `feedUnreadCounts` field added by this phase's SSE payload,
  and the `(N)` prefix's displayed value all derive from the same
  SQL pattern. No duplicate field, no parallel computation, no
  drift.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### 020-add-feed-zero-unread.AC2: Unread accumulates only from subscription time forward
- **020-add-feed-zero-unread.AC2.3 New item increments unread by 1:**
  Given the reader has a subscribed feed at 0 unread, When the feed
  publishes a new item and the client receives it (via refresh or
  background poll), Then the unread count increments by 1 and the
  `(N)` prefix appears in the sidebar.
- **020-add-feed-zero-unread.AC2.4 Reading items decrements in lockstep:**
  Given a subscribed feed has accumulated unread items, When the
  reader opens and reads those items, Then the unread count
  decreases accordingly and the `(N)` prefix updates or disappears
  in lockstep with the unread badge.

Also satisfied transitively:
- **FR-005** retires the spec 014 pending-download semantics from
  the `(N)` prefix without changing its visual treatment.
- **FR-009** single-source-of-truth: POST response unread (Phase
  2), `(N)` prefix value, and SSE-delivered unread updates all
  share the same per-feed SQL computation.

---

## Implementation Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Server emits per-feed unread on SSE feed-updates-available

**Verifies:** 020-add-feed-zero-unread.AC2.3

**Files:**
- Modify: `src/server/durable-objects/index.ts` — add new method
  `getPerFeedUnreadCounts` adjacent to `getFeedUpdateCounts` at
  line 570-593.
- Modify: `src/server/durable-objects/index.ts:1715-1730` — the
  `if (newItems.length > 0)` block inside `fetchFeed`'s success
  path; extend the broadcast payload.

**Implementation:**

Add the new method on `UserDO`:

```ts
getPerFeedUnreadCounts ():Record<string, number> {
    const rows = this.sql.exec(
        'SELECT feed_id, COUNT(*) as unread FROM items ' +
        'WHERE is_read = 0 GROUP BY feed_id'
    ).toArray() as Array<{ feed_id:number|string; unread:number }>

    return rows.reduce<Record<string, number>>((counts, row) => {
        counts[String(row.feed_id)] = Number(row.unread)
        return counts
    }, {})
}
```

This is the SAME SQL pattern used by the GET /counts endpoint at
lines 681-684. Single computation logic; just exposed as a method
so the broadcast can call it. (Phase 2 added a single-feed helper
`getFeedUnreadCount`; this one returns the full map. Keep them
separate — different signatures, different call sites.)

Modify the broadcast at lines 1723-1729:

```ts
const feedIdStr = String(feed.id)
const allCounts = this.getFeedUpdateCounts()
const allUnread = this.getPerFeedUnreadCounts()
this.broadcast('feed-updates-available', {
    feedUpdateCounts: {
        [feedIdStr]: allCounts[feedIdStr] ?? 0
    },
    feedUnreadCounts: {
        [feedIdStr]: allUnread[feedIdStr] ?? 0
    }
})
```

Notes:
1. Only the touched feed's entries are included in both fields —
   matching the existing payload shape (the broadcast is
   per-fetch, not per-DB-snapshot). Sidebar reads other feeds'
   unread counts from the existing `state.counts.value.perFeed`
   signal, which is refreshed via `/counts` on boot and on
   relevant events.
2. The legacy `feedUpdateCounts` field is preserved untouched. Any
   existing client deployments that don't know about
   `feedUnreadCounts` continue to function (they just don't get
   the per-feed unread update — but they have the spec 014
   prefix semantics today, so it's a no-op for them).
3. **Subtle: Phase 3 changed initial-fetch INSERTs to write
   `is_read = 1`.** That means the initial fetch's "newItems.length > 0"
   branch will broadcast `feedUnreadCounts: { feedId: 0 }`. That's
   correct: 0 unread for the just-subscribed feed. The client
   merge logic in Task 2 must handle the 0 case by deleting the
   feed from `perFeed` (rather than leaving a stale entry).
4. **Scope note**: This task broadcasts unread on `fetchFeed`
   completion only — i.e. after a server-driven fetch ingests
   items. Cross-tab propagation when the reader marks an item
   read in another tab is NOT in scope for this task. Today,
   mark-read goes through `State.toggleItemRead`
   (`src/client/state.ts:1762-1793`) which calls
   `State.loadCounts(state)` to refresh `state.counts.value.perFeed`.
   Other open tabs would only see the change on their next
   `loadCounts` (e.g. on focus, on SSE refresh-complete). Spec
   020 does not require cross-tab live-update of unread; that's
   a separate concern.

**Verification:**

Run: `npm run lint && npm run build`
Expected: Clean.

**Commit:** `feat(do): broadcast per-feed unread on feed-updates-available (FR-009)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Client SSE handler merges feedUnreadCounts into counts.perFeed

**Verifies:** 020-add-feed-zero-unread.AC2.3

**Files:**
- Modify: `src/client/state.ts:839-887` — the
  `source.addEventListener('feed-updates-available', ...)` handler.

**Implementation:**

Extend the parsed type and add a sibling merge for unread. Place
the new logic INSIDE the existing batch wrapper at line 857-874 so
all signal writes happen atomically.

```ts
const parsed = JSON.parse(ev.data) as {
    feedUpdateCounts?:Record<string, number>
    feedUnreadCounts?:Record<string, number>
    feedIds?:string[]
}

// ... existing feedUpdateCounts branch unchanged ...

// New: merge per-feed unread into counts.perFeed.
if (
    parsed.feedUnreadCounts &&
    typeof parsed.feedUnreadCounts === 'object'
) {
    const known = new Set(
        state.feeds.value.map((f) => String(f.id))
    )
    const unreadEntries = Object.entries(
        parsed.feedUnreadCounts
    ).filter(([feedId]) => known.has(feedId))
    if (unreadEntries.length > 0) {
        const nextPerFeed = { ...state.counts.value.perFeed }
        for (const [feedId, count] of unreadEntries) {
            if (count === 0) {
                delete nextPerFeed[feedId]
            } else {
                nextPerFeed[feedId] = count
            }
        }
        const nextTotalUnread = Object.values(nextPerFeed)
            .reduce((sum, n) => sum + n, 0)
        state.counts.value = {
            ...state.counts.value,
            perFeed: nextPerFeed,
            unread: nextTotalUnread
        }
    }
}
```

Notes:
1. **Restructure the handler so both branches live inside the
   same batch.** Move the unread-merge block ABOVE the early
   `return` that exists in the current `feedUpdateCounts` branch
   (line 875) so both can run. Per user CLAUDE.md: use `batch()`
   when sequentially setting multiple signals.
2. **Total unread (`state.counts.value.unread`)** is also
   recomputed because it represents "all unread across all feeds"
   and must stay consistent with the per-feed map. Recompute from
   the new perFeed map rather than incrementing — incrementing
   could drift if the incoming payload was a corrected re-emit.
3. **Filter to known feeds**: matches the existing
   `feedUpdateCounts` pattern at line 850-855 — unknown feed ids
   are ignored. This prevents stale state for feeds unsubscribed
   in another tab.
4. **count === 0 → delete entry**: keeps `perFeed` semantically
   "feeds with at least one unread item." Matches the existing
   `feedUpdateCounts` pattern at line 860-864. (N) prefix logic
   only renders when value > 0, so an absent entry naturally
   produces no prefix.
5. **Do NOT also write to `state.feedUpdateCounts`** from the new
   field — that signal is owned by the pending pipeline.
6. **TypeScript:** `state.counts.value.perFeed` is typed
   `Record<string, number>` per `CountsResponse` (re-exported at
   line 254). No type changes needed.

**Verification:**

Run: `npm run lint && npm run build`
Expected: Clean.

Run: `npm test` — no regressions; the existing
`feed-updates-available` tests (if any) should still pass.

**Commit:** `feat(state): merge SSE feedUnreadCounts into counts.perFeed`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Sidebar (N) prefix reads unread count

**Verifies:** 020-add-feed-zero-unread.AC2.3, 020-add-feed-zero-unread.AC2.4

**Files:**
- Modify: `src/client/components/sidebar.ts:160-185` (the per-feed
  render block inside `feeds.value.map(...)`).

**Implementation:**

Change the data source for the `(N)` prefix. Currently lines
163-166 compute `feedUnread` from `counts.value.perFeed` AND
`pending` from `state.feedUpdateCounts`. The badge at line 182-184
uses `feedUnread`. The prefix at line 185 uses `pending`.

After this task:
- Remove the `pending` local variable (no longer used).
- The prefix expression reads `feedUnread`.

**Approach**: Extract a pure helper for the prefix string so
tests assert against function output, not rendered HTML (per
user CLAUDE.md "DO NOT WRITE BRITTLE TESTS — do not test for
specific text content in HTML"). Place the helper at the top of
`src/client/components/sidebar.ts` (above the `Sidebar`
component definition) and export it for the test in Phase 4
Task 4. Do not introduce a new file just for this one helper —
keep the change local to the only consumer.

```ts
export function unreadPrefix (unread:number):string {
    return unread > 0 ? `(${unread}) ` : ''
}
```

Then update the sidebar render block:

```diff
-                        const feedUnread = counts.value
-                            .perFeed[String(feed.id)] ?? 0
-                        const pending = (state
-                            .feedUpdateCounts.value[String(feed.id)] ?? 0)
+                        const feedUnread = counts.value
+                            .perFeed[String(feed.id)] ?? 0
                         const isResolving = (
                             feed.last_fetched === null && !feed.last_error
                         )
                         ...
                         <span class="badge feed-unread-count">
                             ${feedUnread}
                         </span>
-                        ${pending > 0 ? `(${pending}) ` : ''}
+                        ${unreadPrefix(feedUnread)}
```

**Per spec FR-005**: visual format / placement / accessibility
treatment unchanged. The prefix renders as `(N) ` exactly as
today, just sourced from a different signal.

**CSS guardrail**: the user CLAUDE.md says "NEVER change CSS that
is not related to the task you are working on." This task changes
JSX/TS only. Do NOT touch `sidebar.css`.

**Dead-code note**: After this task, `state.feedUpdateCounts` is
no longer consumed by `sidebar.ts`. Other call sites still write
to and read from it (refresh-tracking, `feedSyncStatus`, etc.).
Do NOT remove the signal — its other uses are out of scope per
spec 020.

**Verification:**

Run: `npm run lint && npm run build`
Expected: Clean. No unused-variable lint errors (the `pending`
variable is removed).

Visual check: in dev server, with a feed at 3 unread, sidebar
shows `(3) FeedName` (prefix) and the badge shows `3`.

**Commit:** `feat(sidebar): (N) prefix reads unread count (FR-005)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for unread SSE flow and prefix semantics

**Verifies:** 020-add-feed-zero-unread.AC2.3, 020-add-feed-zero-unread.AC2.4

**Files:**
- Create: `test/sse-unread-counts.ts` (new file)
- Optionally modify: existing test files only if they assert on
  the old pending-prefix semantics; add a follow-up test for the
  new unread-prefix semantics.

**Implementation:**

Follow the harness pattern from `test/feed-resolve-state.ts`
(server-side DO mock) and any existing client SSE-handler tests
(check `test/` for files testing SSE event handling — likely
`test/state-events.ts` or similar; if none exist, build the
fixture inline).

Tests required:

**Test 1 — Server broadcast includes feedUnreadCounts (AC2.3, server-side):**
Drive `fetchFeed(feed)` against a non-initial feed row (last_fetched
populated) with a parser returning 2 new items. Assert the
captured `broadcasts` log contains exactly one entry where
- `event === 'feed-updates-available'`
- `data.feedUnreadCounts` is an object containing this feed's id
  mapped to the expected unread count (2 in this case, plus any
  pre-existing unread for the same feed).

**Test 2 — Client handler merges feedUnreadCounts into perFeed (AC2.3, client-side):**
Set up an AppState fixture with `state.counts.value.perFeed` empty
and `state.feeds.value` containing a feed with id `42`. Simulate
the SSE event by directly dispatching a synthetic
`MessageEvent('feed-updates-available', { data: JSON.stringify({
  feedUpdateCounts: { '42': 0 },
  feedUnreadCounts: { '42': 1 }
}) })` to the registered handler.

Assert after the synchronous handler dispatch:
- `state.counts.value.perFeed['42'] === 1`
- `state.counts.value.unread === 1`
- `state.feedUpdateCounts.value['42']` is unchanged (we sent 0;
  zero deletes per existing pattern).

**Test 3 — Zero unread deletes the perFeed entry:**
Same fixture, but send `feedUnreadCounts: { '42': 0 }`. Assert:
- `state.counts.value.perFeed` does NOT have key `'42'`.
- `state.counts.value.unread === 0`.

**Test 4 — unreadPrefix helper (AC2.3, AC2.4):**
Pure-function test of `unreadPrefix` (Task 3). Asserts:
- `unreadPrefix(0) === ''`
- `unreadPrefix(1) === '(1) '`
- `unreadPrefix(42) === '(42) '`

This deliberately tests the function's return value, not the
rendered HTML — the project CLAUDE.md prohibits text-content
assertions against HTML. The end-to-end visual correctness is
covered by manual smoke (Task 5).

**Test 5 — Mark-read decrements (AC2.4):**
Set up state with `perFeed: { '42': 3 }`. Mock `adapter.updateItem`
and `State.loadCounts` (or use the real flow). Call
`State.toggleItemRead(state, itemId, true)`. After awaiting, assert
`state.counts.value.perFeed['42']` is the new server-recomputed
value (the test should drive the mock to return 2). The point is
to verify the `(N)` prefix data source updates lockstep with
mark-read — this is implicit through the existing `loadCounts`
call, but the test asserts the invariant.

**Verification:**

Run: `npm test -- --grep sse-unread-counts`
Expected: All tests pass.

Run: `npm test`
Expected: Full suite passes. Pay particular attention to any
pre-existing tests that may have asserted the spec 014 prefix
semantics (`(${pending})`). If found, update them to assert the
new semantics and add a comment referencing spec 020 FR-005.

**Commit:** `test: SSE unread merge and (N) prefix unread semantics`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Manual UI smoke verification

**Verifies:** 020-add-feed-zero-unread.AC2.3, 020-add-feed-zero-unread.AC2.4

**Files:** None.

**Implementation:**

After Tasks 1-4 land:

1. Start dev server: `npm run dev`.
2. Log in.
3. **AC2.3:** Subscribe to a feed (after all of Phases 1-3 land,
   this should produce a feed at 0 unread; no `(N)` prefix). Wait
   for the next background poll OR trigger a manual refresh on
   that feed. If the upstream feed has not published a new item
   between subscribe and refresh, either wait or use a test feed
   you control to publish a new item. Confirm:
   - The sidebar row updates to show `(1) FeedName`.
   - The badge for that feed shows `1`.
4. **AC2.4:** Click into the feed, read the one unread item.
   Either via toggle-read UI or by opening it (depends on the
   project's mark-as-read trigger — check existing UX). Confirm:
   - The badge transitions from `1` to `0` (or hides if 0 is
     hidden).
   - The `(N)` prefix disappears (since `feedUnread > 0`
     becomes false).
   - The transition is in lockstep — both update within one
     render cycle. No visible drift.
5. **FR-009 invariant**: Open browser devtools, network tab. Add
   a new feed. Inspect the POST `/api/feeds` response body. The
   `unread` field value should match `counts.value.perFeed[feedId]`
   after `loadCounts` runs (you can read this via React/Preact
   devtools or by logging `state.counts.value.perFeed` in the
   console).

If any of the above fail, return to the relevant task. For step 5
specifically, if the values differ, double-check the SQL pattern
in Phase 2 Task 1's `getFeedUnreadCount` helper matches
Phase 4 Task 1's `getPerFeedUnreadCounts` (both should derive from
`WHERE is_read = 0`).

**Verification:**
Visual matches the above.

**Commit:** No code change.
<!-- END_TASK_5 -->

---

## Phase 4 Done When

- `npm test` passes including new `sse-unread-counts` suite.
- `npm run lint` passes.
- Manual smoke (Task 5) confirms AC2.3 and AC2.4 visually, and
  the FR-009 invariant check on POST response equality.
- Phase 4 commits land on the `020-add-feed-zero-unread` branch.
- The full spec's User Story 1, 2, and 3 acceptance scenarios are
  all green across Phases 1-4.

## Out of Scope for Phase 4

- Removing `getFeedUpdateCounts` or `state.feedUpdateCounts` —
  those continue to drive spec 014's refresh-tracking UI and
  `feedSyncStatus`. Their removal is a separate cleanup spec.
- Renaming the SSE event `feed-updates-available`. The payload
  shape is extended additively to preserve backward compatibility
  with any in-flight client deployments.
- Consuming Phase 2's POST response `unread` field directly to
  short-circuit the post-POST `loadCounts` call. The current
  flow's correctness is unchanged; optimization is a separate
  concern.
- Backfilling read state for pre-existing feeds — explicitly
  out-of-scope per spec Assumptions.
