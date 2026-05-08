# Phase 1 Data Model: Refresh Feeds Click Must Produce an Observable Response

This feature is a regression fix in the client render layer. There
is no SQLite schema change, no `/api/sync` payload change, and no
DO KV record change. The "data model" here is twofold:

1. The `Button` component's prop contract — specifically the
   ownership of the `isSpinning` signal — and how that contract
   composes with the application-state signal it now properly
   leaves alone.
2. The `state.refreshInProgress` lifecycle from feature 010,
   carried forward unchanged.

## Scope

- **In scope.** `Button` component prop contract; per-feed
  refresh map shape in `routes/updates.ts`; the relationship
  between `state.refreshInProgress` (owned by
  `State.refreshFeeds`) and `Button` (now strictly a passive
  renderer of that signal).
- **Out of scope.** Per-user DO SQLite tables (`feeds`, `items`,
  `outbox`, `read_state`), DO KV poller state from feature 009,
  `/api/sync` payload shape, `/feed-status` payload shape, the
  local SQLite mirror schema. None of these change.

## Component prop model (changed)

### `Button.props.isSpinning?:Signal<boolean>` (CONTRACT TIGHTENED)

- **When supplied** (`isSpinning` is truthy at render time): the
  parent owns the lifecycle. `Button` MUST NOT write to the
  signal. `Button` reads it for `aria-busy`, `disabled`, and the
  `spinning` CSS class. The parent's `onClick` is responsible
  for setting and clearing the signal as appropriate. This is
  the controlled mode introduced by feature 010 and now made
  authoritative.
- **When omitted**: `Button` falls back to a hook-local
  `useSignal<boolean>(false)` and auto-manages the busy state
  around the `await props.onClick(ev)` call (set true before the
  await, set false after, with `try/finally` so a thrown
  `onClick` does not leave the button stuck busy). This is the
  uncontrolled mode and matches the original (pre-feature-010)
  behavior used by callers that don't have an external lifecycle
  to bind to.
- **Invariant**: `Button` writes to `isSpinning` if and only if
  it owns the signal (uncontrolled mode). In controlled mode,
  the only writes to the signal come from the parent's
  application code.
- **Backward compatibility**: callers that previously omitted
  `isSpinning` are unaffected. Callers that previously supplied
  it and *also* relied on `Button`'s auto-managed write to
  toggle it (this is exactly the bug class) will now see the
  signal stay at its parent-set value across the click. The
  only known caller of that incorrect pattern is
  `routes/updates.ts`, which is updated to drop the binding
  entirely (see below).

### `routes/updates.ts` per-feed refresh map (REDUCED)

- **Before**:
  ```ts
  type RefreshMap = Map<string, {
      spinning:Signal<boolean>
      error:Signal<string|null>
  }>
  ```
- **After**:
  ```ts
  type RefreshMap = Map<string, {
      error:Signal<string|null>
  }>
  ```
- **Reasoning**: `spinning` was only ever read by `Button`. With
  the controlled-mode fix, `Button` no longer writes to it; with
  the binding dropped, `Button` no longer reads it either. The
  field becomes dead. `error` is still produced by the parent
  on `catch` and rendered as `<p class="refresh-error">`, so it
  stays.

### `SidebarFooter` (unchanged)

```ts
<${Button}
    onClick=${() => State.refreshFeeds(state)}
    isSpinning=${state.refreshInProgress}
>Refresh Feeds<//>
```

This remains the canonical controlled-mode caller. After the
fix it actually behaves as a controlled binding:
`state.refreshInProgress` is set true exclusively inside
`State.refreshFeeds`'s click-setup `batch`, and cleared
exclusively by the lifecycle paths from feature 010 (SSE
`refresh-complete`, SSE `open` reconnect, safety timeout, POST
failure, 401 branch).

## Application signal model (unchanged from feature 010)

`state.refreshInProgress:Signal<boolean>` continues to be
defined in `src/client/state.ts` (declaration line 177,
initialization line 225). The lifecycle table from feature 010
is reproduced here for reference; this feature does not modify
it.

