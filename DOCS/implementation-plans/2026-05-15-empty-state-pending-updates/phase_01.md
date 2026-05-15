# Empty-state pending-updates Implementation Plan — Phase 1

**Goal:** Introduce a self-contained `PendingUpdateEmptyState` Preact
component that renders an "N pending update(s)" message and a "Click to
refresh" button, owning its own in-flight busy flag so the button can
disable and relabel while an awaited callback is pending.

**Architecture:** Stateless from the caller's perspective: parent passes
`count:number` and `onRefresh:() => Promise<void>`. The component owns one
local `useSignal<boolean>(false)` busy flag, awaits `onRefresh()` on click,
and resets the flag in a `finally` so it survives both success and
failure. Pluralization is handled by a tiny pure helper that can be tested
without DOM.

**Tech Stack:** TypeScript, Preact, `@preact/signals` (`useSignal`),
`htm/preact`, `@substrate-system/tapzero` (tests).

**Scope:** Phase 1 of 2 from
`/Users/nick/code/rsss/docs/design-plans/2026-05-15-empty-state-pending-updates.md`.

**Codebase verified:** 2026-05-15.

**Branch:** `empty-state-pending-updates` (based on `origin/staging`).

---

## Acceptance Criteria Coverage

This phase implements and tests:

### empty-state-pending-updates.AC1: Pending-update component renders correctly
- **empty-state-pending-updates.AC1.1 Success:** With `count=1`, the component
  renders "1 pending update" (singular) and a "Click to refresh" button.
- **empty-state-pending-updates.AC1.2 Success:** With `count=50`, the component
  renders "50 pending updates" (plural) and a "Click to refresh" button.
- **empty-state-pending-updates.AC1.3 Success:** Clicking the button invokes
  the `onRefresh` callback exactly once.
- **empty-state-pending-updates.AC1.4 Edge:** With `count=0`, the parent does
  not render this component (the component itself is not required to handle
  zero — that's the caller's contract). _Phase 1 honors this contract; the
  count=0 branching is verified in Phase 2._

### empty-state-pending-updates.AC2: Button in-flight state
- **empty-state-pending-updates.AC2.1 Success:** While the awaited
  `onRefresh()` promise is pending, the button is disabled and its label
  reads "Refreshing…".
- **empty-state-pending-updates.AC2.2 Success:** When `onRefresh()` resolves,
  the button re-enables and the label reverts to "Click to refresh".
- **empty-state-pending-updates.AC2.3 Failure:** When `onRefresh()` rejects,
  the busy flag clears and the button re-enables (label reverts) so the
  user can retry. The component does not surface an inline error message.

---

## Codebase context (for the implementor)

You have zero prior context. Quick orientation:

- Components live in `src/client/components/`. Files are kebab-case
  `.ts` (no `.tsx`). Each component imports its own `.css` next to it
  when it needs styles.
- Canonical component shape (see `src/client/components/dot.ts` for a
  minimal example, `src/client/components/sidebar-footer.ts` for a
  state-consuming example):
  - Named export.
  - `FunctionComponent<{ ...props }>` type from `'preact'`.
  - `import { html } from 'htm/preact'` (both `'htm/preact'` and
    `'htm/preact/index.js'` appear in-repo; either is fine, prefer
    `'htm/preact'`).
- Component-local state uses `useSignal<T>(initial)` from
  `'@preact/signals'`. See `src/client/components/button.ts:4,20` for a
  precedent.
- The project-wide `.empty-state` class is already defined at
  `src/client/style.css:324-328` (centered text, secondary color). Reuse
  this wrapper class — no new CSS file is required for this component.
- The existing button styling in the items header
  (`src/client/routes/feed-reader.ts:122-128, 158-163`) uses classes
  `btn btn-small`. Reuse those for the refresh button.
- `npm test` runs all tests via `node test/run-all-tests.mjs`. Lint
  via `npm run lint`. Both must pass before commit.
- Project house-style (from `/Users/nick/.claude/CLAUDE.md`):
  - 80-column lines.
  - No space between `:` and type annotation (`count:number`,
    not `count: number`).
  - Ternaries are line-broken with branches indented (see CLAUDE.md
    examples).
  - Use `batch()` from `'@preact/signals'` when setting multiple signals
    sequentially.
  - **Tests must not assert specific text content of HTML.** Use
    structural assertions (presence/absence of elements, attribute
    values, callback invocation counts) and test pluralization logic via
    a separate pure helper.

---

## Tasks

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Pluralization helper

**Verifies:** empty-state-pending-updates.AC1.1, empty-state-pending-updates.AC1.2

**Files:**
- Create: `src/client/components/pending-update-empty-state.ts`
  (initial scaffold — exports only the helper for now;
  component lands in Task 2)
- Test: `test/pending-update-empty-state.ts` (unit, tapzero)

**Implementation:**

Add a pure exported function `pendingUpdateLabel(count:number):string` to
`src/client/components/pending-update-empty-state.ts` that returns:
- `"1 pending update"` when `count === 1`
- `"<count> pending updates"` otherwise (including 0, negatives, etc.)

The function takes a `number` and returns a `string`. No signals, no DOM,
no side effects. Project house-style: `count:number` (no space before
type), 80-column lines, no comments unless the WHY is non-obvious.

**Testing:**

Create `test/pending-update-empty-state.ts`. Use the standard pattern from
`test/dot.ts` (see file in repo for exact import/structure). The pure
helper is plain — call it and assert the return value with `t.equal`.
Tests must verify each AC listed above:

- empty-state-pending-updates.AC1.1: `pendingUpdateLabel(1)` returns
  `"1 pending update"`.
