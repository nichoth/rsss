# Spec 020 Test Requirements

This document maps every acceptance criterion (AC1.1-AC1.3, AC2.1-AC2.4,
AC3.1-AC3.3) and every success criterion (SC-001 through SC-006) from
spec `020-add-feed-zero-unread` to either an automated test (file +
test type) or to a documented human verification procedure. It also
walks each Edge Case from the spec. Source spec lives at
`/Users/nick/code/rsss/specs/020-add-feed-zero-unread/spec.md`; the
per-phase task-level "Verifies:" tags in
`/Users/nick/code/rsss/docs/implementation-plans/2026-05-11-020-add-feed-zero-unread/phase_0{1..4}.md`
are the ground truth for which task creates which test.

## Automated Tests

Tests are run via `node test/run-all-tests.mjs`, which aggregates
`@substrate-system/tapzero` files under `/Users/nick/code/rsss/test/`.

### User Story 1 - Adding a feed feels instant and calm

| Criterion | Test Type | Test File | Created By | Notes |
|-----------|-----------|-----------|------------|-------|
| 020-add-feed-zero-unread.AC1.1 | unit (server, DO handler) | `test/post-feed-hybrid.ts` | Phase 2 Task 3 (Tests 1, 2) | Test 1 asserts fast path returns `{ feed, unread }` with `feed.last_fetched` set and `unread === 0`. Test 2 covers the fast-path-but-failed sub-case (edge case). Slow-path contract is asserted via Test 3 (helper returns `'timeout'`). Test 4 asserts the alarm is set unconditionally. |
| 020-add-feed-zero-unread.AC1.2 | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 1 | Advances fake timer past `RESOLVE_WINDOW_MS + CLIENT_GRACE_MS`, asserts the converge callback fires `refreshAfterSync` and `state.feeds.value` reflects terminal state. |
| 020-add-feed-zero-unread.AC1.3 | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 2 | Simulates boot with a feed in resolving state hydrated from server; asserts `_resolveConvergenceForTest.pendingTimerCount() > 0` after `loadInitialView`, then asserts terminal state appears after timer advance. |

### User Story 2 - Unread accumulates only from subscription time forward

| Criterion | Test Type | Test File | Created By | Notes |
|-----------|-----------|-----------|------------|-------|
| 020-add-feed-zero-unread.AC2.1 | unit (server, DO ingest) | `test/initial-fetch-mark-read.ts` | Phase 3 Task 2 (Test 1) | Drives `fetchFeed` against a feed row with `last_fetched: null, last_error: null`, parser returns 3 items, asserts `is_read = 1` is passed for each INSERT and unread count is 0. |
| 020-add-feed-zero-unread.AC2.2 | unit (server, DO ingest) | `test/initial-fetch-mark-read.ts` | Phase 3 Task 2 (Test 1) | Same setup as AC2.1; asserts the items are present in the items table (visible) but flagged read. Tests behavior at the SQL parameter layer, not rendered HTML. |
| 020-add-feed-zero-unread.AC2.3 | unit (server broadcast + client SSE handler + pure helper) | `test/sse-unread-counts.ts` | Phase 4 Task 4 (Tests 1, 2, 4) | Test 1: server broadcasts `feedUnreadCounts` on `fetchFeed` with new items. Test 2: client handler merges `feedUnreadCounts` into `state.counts.value.perFeed`. Test 4: `unreadPrefix(1) === '(1) '` so the prefix appears when unread > 0. |
| 020-add-feed-zero-unread.AC2.4 | unit (client signals + pure helper) | `test/sse-unread-counts.ts` | Phase 4 Task 4 (Tests 3, 4, 5) | Test 3: count === 0 deletes the perFeed entry. Test 4: `unreadPrefix(0) === ''`. Test 5: `toggleItemRead` triggers `loadCounts` and the perFeed entry drops, exercising the lockstep invariant. |

### User Story 3 - Retry control reliably re-attempts a failed resolve

