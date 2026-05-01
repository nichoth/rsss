---

description: "Task list for 001-fix-og-image-redirects"
---

# Tasks: Fix "Redirected Too Many Times" Errors During Feed Refresh

**Input**: Design documents from `/specs/001-fix-og-image-redirects/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/README.md, quickstart.md

**Tests**: Test tasks ARE included. The plan and research explicitly call
for new and updated tests in `test/feed-fetch-security.ts` and
`test/feed-parser.ts` (see plan.md Project Structure and research.md R-6).

**Organization**: Tasks are grouped by user story so each story can be
implemented and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)
- File paths are absolute from repo root

## Path Conventions

Single web project (Worker + Durable Object) with a Preact SPA. Server
sources live under `src/server/`; tests live under `test/`. Only
server-side files are touched by this feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the working state before behavioural changes.

- [X] T001 Confirm branch `001-fix-og-image-redirects` is checked out and
      working tree is clean (`git status` shows no uncommitted changes
      outside `specs/001-fix-og-image-redirects/`)
- [X] T002 Run baseline `npm test && npm run lint` and record any
      pre-existing failures so post-change runs can be compared

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the two redirect-budget constants and the internal
`maxRedirects` plumbing that BOTH user stories build on. Per research.md
R-2 this is a single shared helper change in
`src/server/feed-fetch.ts` and MUST land before either story's behaviour
can be verified.

**CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 In `src/server/feed-fetch.ts` add a top-of-file constant
      `MAX_ARTICLE_REDIRECTS = 5` next to the existing
      `MAX_FEED_REDIRECTS = 3`. Do not change the value of
      `MAX_FEED_REDIRECTS`.
- [X] T004 In `src/server/feed-fetch.ts` extend the internal
      `fetchValidatedResponse` helper to accept an optional
      `maxRedirects?:number` option (defaulting to `MAX_FEED_REDIRECTS`)
      and use it in the redirect-loop bound. Do not expose the option
      on the public `FetchFeedTextOptions` or `FetchOgImageOptions`
      types (research.md R-2).
- [X] T005 In `src/server/feed-fetch.ts` make `fetchFeedText` continue to
      call `fetchValidatedResponse` with `maxRedirects:
      MAX_FEED_REDIRECTS` and continue to throw `FeedFetchError('Feed
      redirected too many times')` on the cap. No behaviour change for
      this path; this task locks the existing wording in.

**Checkpoint**: Foundation in place — User Story 1 and User Story 2 can
now be implemented in parallel.

---

## Phase 3: User Story 1 — Quiet, successful "refresh feeds" (Priority: P1) MVP

**Goal**: Routine article-page redirect chains and even genuine article
loops no longer produce error-level `console.error` lines during a
"refresh feeds" run, while feed-XML failures continue to be reported
(FR-001, FR-003, FR-004, FR-005, FR-006).

**Independent Test**: Stub `fetch` so an article URL returns more than
`MAX_ARTICLE_REDIRECTS` 302s; spy on `console.error` for the duration of
a `UserDO` refresh; assert no spy call matches
`/redirected too many times/i` or `/og image/i`. Stub a feed-XML URL the
same way and assert one `console.error('Error fetching feed …')` line
fires.

### Tests for User Story 1

> Write these tests FIRST. Confirm they FAIL on the current foundational
> state before implementing T010–T011.

- [X] T006 [P] [US1] In `test/feed-fetch-security.ts` update the existing
      redirect-limit test for the article path to expect 6 `fetch` calls
      (initial + 5 redirects) instead of 4, and assert the thrown
      `FeedFetchError` message is `'Article redirected too many times'`
      (research.md R-3, R-6).
- [X] T007 [P] [US1] In `test/feed-fetch-security.ts` add a parallel
      test confirming `fetchFeedText` still caps at 4 calls (initial + 3
      redirects) and still throws
      `FeedFetchError('Feed redirected too many times')`.
- [X] T008 [P] [US1] In `test/feed-parser.ts` add a test that stubs
      `globalThis.fetch` so an article URL returns 302→302→302→302→302→302
      (exceeds `MAX_ARTICLE_REDIRECTS`), runs the `UserDO` refresh path
      that triggers OG enrichment, spies on `console.error`, and asserts
      the spy was NOT called with anything matching
      `/redirected too many times/i` or `/og image/i` (research.md R-6).
- [X] T009 [P] [US1] In `test/feed-parser.ts` add a regression test that
      stubs `globalThis.fetch` so the FEED-XML URL exceeds
      `MAX_FEED_REDIRECTS`, runs the refresh, spies on `console.error`,
      and asserts exactly one error line fires whose message contains
      both `Error fetching feed` and the feed URL — and that the feed
      row's `last_error` is updated (FR-005).

### Implementation for User Story 1

- [X] T010 [US1] In `src/server/feed-fetch.ts` change `fetchOgImage` to
      call `fetchValidatedResponse` with `maxRedirects:
      MAX_ARTICLE_REDIRECTS` and to throw
      `FeedFetchError('Article redirected too many times')` on the cap
      (research.md R-2, R-3). The function must continue to return
      `null` for any caught `FeedFetchError`.
- [X] T011 [US1] In `src/server/durable-objects/index.ts` remove the two
      `console.error('Error fetching og image for …', err)` call sites
      inside `fetchOgImageBeforeDeadline` (the `onError` callback near
      line ~1290 and the outer `catch` near line ~1301). Do NOT replace
      them with a `console.debug` or any other logger — research.md R-4
      says no debug log is added in this change.
- [X] T012 [US1] In `src/server/durable-objects/index.ts` verify (and
      leave unchanged) the existing feed-XML `catch` block that emits
      `console.error("Error fetching feed ${feed.url}", err)` and writes
      `last_error` / `last_status` on the feed row. Add a one-line
      comment ONLY if needed to clarify that this log is intentionally
      retained per FR-005; otherwise leave the block untouched per the
      "default to writing no comments" rule.

**Checkpoint**: A normal "refresh feeds" run produces zero "redirected
too many times" or "Error fetching og image" lines (SC-001), feed-XML
failures still surface against the feed (SC-004), and tests T006–T009
pass. User Story 1 is independently shippable as MVP.

---

## Phase 4: User Story 2 — Thumbnails load for articles with normal redirect chains (Priority: P2)

**Goal**: New items whose article URLs follow up to
`MAX_ARTICLE_REDIRECTS` (5) ordinary redirects end up with a thumbnail
from the article's OpenGraph image; items whose URLs cannot be resolved
still appear with a feed-supplied fallback or no thumbnail (FR-002,
FR-007, SC-002).

**Independent Test**: Stub `fetch` so an article URL returns
302→302→302→200 with HTML containing
`<meta property="og:image" content="…">`. Run the refresh; assert the
inserted item has `thumbnail_url` set to the OG image. Then stub a URL
that returns >5 302s; assert the item is still inserted and is shown
with either the feed-supplied image or `thumbnail_url IS NULL`.

### Tests for User Story 2

- [X] T013 [P] [US2] In `test/feed-parser.ts` add a happy-path test
      that stubs `globalThis.fetch` so the article URL returns 3 302
      hops then 200 with `<meta property="og:image" content="…">`, runs
      the refresh, and asserts the new item row's `thumbnail_url`
      matches the stubbed OG image URL.
- [X] T014 [P] [US2] In `test/feed-parser.ts` add a fallback test where
      the article URL exceeds the article redirect budget but the feed
      XML supplied a `<media:thumbnail>` (or equivalent) image; assert
      the item is inserted with `thumbnail_url` set to the
      feed-supplied image (FR-007 fallback path).
- [X] T015 [P] [US2] In `test/feed-parser.ts` add a "no thumbnail at
      all" test where the article URL exceeds the budget AND the feed
      XML supplied no fallback image; assert the item is still inserted
      with `thumbnail_url IS NULL` and is therefore visible in a
      subsequent `SELECT * FROM items` (FR-007 no-fallback path).

### Implementation for User Story 2

User Story 2's behaviour is delivered entirely by the foundational
change (T003–T005) and the `fetchOgImage` budget bump in T010 — no
additional production code is required. The implementation tasks here
are integration-level verifications that the budget actually unlocks
the previously-failing chains.

- [X] T016 [US2] Run the new tests T013–T015 against the implementation
      from T010 and confirm they pass without further code changes. If
      any fails, the failure indicates a real bug in T010's wiring; fix
      `src/server/feed-fetch.ts` rather than weakening the test.
- [ ] T017 [US2] Manually walk through Quickstart steps 2 and 5
      (`specs/001-fix-og-image-redirects/quickstart.md`) against
      `npm start`, using a real subscribed feed whose items use multi-hop
      article redirects. Confirm thumbnails appear for resolvable
      chains and the refresh completes within the existing
      `OG_IMAGE_FETCH_BUDGET_MS` (10s) for loop items (SC-002, SC-003).
      *(MANUAL — deferred to user; requires real subscribed feed and
      live network access.)*

**Checkpoint**: User Stories 1 AND 2 both pass their independent tests.
≥95% of newly-ingested items in a representative refresh end up with a
thumbnail (SC-002), and a single looping item does not extend total
refresh wall time (SC-003).

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final gates before merge. No new behaviour.

- [X] T018 Run `npm test && npm run lint` and confirm a green run.
      Compare against the T002 baseline; any newly-failing test must be
      fixed (not skipped) before merge.
- [X] T019 Run `npm run typecheck` to confirm
      `src/server/feed-fetch.ts` and `src/server/durable-objects/index.ts`
      still type-check cleanly.
- [X] T020 Re-read the diff for `src/server/feed-fetch.ts` and
      `src/server/durable-objects/index.ts` and confirm: (a) no CSS
      changes, (b) no emoji in code or comments, (c) no logging of
      article URLs at error level, (d) no public type changes, (e) no
      new exports (per contracts/README.md and CLAUDE.md style rules).
- [ ] T021 Walk through Quickstart step 3
      (`specs/001-fix-og-image-redirects/quickstart.md`) manually to
      confirm a feed whose XML loops still surfaces `last_error` /
      `last_status` in the UI and logs exactly one feed-level
      `console.error` line (SC-004 / FR-005).
      *(MANUAL — deferred to user; live network walkthrough.)*

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS both user
  stories: the new constant and `maxRedirects` plumbing must exist
  before either story's tests are meaningful.
- **User Story 1 (Phase 3, P1)**: Depends on Foundational. Independently
  shippable as MVP.
- **User Story 2 (Phase 4, P2)**: Depends on Foundational AND on T010
  from User Story 1 (because T010 is the only place
  `MAX_ARTICLE_REDIRECTS` is actually consumed by `fetchOgImage`). It
  does NOT depend on T011/T012 — log-quietness is independent of
  thumbnail-success — so US2 tests can be authored against T010 alone
  if work is split across developers.
- **Polish (Phase 5)**: Depends on both user stories being complete.

### Within Each User Story

- Write the test tasks (marked [P] within the story) FIRST and confirm
  they FAIL before changing production code (TDD discipline applies
  here per the project's stated style).
- Production code changes follow the test changes.
- All tests for a story must be green before that story's checkpoint.

### Parallel Opportunities

- T006, T007, T008, T009 are all in `test/feed-fetch-security.ts` or
  `test/feed-parser.ts` but live in distinct test blocks; they can be
  authored in parallel by different contributors as long as merges
  preserve each other's `t.test(...)` blocks.
- T013, T014, T015 are all new test blocks in `test/feed-parser.ts` and
  can likewise be authored in parallel.
- T010 (in `src/server/feed-fetch.ts`) and T011 (in
  `src/server/durable-objects/index.ts`) touch different files and can
  be implemented in parallel.

---

## Parallel Example: User Story 1

```bash
# Author all four US1 tests in parallel:
Task: "Update redirect-limit test for article path to expect 6 calls and the new error message in test/feed-fetch-security.ts"
Task: "Add fetchFeedText redirect-limit regression test (still 4 calls, 'Feed redirected too many times') in test/feed-fetch-security.ts"
Task: "Add console.error-quietness test for article overflow in test/feed-parser.ts"
Task: "Add feed-XML loud-failure regression test in test/feed-parser.ts"

# Then implement in parallel:
Task: "Wire MAX_ARTICLE_REDIRECTS into fetchOgImage and switch the cap message to 'Article redirected too many times' in src/server/feed-fetch.ts"
Task: "Drop the two 'Error fetching og image' console.error call sites in src/server/durable-objects/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. STOP and validate: SC-001 (no "redirected too many times" log lines
   for article URLs) and SC-004 (feed-XML errors still visible) hold.
4. This alone resolves the user-reported bug and is shippable.

### Incremental Delivery

1. Foundation (T003–T005) lands.
2. US1 tests + implementation (T006–T012) land — log noise is gone
   (MVP).
3. US2 tests + verification (T013–T017) land — thumbnails recover for
   multi-hop article URLs (SC-002).
4. Polish (T018–T021) gates merge.

### Parallel Team Strategy

After Phase 2 completes:

- Developer A: Phase 3 (US1) — focuses on log-quietness and
  `fetchOgImage` rewiring.
- Developer B: Phase 4 (US2) — focuses on thumbnail-success tests
  against the same `fetchOgImage` change.

Both developers converge in Phase 5 for the final lint/typecheck pass
and quickstart walkthrough.

---

## Notes

- [P] tasks = different files OR distinct, non-overlapping test blocks
  in the same file.
- [Story] label maps each task to the user story it serves.
- Tests precede implementation within each story (research.md R-6).
- Commit after each task or after each logical group (e.g. all four US1
  tests together, then all US1 implementation together).
- Stop at the User Story 1 checkpoint to validate the MVP independently
  before starting User Story 2.
- Avoid: adding a debug log in this change (research.md R-4 explicitly
  rejects it), exposing `maxRedirects` on public option types
  (research.md R-2), changing the feed-XML error wording or path
  (research.md R-5), and any CSS or unrelated edits (CLAUDE.md).
