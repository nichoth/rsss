# Contract: `Button.isSpinning` Controlled-vs-Uncontrolled Mode

This feature does not change any server-facing contract.
`POST /feeds/refresh`, `GET /feed-status`, the SSE event format,
the `/api/sync` payload, and the per-user Durable Object SQLite
schema are all untouched. The contract this feature introduces
is internal to the client render layer: how the `Button`
component composes with externally-owned signals, and how that
composition obeys the `state.refreshInProgress` lifecycle from
feature 010.

## Public API of `Button`

`src/client/components/button.ts` exports
`Button:FunctionComponent<ButtonProps>` with:

```ts
export interface ButtonProps {
    onClick?:(ev:MouseEvent) => void | Promise<void>;
    class?:string;
    isSpinning?:Signal<boolean>;
    className?:string;
    disabled?:boolean;
}
```

The shape of the public API is unchanged. The change is to the
*write contract* on the `isSpinning` signal.

## Modes

### Controlled mode

- **Trigger**: caller passes a non-null `isSpinning` signal
  (the existing `_isSpinning || useSignal(...)` fallback at
  render line 19 evaluates the prop as truthy).
- **Read responsibilities** (`Button`):
  - sets `aria-busy=${isSpinning.value}` on the rendered
    `<button>`,
  - sets `disabled=${isSpinning.value || _props.disabled}` on
    the rendered `<button>`,
  - includes the `spinning` CSS class on the rendered
    `<button>` when `isSpinning.value === true`.
- **Write responsibilities** (`Button`): NONE.
  - `Button.click` MUST NOT write to `props.isSpinning` in any
    branch.
  - In particular, the previous `isSpinning.value = true` /
    `isSpinning.value = false` writes around `await
    props.onClick(ev)` MUST be elided when `isSpinning` is
    supplied.
- **Write responsibilities** (parent / caller): everything.
  - Setting the signal `true` to enter the busy state.
  - Clearing the signal back to `false` on resolution
    (success, failure, timeout, or whatever lifecycle the
    parent owns).
  - The parent's `onClick` is the only path through which the
    busy state advances; `Button` is a passive renderer of
    `isSpinning`.
- **Why**: callers (e.g. `SidebarFooter`) that bind
  `isSpinning` to an application-state signal
  (`state.refreshInProgress`) need that signal to follow a
  contract owned by application code (here, `State.refreshFeeds`'s
  re-entry guard, SSE `refresh-complete` settle, safety
  timeout, etc.). A render-layer write to that signal would
  short-circuit the FR-008 re-entry guard and silently drop the
  effect of the click — which is precisely the regression this
  feature fixes.

### Uncontrolled mode

- **Trigger**: caller does not pass `isSpinning`, or passes
  `undefined` / `null`. The `_isSpinning || useSignal(...)`
  fallback creates a hook-local signal initialised to `false`.
- **Read responsibilities** (`Button`): same as controlled
  mode — drives `aria-busy`, `disabled`, and the `spinning`
  CSS class from the hook-local signal.
- **Write responsibilities** (`Button`):
  - `Button.click` writes `isSpinning.value = true` before
    `await props.onClick(ev)`.
  - `Button.click` writes `isSpinning.value = false` after the
    await resolves.
  - The two writes MUST be wrapped in `try/finally` so a
    thrown / rejecting `onClick` does not leave the button
    stuck busy.
- **Write responsibilities** (parent / caller): NONE on
  `isSpinning` (since the caller didn't supply it).
- **Why**: this preserves the original `Button` behavior for
  callers that have no external lifecycle to bind to (e.g.
  per-feed `Refresh` in `routes/updates.ts` after the
  `spinning` field is dropped, and any other call site that
  just wants "show a spinner while my async onClick is in
  flight"). It is a strictly local concern; nothing outside
  `Button` reads or writes the hook-local signal.

## Invariants

I-1. *`Button` is the sole writer of `isSpinning` in
uncontrolled mode.* No external code can bind to a hook-local
signal it never received a reference to. (Trivially true by
construction.)

I-2. *`Button` writes to `isSpinning` only in uncontrolled mode.*
Equivalently: when `props.isSpinning` is supplied, no
`Button.click` codepath assigns to it.

I-3. *Uncontrolled-mode writes are balanced.* Every
`isSpinning.value = true` is paired with exactly one
`isSpinning.value = false` (via `try/finally`), even on a
thrown `onClick`. This closes the latent
"throw leaves spinner stuck" bug observed during the fix.

I-4. *Public API is backward-compatible.* `ButtonProps` is
unchanged. Existing call sites that omit `isSpinning` see no
behavior change. Existing call sites that pass `isSpinning`
and also rely on the auto-managed write are exactly the bug
this feature fixes; the only known caller is
`routes/updates.ts` which is updated in the same change set to
drop the binding.

## Conformance with feature 010 lifecycle

The lifecycle table from
`010-fix-refresh-feedback/contracts/refresh-lifecycle.md` is
unchanged by this feature. After the fix:

- `state.refreshInProgress` is written to `true` only at the
  click-setup `batch` inside `State.refreshFeeds` (its declared
  owner). The `Button` no longer races this write.
- `state.refreshInProgress` is cleared only via the six paths
  enumerated in the feature-010 lifecycle table (SSE
  `refresh-complete` settle, SSE `open` reconnect settle, 60s
  safety timer, POST failure batch, 401 batch — and now, the
  manual click flow can actually reach all of these because the
  POST is no longer dropped).

## Acceptance contract (mapped from spec FRs)

| FR     | Verified by                                                                                                |
|--------|------------------------------------------------------------------------------------------------------------|
| FR-001 | New click-through test asserts `aria-busy="true"` after click; `Button.click` does not race the signal off. |
| FR-002 | Same test asserts `aria-busy` stays `true` past POST resolve, until SSE `refresh-complete`.                |
| FR-003 | Three click-through cases (new items / no new items / failure) cover the three terminal cues.              |
| FR-004 | Click-through test asserts the `aria-busy="false"` transition coincides with the resolution cue (pill / items / failure legend). |
| FR-005 | Settle batch in feature 010 is reused; click-through test asserts items list and pill update inside the same paint as `aria-busy=false`. |
| FR-006 | Failure case asserts the prior `feedUpdateCounts` is restored, not zeroed; failure legend visible.         |
| FR-007 | Same as FR-006 (counts restoration).                                                                      |
| FR-008 | Click-through test attempts a second click while the button is `disabled` and asserts no second POST.     |
| FR-009 | Click-through test asserts a single `false → true → false` transition on `aria-busy` per click.            |
| FR-010 | Safety timer / SSE reopen paths from feature 010 are unaffected; existing tests continue to pass.         |
| FR-011 | Existing feature-010 test "background poll's `feed-updated` does not clear busy" continues to pass.       |
| FR-012 | New click-through test in `test/sidebar-footer-refresh.ts` runs as part of `npm test`. New broken-caller-pattern guard test in `test/refresh-lifecycle.ts` extends the contract one layer deeper. |

## Forbidden after this feature

- `Button.click` writing to `props.isSpinning` when supplied.
- Any other render-layer component reading
  `state.refreshInProgress` and writing it back. Application
  signals are owned by application code (`State.*` in
  `state.ts`); render components are passive over them.
- Re-introducing a `spinning` field in any per-feed map without
  a corresponding writer outside `Button`.
