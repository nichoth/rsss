# Phase 0 Research — 018-fix-feed-resolving-stuck

The spec contains no `NEEDS CLARIFICATION` markers. The single
parameter the spec defers to planning is the **bounded resolution
window** ("a specific numeric ceiling will be decided during planning;
the spec requires only that such a bound exist and be enforced").
Everything else in this document is best-practice / pattern research
needed to make the design defensible.

---

## Decision 1 — Bounded resolution window value

**Decision**: `RESOLVE_WINDOW_MS = 30_000` (30 seconds).

**Rationale**:
- Server-side feed fetch timeout is `FEED_FETCH_TIMEOUT_MS = 15_000`
  (`src/server/feed-fetch.ts:3`). The window must be strictly greater
  than the fetch timeout, otherwise a slow but eventually-successful
  fetch would be cancelled by the sweep.
- 30s = 2× fetch timeout. That covers (a) one full slow upstream
  response that still completes successfully, plus (b) DO scheduling /
  alarm dispatch latency, plus (c) a small safety margin.
- 30s is short enough that a reader who just submitted a feed sees
  *some* terminal state (resolved or failed) within the same screen
  view — they do not need to walk away.
- The reader-perceived window in the client is `RESOLVE_WINDOW_MS +
  CLIENT_GRACE_MS` (5s) = 35s, to allow the server-side sweep to write
  the row before the client polls. Round trip + sweep + pull-sync fits
  comfortably in 5s.

**Alternatives considered**:
- **15s** (= fetch timeout): rejected. A successful fetch that takes
  the full timeout would be cancelled by the sweep that fires at the
  exact same instant; race-prone.
- **60s**: rejected as user-hostile. The user has no signal during
  this whole window other than the spinner; a full minute of spinner
  is the bug we're fixing.
- **5–10s**: rejected. Less than `FEED_FETCH_TIMEOUT_MS`. The sweep
  would systematically fail every legitimate slow-upstream fetch.
- **Configurable / per-user**: rejected as scope creep; not requested
  by spec. A constant in the DO file is sufficient.

---

## Decision 2 — Where the bounded-window guarantee lives (server vs.
client)

**Decision**: **Server-authoritative sweep** in the DO `alarm()`
handler is the source of truth. The client also schedules a one-shot
`runSync` at `RESOLVE_WINDOW_MS + 5s` after `addFeed` for defense in
depth and SSE-independence (FR-006).

**Rationale**:
- FR-001 says the row "MUST NOT persist past the window under any
  condition (success, failure, partial success, network interruption,
  server crash)." The only place that can guarantee this across
  *server crashes* is the server itself.
- Spec Story 3 explicitly requires that reload after the window shows
  the correct terminal state — that means the *server-side row* must
  carry the terminal value. A client-only timer cannot satisfy that.
- The client one-shot pull-sync exists because of FR-006: "the client
  MUST NOT depend solely on receiving a live event." If SSE drops and
  the user does not reload, the client must still converge. Existing
  triggers (`online` event, `feed-updated` SSE, manual refresh) cover
  most cases; the one-shot fills the gap of "page open, SSE silent,
  no other trigger."

**Alternatives considered**:
- **Client-only watchdog** (`setTimeout` flips local row to "failed"):
  rejected. Reload would revert to resolving (FR-008 violation), and
  multi-device users would see different states.
- **Server `await fetchFeed(...)` in `POST /api/feeds`** instead of
  `waitUntil`: rejected. The handler would block for up to
  `FEED_FETCH_TIMEOUT_MS`, undermining the optimistic add-feed UX,
  and DO eviction during the awaited call still has the same outcome
  (write may not complete). The sweep is simpler and covers more
  failure modes.
- **Cloudflare Queue retry**: rejected. Constitution III: per-user
  state lives in the per-user DO; introducing a cross-user queue is
  an architecture change, not a bug fix.

---

## Decision 3 — How the alarm sweep identifies stuck rows

