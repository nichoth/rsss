---
description: "Task list for feature 016 — Fix Dev Server FOUC and Vite Dynamic-Import Warning"
---

# Tasks: Fix Dev Server FOUC and Vite Dynamic-Import Warning

**Input**: Design documents from `/specs/016-fix-dev-server-fouc/`
**Prerequisites**: plan.md (required), spec.md (required), research.md,
data-model.md, contracts/README.md, quickstart.md

**Tests**: Tests are explicitly requested by the spec (FR-008, FR-009 ask
for regression guards). Two test artifacts are produced:
extension to `test/lazy-html.ts` (US1 dev gate) and a new
`test/server-import-shape.ts` (US2 import shape).

**Organization**: Tasks are grouped by user story so each can be
implemented and validated independently. The two stories touch
different sites in the same file (`src/server/index.ts`) but are
otherwise decoupled — see Decision 1 and Decision 2 in `research.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete deps)
- **[Story]**: US1 (dev FOUC + wrong-route fix) or US2 (Vite warning fix)
- File paths are absolute relative to the repo root

## Path Conventions

Web app layout from `plan.md`: `src/server/`, `src/client/`,
`src/shared/`, `test/` at repo root. Only `src/server/` is touched in
this feature. Tests land under `test/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Capture the pre-fix baseline so regressions are easy to
attribute later. No new dependencies, no project scaffolding, no
config changes.

- [ ] T001 Reproduce both reported symptoms on a clean checkout of
      `016-fix-dev-server-fouc` before any code change: run
      `npm start`, confirm the Vite warning appears in the terminal
      (search output for `dynamic import` /
      `cannot be analyzed`), then visit `http://127.0.0.1:2222/login`
      while authenticated and observe the unstyled flash + wrong-route
      article markup. Record the exact warning text and a brief note
      of frame timing in scratch notes (do not commit). This is the
      baseline the fix must remove.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None for this feature. Per `data-model.md`, no entities,
no schemas, no shared infrastructure are introduced. The two stories
share only a source file (`src/server/index.ts`), and that sharing is
sequenced via task ordering inside each story rather than via a
foundational phase.

(intentionally empty — proceed directly to Phase 3)

---

## Phase 3: User Story 1 - Dev page load shows styled content quickly (Priority: P1) MVP

**Goal**: Eliminate the dev-server FOUC and the wrong-route content
flash. After this story, hard-reloading any top-level route in the
dev server paints either blank/loading or the styled destination
route — never unstyled markup, never article markup at `/login`.

**Independent Test**: With the dev server running and authenticated,
hard-reload `http://127.0.0.1:2222/login` (Cmd+Shift+R). Watch the
DevTools Performance tab frame strip from navigation start to FCP.
No frame shows browser-default link blue / unstyled markup; no frame
shows article items while the URL is `/login`. Equivalently, every
visible frame is either blank/loading or the login UI styled.

### Tests for User Story 1 (regression guard for FR-009)

> Write the test BEFORE wiring the gate into `src/server/index.ts`, so
> the test fails until the helper exists and passes once it does.

- [ ] T002 [US1] Extend `test/lazy-html.ts` with two `tapzero` test
      cases asserting the dev-gating predicate contract from
      `specs/016-fix-dev-server-fouc/contracts/README.md` Contract 1:
      (a) `shouldSkipLazyHtml({ dev: true })` returns `true`,
      (b) `shouldSkipLazyHtml({ dev: false })` returns `false`. Import
      from the helper module chosen in T003 (likely
      `../src/server/lazy-html.js`). Run `npm test` and confirm the
      new cases fail with a "missing export" error before T003 lands.

### Implementation for User Story 1

- [ ] T003 [US1] Add the pure helper
      `export function shouldSkipLazyHtml (args:{ dev:boolean }):
      boolean { return args.dev }` to `src/server/lazy-html.ts` (the
      module already imported by `test/lazy-html.ts`, so the test
      from T002 can resolve it without a new file). The helper MUST
      NOT read `import.meta`, `process`, or any ambient state —
      Contract 1 invariant 3. After this lands, re-run `npm test`
      and confirm T002's cases pass.

