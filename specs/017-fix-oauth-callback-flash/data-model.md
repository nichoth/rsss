# Data Model: OAuth callback window

**Feature**: 017-fix-oauth-callback-flash
**Date**: 2026-05-10

No SQLite schema change, no DO storage change, no `/api/sync`
payload change. This is purely a client-side state-lifecycle change.
The "data model" is the additional client signal and its
relationship to the existing auth lifecycle.

## New entity: `oauthInFlight` (client signal)

Type: `Signal<boolean>`
Lives on: `AppState` (the existing state container in
`src/client/state.ts`)
Initial value: derived synchronously from `window.location` at boot
— `true` iff the page was loaded from an OAuth-callback URL,
otherwise `false`.

**OAuth-callback URL** is defined as either:

- `window.location.pathname === '/oauth/callback'`, **or**
- the URL carries all three of `code`, `state`, and `iss` query
  parameters (covers the spec assumption that the flash could
  originate on the post-callback landing route).

## Lifecycle

| # | When                                                         | Action                                                                                  |
|---|--------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| 1 | `State()` constructor runs                                   | Set `oauthInFlight` synchronously from URL inspection (see above).                      |
| 2 | If `oauthInFlight === true`, await `checkAuth()`             | (Edge case: refreshed callback URL on an already-authed session.)                       |
| 3 | After `checkAuth`, if `isAuthenticated.value === true`       | `batch`: set `oauthInFlight = false` then `_setRoute('/')`. Skip `handleOAuthCallback`. |
| 4 | After `checkAuth`, if `isAuthenticated.value === false`      | Call `State.handleOAuthCallback(state)`.                                                |
| 5 | `handleOAuthCallback` entry                                  | `batch`: `authError = null`, `authLoading = true`.                                      |
| 6 | `handleOAuthCallback` returns (success **or** any error)     | `batch` in `finally`: `authLoading = false`, `oauthInFlight = false`.                   |

## Invariants

- **I1**: `oauthInFlight` is `true` for the entire window between
  the callback URL being loaded and `handleOAuthCallback` returning
  (or the already-authed short-circuit completing). Single owner
  for both transitions: `State()` flips it on; `handleOAuthCallback`
  / the already-authed path flips it off.

- **I2**: Whenever `oauthInFlight === true`, no `LoginPage` render
  is reachable from the App shell — the shell short-circuits to
  `<OAuthCallbackLoader/>` before evaluating `route.value` or
  `pageReady`.

- **I3**: `oauthInFlight === false` is the steady-state. It is the
  initial value on every non-callback URL load (homepage refresh,
  login page, deep link, etc.), and a one-way transition from
  `true → false` happens exactly once per callback handshake.

## Relationship to existing signals

| Existing signal           | Interaction                                                                                                                  |
|---------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `authLoading`             | Still flips around `checkAuth` and `handleOAuthCallback` independently. The shell now reads `oauthInFlight` *before* it reads `pageReady` (which itself reads `authLoading`), so the loader wins. |
| `authError`               | Cleared at the start of `handleOAuthCallback` to guarantee no stale error survives into the callback window (FR-002).        |
| `user`                    | Unchanged. Set inside `checkAuth` on success, as today.                                                                      |
| `route`                   | Still flipped by `handleOAuthCallback`'s `_setRoute('/' or '/login')`. The shell only reads it after `oauthInFlight` clears. |
| `initialLoadComplete`     | Unchanged. The post-callback `/` render still uses `PageSkeleton` until the first `refreshAfterSync` resolves.               |

## Why no validation / migration

- Pure UI signal, no persistence, no schema, no wire format.
- No backwards-compatibility surface: the signal is born at boot
  and dies when the page is closed.
- No multi-tab coordination: the flash bug is per-tab and the
  callback URL is only ever loaded in one tab.