**Decision**: SQL predicate
```sql
WHERE last_fetched IS NULL
  AND last_error IS NULL
  AND created_at < datetime('now', '-30 seconds')
```
Update sets `last_error = 'Initial fetch did not complete'`,
`last_status = 504`. Then `broadcast('feed-updated', { feedId })` for
each row swept.

**Rationale**:
- `last_fetched IS NULL AND last_error IS NULL` is *exactly* the
  client's `isResolving` predicate
  (`src/client/components/sidebar.ts:166-167`). Sweeping that set
  drops `isResolving` to false on the next pull.
- `created_at < now - WINDOW` ensures a row that was just inserted
  (and whose `waitUntil(fetchFeed)` is legitimately in flight) is
  *not* swept prematurely.
- HTTP 504 (Gateway Timeout) is the most truthful status code for
  "we never heard back from the upstream within the window". This
  also makes the failure look identical to a network-timeout failure
  on retry, so client UI/labels need no special-casing.
- Broadcasting `feed-updated` triggers the existing client refresh
  path (`src/client/state.ts:682-685`) so SSE-connected clients see
  the transition immediately.

**Alternatives considered**:
- **Different sentinel column** (e.g. `resolve_status`): rejected.
  Adding a column means a server schema change, a `pullSync` change,
  a `bootstrapLocalDb` change, and a sidebar-predicate change — a
  Principle II violation if any one is missed. The two existing
  columns are sufficient: their *current* combinations already encode
  the three states.
- **Sweep on every `/api/sync` read**: considered as a complement
  (zero-extra-latency on user-driven polls). Rejected for *this
  feature* to keep the change focused; a future PR can add it. The
  alarm-based sweep is sufficient for FR-001.

---

## Decision 4 — How the `alarm()` cadence is shortened post-add

**Decision**: At the end of `POST /api/feeds`, call
`this.ctx.storage.setAlarm(min(existingAlarmAt, now + RESOLVE_WINDOW_MS))`.
The existing 10-minute periodic alarm is preserved; we only pull it
forward.

**Rationale**:
- Cloudflare DO alarms are single-cell: setting an earlier time wins.
- After the alarm fires, the existing handler reschedules to the
  next periodic refresh time, so we don't permanently shorten the
  cadence.
- This is the smallest change that satisfies the bounded window for
  newly added feeds without altering refresh cadence for steady-state
  feeds.

**Alternatives considered**:
- **Always poll alarms at 30s cadence**: rejected. It would 20× the
  alarm volume for no benefit on steady-state feeds.
- **Track per-feed deadlines in storage and pick min**: rejected as
  over-engineered for a 1-bit case (newly-added vs. not).

---

## Decision 5 — `POST /api/feeds/:id/refresh` response shape

**Decision**: Change response from `{ success: true }` to
`{ feed: <full feed row, post-fetch> }`. The shape mirrors the
"wrapped authoritative row" convention already established by
`/api/sync` conflict responses (Constitution II).

**Rationale**:
- Today the client must wait for SSE `feed-updated` (or the next
  pull-sync) to learn whether retry succeeded. That's exactly the
  failure mode FR-006 forbids.
- Returning the row immediately means the client can call
  `upsertFeedFromServer` and the sidebar updates in the same tick
  the retry button was clicked.
- Consistent with `POST /api/feeds`, which already returns the
  inserted feed row.

**Alternatives considered**:
- **Return only the changed columns**: rejected. The wrapped-row
  pattern is the codebase convention; deviating creates a new
  serialization shape to maintain.
- **Leave the response unchanged, rely on SSE**: rejected. Same
  reason as above — FR-006 forbids SSE dependency for correctness.

---

## Decision 6 — `fetchFeed` 304-on-first-fetch path

**Decision**: Inside the `if (fetched.notModified)` branch
(`durable-objects/index.ts:1525-1542`), add an `UPDATE feeds SET
last_fetched = datetime('now'), last_error = NULL, last_status = NULL
WHERE id = ?` *before* `return`. The poller-state and
last-any-success bookkeeping stay as-is.

**Rationale**:
- 304 means the upstream is reachable. Per FR-005, that *is* a
  resolved state — the row should not stay perpetually resolving just
  because the server happened to have a cached ETag for a brand-new
  subscription.
