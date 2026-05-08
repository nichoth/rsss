# Phase 0 Research: Refresh Feeds Click Must Produce an Observable Response

This feature is a regression-fix on top of feature 010
(`010-fix-refresh-feedback`). The lifecycle contract is already
defined; the bug is a render-layer write that violates that
contract. The research pass therefore concentrates on three
things: locating the actual fault site, picking the right
generalisation of the Button component, and choosing a test
shape that catches the regression at the click boundary rather
than at a layer below it where the bug is invisible.

## Decision: Locate the fault at the `Button` component's local click handler, not at `State.refreshFeeds`

**Rationale.** Feature 010's `State.refreshFeeds` lifecycle is
correct against its contract: it guards against re-entry
(`if (state.refreshInProgress.value) return`,
`src/client/state.ts` line 1371), it sets the signal `true` only
inside its own click-setup `batch` (line 1377), and it does not
clear the signal on POST acknowledgement (the comment at lines
1393-1397 explicitly defers to the SSE handler). Replicating the
spec's three failure modes (no acknowledgement, no in-progress
signal, no conclusion) by running `State.refreshFeeds(state)`
directly produces *correct* observable behavior: signal stays
high, SSE handler clears it, items reconcile.

The user-visible bug only reproduces when the click is dispatched
through the actual `Button.click` wrapper. Reading
`src/client/components/button.ts` lines 28-34:

```ts
async function click (ev:MouseEvent) {
    if (props.onClick) {
        isSpinning.value = true
        await props.onClick(ev)
        isSpinning.value = false
    }
}
```

When `props.isSpinning` is supplied (as `state.refreshInProgress`),
`isSpinning` is the *same* signal. The wrapper:

1. writes `state.refreshInProgress.value = true`,
2. calls `props.onClick = () => State.refreshFeeds(state)`,
3. `State.refreshFeeds` short-circuits at the re-entry guard,
4. the wrapper writes `state.refreshInProgress.value = false`.

The POST is never dispatched. SSE never broadcasts
`refresh-complete`. The reader sees a synchronous
true→false→true→false flicker bound to the same render frame as
the click, which from a user perspective is "nothing happened."

The fault is therefore an interaction between the Button's
auto-managed lifecycle (a holdover from before feature 010) and
the now-controlled signal. Fixing it inside `State.refreshFeeds`
is the wrong layer: the signal is already in the wrong state by
the time `refreshFeeds` runs. The fix has to be in the component
that owns the click event.

**Alternatives considered.**

- *Move the re-entry guard out of `refreshFeeds` and into
  `SidebarFooter`'s `onClick`.* Rejected: the signal contract
  from feature 010 explicitly puts that guard at the lifecycle
  function, so duplicate clicks dispatched from anywhere (key
  shortcuts, programmatic invocations, future keyboard-only
  paths) are protected. Pulling the guard up to a single call
  site re-introduces the leakage class FR-008 was added to
  prevent.
- *Switch `State.refreshFeeds` to read a different signal
  (`refreshRequested`) and write `refreshInProgress` on its
  own.* Rejected: this is a workaround for a render bug. It
  doubles the signal surface for the manual-refresh lifecycle
  with no semantic gain, and any future controlled-mode caller
  would hit the same trap.
- *Have `State.refreshFeeds` notice the signal is already true
  but distinguish "armed by Button" vs "armed by another
  refreshFeeds in flight."* Rejected: the only way to make the
  distinction is a sentinel on the signal (e.g. a counter or
  ID), which leaks the bug's coupling into the contract. The
  problem is that a render component is writing
  application-state without that being part of its API.

## Decision: `Button.isSpinning` becomes a controlled prop when supplied

**Rationale.** The React-style controlled-vs-uncontrolled
pattern is the right generalisation: a component that takes an
optional state prop must not write to that prop unless it is
explicitly designated owner. The current `Button` API already
half-implements this — `useSignal` is used as a fallback when
`isSpinning` is omitted (line 19) — but the click handler treats
both cases the same. Closing that gap is a one-line check and
keeps the public API identical:

