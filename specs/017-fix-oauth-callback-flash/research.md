# Research: OAuth callback flash

**Feature**: 017-fix-oauth-callback-flash
**Date**: 2026-05-10

## Goal of research

Pin down (a) where exactly the brief login-form/error flash comes
from after the Bluesky OAuth redirect, and (b) the smallest UI
lifecycle change that eliminates it without regressing the genuine
login path. No NEEDS CLARIFICATION remained after the spec; this
document captures the code archaeology that the plan is built on.

## Decision 1 — Root cause of the flash

**Decision**: The flash originates from the `/oauth/callback` route
action returning `LoginPage` synchronously while the async
`State.handleOAuthCallback()` is in flight. The App shell's skeleton
fall-through (`src/client/index.ts:59-68`) only special-cases `/`,
`/feed/*`, and item routes, so `/oauth/callback` lands in the "render
normally" bucket and `LoginPage` mounts. The handshake takes
~500ms-2s, during which the user sees the form (and, when stale,
`state.authError`).

**Evidence**:

- `src/client/routes/index.ts:73-87` — route action body:
  ```ts
  router.addRoute('/oauth/callback', () => {
      if (state.isAuthenticated.value) {
          state._setRoute('/')
          return FeedReader
      }
      State.handleOAuthCallback(state)
      return LoginPage
  })
  ```
- `src/client/state.ts:825-881` — `handleOAuthCallback` awaits
  `POST /api/auth/callback`, awaits `checkAuth`, then `_setRoute`s
  to `data.returnTo || '/'`. The awaits are the flash window.
- `src/client/state.ts:825-881` — no `authError = null` reset at
  entry. A stale `authError` from a prior failed login attempt in
  the same session persists through the in-flight render.
- `src/client/index.ts:55-68` — App shell:
  ```ts
  if (!pageReady.value) {
      if (isItemRoute(route.value)) return <ItemSkeleton/>
      if (route.value === '/' || route.value.startsWith('/feed/')) {
          return <PageSkeleton/>
      }
      // fall through for /oauth/callback, /login, /about, etc.
  }
  ```
  `/oauth/callback` is not covered, so the action's `LoginPage`
  renders.

**Rationale**: The handshake call is correctly placed (the route
action is a reasonable trigger) but the *fallback render while it's
running* is what leaks the login form. Two independent contributors
(no skeleton case for `/oauth/callback`; no `authError` clear) both
need to be addressed.

**Alternatives considered**:

- *Just hide the form in `LoginPage` when `authLoading` is true.*
  Rejected: the spec says no form **and** no error message during
  the callback window; toggling fields inside `LoginPage` is fragile
  (someone adds a banner tomorrow and reintroduces the flash) and
  doesn't address the stale-error path.
- *Server-render the callback page with no form.* Rejected: the SPA
  shell is the same for all routes, and Phase 0's investigation
  showed the worker already returns the SPA shell for `/oauth/callback`
  (see `src/server/index.ts:542`). The fix has to live client-side.

## Decision 2 — Visual gate: dedicated `oauthInFlight` signal

**Decision**: Introduce `state.oauthInFlight:Signal<boolean>`.
Initialise it synchronously in `State()` from the current URL
(matches `pathname === '/oauth/callback'`, or any pathname carrying
all three of `code`, `state`, `iss` query params — the latter covers
the assumption in spec.md §Assumptions that the flash can originate
on the post-callback landing route as well). The App shell short-
circuits to a neutral `<OAuthCallbackLoader/>` whenever the flag is
true.

**Rationale**:

- A single signal owns the visual contract for the whole callback
  window. Reviewers reading the App shell see one render branch and
  one lifecycle.
- Cleared in `handleOAuthCallback`'s `finally`, so success, sync
  error (bad params), and async error (POST failure) all converge
  on the same state transition.
- Independent of `authLoading`. `authLoading` is already overloaded:
  `checkAuth` and `login` and `handleOAuthCallback` all flip it.
  Piggybacking on it would couple the loader's visibility to
  unrelated boot-time auth checks.

**Alternatives considered**:

- *Add `/oauth/callback` to the App skeleton fall-through.*
  Rejected: doesn't cover the post-callback landing window if the
  redirect URI ever moves (FR-006), and still requires a parallel
  fix for stale `authError`.
- *Detect callback URL inside the `/oauth/callback` route action
  only.* Rejected: doesn't cover boot-time render before the router
  has a chance to dispatch (one frame of `LoginPage` is still a flash
  per spec §Assumptions "shorter flash still fails").

## Decision 3 — Boot-time dispatch of `handleOAuthCallback`

**Decision**: When `State()` detects an OAuth callback URL, it sets
`oauthInFlight = true` synchronously, then awaits the existing
`checkAuth()` to settle the "already-authenticated" edge case
(spec §Edge Cases). If `checkAuth` lands authenticated, route to `/`
and clear the flag. Otherwise call `handleOAuthCallback(state)`.

**Rationale**:

- The route action was performing two responsibilities (decide
  visual + start handshake). Boot-time dispatch lets the route
  action become trivial (return `LoginPage` as a fallback that the
  App shell will never actually display while the flag is set).
- The pre-existing `if (state.isAuthenticated.value)` short-circuit
  in the route action is preserved by running `checkAuth` first at
  boot — a refreshed callback URL still routes home without trying
  to consume an already-spent state from KV.

**Alternatives considered**:

- *Skip `checkAuth` entirely on the callback path and let the
  server return 401 if the state is spent.* Rejected: produces a
  spurious error message ("Authentication failed") in a perfectly
  legitimate "user refreshed the callback URL" scenario.

## Decision 4 — Clear stale `authError` at entry

**Decision**: Wrap the entry of `handleOAuthCallback` in:

```ts
batch(() => {
    state.authError.value = null
    state.authLoading.value = true
})
```

**Rationale**:

- Belt-and-suspenders for FR-002: even though the App shell
  short-circuit prevents `LoginPage` from rendering during the
  callback window, clearing the error at entry guarantees that any
  future code path that does reach `LoginPage` during the window
  cannot pull in a stale error from a prior attempt.
- `batch()` ensures no intermediate render sees one signal updated
  without the other (Constitution: state mgmt section).

**Alternatives considered**:

- *Clear `authError` in `LoginPage`'s effect.* Rejected: would also
  clear errors that are *meant* to be displayed on the genuine
  `/login` route after a failed OAuth attempt, defeating SC-004.

## Decision 5 — Loader component visuals

**Decision**: A tiny dedicated component, `<OAuthCallbackLoader/>`,
renders a centred spinner + the text "Signing in…" (or equivalent
non-error microcopy). No header, no footer, no form fields, no
error region — matches spec FR-003 ("non-error loading indication
or visually neutral") and FR-005 (no redirect to login form during
the interim).

**Rationale**:

- `PageSkeleton` is the feed-reader skeleton; rendering it during
  OAuth would (a) be misleading (feeds are not loading; auth is)
  and (b) flash the Header which knows about the user but the user
  signal is null at this point.
- A minimal component keeps the rendered DOM tiny so the visual
  transition into the authenticated UI is one continuous loading
  state rather than a complex skeleton swap.

**Alternatives considered**: Reuse `PageSkeleton` (rejected, see
above); render nothing/blank (acceptable per spec but slightly less
informative — chose spinner+text).

## Out of scope (confirmed)

- Server-side OAuth (`src/server/auth/oauth.ts`): untouched.
- Dev-mode login (`State.devLogin`): not the bug-reported path
  (spec §Assumptions).
- Local-first / sync changes: none required.
- Any HTTP API contract: none changed.