- We do not parse, do not insert items, do not broadcast
  `feed-updates-available`. None of that changes. We *only* mark the
  row as resolved.
- Idempotent: subsequent 304s on the same feed re-write the same
  values; no side effects.

**Alternatives considered**:
- **Treat 304-on-first-fetch as failure ("we have no metadata")**:
  rejected; explicitly contradicts FR-005.
- **Branch on whether the feed has prior items / ever-resolved
  before**: rejected. Spec wants resolved state from a successful
  conditional fetch, full stop. No need to inspect history.

---

## Decision 7 — `fetchFeed` parsed-but-no-metadata path

**Decision**: Drop the `if (parsedFeed.title || parsedFeed.description
|| parsedFeed.link)` guard at `durable-objects/index.ts:1557`. The
`UPDATE` runs unconditionally on the success path, using `COALESCE`
to keep stale metadata sticky when fields are null.

**Rationale**:
- FR-004: "A feed whose initial fetch succeeds but yields no
  parseable title, description, or link metadata MUST still be
  recorded as resolved (not failed, not perpetually resolving)."
- The current `COALESCE(?, title)` already preserves the previous
  metadata when the new value is null, so dropping the guard does
  not erase good data with bad data.
- The crucial side effect is that `last_fetched`, `last_error`,
  `last_status` are written on every successful parse, regardless of
  metadata content.

**Alternatives considered**:
- **Issue a separate "always" UPDATE for the three terminal-state
  columns and keep the metadata UPDATE guarded**: works, but two
  UPDATEs where one suffices. Rejected for simplicity.
- **Set `title = url` when no metadata is present**: rejected.
  Sidebar already falls back to `feed.url` when `feed.title` is null
  (`sidebar.ts:196`). No need for server to special-case.

---

## Decision 8 — Local SQLite migration for `last_error`/`last_status`

**Decision**: In `src/client/db/local-db.ts`, run guarded
`ALTER TABLE feeds ADD COLUMN last_error TEXT` and
`ADD COLUMN last_status INTEGER` if the columns are missing,
following the same pattern already used for
`itemFullContentColumnsReady` (`pull-sync.ts:115-143`). Idempotent;
runs once per local DB.

**Rationale**:
- `src/shared/schema.ts:38-50` already declares both columns. New
  local DBs created from `SCHEMA_SQL` will have them automatically.
- Local DBs created before commit 7189ddc (the "fix add feed flow"
  commit that introduced the columns shared-schema-side) will lack
  them, and the new `upsertFeed` SQL will throw on `excluded.last_error`.
- Guarded by a `PRAGMA table_info(feeds)` check (or by the
  already-established once-per-DB `Set<Sqlite3Db>` pattern).

**Alternatives considered**:
- **Bump local schema version + drop and recreate**: rejected.
  Destroys local items cache for no reason.
- **Wrap the upsert in try/catch and ignore unknown-column errors**:
  rejected. Hides real bugs. The migration is small and explicit.

---

## Decision 9 — Tests

**Decision**: Vitest specs at `test/feed-resolve-state.test.ts`
covering the four invariants:

1. After a successful `fetchFeed`, the row has `last_fetched != NULL`,
   `last_error = NULL`, regardless of whether parsed metadata is
   present.
2. After a 304-only `fetchFeed` (mocked `notModified`), the row has
   `last_fetched != NULL`.
3. After `created_at + RESOLVE_WINDOW_MS` elapses with neither field
   set, the alarm sweep marks the row failed with
   `last_status = 504`.
4. `upsertFeed` and `upsertFeedFromServer`, given a server payload
   that includes `last_error`/`last_status`, persist both fields to
   the local DB.

**Rationale**: One spec per FR cluster. Use the existing test harness
in `test/`. No browser integration test required for this feature
beyond manual quickstart steps; the failure mode is a state-machine
bug observable in unit tests.

**Alternatives considered**:
- **Playwright end-to-end test**: deferred. Quickstart steps cover
  manual verification; full e2e for the bounded-window timeout is
  flaky to pin without a controllable upstream mock.