| Criterion | Test Type | Test File | Created By | Notes |
|-----------|-----------|-----------|------------|-------|
| 020-add-feed-zero-unread.AC3.1 | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 3 | Uses a deferred-promise mock for `api.post` so the call stays pending; asserts that synchronously (before awaiting the post) the targeted feed in `state.feeds.value` has `last_fetched: null, last_error: null` (resolving state). |
| 020-add-feed-zero-unread.AC3.2 | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 3 | After the retry POST resolves with a feed body whose `last_fetched` is set, asserts the row in `state.feeds.value` reflects resolved state. |
| 020-add-feed-zero-unread.AC3.3 | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 3 | If the POST throws or returns no `feed` field, asserts the row stays in optimistic resolving state AND a convergence timer is scheduled (`_resolveConvergenceForTest.pendingTimerCount() > 0`); advancing the timer surfaces the failed state if the server still cannot resolve. |

### Edge cases with automated coverage

| Edge Case | Test Type | Test File | Created By | Notes |
|-----------|-----------|-----------|------------|-------|
| Feed has zero items on initial fetch | unit (server, DO ingest) | `test/initial-fetch-mark-read.ts` | Phase 3 Task 2 (Test 4) | Parser returns zero items; asserts no INSERT calls, feed row transitions to resolved, unread count is 0. |
| Delete and re-add the same feed | integration (server, DO handlers) | `test/do-handlers.ts` (existing file extended) | Phase 3 Task 2 (Test 5) | POSTs feed → awaits initial fetch (items marked read) → DELETEs → POSTs same URL → awaits new initial fetch; asserts re-added feed's `counts.perFeed[id]` is 0. Validates that cascade-delete + fresh fetch restarts the mark-read boundary. |
| Subscribe twice to the same URL | covered by existing dedup tests | `test/do-handlers.ts` (existing 409 dedup path) | Pre-existing | Server-side dedup at `src/server/durable-objects/index.ts:801-829` returns 409 before reaching `fetchFeed`; existing handler tests cover this. No new dedup test created by spec 020 — the path never re-triggers the mark-read rule by construction. |
| POST 3s wait succeeds but fetch result is failure | unit (server, DO handler) | `test/post-feed-hybrid.ts` | Phase 2 Task 3 (Test 2) | Parser/fetch rejects in under 3s; response carries 201 with `feed.last_error` populated, `unread === 0`, no spinner state in response. |
| POST 3s elapses, background fetch later succeeds, SSE drops | unit (client, signals) | `test/resolve-convergence-signal-refresh.ts` | Phase 1 Task 1 + Task 2 | The convergence timer fires at `RESOLVE_WINDOW_MS + CLIENT_GRACE_MS` independent of SSE delivery; the signal-refresh fix is the test's subject. This is the exact failure mode the convergence test was built to cover. |
| Background poll surfaces items with pub_date older than subscribed_at | unit (server, DO ingest) | `test/initial-fetch-mark-read.ts` | Phase 3 Task 2 (Test 2) | Drives `fetchFeed` with `last_fetched` already set (non-initial). Parser returns items regardless of their pub_date. Asserts `is_read = 0` passed in INSERT — so an item ingested by a non-initial fetch counts as unread, regardless of pub_date. Validates the fetch-time-boundary rule rather than a pub_date-derived rule. |

### Phase-internal infrastructure tests (not directly mapped to ACs)

| Test | Test Type | Test File | Created By | Notes |
|------|-----------|-----------|------------|-------|
| `awaitFetchOrTimeout` returns `'timeout'` on slow fetch | unit (server, isolated helper) | `test/post-feed-hybrid.ts` | Phase 2 Task 3 (Test 3) | Drives the race helper directly with a 50ms window so the test runs in real time; isolates the timing contract from the full handler. |
| Alarm is set unconditionally before the race begins | unit (server, DO handler) | `test/post-feed-hybrid.ts` | Phase 2 Task 3 (Test 4) | Defends FR-002 (terminal-state-within-window) by ensuring the server alarm safety net is registered even when the fast branch wins. |
| `unread` field uses the canonical /counts SQL pattern | unit (server, behavior equality) | `test/post-feed-hybrid.ts` | Phase 2 Task 3 (Test 5) | FR-009 single-source-of-truth: drives both POST and /counts in the same fixture and asserts the unread value is identical. |
| Subsequent fetch after prior failure does NOT flag items as read | unit (server, DO ingest) | `test/initial-fetch-mark-read.ts` | Phase 3 Task 2 (Test 3) | `last_fetched: null, last_error: <string>` is treated as non-initial; ensures a failed-then-retried fetch does not re-mark the retry's items as read. |

