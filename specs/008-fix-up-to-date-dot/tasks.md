# Tasks: Fix Up-to-Date Dot Indicator

**Input**: Design documents from `/specs/008-fix-up-to-date-dot/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED. The plan and quickstart explicitly enumerate test
coverage to add (`test/do-handlers.ts`, `test/feed-status.ts`,
`test/dot.ts`, `test/feed-status-loader.ts`). Tests are written before
the implementation they cover within each user story.

**Organization**: Tasks are grouped by user story so each can be
implemented and tested independently against the spec's acceptance
scenarios.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Maps to spec.md user story (US1, US2, US3)
- All paths are absolute from repository root

## Path Conventions

This repo uses `src/server`, `src/client`, `src/shared`, with tests
under `test/` (Node-side stubs of CF Workers + DOM, run via `tape`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new dependencies, tooling, or project structure are
required for this feature; setup is intentionally minimal.

- [X] T001 Confirm working tree is clean and on branch
  `008-fix-up-to-date-dot`; run `npm install` then `npm test && npm
  run lint` once to capture a green baseline before changes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared type and the new server endpoint that every user
story depends on. These MUST be in place before any user story phase
can be worked on.

**CRITICAL**: No user story work can begin until this phase is
complete.

- [X] T002 [P] Add `FeedStatusResponse` interface
  (`{ feedUpdateCounts:Record<string, number>; totalPending:number }`)
  to `src/client/db/types.ts` per
  `specs/008-fix-up-to-date-dot/contracts/feed-status-endpoint.md`.
- [X] T003 [P] Extend `test/do-handlers.ts` with `GET /feed-status`
  cases: empty feeds (`{}`, 0), mixed pending (multiple feeds with
  varied counts), fully synced (all zeros). Tests must FAIL until
  T004 lands.
- [X] T004 Implement `GET /feed-status` route in
  `src/server/durable-objects/index.ts` that calls the existing
  `getFeedUpdateCounts()` and returns
  `{ feedUpdateCounts, totalPending }`. Mount under the same
  `dataRouter` group covered by `requireAuth`; do NOT add
  `requireEntitlement` (free users must reach it per FR-004).
- [X] T005 Add `State.loadFeedStatus(state)` shell in
  `src/client/state.ts` that issues `GET /api/feed-status` via the
  shared `ky` client, parses `FeedStatusResponse`, and sets
  `state.feedUpdateCounts` + `state.feedSyncStatus`
  (`'updates' | 'synced'`) inside a `batch(...)`. Failure path sets
  `feedSyncStatus = 'error'` and `feedSyncError` (FR-012). Do NOT yet
  remove indicator-state writes from `loadFeeds()` — that happens in
  US1.

**Checkpoint**: Endpoint live and reachable; client loader callable
but not yet wired in. User story phases may begin.

---

## Phase 3: User Story 1 - Page-load indicator is correct (Priority: P1) MVP

**Goal**: On every page load the header pill reflects the
authoritative server-vs-client comparison via a single round trip,
including in online-only mode and including the failure path
(red, not green).

**Independent Test**: Quickstart Scenarios 1, 2, 3, 7. Confirm
DevTools shows exactly one `GET /api/feed-status` per page load
regardless of feed count, and that blocking that request leaves the
indicator in the red error state — never green.

### Tests for User Story 1 (write FIRST; ensure they FAIL)

- [X] T006 [P] [US1] Add `test/feed-status-loader.ts` covering
  `State.loadFeedStatus()`: success populates
  `feedUpdateCounts` + `feedSyncStatus` from the response;
  HTTP 5xx path sets `feedSyncStatus = 'error'` and `feedSyncError`;
  HTTP 401 clears the user and routes to `/login` (matches existing
  `PullSyncAuthError` handling).
- [X] T007 [P] [US1] Extend `test/feed-status.ts` to assert the
  `<FeedStatus>` component renders the red "sync failed" pill when
  `feedSyncStatus = 'error'` (this state is the page-load failure
  path, FR-012 / SC-006).
- [X] T008 [P] [US1] Extend `test/dot.ts` with the error-color path
  (red dot for `feedSyncStatus = 'error'`), plus assertions that blue
  dot shows when `totalPending > 0` and green dot shows when
  `totalPending === 0`.

### Implementation for User Story 1

- [X] T009 [US1] Wire `State.loadFeedStatus(state)` into the
  post-auth boot path in `src/client/state.ts` (the function that
  today calls `State.loadFeeds(state)` after auth resolves). Call it
  alongside `loadFeeds`, not nested, so indicator state and feed list
  are decoupled.
- [X] T010 [US1] Remove indicator state writes from `State.loadFeeds`
  in `src/client/state.ts`: stop assigning
  `state.feedUpdateCounts` and `state.feedSyncStatus` from the feeds
  response. The function now only loads the feeds list.
- [X] T011 [P] [US1] In `src/client/db/remote-adapter.ts`, drop
  `feedUpdateCounts` from the `getFeeds()` parsed shape and from the
  returned `FeedsResponse`. Keep the wire response tolerant (accept
  but ignore the legacy field for one deploy window).
- [X] T012 [P] [US1] In `src/client/db/types.ts`, remove
  `feedUpdateCounts` from `FeedsResponse` so `localAdapter` and
  `remoteAdapter` agree on the trimmed shape.
- [X] T013 [US1] Trigger `State.loadFeedStatus(state)` on the
  browser `online` event handler in `src/client/state.ts` (mirrors
  the existing `runSync` rerun); ensures recovery from transient
  offline at boot.

**Checkpoint**: Page load issues exactly one `GET /api/feed-status`,
indicator is correct in remote and local-first modes, and a failed
status request leaves the pill red — never silently green. SC-001,
SC-004, SC-005, SC-006 verifiable.

---

## Phase 4: User Story 2 - Live updates while app is open (Priority: P2)

**Goal**: When the server detects new items on a subscribed feed
while the reader has the app open, the indicator transitions / grows
without a reload, and reconciles after SSE drops.

**Independent Test**: Quickstart Scenarios 4 and 5. Trigger a
server-side feed fetch with the app open; confirm the indicator goes
from green to blue with the correct count within seconds. Trigger a
second fetch on the same feed; confirm the count grows. Disconnect
and reconnect SSE while items arrive; confirm the indicator
reconciles after reconnect.

### Tests for User Story 2 (write FIRST; ensure they FAIL)

- [X] T014 [P] [US2] Extend `test/do-handlers.ts` (or add a focused
  case alongside) to assert the new `feed-updates-available` SSE
  payload shape: `{ feedUpdateCounts: { [feedId]: number } }`,
  emitted on every `fetchFeed` call where `newItems.length > 0`
  (i.e. without the `wasAlreadyUnsynced` short-circuit).
- [X] T015 [P] [US2] Extend `test/feed-status-loader.ts`:
  - On `feed-updates-available` event with a counts payload, the
    client overwrites `feedUpdateCounts` (does not increment); a
    payload entry of `0` removes that feed from the map.
  - On EventSource reconnect (a successful `open` after a previous
    `error`), `loadFeedStatus()` is called.
  - An incoming event for a `feedId` not present in the user's
    feeds list is ignored (multi-tab unsubscribe edge case).

### Implementation for User Story 2

- [X] T016 [US2] In `src/server/durable-objects/index.ts` `fetchFeed`
  (around the existing `wasAlreadyUnsynced` block), replace the
  broadcast with one that runs `getFeedUpdateCounts()` (filtered to
  the touched feed(s)) and emits
  `broadcast('feed-updates-available', { feedUpdateCounts })`. Remove
  the `&& !wasAlreadyUnsynced` short-circuit so additional items on
  an already-unsynced feed still broadcast (Acceptance 2.2).
- [X] T017 [US2] In `src/client/state.ts` `feed-updates-available`
  handler, switch from the `updateCountsFromFeedIds` increment path
  to a merge-and-prune of the canonical counts from the payload
  (overwrite; entries with value `0` are deleted). Recompute
  `feedSyncStatus` from the resulting total (`'updates'` if > 0,
  `'synced'` if 0). Keep a one-deploy-window fallback that calls
  `State.loadFeedStatus(state)` if the legacy `feedIds` shape is
  received.
- [X] T018 [US2] In `src/client/state.ts` EventSource setup, add an
  `open` handler that, on every successful `open` after the first,
  calls `State.loadFeedStatus(state)` to reconcile (FR-007). The
  first `open` does not need to refetch because the boot path already
  loaded status (US1).
- [X] T019 [US2] In the `feed-updates-available` handler, ignore
  payload entries whose `feedId` is not present in
  `state.feeds.value` (edge case in spec; defensive against late
  events for unsubscribed feeds).

**Checkpoint**: Live updates render within seconds with correct
counts; reconnect reconciles state. SC-002 verifiable; Acceptance
2.1, 2.2, 2.3 pass.

---

## Phase 5: User Story 3 - Refresh clears the indicator (Priority: P2)

**Goal**: After "Refresh Feeds" completes successfully with no
remaining server-side pending items, the indicator returns to green;
if more items arrived during the refresh, the displayed count
reflects the remainder rather than misleadingly going green.

**Independent Test**: Quickstart Scenario 6. Click "Refresh Feeds"
with the indicator blue; confirm it goes green within ~3s. Trigger a
mid-refresh server fetch; confirm the indicator reflects the
remaining count after refresh completes.

### Tests for User Story 3 (write FIRST; ensure they FAIL)

- [X] T020 [P] [US3] Extend `test/feed-status-loader.ts`: after a
  `refresh-complete` SSE event the client calls
  `State.loadFeedStatus(state)` (defensive reconcile beyond the
  immediate `feedUpdateCounts = {}` clear); and on a refresh that
  partially fails, `feedSyncStatus` ends in `'error'` and is not
  silently overwritten by a subsequent `loadFeedStatus()` success
  unless the underlying state is genuinely caught up.
- [X] T021 [P] [US3] Extend `test/feed-status.ts` to assert the
  green `'up to date'` rendering when `feedSyncStatus === 'synced'`
  and `totalPending === 0` after a refresh sequence.

### Implementation for User Story 3

- [X] T022 [US3] In `src/client/state.ts` `refresh-complete`
  handler, after the existing `feedUpdateCounts = {}` /
  `feedSyncStatus = 'synced'` assignment, call
  `State.loadFeedStatus(state)` to defensively reconcile in case
  items arrived during the refresh window (Acceptance 3.2). Keep the
  existing optimistic clear so the dot reacts immediately; the
  reconcile is a follow-up.
- [X] T023 [US3] Confirm the `refreshFeeds()` failure path in
  `src/client/state.ts` still sets `feedSyncStatus = 'error'` and
  that the new `loadFeedStatus` reconcile in T022 does NOT run on
  the failure branch (Acceptance 3.3 / FR-009).

**Checkpoint**: Refresh closes the loop predictably and never lies
green when items remain. SC-003 verifiable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final integration sweep across stories and verification
against the quickstart.

- [X] T024 [P] Update `src/client/state.ts` JSDoc / comments for
  `loadFeedStatus`, the `feed-updates-available` handler, and the
  EventSource `open` reconciler so the next reader sees the
  "indicator is server-vs-client divergence; this is the single
  source" invariant.
- [X] T025 Remove the legacy `feedIds`-shape fallback in the
  `feed-updates-available` handler in `src/client/state.ts` once a
  deploy window has passed (gate with a follow-up commit; flagged
  here so it is not forgotten). Until then, leave the fallback in
  place.
- [X] T026 [P] Run `npm test && npm run lint`; fix any failures and
  update affected tests. Capture the green output to confirm
  baseline restored after all changes.
- [ ] T027 Walk through `specs/008-fix-up-to-date-dot/quickstart.md`
  scenarios 1–8 manually in the dev environment and tick each off
  against acceptance scenarios in `spec.md`. Record any deviations
  in the PR description.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 has no dependencies.
- **Foundational (Phase 2)**: T002 (types) is independent. T003
  (test) and T004 (endpoint) form a TDD pair. T005 (client loader
  shell) depends on T002.
- **User Story 1 (Phase 3)**: depends on Foundational (T004, T005).
- **User Story 2 (Phase 4)**: depends on Foundational; benefits from
  US1 being in place but is independently shippable.
- **User Story 3 (Phase 5)**: depends on Foundational (T005); is
  trivially compatible with US1 / US2.
- **Polish (Phase 6)**: depends on all stories landing.

### User Story Dependencies

- **US1 (P1)**: Independent after Foundational. Ships the page-load
  correctness MVP.
- **US2 (P2)**: Independent after Foundational. Can ship without
  US1, but is most valuable with US1 already in place.
- **US3 (P2)**: Independent after Foundational. Touches a different
  SSE handler from US2, so US2 and US3 can be implemented in
  parallel.

### Within Each User Story

- Tests (T006–T008, T014–T015, T020–T021) MUST be written and
  observed FAILING before their corresponding implementation tasks.
- Server-side changes precede client wiring where they affect the
  contract (e.g. T016 before T017 to keep the legacy fallback path
  meaningful).
- Within US1: T009 (boot wire) is the first behavior change; T010
  (remove old writes) follows; T011 / T012 (adapter shape trim) are
  parallelizable.

### Parallel Opportunities

- T002, T003 can run in parallel (different files).
- T006, T007, T008 can run in parallel (different test files).
- T011, T012 can run in parallel (different files in
  `src/client/db/`).
- T014, T015 can run in parallel (different test files).
- T020, T021 can run in parallel (different test files).
- US2 and US3 implementation can proceed in parallel after
  Foundational lands.
- T024, T026 can run in parallel.

---

## Parallel Example: User Story 1 Tests

```bash
# Launch the three US1 test additions in parallel:
Task: "Write test/feed-status-loader.ts loader cases per T006"
Task: "Extend test/feed-status.ts error-state render per T007"
Task: "Extend test/dot.ts error-color path per T008"
```

## Parallel Example: User Story 2 + User Story 3

```bash
# After Foundational lands, two developers can split:
Developer A: User Story 2 (T014 → T016 → T017 → T018 → T019)
Developer B: User Story 3 (T020 → T021 → T022 → T023)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup (T001).
2. Phase 2 Foundational (T002–T005).
3. Phase 3 User Story 1 (T006–T013).
4. STOP and VALIDATE: Quickstart Scenarios 1, 2, 3, 7 must pass.
   This delivers the spec's headline outcome: the indicator no
   longer lies green on page load.
5. Deploy / demo if desired.

### Incremental Delivery

1. MVP (US1) ships → indicator is correct on page load.
2. Add US2 → live updates and reconcile-on-reconnect; indicator
   stays correct over the session.
3. Add US3 → refresh closes the loop cleanly.
4. Polish phase to remove legacy fallback and run quickstart end to
   end.

### Parallel Team Strategy

- One engineer takes Foundational (T002–T005) and US1 (T006–T013).
- Once Foundational is merged, a second engineer can pick up US2
  while a third handles US3, since the only shared file is
  `src/client/state.ts`. To avoid merge conflicts there, sequence
  US2 and US3 client-side edits or coordinate via a single PR.

---

## Notes

- [P] = different files, no dependencies on incomplete tasks.
- [Story] label maps each task to a spec.md user story for
  traceability.
- The feature ships without any database schema change or migration;
  do not introduce one (Constitution Principle II).
- Page-load failure must NEVER fall through to green
  (FR-012 / SC-006); the test in T006 and the wiring in T005 are the
  guardrails.
- Commit per task or per logical pair (e.g. test + impl) so each
  checkpoint is bisectable.