- [ ] T004 [US1] Wire the gate into `src/server/index.ts` inside the
      catch-all asset handler (`app.all('*')`, ~line 1467-1487).
      Immediately after the `c.env?.ASSETS` guard and BEFORE any
      access to `did`, `c.env.HTML_KV`, or `c.env.USER_DO`, call
      `shouldSkipLazyHtml({ dev: import.meta.env.DEV })`; when it
      returns `true`, return `c.env.ASSETS.fetch(c.req.raw)`
      immediately. Add the import for `shouldSkipLazyHtml` from
      `./lazy-html.js` (or the chosen path from T003) at the top of
      the file alongside other server-internal imports. Do not change
      the production branch — the existing lazy-HTML seeding code
      stays exactly as it is below the new gate.

- [ ] T005 [US1] Manual verification of US1 against
      `specs/016-fix-dev-server-fouc/quickstart.md` sections B
      (no unstyled flash) and C (no wrong-route content). Run the
      dev server fresh, authenticate, hard-reload `/`, `/login`, and
      one feed-detail route. Confirm every visible frame is either
      blank/loading or styled, and `/login` never shows article
      markup. Record any frame that fails the criterion and fix
      before checkpointing.

**Checkpoint**: User Story 1 is complete. Dev FOUC and wrong-route
flash are gone. Vite still warns about the dynamic import — that is
US2's territory and is not blocking US1's checkpoint.

---

## Phase 4: User Story 2 - Dev server starts without spurious warnings (Priority: P2)

**Goal**: Eliminate the Vite "dynamic import will not be moved to a
separate chunk" warning by rewriting the un-analyzable
`await import(blurhashRuntimeModule)` at `src/server/index.ts:1493`
as a literal `await import('./blurhash-runtime.js')`. Lazy-load
semantics are preserved — Vite still cleaves a separate chunk for
any literal `import(...)`.

**Independent Test**: Stop the dev server. Restart with `npm start`
on a clean terminal. From the first line through "ready," there is
no occurrence of the strings `dynamic import` or
`cannot be analyzed by Vite` attributable to a file under `src/`.
Trigger one normal page load — still no such warning. Build with
`npm run build` and confirm a `blurhash-runtime`-named chunk exists
under `public/_worker.js/` (proves Vite still cleaves the lazy
chunk). This story is independently testable: the warning is gone
and the lazy chunk is intact, regardless of US1's status.

### Tests for User Story 2 (regression guard for FR-008)

> Write the test BEFORE rewriting the import. The test fails until
> the variable form is replaced with a literal.

- [ ] T006 [P] [US2] Create a new test file
      `test/server-import-shape.ts` that implements Contract 2 from
      `specs/016-fix-dev-server-fouc/contracts/README.md`:
      using `node:fs` + a recursive walk of `src/server/`, collect
      every `.ts` file, and for each file run a regex (or AST scan
      via the existing TypeScript dependency if simpler) over the
      source asserting that no `import(<expr>)` /
      `await import(<expr>)` site has a bare-identifier argument.
      Allowed forms: string literals
      (`'./blurhash-runtime.js'`, `"@scope/pkg"`) and template
      literals with no `${...}` interpolations. Use the existing
      `@substrate-system/tapzero` test runner the way other tests
      under `test/` do (see `test/lazy-html.ts:1`). Run `npm test`
      before T007 and confirm the test FAILS at
      `src/server/index.ts:1493`.

### Implementation for User Story 2

- [ ] T007 [US2] In `src/server/index.ts`: (a) delete the
      `const blurhashRuntimeModule = './blurhash-runtime.js'`
      declaration at ~line 1489, (b) inline the literal at the
      import site at ~line 1493 so the call reads
      `await import('./blurhash-runtime.js')` (preserve the
      `as typeof BlurhashRuntime` cast and surrounding code).
      Re-run `npm test` and confirm T006's test now passes.

- [ ] T008 [US2] Manual verification of US2 against
      `specs/016-fix-dev-server-fouc/quickstart.md` section A. Stop
      and restart the dev server cleanly; grep the terminal output
      for `dynamic import` and `cannot be analyzed` — both must
      yield zero matches. Then `npm run build` and run
      `find public -type f -name '*.js' | sort | grep blurhash` —
      a `blurhash-runtime`-prefixed chunk MUST appear, confirming
      FR-005 (lazy-load preserved). This step covers Quickstart A
      and D in one pass.

**Checkpoint**: User Story 2 is complete. Vite warning gone, lazy
chunk verified.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Production-parity check, full test/lint pass, and the
production-side smoke required by SC-005 / FR-006.

