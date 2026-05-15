# Phase 3: Mark-Read on Initial Fetch

**Goal:** When a user subscribes to a feed, every item ingested by
the very first server-side fetch of that feed is flagged as
already-read for that user. Every subsequent fetch (refresh, retry,
background poll) leaves the default unread state untouched.

**Architecture:** Determine "initial fetch" by reading the `feeds`
row state at the moment `fetchFeed` is called:
`feed.last_fetched === null && feed.last_error === null` uniquely
identifies the very first fetch attempt that has not yet recorded
any outcome. Pass this single bit through to the existing item
INSERT statement and write `is_read = 1` for initial-fetch
ingestions. Keep the column's schema-level `DEFAULT 0` so any other
direct INSERT path retains the existing semantics.

**Tech Stack:** TypeScript (Cloudflare Workers, ES2022), Durable
Object SQLite, `@cloudflare/workers-types`.

**Scope:** Phase 3 of 4. Server-only change inside `fetchFeed`. No
client-side changes; the client reads unread via the existing
`/counts` query which reflects the new write rule automatically.

**Codebase verified:** 2026-05-11

---

## Investigation Findings

- `fetchFeed` is at `src/server/durable-objects/index.ts:1553-1830`.
- The function is the single ingestion path used by initial
  subscription (via `POST /feeds` → `ctx.waitUntil` or Phase 2's
  hybrid race), manual refresh (`POST /feeds/:id/refresh`,
  line 958-995), batch refresh (`POST /feeds/refresh`,
  line 1001+), and the background poller alarm path.
- The item INSERT lives at line 1658-1673 inside a per-item
  for-loop at line 1653. It uses `INSERT OR IGNORE INTO items
  (feed_id, guid, title, link, description, content, author, pub_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)` — no explicit `is_read`, so the
  schema-level `DEFAULT 0` (`src/shared/schema.ts:67`) applies.
- Items table declares
  `is_read INTEGER DEFAULT 0` and
  `FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE`
  (`src/shared/schema.ts:67, 74`). So delete-then-re-add reliably
  starts fresh: the old row's items are cascade-deleted, the new
  row's first fetchFeed call sees `last_fetched = null` and
  `last_error = null` and is therefore "initial."
- The existing server-side dedup at `src/server/durable-objects/index.ts:801-829`
  returns 409 when the URL already exists, never reaching
  `fetchFeed`. So "subscribe twice to the same URL" never
  re-triggers the initial-fetch rule.
- Open Item resolved: implement the rule at item-insert time, not
  as a follow-up UPDATE. The INSERT is already in a single
  well-isolated loop; passing one extra column value is the
  minimal change. A follow-up UPDATE would be slightly more
  defensive (catches any future code path that also INSERTs into
  items for a freshly-subscribed feed) but would also flip the
  read state of any pre-existing rows that happen to share the
  feed_id — impossible by construction for a true initial fetch,
  but a real risk if the rule's invariants ever drift. The
  INSERT-time approach is cleaner.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### 020-add-feed-zero-unread.AC2: Unread accumulates only from subscription time forward
- **020-add-feed-zero-unread.AC2.1 Just-subscribed feed shows 0 unread:**
  Given the reader has just subscribed to a feed with N existing
  items, When the reader views the sidebar, Then the feed shows 0
  unread.
- **020-add-feed-zero-unread.AC2.2 Initial items visible but flagged read:**
  Given the subscription's initial server fetch has ingested the
  feed's existing items, When the reader opens the feed's article
  list, Then those items are visible but flagged as already-read.

Plus the edge cases from spec:
- Zero items on initial fetch → row resolved, 0 unread, nothing to
  flag.
- Re-add same feed after delete → fresh subscription → items
  marked read again.
- Subsequent (refresh / retry / poll) fetches do NOT auto-flag
  newly discovered items as read.

Reload durability (FR-006) is verified here because the
`is_read = 1` write is to the canonical Durable Object SQLite —
the server-authoritative store. Reload is a no-op for read state.

---

## Implementation Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Mark items as read on initial fetch in fetchFeed

**Verifies:** 020-add-feed-zero-unread.AC2.1, 020-add-feed-zero-unread.AC2.2

**Files:**
- Modify: `src/server/durable-objects/index.ts:1553-1711` (the
  `fetchFeed` method, specifically the per-item INSERT at
  line 1658-1673).

**Implementation:**

At the very top of `fetchFeed`, immediately after the existing
`console.log('[DO] fetchFeed:', feed.url)` at line 1554-1557 and
before the `readPollerFeedState` call at line 1558, capture the
initial-fetch bit from the passed-in `feed` parameter:

```ts
// Per spec 020 FR-003: items ingested by the very first fetch of
// a newly subscribed feed are flagged as already-read so the
// reader is not confronted with a backlog of historical items.
// Identify the initial fetch by the row state at call time —
// any prior attempt would have left at least one of
// last_fetched / last_error populated.
const isInitialFetch = (
    feed.last_fetched === null && feed.last_error === null
)
const initialIsRead = isInitialFetch ? 1 : 0
```

The user CLAUDE.md says "Default to writing no comments. Only add
one when the WHY is non-obvious." The why here IS non-obvious
(spec rule, derived state machine semantics) so the comment stays.
Keep it concise.

Update the INSERT statement at line 1658-1673 to write `is_read`
explicitly:

```ts
const result = this.sql.exec(
    `INSERT OR IGNORE INTO items
        (
            feed_id, guid, title, link, description,
            content, author, pub_date, is_read
        )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    feed.id,
    guid,
    item.title,
    item.link,
    item.description,
    item.content,
    item.author,
    item.pubDate,
    initialIsRead
)
```

Notes on subtleties:

1. **Column added at the end** of the column list and value list,
   matching the existing argument style. No reordering.
2. **`is_read` column already exists** in `items` (`src/shared/schema.ts:67`).
   No schema change required. The schema-level `DEFAULT 0` remains
   correct for any other code path that does not pass the column.
3. **Existing `is_starred`, `created_at`, `updated_at`, etc.** are
   intentionally still left to schema defaults — we are only
   adding the one column the spec requires.
4. **`feed.last_fetched` and `feed.last_error` types**: the `Feed`
   type uses `string|null` for both. Strict-equality checks
   against `null` are correct.
5. **Don't change the loop, error handling, or thumbnail-update
   path** — those are intentionally identical to current behavior.
6. **Side effect**: subsequent fetches will now explicitly INSERT
   `is_read = 0` rather than rely on the column default. That's a
   benign change — same observable behavior, slightly clearer
   intent at the call site.

**Verification:**

Run: `npm run lint`
Expected: Lint passes.

Run: `npm run build`
Expected: TypeScript compiles.

**Commit:** `feat(do): mark items as read on initial feed fetch (FR-003)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for initial vs subsequent fetch ingest

**Verifies:** 020-add-feed-zero-unread.AC2.1, 020-add-feed-zero-unread.AC2.2

**Files:**
- Create: `test/initial-fetch-mark-read.ts` (new file)

**Implementation:**

Mirror `test/feed-resolve-state.ts` for the fetch harness pattern.
The existing harness already covers:
- Construction of `UserDO` via `Object.create(UserDO.prototype)`.
- Mocked `sql.exec` with a queryable call log.
- Mocked `doFetchFeedText` returning canned text.
- A mocked `parseFeed` returning a chosen item list.

Tests required:

**Test 1 — Initial fetch flags all items as read:**
Build a feed row with `last_fetched: null` and `last_error: null`.
Drive `fetchFeed(feed)` against a parser returning, e.g., 3 items.
Assert that the INSERT-row arguments captured in the harness'
`sqlCalls` log contain `is_read = 1` for each of the three items.
Then drive a SELECT-COUNT against the harness' in-memory items
store (or equivalent observation surface used by the existing
test) and confirm unread count for the feed is 0.

If the harness does not implement an in-memory items store, then
inspect the captured INSERT call args directly: for each item-
insert call, the last parameter passed to `sql.exec` should be
`1`. Test behavior over implementation: prefer the count-query
assertion when feasible, fall back to call-arg inspection
otherwise. Per user CLAUDE.md "DO NOT WRITE BRITTLE TESTS" — do
NOT assert the exact SQL string. Assert on parameter values.

**Test 2 — Subsequent fetch does NOT flag items as read:**
Build a feed row with `last_fetched` set to a recent ISO
timestamp and `last_error: null`. Drive `fetchFeed(feed)` with a
parser returning 2 new items. Assert the INSERT calls for those
items pass `is_read = 0` (or the column-omitted INSERT, depending
on which version of the code is tested — but per Task 1 the
implementation now always passes is_read explicitly, so the value
is `0`).