```ts
const isControlled = Boolean(_isSpinning)
const isSpinning = _isSpinning || useSignal<boolean>(false)
// ...
async function click (ev:MouseEvent) {
    if (props.onClick) {
        if (!isControlled) isSpinning.value = true
        try {
            await props.onClick(ev)
        } finally {
            if (!isControlled) isSpinning.value = false
        }
    }
}
```

The `try/finally` is added because the existing code did not
clear `isSpinning` if `onClick` threw — a separate latent bug
(any caller whose `onClick` rejects gets stuck in the spinning
state). Wrapping the await in `try/finally` is on the path of the
fix and one cheap correctness step.

`aria-busy`, `disabled`, and the `spinning` CSS class continue
to read from the same signal in the JSX, so the rendered output
is unchanged for both controlled and uncontrolled callers — only
*who is allowed to write to the signal* changes.

**Alternatives considered.**

- *New `controlledSpinning` prop.* Rejected: doubles the API
  surface for no gain. The existing prop semantics are already
  "an external signal the parent wants the button to render";
  the only new restriction is that the Button no longer writes
  to it. A second prop would force every existing caller to
  choose between two near-identical knobs.
- *Make the click handler call a parent-supplied
  `onSpinningChange` callback when `isSpinning` is supplied.*
  Rejected: any caller that wants the auto-managed behavior
  while passing a signal can already get it by handling the
  state in their own `onClick`; the callback adds indirection
  for a use case nobody currently has.
- *Keep the auto-managed write but only execute it if the
  signal is currently `false`.* Rejected: this is precisely the
  "guard the component against the contract it doesn't know
  about" pattern that the bug already exhibits. It would mask
  this specific bug while making future signal collisions harder
  to reason about.

## Decision: Fix the per-feed Refresh button in `routes/updates.ts` by dropping its `isSpinning` binding entirely

**Rationale.** `routes/updates.ts` keeps a per-feed
`refresh:{ spinning:Signal<boolean>, error:Signal<string|null> }`
map and passes `refresh.spinning` to its `<${Button}>`. After
the controlled-vs-uncontrolled fix, `Button` will not write to
that signal, and nothing else in `routes/updates.ts` writes to
it either. Without removing the binding the per-feed Refresh
button would never visually spin.

The per-feed flow is shorter than the all-feeds flow:
`State.refreshFeed` (`src/client/state.ts` lines 1660-1675)
finishes its work synchronously inside the POST resolution —
there is no SSE-bounded second leg. The await on the click is
exactly the busy window. So the simplest correct binding is
*no* `isSpinning` prop: `Button` falls back to its
`useSignal<boolean>(false)` default and auto-manages the busy
state for the duration of `await State.refreshFeed(...)`. The
`refresh.error` signal stays in the per-feed map (the parent
reads it for error rendering) but `refresh.spinning` becomes
dead and is removed.

**Alternatives considered.**

- *Keep the `spinning` signal and write to it in
  `handleRefresh`.* Rejected: it is unread elsewhere; adding
  manual writes is busywork that would need to be undone if any
  future flow needs only `error`.
- *Bind to `state.refreshInProgress` for per-feed buttons.*
  Rejected: that signal is the all-feeds lifecycle; binding
  per-feed buttons to it would visually mark every per-feed
  refresh button busy whenever the all-feeds flow is busy.
  Wrong scope.

## Decision: Add a click-through regression test that mounts `SidebarFooter` and dispatches a real DOM click

**Rationale.** Existing `test/refresh-lifecycle.ts` cases all
call `State.refreshFeeds(state)` directly. They pass today even
though the user-facing flow is broken, because they bypass the
exact site of the regression. FR-012 explicitly demands a test
that catches this kind of regression. The natural extension is
a browser-driven test (the project already runs UI tests via
tapout-bundled bundles, e.g. `signup-ui.ts`) that mounts the
real `SidebarFooter`, stubs `EventSource` and `fetch`, and
dispatches a real click event on the rendered `<button>`.

This shape of test:

- runs the actual `Button.click` wrapper (would have caught the
  bug),
- asserts the visible chain via DOM attributes (`aria-busy`,
  `disabled`) rather than internal signals, which mirrors what
  the user perceives,
