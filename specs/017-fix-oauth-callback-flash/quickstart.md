# Quickstart: Verify the OAuth callback flash fix

**Feature**: 017-fix-oauth-callback-flash
**Date**: 2026-05-10

This is the manual verification script that satisfies the
constitution's "Local verification" gate. Type-check and unit tests
alone don't prove a UI lifecycle fix; this script proves it.

## Prerequisites

- Real Bluesky account (the dev-mode "skip OAuth" path is not under
  test — see spec §Assumptions).
- Local dev server running: `npm start` → app at
  `http://127.0.0.1:2222/`.
- Browser DevTools open with the **Performance** tab ready to
  record at 4× CPU throttling (to make any flash easier to catch).
- A screen recorder ready (QuickTime, OBS, or browser-native
  recording) for the slow-motion repro pass.

## Acceptance loop — happy path (SC-001, SC-002, SC-003)

For each of 10 consecutive runs:

1. From `http://127.0.0.1:2222/`, click **Sign in with Bluesky**.
2. Complete the handshake at the Bluesky identity provider.
3. The browser redirects back to `http://127.0.0.1:2222/oauth/callback?…`
   and then on to `/`.
4. **Observe** the window between the redirect-back paint and the
   authenticated feed-reader paint. Expected:
   - **Zero frames** containing the login form (input, submit
     button, "Sign in with Bluesky" text).
   - **Zero frames** containing any error message (red banner,
     `error-message` class, "Authentication failed", etc.).
   - A continuous neutral loading state (`<OAuthCallbackLoader/>`)
     for the entire window.
5. Once the feed reader is rendered, **log out** (header button) and
   start the next run.

If any run shows a login-form frame or an error frame, FAIL.

## Slow-motion confirmation pass (SC-001 strict)

Run **one** sign-in with:

- DevTools Performance set to **6× CPU throttle** and **Fast 4G
  network throttle**.
- Screen recording ON for the full transition.

Step through the recording frame-by-frame from the moment the URL
becomes `/oauth/callback?…` until the feed-reader header is visible.
Confirm: no frame shows form/error. The slowdown makes any
sub-perceptual flash visible.

## Failure-still-works check (SC-004)

Confirm OAuth failures still produce a user-visible error after the
handshake concludes:

1. Edit your local `OAUTH_CLIENT_ID` (or temporarily break the local
   OAuth config) so the token exchange will fail.
2. Sign in via the form.
3. Complete the provider step.
4. After redirect-back, expected: a brief loader, **then**
   `/login` with an `authError`-driven error message visible.
5. Restore the config.

If no error is shown after the loader, FAIL — the fix is silencing
legitimate failures.

## Stale-error-cleared check (FR-002)

1. From `/login`, type a deliberately bad handle (e.g.
   `not-a-real-handle.bsky.social`) and submit. Expect a visible
   `authError` on the login page.
2. **Without reloading**, sign in correctly (use a valid handle,
   complete the provider step, return).
3. During the callback window, expected: no error message
   (`authError` is cleared at entry). Authenticated UI lands as
   normal.

If the stale error from step 1 appears during the callback in step
2, FAIL.

## First-visit unauth check (SC-005)

In a fresh private window with no cookies:

1. Navigate to `http://127.0.0.1:2222/`.
2. Expected: redirected to `/login`, `LoginPage` renders with the
   form and **no** loader stuck on screen.

If the loader shows indefinitely on a first visit (no OAuth params
in URL), FAIL — `oauthInFlight` is being initialised wrong.

## Already-authed callback URL refresh (Edge case)

1. Sign in successfully.
2. Manually paste the previous callback URL (the one with
   `code=…&state=…&iss=…`) into the address bar and press Enter.
3. Expected: brief loader, then home route (`/`). No error, no
   login form. (Server-side state may already be consumed; the
   client-side short-circuit catches the "already authenticated"
   case from `checkAuth` and routes home.)

If the user is bounced to `/login` with an error, FAIL.

## What to record in `progress.log`

After completing all checks above, append:

```
017-fix-oauth-callback-flash: manual verification PASS
  - 10/10 sign-ins clean (no form/error frames)
  - 1× slow-mo recording reviewed frame-by-frame: clean
  - failure path still surfaces error: yes
  - stale authError cleared: yes
  - first-visit unauth: login form renders normally
  - already-authed callback refresh: routes home cleanly
```

(Don't claim PASS without all six items checked.)