## Human Verification

The following criteria cannot be reasonably automated because they
either require real upstream feed endpoints (variable network
conditions, real DNS / TLS, real publisher metadata), real
inter-process timing across the browser + worker + DO + alarm
scheduler, or visual perception (no spinner observed) that is
ill-defined as a unit-test assertion. Each entry lists the criterion,
why automation isn't feasible, and a concrete verification procedure.

### SC-001: 100% of newly added feeds reach a terminal state within 35s across a representative URL set

- **Why manual.** The success-criterion explicitly enumerates a
  "representative set of feed URLs covering success, 404, network
  failure, slow upstream, malformed content, redirect, empty-metadata,
  and oversized." Automating this faithfully would require a fixture
  network that mirrors all of those failure modes — and worse, real
  upstream timing variance is the failure mode the spec is trying to
  guard against. A mocked-network unit test verifies the timer logic
  (which AC1.2 and AC3.x cover) but does not verify the success
  criterion.
- **Verification approach.**
  1. Prepare a URL list with at least one of each: known-good fast
     feed; known 404; non-existent hostname (network failure); a
     deliberately slow upstream (e.g. an httpbin `delay/20` shim
     serving an Atom payload); malformed XML; HTTP 301/302 redirect to
     a valid feed; a feed with no `<title>` element; a feed whose
     response body exceeds the worker fetch limit (oversized).
  2. For each URL, start a stopwatch at POST submission. Confirm the
     sidebar row reaches either resolved (with title) or failed (with
     retry control) within 35 seconds.
  3. Record results in a checklist; flag any row that persists in
     resolving past 35s as a SC-001 failure.

### SC-002: 100% of newly added feeds show 0 unread immediately and after next refresh

- **Why partially manual.** The "immediately" half is covered by
  `test/post-feed-hybrid.ts` (Test 1, unread === 0 in response) plus
  `test/initial-fetch-mark-read.ts` (Test 1, items flagged read on
  ingest). The "after next refresh" half is structurally guaranteed by
  the fetch-time boundary rule (Phase 3 Test 2 covers subsequent-fetch
  semantics) but the success criterion is phrased about field
  outcomes, not unit behavior.
- **Verification approach.**
  1. Subscribe to a feed with at least 20 known existing items.
  2. Confirm the sidebar shows 0 unread immediately after POST.
  3. Trigger a manual refresh (or wait for the background poll cycle).
  4. Confirm the count remains 0 — historical items were not
     resurfaced as unread.

### SC-003: For fast feeds, the reader observes no spinner moment

- **Why manual.** "No spinner moment observed" is a perceptual
  assertion. AC1.1's automated test confirms the POST response carries
  the resolved row, but whether the rendered sidebar transitions
  through any visible spinner state depends on browser paint
  scheduling, signal-update batching, and CSS animation timing — none
  of which the unit harness exercises.
- **Verification approach.**
  1. Open the app in a dev-tools-instrumented browser. Open the
     Performance panel and start recording.
  2. Add a known-fast feed (a well-cached public RSS endpoint).
  3. Stop recording. Scrub through the frames between POST submit and
     row paint.
  4. Confirm no frame contains the "Resolving feed" spinner element
     for that row. The row's first paint should already show the
     resolved title.
  5. Repeat with the page visible at native frame rate without
     recording, to confirm no visible flash.

### SC-004: After page reload, terminal-state rows are shown in terminal state on first paint

- **Why manual.** "First paint" is a render-pipeline property. The
  automated AC1.3 test asserts the convergence safety net schedules
  correctly after reload, but does not assert the SSR/hydration path
  preserves terminal state on first paint without flashing through
  resolving. Spec 015 (FOUC) is the relevant prior art; this is a
  hydration-correctness check distinct from convergence-correctness.
- **Verification approach.**
  1. Add several feeds and let them reach terminal state (mix of
     resolved and failed).
  2. Hard-reload the page (Cmd+Shift+R / Ctrl+F5) to force a cold
     render.
  3. With Performance recording or via slow-motion observation,
     confirm no row appears in resolving state at any point during
     hydration. Each row should paint into its terminal state directly.

### SC-005: After reload, read/unread state of every item is preserved exactly

- **Why partially manual.** Phase 3's tests assert mark-read is
  persisted server-side. But the success criterion is about
  end-to-end durability through reload — pulling the read state from
  the DO and rendering it correctly post-hydration.