- empty-state-pending-updates.AC1.2: `pendingUpdateLabel(50)` returns
  `"50 pending updates"`. Also add a `pendingUpdateLabel(2)` and
  `pendingUpdateLabel(0)` case to lock down the plural branch for
  small and edge values.

These three assertions are string-equality on a pure function's return
value — they are NOT HTML content assertions and do not violate the
"don't test specific HTML text content" rule.

**Verification:**

Run: `npm test`
Expected: New pluralization tests pass; existing test suite still passes.

Run: `npm run lint`
Expected: No new lint errors.

**Commit:**

```bash
git add src/client/components/pending-update-empty-state.ts \
        test/pending-update-empty-state.ts
git commit -m "feat(empty-state): add pendingUpdateLabel pluralization helper"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: PendingUpdateEmptyState component

**Verifies:** empty-state-pending-updates.AC1.3,
empty-state-pending-updates.AC2.1,
empty-state-pending-updates.AC2.2,
empty-state-pending-updates.AC2.3

**Files:**
- Modify: `src/client/components/pending-update-empty-state.ts` (extend
  the file created in Task 1 by adding the component below the helper)
- Modify: `test/pending-update-empty-state.ts` (extend with component
  tests below the helper tests from Task 1)

**Implementation:**

Add a named export `PendingUpdateEmptyState`:

```ts
import { type FunctionComponent } from 'preact'
import { useSignal } from '@preact/signals'
import { html } from 'htm/preact'

export const PendingUpdateEmptyState:FunctionComponent<{
    count:number;
    onRefresh:() => Promise<void>;
}> = function PendingUpdateEmptyState ({ count, onRefresh }) {
    const busy = useSignal<boolean>(false)

    const handleClick = async () => {
        if (busy.value) return
        busy.value = true
        try {
            await onRefresh()
        } finally {
            busy.value = false
        }
    }

    return html`
        <div class="empty-state pending-update-empty-state">
            <p>${pendingUpdateLabel(count)}</p>
            <button
                class="btn btn-small"
                type="button"
                onClick=${handleClick}
                disabled=${busy.value}
            >
                ${busy.value ? 'Refreshing…' : 'Click to refresh'}
            </button>
        </div>
    `
}
```

Notes for the implementor:
- Re-use the existing wrapper class `empty-state` so the component
  inherits the project's centered text styling from
  `src/client/style.css:324-328`. The extra class
  `pending-update-empty-state` is optional and only needed if future
  styling diverges — leave it in as a stable hook for tests.
- Button uses existing `btn btn-small` classes. No new CSS file.
- The `busy` guard at the start of `handleClick` makes double-clicks
  no-ops while the prior promise is still pending. This protects the
  per-feed primitive (`State.refreshFeed`) which has no re-entrancy
  guard of its own.
- `finally` is required so AC2.3 (re-enable after rejection) holds. Do
  not catch and swallow the error — let the rejection propagate so the
  upstream error surfaces are unaffected.

**Testing:**

Use the existing component test pattern. The reference test file is
`test/dot.ts` — read it for the exact render/cleanup boilerplate (render
into a detached `div` appended to `document.body`, query with
`document.querySelector`, call `cleanup()` between tests).

Tests must verify each AC listed above. **All assertions are structural —
no `textContent`/HTML-string comparisons.**

- **empty-state-pending-updates.AC1.3** — Render with a spy callback that
  returns an immediately-resolved promise. Call `button.click()`.
  Assert the spy was invoked exactly once. (Use a simple counter
  variable; do not introduce a mocking library.)

- **empty-state-pending-updates.AC2.1** — Render with a `onRefresh` that
  returns a manually-resolvable promise (`let resolve; const p = new
  Promise<void>(r => { resolve = r })`). Click the button. Without
  resolving the promise, flush microtasks (`await Promise.resolve()`)
  and assert:
  - `button.disabled === true`
  - the button has the busy state hook — verify via the
    `pending-update-empty-state` wrapper still rendered and the button
    is the only one inside it. Do NOT assert the button's text content.

- **empty-state-pending-updates.AC2.2** — Continuing from the AC2.1
  setup, call `resolve()` then `await p` then flush microtasks. Assert
  `button.disabled === false`.

- **empty-state-pending-updates.AC2.3** — Same shape as AC2.1/2.2 but
  the manually-controlled promise is rejected
  (`let reject; const p = new Promise<void>((_, r) => { reject = r })`).
  Wrap the click in a try/catch to swallow the propagated rejection in
  the test (or use `await
  Promise.resolve(button.click()).catch(() => {})`). Then flush and
  assert `button.disabled === false`.

For each test, also assert that re-clicking the disabled button (i.e.
clicking again while `busy.value === true`) does NOT invoke the
`onRefresh` spy a second time — this verifies the in-handler re-entrancy
guard.

**Verification:**

Run: `npm test`
Expected: All new component tests pass alongside the helper tests from
Task 1. Existing tests still pass.

Run: `npm run lint`
Expected: No new lint errors.

**Commit:**

```bash
git add src/client/components/pending-update-empty-state.ts \
        test/pending-update-empty-state.ts
git commit -m "feat(empty-state): add PendingUpdateEmptyState component"
```
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

---

## Phase completion checklist

- [ ] `src/client/components/pending-update-empty-state.ts` exists and
  exports both `pendingUpdateLabel` and `PendingUpdateEmptyState`.
- [ ] `test/pending-update-empty-state.ts` contains tests for all listed
  ACs and tests use structural assertions only (no HTML text-content
  comparisons except in the pure-helper unit tests).
- [ ] `npm test` passes.
- [ ] `npm run lint` passes.
- [ ] Two commits land cleanly on `empty-state-pending-updates`.
- [ ] No edits to `src/client/routes/feed-reader.ts` yet — that is
  Phase 2's job.
