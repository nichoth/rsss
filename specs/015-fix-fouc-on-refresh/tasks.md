---

description: "Task list for 015-fix-fouc-on-refresh"
---

# Tasks: Fix Flash of Unstyled Content on Page Refresh

**Input**: Design documents from
`/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/README.md, quickstart.md

**Tests**: Spec FR-007 explicitly requests "some form of automated
detection (a check, test, or recorded baseline) that fails when a
page refresh once again paints unstyled content." Test tasks below
satisfy that requirement; they are NOT optional for this feature.

**Organization**: Two user stories from spec.md.
- US1 (P1): Refresh shows styled content immediately on the feed view.
- US2 (P2): Other entry points are also FOUC-free.

The single source `index.html` change is the load-bearing fix; both
US1 and US2 are satisfied by the same edit. The lazy-HTML cache-key
bump is grouped with US1 because the feed view is the only seeded
path that actually exercises the cache today, but it transparently
benefits US2 as well (all routes flow through the same handler when
authed). US2's tasks are therefore predominantly verification.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on
  incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2). Setup,
  Foundational, and Polish phases have no story label.
- All file paths are absolute.

## Path Conventions

This is a web app per `plan.md`. Source lives at
`/Users/nick/code/rsss/src/client/` and
`/Users/nick/code/rsss/src/server/`; tests at
`/Users/nick/code/rsss/test/`; the entry HTML at
`/Users/nick/code/rsss/index.html`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm a clean baseline before changing anything. No
new dependencies, no scaffolding — the project is already wired.

- [ ] T001 Capture the pre-fix state by running `npm start` and
  visiting `http://127.0.0.1:2222/` while signed in; confirm the
  visible FOUC matches the screenshot in
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/spec.md`
  (browser-default blue underlined links over a white background on
  the seeded feed markup). Then run `npm test && npm run lint` from
  `/Users/nick/code/rsss/` and confirm a clean baseline before any
  edits.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Empty for this feature. The fix introduces no new
schema, no new framework, no new shared module. Both user stories
can begin immediately after Phase 1.

*(No tasks in this phase.)*

**Checkpoint**: User-story implementation can begin.

---

## Phase 3: User Story 1 — Refresh shows styled content immediately on the feed view (Priority: P1) MVP

**Goal**: The first painted frame after a page refresh on the feed
view shows the app's stylesheet applied — no period of browser-default
styles. Holds on warm cache, cold cache, slow-3G, and hard reload.

**Independent Test**: With `npm start` running and a signed-in user
viewing the feed view at `http://127.0.0.1:2222/`, refresh the page
under each of: warm cache (Cmd+R), cold cache (DevTools "Disable
cache"), Slow 3G throttle, and hard reload (Cmd+Shift+R). The first
visible frame is app-styled in every case (per
`/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/quickstart.md`
section A.2–A.5).

### Tests for User Story 1 (FR-007 regression guard)

> **NOTE: Write these tests FIRST. They MUST fail against the
> pre-fix tree (T002 fails because `index.html` has no `<link>`;
> T004 fails because `buildLazyHtmlCacheKey` returns `html:...`
> without the `v2:` segment) and MUST pass after the implementation
> tasks (T005, T006).**

- [X] T002 [P] [US1] Create
  `/Users/nick/code/rsss/test/shell-html.mjs` — a plain node script
  matching the pattern of
  `/Users/nick/code/rsss/test/vite-build-inputs.mjs` (uses
  `node:fs` and `node:assert/strict`, no TAP output). It reads
  `/Users/nick/code/rsss/index.html` and asserts: (1) the file
  contains a `<link rel="stylesheet" href="...">` element; (2) the
  match is positioned inside `<head>` (its character offset is
  greater than the offset of `<head>` and less than the offset of
  `</head>`); (3) the offset of the first `<link rel="stylesheet">`
  is strictly less than the offset of the first `<script>` tag in
  the document. These three invariants are the build-artifact
  contract recorded at
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/contracts/README.md`.

- [X] T003 [P] [US1] Wire the new test into the project's runner.
  Edit `/Users/nick/code/rsss/test/run-all-tests.mjs` to add
  `'node test/shell-html.mjs'` to the `commands` array (group it
  with the other static `node test/*.mjs` checks near the top of
  the array, e.g. next to `'node test/vite-build-inputs.mjs'`).
  No `package.json` script alias is required — `test/run-all-tests.mjs`
  is invoked by `npm test` directly.

- [X] T004 [P] [US1] Extend
  `/Users/nick/code/rsss/test/lazy-html.ts` with one new tapzero
  test: import `buildLazyHtmlCacheKey` from
  `'../src/server/lazy-html.js'`, call it with a representative
  `(did, version)` pair (e.g. `'did:plc:test'`, `7`), and assert the
  returned string starts with the literal `'html:v2:'`. This locks
  the schema-version forward per
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/data-model.md`
  ("Cache key (after this fix)") and
  `contracts/README.md` ("Lazy-HTML cache key contract").

### Implementation for User Story 1

- [X] T005 [US1] Edit `/Users/nick/code/rsss/index.html`. Add a
  single new child of `<head>`:
  `<link rel="stylesheet" href="/src/client/style.css">`. Place
  it **before** the existing
  `<script type="module" src="/src/client/index.ts"></script>` so
  the build-artifact contract invariant (link offset < first
  script offset) holds. Do NOT remove the existing `import
  './style.css'` from
  `/Users/nick/code/rsss/src/client/index.ts:12` — it is kept for
  HMR ergonomics in dev (Vite dedupes; rationale in
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/research.md`
  Decision 1, point 4).

- [X] T006 [US1] Edit `/Users/nick/code/rsss/src/server/lazy-html.ts`.
  In `buildLazyHtmlCacheKey` change the returned string from
  `` `html:${did}:${version}` `` to
  `` `html:v2:${did}:${version}` ``. This is a single-line edit
  inside the existing function body — no signature change, no new
  exports. Cache invalidation rationale is in
  `research.md` Decision 2; the schema rolls forward as documented
  in `data-model.md` ("HTML_KV cache entries").

### Verification for User Story 1

- [X] T007 [US1] From
  `/Users/nick/code/rsss/`, run `npm test`. The new
  `test/shell-html.mjs` runs as part of the static-checks group and
  must pass; the extended `test/lazy-html.ts` runs as part of the
  bundled tapout group and must pass; the rest of the suite must
  still pass (no regressions).

- [ ] T008 [US1] Manually exercise the spec's User Story 1
  Acceptance Scenarios on the feed view (`/`) per
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/quickstart.md`
  section A.2–A.5: warm Cmd+R, DevTools "Disable cache" reload,
  Slow-3G-throttled reload, and hard Cmd+Shift+R reload. The first
  visible frame must be app-styled in every case. If any frame is
  painted before the stylesheet applies under Slow 3G, that frame
  must be empty/blank rather than the seeded feed markup with
  browser defaults (FR-001, FR-002, Edge Case 1).

**Checkpoint**: User Story 1 is fully implemented and independently
testable. The MVP cut of this feature could ship from here.

---

## Phase 4: User Story 2 — Other entry points are also FOUC-free (Priority: P2)

**Goal**: The same first-frame-styled guarantee applies to every
top-level route the SPA exposes, not just the feed view.

**Independent Test**: Repeat User Story 1's reload scenarios on each
top-level route reachable by direct URL (about, settings, item
reader, terms, privacy, signup, login, payment-success). Each route
paints app-styled on the first visible frame.

**Note**: No new code is required for this story — the
`index.html` shell change in T005 is shared infrastructure that
applies to every route, and the cache-key bump in T006 covers cached
hits for every route too. Phase 4 is purely verification of US2's
acceptance criteria.

### Implementation for User Story 2

*(No code tasks. The shell `<link>` change in T005 already covers
every top-level route because every route is served from the same
`index.html` shell, and the lazy-HTML handler relays the shell
verbatim — `src/server/lazy-html-handler.ts:60-73` — to authed users
on every route.)*

### Verification for User Story 2

- [ ] T009 [US2] Manually exercise the spec's User Story 2
  Acceptance Scenarios in **dev mode** (`npm start`) per
  `/Users/nick/code/rsss/specs/015-fix-fouc-on-refresh/quickstart.md`
  section A.6. Repeat the four reload scenarios from T008 on each
  of: `/about`, `/settings`, an item route (`/post/...`), `/terms`,
  `/privacy`, `/signup`, `/login`, `/payment-success`. Confirm
  app-styled first paint on every route in every reload mode. Cover
  both authenticated and unauthenticated routes (FR-001, US2
  Acceptance Scenario 1, spec Edge Case "Authenticated vs
  unauthenticated routes").

- [ ] T010 [US2] Manually exercise the same scenarios in a
  **production-like build** per `quickstart.md` section B. Run
  `npm run build` from `/Users/nick/code/rsss/`, then `npx wrangler
  dev` (or push to a preview environment), and repeat the route
  matrix from T009. Hit each route twice in quick succession to
  exercise both the cold-cache write path and the cached lazy-HTML
  read path under the new `html:v2:<did>:<feed-version>` key
  (`quickstart.md` section B.3). The second hit must paint
  app-styled on the first frame too — confirming the cached HTML
  carries the new `<link>` (FR-005).

**Checkpoint**: Both User Stories are implemented and independently
verified.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final quality checks per the spec's Success Criteria
and Edge Cases that span both stories. These run after the two
story phases are complete.

- [X] T011 [P] Run `npm run lint` from `/Users/nick/code/rsss/` and
  confirm it passes.

- [X] T012 [P] Run `npm run typecheck` from `/Users/nick/code/rsss/`
  and confirm it passes.

- [ ] T013 Manually verify SC-002 (TTFCP regression ≤10%) per
  `quickstart.md` "Sanity-check expectations". Run a Lighthouse
  Performance audit on the feed route against `git stash`'d pre-fix
  state, then against the post-fix state, both on the same network
  profile. Time-to-first-contentful-paint must be neutral-to-faster.

- [ ] T014 Manually verify the stylesheet-failure degraded mode per
  `quickstart.md` section C and spec Edge Case 2. Block the
  stylesheet's network response in DevTools (right-click the CSS
  request → "Block request URL"), reload, confirm the page is still
  readable. The fix must not make this case worse than it is today.

- [ ] T015 Manually verify reduced-motion / prefers-color-scheme
  per `quickstart.md` section D and spec Edge Case 4. Toggle the
  OS-level `prefers-reduced-motion` and `prefers-color-scheme`,
  reload the feed view, confirm the first painted frame already
  honors the user's preference (no flash where the wrong scheme
  paints first).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No code dependencies. Captures baseline.
- **Foundational (Phase 2)**: Empty. No blocking work.
- **User Story 1 (Phase 3)**: Begins after Phase 1.
- **User Story 2 (Phase 4)**: Depends on T005 (the shell change)
  and T006 (the cache-key bump) being complete. T009 and T010 are
  pure verification of code that ships in Phase 3, so they are
  ordered after Phase 3 even though no US2 code is added.
- **Polish (Phase 5)**: Depends on Phase 3 and Phase 4.

### Within Phase 3 (User Story 1)

- T002, T003, T004 are tests written first (TDD per FR-007). They
  are independent of each other (three different files); run in
  parallel.
- T005 and T006 implement the change. They edit different files
  and have no order dependency between them; can run in parallel,
  but each one must come **after** the test it makes pass: T005
  unblocks T002; T006 unblocks T004; T003 is purely a runner-wiring
  change and is unblocked from the start.
- T007 (run `npm test`) depends on T002, T003, T004, T005, T006.
- T008 (manual browser verification) depends on T005 (the dev
  server must serve the patched HTML) and T006 (so the lazy HTML
  cache miss fills under the new key). T008 does not depend on the
  test tasks.

### Within Phase 4 (User Story 2)

- T009 and T010 are independent manual checks (different
  environments: dev vs. prod-like build). Both depend on T005 and
  T006 from Phase 3. T010 additionally depends on `npm run build`
  succeeding.

### Within Phase 5 (Polish)

- T011 and T012 are independent shell commands; run in parallel.
- T013, T014, T015 are sequential manual browser sessions on the
  same dev server; run sequentially in any order.

### Parallel Opportunities

- **Within Phase 3**: T002 [P], T003 [P], T004 [P] all run in
  parallel (three different files: `test/shell-html.mjs`,
  `test/run-all-tests.mjs`, `test/lazy-html.ts`).
- **Within Phase 5**: T011 [P], T012 [P] run in parallel.

---

## Parallel Example: Phase 3 tests

```bash
# Three test-authoring tasks in parallel — different files,
# zero shared state.
Task: "Create test/shell-html.mjs (T002)"
Task: "Wire test/shell-html.mjs into test/run-all-tests.mjs (T003)"
Task: "Extend test/lazy-html.ts with v2: prefix assertion (T004)"
```

Once those complete and fail (TDD red), apply the implementation
edits in T005 and T006 (also independent files; can be parallel).
Then run T007 to confirm the suite goes green.

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (T001): capture baseline.
2. Phase 3 tests (T002, T003, T004) — write and watch them fail.
3. Phase 3 implementation (T005, T006) — apply the two edits.
4. Phase 3 verification (T007, T008) — full suite green; manual
   FOUC-free first paint confirmed on the feed view.
5. **STOP and validate.** This is a shippable MVP that fixes the
   user-reported bug on the most-refreshed surface.

### Incremental Delivery

1. Ship the MVP after T008.
2. Run Phase 4 (T009, T010) to confirm the same fix carries every
   non-feed route, in both dev and prod-like build paths. This is
   verification-only — there is no second deploy required.
3. Run Phase 5 (T011–T015) for the SC-002 / Edge-Case sweep.

### Solo / single-developer flow

The change set is small (two source files, two test files). A
realistic ordering for one developer is: T001 → T002 → T004 → T005
→ T006 → T003 (wire the runner) → T007 → T008 → T009 → T010 →
T011/T012 → T013 → T014 → T015. Total real edits: four files.

---

## Notes

- [P] tasks = different files, no order dependencies.
- [Story] label maps each task to US1 or US2 for traceability.
- T002 and T004 are TDD-red tests: they MUST fail before T005 / T006
  land, and MUST pass after. Verifying the red state is part of
  the value of the test (it proves the assertion is real).
- The single source-of-truth `<link>` lives in
  `/Users/nick/code/rsss/index.html`. Keep the existing
  `import './style.css'` in
  `/Users/nick/code/rsss/src/client/index.ts:12` — do not remove it
  (HMR ergonomics; Vite dedupes; covered in `research.md` Decision
  1).
- Never modify CSS unrelated to this task (per
  `/Users/nick/.claude/CLAUDE.md`). The fix is delivery-mechanism
  only; no rule, no selector, no variable changes.
- Do not write tests that assert specific user-facing text content
  in HTML (per the project's testing rules); the regression guard
  asserts on the *shape* of the entry HTML, not on rendered text.