- **Verification approach.**
  1. With a populated reader, mark a known set of items as read across
     several feeds.
  2. Note which items are read.
  3. Reload the page.
  4. Verify each item retains its read state exactly. None of the
     previously-read items has reverted to unread.

### SC-006: New item arrival increments unread by 1 within one cycle; prefix updates

- **Why partially manual.** Phase 4's automated tests verify the SSE
  merge logic and the prefix helper in isolation. The end-to-end
  success criterion (real new item published upstream → background
  poll fires → SSE arrives → UI updates within one cycle) requires
  either real upstream publishing or a controlled test feed plus
  observation of the actual SSE timing in the browser.
- **Verification approach.**
  1. Subscribe to a feed you control (e.g. a static feed file you can
     edit, served via local HTTP, registered as a subscription).
  2. Confirm the feed shows 0 unread.
  3. Publish one new item (append to the feed file).
  4. Either trigger a manual refresh OR wait for the background poll
     cycle.
  5. Confirm: the sidebar updates to `(1) FeedName`, the badge shows
     1, both within a single render cycle of the SSE arrival (no
     intermediate drift between the prefix and the badge).
  6. Open the item; confirm the prefix and badge return to 0 / hidden
     together.

### Edge cases requiring human verification

| Edge Case | Why Manual | Verification Approach |
|-----------|------------|-----------------------|
| Feed parses but has no title metadata | Visual/UX assertion — title falls back to URL. Automatable in principle, but the spec phrasing is about display label, and CLAUDE.md prohibits testing specific text content in HTML. | Add a feed whose RSS lacks a `<title>` element. Confirm the sidebar row uses the URL as the display label and shows 0 unread. |
| Reader had feeds before this change ships | Requires deployed-state comparison across a deploy boundary — not unit-testable. | After deploy: confirm pre-existing feeds' read/unread state is unchanged from pre-deploy state. The new mark-read rule should not retroactively flag any historical items. Use a staging account with known read/unread distribution; compare before/after snapshots. |

## Coverage Audit

Every AC1.x, AC2.x, AC3.x and every SC-001..006 listed below with its
coverage source. No criterion is uncovered.

| Criterion | Covered By | Coverage Type |
|-----------|------------|---------------|
| AC1.1 | `test/post-feed-hybrid.ts` (Phase 2 Task 3, Tests 1-2) | Automated |
| AC1.2 | `test/resolve-convergence-signal-refresh.ts` (Phase 1 Task 1) | Automated |
| AC1.3 | `test/resolve-convergence-signal-refresh.ts` (Phase 1 Task 2) | Automated |
| AC2.1 | `test/initial-fetch-mark-read.ts` (Phase 3 Task 2, Test 1) | Automated |
| AC2.2 | `test/initial-fetch-mark-read.ts` (Phase 3 Task 2, Test 1) | Automated |
| AC2.3 | `test/sse-unread-counts.ts` (Phase 4 Task 4, Tests 1-2, 4) | Automated |
| AC2.4 | `test/sse-unread-counts.ts` (Phase 4 Task 4, Tests 3-5) | Automated |
| AC3.1 | `test/resolve-convergence-signal-refresh.ts` (Phase 1 Task 3) | Automated |
| AC3.2 | `test/resolve-convergence-signal-refresh.ts` (Phase 1 Task 3) | Automated |
| AC3.3 | `test/resolve-convergence-signal-refresh.ts` (Phase 1 Task 3) | Automated |
| SC-001 | Manual: representative-URL-set procedure above | Manual (network variance) |
| SC-002 | Automated (immediate: `post-feed-hybrid.ts`, `initial-fetch-mark-read.ts`) + Manual (next-refresh procedure) | Hybrid |
| SC-003 | Manual: no-spinner-observed perceptual procedure | Manual (perception) |
| SC-004 | Manual: first-paint terminal-state procedure | Manual (hydration paint) |
| SC-005 | Automated (server persistence: `initial-fetch-mark-read.ts`, `do-handlers.ts`) + Manual (reload-end-to-end procedure) | Hybrid |
| SC-006 | Automated (SSE merge + helper: `sse-unread-counts.ts`) + Manual (real new-item arrival procedure) | Hybrid |
