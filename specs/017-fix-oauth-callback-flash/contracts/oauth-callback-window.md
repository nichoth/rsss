# UI Contract: OAuth callback window

**Feature**: 017-fix-oauth-callback-flash
**Date**: 2026-05-10

This feature has no external API contract (no HTTP/sync/schema
change). It has a **visual / lifecycle contract** that the App
shell must obey from the moment a callback URL is loaded until the
authenticated UI is committed. This file documents that contract so
future reviewers can confirm it is still in force.

## Window definition

The **OAuth callback window** begins when the SPA boots on an
OAuth-callback URL (`/oauth/callback` path, or any path with all
three of `code`, `state`, `iss` query params) and ends when
`State.handleOAuthCallback()` resolves (success or any error), or
when the already-authenticated short-circuit completes.

Equivalent state predicate: `state.oauthInFlight.value === true`.

## Permitted renders during the window

The App shell MUST render exactly one of:

- `<OAuthCallbackLoader/>` — the neutral loading component, OR
- nothing (e.g. the very first paint before signals settle is
  acceptable to be visually blank).

The shell MUST NOT render `LoginPage`, `FeedReader`, `ItemReader`,
`PageSkeleton`, `ItemSkeleton`, `Header`, `footer`, or any other
component during the window.

## Forbidden renders during the window

- The login form (`<form class="login-form">`).
- The "Sign in with Bluesky" button (`Signing in…` text in disabled
  state included — it implies the form is mounted).
- Any error message (`<div class="error-message">`), including:
  - the `authError`-derived banner in `LoginPage`,
  - the `URLSearchParams.get('error')`-derived banner in `LoginPage`,
  - any global error banner anywhere else in the shell.
- Any redirect chain ending on `LoginPage` (FR-005).

## Forbidden transitions

| Forbidden                                                        | Why                                                                |
|------------------------------------------------------------------|--------------------------------------------------------------------|
| `oauthInFlight: true → false → true` within a single window      | Window must be a single continuous loading state (SC-003).         |
| Genuine OAuth failure rendered *before* the window closes        | FR-004: errors only after handshake concludes.                     |
| `LoginPage` rendered while `oauthInFlight === true`              | Invariant I2 from data-model.md.                                   |

## After the window closes

| Outcome                            | Required end state                                                              |
|------------------------------------|---------------------------------------------------------------------------------|
| OAuth success                      | `user.value !== null`, `route.value === data.returnTo || '/'`, App shell renders the home route (initially `PageSkeleton`, then `FeedReader` after `refreshAfterSync`). |
| OAuth failure (any cause)          | `user.value === null`, `route.value === '/login'`, `LoginPage` renders with `authError` populated. The error text MUST be the failure reason; SC-004. |
| Already-authenticated short-circuit | `user.value !== null` (from `checkAuth`), `route.value === '/'`, App shell renders the home route as for success.                                    |

## Test obligation

Each of these renders is observable from a Playwright/manual
session. The quickstart (`./quickstart.md`) defines the minimum
verification: ten consecutive sign-ins, zero login-form frames
during any callback window, and one successful failure-rendering
sign-in to confirm SC-004.

## Non-contracts

- The exact visual treatment of `<OAuthCallbackLoader/>` (spinner
  vs. blank vs. ASCII characters): not specified. Only the *absence*
  of forbidden renders is contractual.
- The hop count of the OAuth round-trip and the duration of the
  window: not specified. The contract holds for any duration
  (FR-003 covers slow handshakes).