- exercises the three resolution paths (new items, no new
  items, failure) so SC-002 / FR-003 are covered end-to-end.

The new test file `test/sidebar-footer-refresh.ts` is added to
the existing `test/index.ts` import list so it is included in
the same `tapout` bundle that runs as part of `npm test`. No
new test runner script is needed.

**Alternatives considered.**

- *Pure unit test against `Button` in isolation.* Rejected: the
  bug emerges only when the Button's `isSpinning` prop is the
  same signal that an external function (`State.refreshFeeds`)
  reads as a guard. A purely Button-level test cannot model
  that interaction without effectively re-implementing
  `State.refreshFeeds`. Mounting `SidebarFooter` is the
  smallest unit that contains the interaction.
- *Playwright end-to-end against a running dev server.*
  Rejected: there is no Playwright infrastructure in this
  repo. Tapout-bundled DOM tests are the project's existing
  "integration" tier and they already provide a real Chromium
  context. Introducing Playwright for one test is out of
  proportion.
- *Snapshot-test the rendered HTML to detect missing
  `aria-busy`.* Rejected: snapshot tests cannot model the
  asynchronous lifecycle of "busy after POST ack, idle after
  SSE refresh-complete." The bug is temporal, not structural.

## Decision: Extend `refresh-lifecycle.ts` with a "broken caller pattern" guard test

**Rationale.** The browser-driven click-through test catches the
specific Button bug. We also want a unit-level test that
captures the more general invariant: "no caller may write
`state.refreshInProgress = true` immediately before invoking
`State.refreshFeeds`." Encoding it as a test means future
callers (e.g. a hypothetical command-palette refresh shortcut,
or a deeplink-trigger) cannot accidentally re-introduce the
same shape of bug without the test failing first.

The test simulates the broken pattern and asserts the consequence:

```ts
state.refreshInProgress.value = true   // simulate broken caller
await State.refreshFeeds(state)
// expect zero POSTs were dispatched (FR-008 short-circuit
// is correct; the bug is upstream).
```

This documents the invariant in code: the signal is owned by
`State.refreshFeeds` *and only by* `State.refreshFeeds` on the
way in; anything else writing it before invocation will be
misinterpreted as "already in flight" and will silently no-op.

**Alternatives considered.**

- *Skip the unit-level guard and rely entirely on the
  click-through test.* Rejected: the click-through test runs in
  a Chromium bundle and is the slower of the two; a unit test
  that fails fast against the same invariant catches future
  regressions earlier in CI.
- *Express the invariant as a runtime assertion in
  `State.refreshFeeds` (e.g. `console.warn` when called with
  the signal already true).* Rejected: the existing re-entry
  guard already returns early; logging would only add noise
  and doesn't help in production. The test is the right place
  for this kind of invariant.

## Open questions resolved

- *Does any other component pass an external `isSpinning` to
  `Button`?* Yes — `routes/updates.ts` passes
  `refresh.spinning` per feed. After the controlled-mode fix
  the parent must either write to that signal itself or stop
  binding the prop. The chosen fix is to drop the binding
  (research decision above) since `State.refreshFeed` is fully
  synchronous-from-the-button's-perspective.
- *Does the controlled-mode fix break any test in
  `test/refresh-lifecycle.ts`?* No. Those tests do not click
  the rendered Button; they call `State.refreshFeeds(state)`
  directly. They continue to pass after the fix.
- *Does the fix change the SSE wire format, the
  `/feeds/refresh` HTTP contract, or the per-user DO storage?*
  No. All server surfaces are unchanged. The fix is entirely
  in the client render layer plus tests.
- *Does the fix interact with the local-first sync cycle
  (`runSync`)?* No. `runSync` is the local-first DB sync (pull
  then push outbox), separate from `/feeds/refresh`. The
  documented separation in `state.ts` line 499 is not crossed.
- *Is the keyboard-activation path covered (FR-010)?* Yes. The
  `<button>` element handles Enter/Space natively, dispatching
  the same `click` event the test simulates with
  `button.dispatchEvent(new MouseEvent('click', ...))`. The
  fix is event-source-agnostic.
