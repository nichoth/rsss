---
description: "Task list for feature 017-fix-oauth-callback-flash"
---

# Tasks: No flash of login form during OAuth callback

**Input**: Design documents from `/specs/017-fix-oauth-callback-flash/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/oauth-callback-window.md

**Tests**: NOT requested in spec. Per constitution, the verification gate
for this UI lifecycle fix is the manual `quickstart.md` script. No
automated test tasks are generated.

**Organization**: One user story (P1). Tasks are grouped by phase per
the template, with the bulk of work under US1.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1)
- File paths are absolute or repo-relative as shown

## Path Conventions

- Web app (Worker + Preact SPA, single repo). All code under
  `src/client/`. No server-side changes in this feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No project initialization is needed for this feature
(bug fix to an existing SPA). Confirm baseline only.

- [X] T001 Confirm baseline build is green: run `npm run lint` and
      `npx tsc --noEmit` from repo root and verify both pass before
      making any changes (creates a known-good comparison point for
      the post-fix verification in Phase 4).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the single new client signal that every
subsequent task reads. All US1 tasks depend on this existing.

**CRITICAL**: No US1 task can begin until T002 lands.

- [X] T002 Add `oauthInFlight:Signal<boolean>` to the `AppState`
      class in `src/client/state.ts`. Declare the field, initialize
      it inside the `State()` constructor *synchronously* from
      `window.location` using the predicate from
      `data-model.md` §"New entity": `true` iff
      `window.location.pathname === '/oauth/callback'` OR the URL
      carries all three of `code`, `state`, and `iss` query
      parameters; otherwise `false`. Export it on the state instance
      so `index.ts` and `routes/index.ts` can read it. Do NOT yet
      change `handleOAuthCallback` or any render path — this task
      only introduces the signal.

**Checkpoint**: `state.oauthInFlight` exists and is correctly true on
callback URLs / false elsewhere. Verify by adding a temporary
`console.log` and loading both `/` and a fake
`/oauth/callback?code=x&state=y&iss=z` URL; remove the log before
committing.

---

## Phase 3: User Story 1 - Clean return from OAuth provider (Priority: P1) MVP

**Goal**: From the moment the browser returns from the Bluesky
identity provider until the authenticated UI is visible, the user
sees only a non-error loading state — never the login form, never
any error message.

**Independent Test**: Run the happy-path acceptance loop from
`quickstart.md` (10 consecutive successful sign-ins). Zero frames
containing the login form or any error message during any callback
window. Slow-mo pass at 6× CPU + Fast 4G throttle confirms strict
SC-001/SC-002.

### Implementation for User Story 1

- [X] T003 [P] [US1] Create the new neutral loader component at
      `src/client/components/oauth-loader.ts`. Export an
      `OAuthCallbackLoader` Preact component using `htm/preact`
      (match the style of the existing components in
      `src/client/components/`). Render a centred spinner plus the
      microcopy "Signing in…" wrapped in a single root element with
      class `oauth-callback-loader`. Do NOT render the `Header`,
      `footer`, any error region, any form, or any auth-derived
      text. Import this component's CSS from the sibling
      `oauth-loader.css` file (created in T004).

- [X] T004 [P] [US1] Create
      `src/client/components/oauth-loader.css` containing minimal
      styling for the loader. Use only existing CSS variables from
      `src/client/_variables.css` (no new colour or size tokens).
      No font sizes below 1rem (per global CLAUDE.md). Centre the
      spinner + label vertically and horizontally in the viewport.

- [X] T005 [US1] In `src/client/state.ts`, modify the boot path so
      that when `oauthInFlight` was set to `true` in T002, the
      constructor (or its boot helper) `await`s the existing
      `checkAuth()`. Then, per `data-model.md` Lifecycle rows 3-4:
      - if `isAuthenticated.value === true`, run a single `batch`
        that sets `oauthInFlight.value = false` and calls
        `_setRoute('/')`. Return — do NOT call
        `handleOAuthCallback`.
      - else, call `State.handleOAuthCallback(state)` (do not
        await; it manages its own lifecycle).
      Use `import { batch } from '@preact/signals'` per global
      style. Depends on T002.

- [X] T006 [US1] In `src/client/state.ts`, modify
      `State.handleOAuthCallback(state)` to clear stale auth state
      at entry and clear `oauthInFlight` in `finally`. Specifically:
      - At the very top of the function body, run:
        ```ts
        batch(() => {
            state.authError.value = null
            state.authLoading.value = true
        })
        ```
        (replaces any pre-existing single-signal `authLoading = true`
        write at the top.)
      - Wrap the existing body (POST to `/api/auth/callback`,
        `checkAuth`, route decision) in `try { ... } finally { ... }`
        so that on success, sync error, OR async error, the
        `finally` runs:
        ```ts
        batch(() => {
            state.authLoading.value = false
            state.oauthInFlight.value = false
        })
        ```
      Preserve all existing success/error branches inside the `try`
      (the routing decision and any `authError` assignment on
      failure stay where they are). Depends on T002. Same file as
      T005, so cannot run in parallel with T005.

- [X] T007 [US1] In `src/client/index.ts`, add the App shell short-
      circuit. Before the existing `if (!pageReady.value) { ... }`
      block (around lines 55-68 per `research.md`), insert:
      ```ts
      if (state.oauthInFlight.value) {
          return html`<${OAuthCallbackLoader} />`
      }
      ```
      Add the corresponding `import { OAuthCallbackLoader } from
      './components/oauth-loader.js'` (or `.ts` per existing import
      style in this file). This guarantees invariant I2 from
      `data-model.md` (no `LoginPage` render reachable while the
      flag is true). Depends on T002 (signal exists), T003/T004
      (component exists).

- [X] T008 [US1] In `src/client/routes/index.ts`, simplify the
      `/oauth/callback` route action. Per `research.md` Decision 3,
      the handshake is now boot-dispatched in `state.ts`, so the
      route action no longer needs to call `handleOAuthCallback`.
      Replace the body referenced at lines 73-87 with:
      ```ts
      router.addRoute('/oauth/callback', () => {
          if (state.isAuthenticated.value) {
              state._setRoute('/')
              return FeedReader
          }
          return LoginPage
      })
      ```
      The returned `LoginPage` is intentionally a fallback that
      will never actually render while `oauthInFlight` is `true`
      (T007 short-circuits the shell). Depends on T002, T007.

**Checkpoint (US1 happy path)**: After T003-T008, with `npm start`
running, completing a real Bluesky sign-in returns the user to the
authenticated UI with no visible login form or error frames. Spot-
check once before moving on.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Verification, quality gates, and recording the manual
verification result per the constitution.

- [X] T009 Run `npm run lint` from repo root and fix any lint errors
      introduced by T002-T008. Lint settings MUST NOT be changed
      (per global CLAUDE.md).

- [X] T010 Run `npx tsc --noEmit` from repo root and resolve any
      type errors introduced by T002-T008.

- [ ] T011 Execute the full `quickstart.md` script:
      - 10× happy-path sign-ins (SC-001, SC-002, SC-003)
      - 1× slow-mo confirmation pass at 6× CPU + Fast 4G
      - failure-still-works check (SC-004)
      - stale-`authError`-cleared check (FR-002)
      - first-visit unauth check (SC-005)
      - already-authed callback URL refresh edge case
      Each section must pass. If any section fails, stop and fix
      before re-running.

- [ ] T012 Append the PASS block from `quickstart.md` §"What to
      record in `progress.log`" to `progress.log` at repo root,
      with all six items individually confirmed. Do NOT mark this
      task done unless every check in T011 passed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. T001 is a baseline check.
- **Foundational (Phase 2)**: Depends on Setup. T002 BLOCKS all of
  US1 — every other task reads `oauthInFlight`.
- **User Story 1 (Phase 3)**: All tasks depend on T002.
- **Polish (Phase 4)**: Depends on US1 completion.

### Within User Story 1

- T003 and T004 are independent (different files, both purely
  additive new files) → run in parallel.
- T005 and T006 both edit `src/client/state.ts` → must be
  sequential. T005 then T006 (or T006 then T005, but not both at
  once).
- T007 (`src/client/index.ts`) depends on T002 (signal) AND T003/T004
  (component import). Cannot start until T003 and T004 are done.
- T008 (`src/client/routes/index.ts`) depends on T002 and on T007
  (because it relies on the shell short-circuiting; otherwise the
  fallback `LoginPage` it returns *would* render).

### Within Polish

- T009 and T010 are independent quality gates → can run in parallel.
- T011 depends on T009 and T010 passing (don't manually verify a
  build that doesn't lint/typecheck).
- T012 depends on T011 passing.

---

## Parallel Example: User Story 1

```bash
# After T002 lands, T003 and T004 can be written in parallel
# (different new files, no dependency between them):
Task: "Create src/client/components/oauth-loader.ts"
Task: "Create src/client/components/oauth-loader.css"
```

T005 and T006 cannot run in parallel — both edit `state.ts`.

---

## Implementation Strategy

### MVP First (User Story 1 = the entire feature)

1. Phase 1: T001 (baseline green check).
2. Phase 2: T002 (signal in place).
3. Phase 3: T003/T004 in parallel → T005 → T006 → T007 → T008.
4. Phase 4: T009/T010 in parallel → T011 → T012.

This is a single-story bug fix; there is no incremental delivery
beyond "fix lands or it doesn't". Stop and validate at the
checkpoint after T008 before running the full quickstart in T011.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- All US1 tasks share the [US1] label per the format requirement.
- Constitution gate: T011 + T012 (manual verification + recorded
  PASS) is non-optional for shipping this fix — type-check and
  lint alone do not prove a UI lifecycle bug is fixed.
- Avoid scope creep: this feature touches exactly four files and
  adds two. Do not refactor adjacent code paths (per global
  CLAUDE.md "no unrelated changes").