- [ ] T009 Production parity smoke against
      `specs/016-fix-dev-server-fouc/quickstart.md` section E. Build
      the worker (`npm run build`), inspect `public/_worker.js/index.js`
      to confirm the dev branch added in T004 is dead-code-eliminated
      (search for the `shouldSkipLazyHtml` call site or for a literal
      `false` collapse where `import.meta.env.DEV` was substituted).
      If a staging deploy is available, deploy and hard-reload the
      home route while authenticated; the seeded feed-item markup
      MUST still paint with full styling on first frame, identical
      to feature 015's behavior.

- [ ] T010 Run `npm test && npm run lint` from repo root and confirm
      both pass cleanly. The new test cases from T002 and the new
      file `test/server-import-shape.ts` from T006 must be included
      in the run. No lint warnings on the modified
      `src/server/index.ts` or `src/server/lazy-html.ts`.

- [ ] T011 Final manual sweep through every numbered acceptance
      scenario in `specs/016-fix-dev-server-fouc/spec.md` (US1
      scenarios 1-4, US2 scenarios 1-3) and every Edge Case bullet,
      ticking each off against the implemented behavior. If any
      scenario is not satisfied, file a defect and re-open the
      relevant story phase rather than ship partial.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: independent — capture baseline first.
- **Foundational (Phase 2)**: empty for this feature.
- **User Story 1 (Phase 3)**: depends only on Setup.
- **User Story 2 (Phase 4)**: depends only on Setup. Independent of
  US1 in principle; see "Within-file ordering" below.
- **Polish (Phase 5)**: depends on US1 and US2 both complete.

### User Story Dependencies

- **US1 (P1)** ↔ **US2 (P2)**: logically independent. US1 does not
  depend on US2's import rewrite; US2 does not depend on US1's gate.
  Either could ship alone and deliver its own user-visible
  improvement.

### Within Each User Story

- US1: T002 (failing test) → T003 (helper) → T004 (gate at call
  site) → T005 (manual verify). T002 must precede T003 because the
  test is the contract; T003 must precede T004 because the gate
  imports the helper.
- US2: T006 (failing test) → T007 (literal rewrite) → T008 (manual
  verify).

### Within-file ordering

US1 and US2 both edit `src/server/index.ts` (different line ranges:
~1467-1487 for US1, ~1489-1495 for US2). The edits do not overlap,
but to keep diffs reviewable and avoid merge friction during
implementation, complete US1 fully (T002→T005) before starting US2
(T006→T008). This ordering also matches the priority order in the
spec.

### Parallel Opportunities

- Within a single story, parallelism is limited because each story
  is small and most tasks share `src/server/index.ts`.
- T006 (creating `test/server-import-shape.ts`) is marked [P]
  because it is a wholly new file with no dependency on US1 work —
  it could be drafted in parallel with US1's tests if a second
  developer is available, though it cannot pass until T007 lands.
- T002 cannot be marked [P] because it edits `test/lazy-html.ts`,
  which other US1 tasks may also touch if conventions evolve.
- T009, T010, T011 are sequenced (build → test → manual sweep)
  rather than parallel, because each builds confidence on the
  previous one.

---

## Parallel Example

```bash
# If two developers are working: one starts US1, the other drafts
# US2's test file. Implementation in src/server/index.ts must still
# be serialized to keep diffs reviewable.
Developer A: T002 → T003 → T004 → T005   # US1 end-to-end
Developer B: T006 (failing test only)    # US2 test, can wait on A
                                          # before T007 lands
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001): capture baseline.
2. Phase 3 (T002→T005): ship the dev gate.
3. STOP and VALIDATE: dev FOUC and wrong-route flash are gone. Vite
   warning still emitted but harmless. Optionally release / merge
   here as the MVP increment.

### Incremental Delivery

1. T001 (baseline) → US1 (T002-T005) → demo: dev FOUC fixed.
2. US2 (T006-T008) → demo: terminal is clean.
3. Polish (T009-T011) → ship.

### Parallel Team Strategy

Single-developer work is the realistic mode here — both stories are
tiny, and the file ownership is concentrated. The Parallel Example
above is the only meaningful concurrency.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- US1 and US2 share `src/server/index.ts` — serialize edits to that
  file even though the stories are logically independent.
- Tests are required (FR-008, FR-009) and must fail before their
  respective implementation tasks land.
- After each story checkpoint, commit before moving on. The
  feature's git hooks already prompt for a commit between phases.
- Quickstart sections A-E from
  `specs/016-fix-dev-server-fouc/quickstart.md` map to: A→T008,
  B→T005, C→T005, D→T008, E→T009. T011 is the final cross-cutting
  sweep over the spec's acceptance scenarios, not a re-run of the
  quickstart.