**Test 3 — Subsequent fetch after prior failure does NOT flag:**
Build a feed row with `last_fetched: null` and `last_error` set
to a string (simulating "POST 3s wait succeeded but fetch
failed"). Drive `fetchFeed(feed)` with a successful parser
returning items. Assert `is_read = 0` for the inserted items.
This exercises the spec edge case where a prior failed attempt
should not count as the initial fetch — the user has effectively
already seen the failed-state row, so the retry's items are
"new" from their perspective.

**Test 4 — Initial fetch with zero items:**
Build a feed row with `last_fetched: null` and `last_error:
null`. Parser returns zero items. Drive `fetchFeed`. Assert no
INSERT calls were made, the feed row updates to resolved
(last_fetched populated), and the unread count for the feed is 0.

**Test 5 — Re-add after delete restarts the boundary:**
Extend `test/do-handlers.ts` directly — its `createDoHarness`
helper (see line 322 `test('UserDO feed handlers list create and
refresh feeds')` for the existing pattern) supports both DELETE
(harness recognizes `'DELETE FROM feeds WHERE id = ?'` at line
181) and POST /feeds (line 339). Add a new top-level
`test('UserDO re-add after delete starts at zero unread', ...)`
that:
1. POSTs a new feed via the harness.
2. Awaits the `waitUntilPromises` so the initial fetch ingests
   the canned items (mark them with `is_read = 1` per Phase 3).
3. DELETEs the feed (`method: 'DELETE'` to `/feeds/:id` per the
   existing line 537 / 726 examples).
4. POSTs the SAME url again. Awaits the new initial fetch.
5. Queries the per-feed unread count (via GET `/internal/lazy-html-data`
   or whichever endpoint exposes `counts.perFeed`) and asserts
   it is `0` for the re-added feed.

Use the existing helper functions to avoid duplicating harness
setup. Assert at the API/behavior layer (counts response value),
not on SQL strings.

**Verification:**

Run: `npm test -- --grep initial-fetch-mark-read`
Expected: All tests pass.

Run: `npm test`
Expected: Full suite passes. No regressions in `feed-resolve-state`,
`do-handlers`, `post-feed-hybrid` (Phase 2), or any other test
that exercises `fetchFeed`.

**Commit:** `test(do): initial-fetch ingest flags items as read`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Manual UI smoke verification

**Verifies:** 020-add-feed-zero-unread.AC2.1, 020-add-feed-zero-unread.AC2.2

**Files:** None.

**Implementation:**

After Tasks 1-2 land:

1. Start dev server: `npm run dev`.
2. Log in.
3. **AC2.1:** Add a feed known to have at least 20 existing items
   (e.g., a public blog with a long history). Confirm immediately
   after the POST resolves:
   - The sidebar row shows 0 unread (no `(N)` prefix, or `(0)` if
     the prefix shows for the zero case — verify against Phase 4's
     decision; for Phase 3 the requirement is just that the unread
     count is 0).
   - The unread badge for that feed shows 0 or is absent.
4. **AC2.2:** Open the feed's article list. Confirm:
   - All ~20 items are visible.
   - Each item is rendered as already-read (greyed out / read-state
     styling — exact treatment matches existing read-state UI).
   - No "wall of unread" backlog framing.
5. **Edge case — re-add same feed**: Delete the feed just added.
   Re-add it. Confirm the new row shows 0 unread again, even
   though the prior subscription may have left items as unread
   before the delete (cascade delete removes those items
   regardless, so the new row starts fresh — but confirm the
   visible behavior).
6. **Non-initial fetch unaffected**: For a long-resident feed
   that has accumulated some unread items, trigger a manual
   refresh (whatever UI surfaces this — likely a refresh control
   on the sidebar). Confirm any newly fetched items appear as
   unread (not flagged read by the new rule).

If step 6 fails, the rule has bled into the non-initial path and
Task 1's `isInitialFetch` check is wrong — return to Task 1.

**Verification:**
Visual inspection matches the above.

**Commit:** No code change.
<!-- END_TASK_3 -->

---

## Phase 3 Done When

- `npm test` passes including the new `initial-fetch-mark-read`
  suite.
- `npm run lint` passes.
- Manual smoke (Task 3) confirms 0 unread immediately and items
  visible-but-read.
- Phase 3 commits land on the `020-add-feed-zero-unread` branch.

## Out of Scope for Phase 3

- Retiring the spec 014 `feedUpdateCounts` "pending download"
  field — Phase 4.
- Backfilling read state for users' pre-existing feeds at deploy —
  explicitly out of scope per spec Assumptions.
- Pub_date-based derivation of unread — explicitly rejected by spec.
- Changes to the background poller / refresh-feeds mechanism
  beyond honoring the new mark-read rule (which Task 1 handles
  transparently via the `isInitialFetch` predicate).