| From  | Trigger                                              | To    | Notes                                                      |
|-------|------------------------------------------------------|-------|------------------------------------------------------------|
| false | `State.refreshFeeds(state)` invoked                  | true  | Inside the click-setup `batch`.                            |
| true  | SSE `refresh-complete` after `refreshAfterSync()`    | false | Inside a settling `batch`.                                  |
| true  | SSE `open` reconnect after `refreshAfterSync()`      | false | Inside a settling `batch`. Only when reconnect happens with `refreshInProgress === true`. |
| true  | 60s safety timer fires                               | false | Standalone write; pill not touched.                         |
| true  | POST `/feeds/refresh` rejects                        | false | Inside the failure `batch` (also writes `feedSyncStatus`/`feedSyncError`/restores `feedUpdateCounts`). |
| true  | POST `/feeds/refresh` returns 401                    | false | Inside the existing 401 `batch` (also nulls `state.user`). |

The new invariant added by this feature, expressed as a code-
level guard via the new test in `refresh-lifecycle.ts`:

> **No code outside `State.refreshFeeds` may write
> `state.refreshInProgress = true` before
> `State.refreshFeeds` runs.** Any caller that does so will
> trip the FR-008 re-entry guard and the POST will be silently
> dropped.

## State machine — click → resolution

The state machine from feature 010 carries forward, but the
*entry condition* changes (correctness restoration, not behavior
change):

```text
                       ┌────────────────┐
                       │  IDLE           │
                       │  refreshInProg- │
                       │  ress = false   │
                       └────────┬───────┘
                                │
                                │ user clicks "Refresh Feeds"
                                │ Button.click runs
                                │ (controlled mode: does NOT
                                │  touch state.refreshInProgress)
                                │
                                │ Button.click invokes onClick
                                │   = () => State.refreshFeeds(state)
                                ▼
                       ┌────────────────────────────┐
                       │  State.refreshFeeds         │
                       │   - re-entry guard sees     │
                       │     refreshInProgress=false │
                       │     → proceeds              │
                       │   - click-setup batch:      │
                       │     refreshInProgress=true  │
                       │     feedSyncStatus='syncing'│
                       │     feedSyncError=null      │
                       │   - safety timer armed      │
                       │   - POST /feeds/refresh     │
                       └────────┬───────────────────┘
                                │
                                │ POST resolves OR fails (FR 010
                                │ contract, unchanged)
                                ▼
                  ... feature 010 lifecycle continues ...
                  (refresh-complete settles via batch,
                   pill / items / button transition together)
```

The fix is entirely about ensuring `Button.click` does NOT
write to `state.refreshInProgress` on the way in. After the fix
the entry condition is restored and the rest of feature 010's
lifecycle runs as designed.

## Idempotency

- **Click while busy.** Once the parent owns the signal,
  `Button` rendering already disables the `<button>` element
  (`disabled=${isSpinning.value || ...}`, line 39). A click
  cannot fire on a disabled button. The DOM-level guard plus
  the `State.refreshFeeds` re-entry guard plus the parent's
  ownership of the signal together provide three layers of
  protection.
- **Multiple SSE `refresh-complete` events.** Same as feature
  010: re-entrant `refreshAfterSync` is safe; the settle batch
  is a no-op write when the signal is already false.
- **Background poll's `feed-updated` during refresh.** Same as
  feature 010: does not touch `refreshInProgress`.

## Failure modes and recovery

| Failure                                              | Behavior                                                                                          |
|------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `Button.click` swallows the click (the current bug)   | After the fix: not possible — `Button` no longer writes to a controlled signal.                   |
| `props.onClick` throws                                | After the fix: `try/finally` in `Button.click` ensures the uncontrolled signal returns to `false`. Controlled mode is unaffected (parent owns the signal). |
| `POST /feeds/refresh` rejects (non-200, network)     | Same as feature 010: refreshInProgress=false, feedSyncStatus='error', feedSyncError set, priorCounts restored. |
| `POST /feeds/refresh` returns 401                    | Same as feature 010: existing 401 branch nulls user, sets authError, routes to /login, clears refreshInProgress in batch. |
| Server fetches start but `refresh-complete` is lost  | Same as feature 010: safety timer fires at 60s.                                                   |
| SSE drops mid-refresh and `refresh-complete` is lost | Same as feature 010: on SSE reopen with refreshInProgress=true, refreshAfterSync runs, refreshInProgress=false. |
| Zero subscribed feeds                                | Same as feature 010: server's `Promise.all([])` resolves immediately, broadcasts `refresh-complete`, settles as normal. |

## Persistence

- `state.refreshInProgress` remains in-memory only (same as
  feature 010). No localStorage, no IndexedDB, no OPFS, no
  server store.
- `Button`'s uncontrolled-mode internal signal
  (`useSignal<boolean>(false)`) is hook-local and discarded on
  unmount.
