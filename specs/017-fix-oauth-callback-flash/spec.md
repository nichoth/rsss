# Feature Specification: No flash of login form during OAuth callback

**Feature Branch**: `017-fix-oauth-callback-flash`
**Created**: 2026-05-10
**Status**: Draft
**Input**: User description: "When I did the OAuth login process, after it redirected me back to the `http://127.0.0.1:2222/` address, it briefly flashed some error text + the login form. That should not happen."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Clean return from OAuth provider (Priority: P1)

A user clicks "Sign in with Bluesky" on the login page, completes the OAuth handshake at the identity provider, and the browser is redirected back to the app. From the moment the app's HTML appears until the authenticated UI is visible, the user must never see the login form or any error message. The transition from "OAuth handshake in progress" to "logged in" must look like a single continuous loading state, not a brief flash of a rejected/unauthenticated screen.

**Why this priority**: This is the only behavior described in the bug report. It is a polish/credibility issue at the most sensitive moment of the user journey — the first thing the user sees after authorizing the app. A flash of an error message at this moment is alarming (it suggests the login failed) and undermines trust before the user has even seen the app.

**Independent Test**: With OAuth credentials configured, sign in via the real Bluesky OAuth flow. Watch the screen continuously from the moment the browser navigates back to the app until the feed reader is rendered. Verify no login form, no error banner, and no error text appears at any point during that window. Repeat several times in a row to catch fast/short flashes; confirm with a screen recording slowed down frame-by-frame if needed.

**Acceptance Scenarios**:

1. **Given** the user has just completed the OAuth handshake at the identity provider, **When** the browser is redirected back to the app, **Then** the user sees only a non-error loading indication (or a blank/neutral screen) until the authenticated UI renders, and never sees the login form or any error text during that window.
2. **Given** the user previously had a stale `authError` value (e.g. from a failed login attempt earlier in the same browser session), **When** they then complete a successful OAuth handshake and are redirected back, **Then** that stale error message is not shown at any point during the callback handling.
3. **Given** the OAuth callback URL contains no `error=` query parameter, **When** the app handles the callback, **Then** no error message is rendered, regardless of any prior state.
4. **Given** the OAuth handshake completes successfully, **When** the app transitions from the loading state to the authenticated UI, **Then** the login form is not rendered as an intermediate frame.

---

### Edge Cases

- **Slow OAuth completion**: The async callback handshake takes longer than usual (e.g. several seconds on a slow network). The loading state must remain stable and non-error-looking for the entire duration; it must not fall through to the login form just because the handshake is slow.
- **Failed OAuth callback**: If the OAuth handshake genuinely fails (provider returns an `error=` parameter, or the token exchange rejects), the app must show the error to the user — but only once, after the handshake has actually concluded, not as a pre-flash before it has even started.
- **Already-authenticated user hits the callback URL**: If the user is already authenticated when the callback URL is loaded (e.g. they refreshed the callback URL), the app must route them to the authenticated UI without flashing the login form.
- **Direct navigation to the callback URL with no OAuth params**: The app must not show a flash of the login form before resolving its destination.
- **OAuth callback in a route other than `/oauth/callback`**: If the redirect target is `/` (or any other route) and authentication completion is still pending, that route must also not flash the login form before authentication state settles.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: During the window between the browser returning from the OAuth provider and the authenticated UI being shown, the app MUST NOT render the login form.
- **FR-002**: During that same window, the app MUST NOT render any error message — neither a stale in-memory error from a prior auth attempt, nor an error sourced from URL query parameters that is not actually relevant to the current callback.
- **FR-003**: The app MUST render a non-error loading indication (or remain visually neutral) for the entire duration of the OAuth callback handshake, so the transition reads as continuous loading rather than as a failure followed by a recovery.
- **FR-004**: If the OAuth handshake genuinely fails, the app MUST surface the resulting error only after the handshake has concluded, and MUST NOT have shown that error (or any other error) earlier as a pre-flash.
- **FR-005**: If the user lands on the post-callback route (e.g. `/`) while authentication state is still being established, the app MUST NOT redirect them to the login form during that interim period.
- **FR-006**: The fix MUST hold across the routes that participate in the OAuth return path — at minimum the dedicated callback route and the post-callback landing route — so that neither one is the source of the flash.
- **FR-007**: The fix MUST NOT introduce a regression where genuinely unauthenticated users (who never started an OAuth flow) are denied the login form on first visit.

### Key Entities

- **Auth state**: The client-side notion of "is the user authenticated, are we still figuring it out, did the last attempt error" — the source of truth that route handlers and the login view both consult. The flash bug is fundamentally a question of how this state is initialized and read during the OAuth return window.
- **OAuth callback window**: The interval between the browser landing back on the app's URL after the identity provider redirect and the authenticated UI being committed to the screen. This window has its own visual contract (loading-only, no errors, no login form) that is distinct from both the unauthenticated and authenticated steady states.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In ten consecutive successful OAuth sign-ins (real provider, normal network), the user sees zero frames containing the login form between the redirect back and the authenticated UI being visible.
- **SC-002**: In those same ten sign-ins, the user sees zero frames containing any error message during the same window.
- **SC-003**: The transition from "browser returned from provider" to "authenticated UI rendered" reads as a single continuous loading state, with no intermediate UI of a different kind appearing at any point.
- **SC-004**: When OAuth genuinely fails, the user still sees a clear error message after the handshake concludes (the fix does not silence legitimate failure feedback).
- **SC-005**: A first-time visitor with no prior session who navigates directly to the app's root URL still sees the login form on first visit (the fix does not over-suppress the login UI for users who actually need to see it).

## Assumptions

- The bug report's "redirected me back to the `http://127.0.0.1:2222/` address" describes the user's perceived endpoint of the OAuth round-trip; the actual callback URL handled by the app is `/oauth/callback` (and/or a redirect-onward to `/`). The flash can originate at either the callback route or the landing route, and the fix must cover both.
- The flashed "error text" the user observed is either (a) a stale `authError` value carried over from earlier client state, or (b) an `error=` query parameter being read by the login view regardless of whether it is relevant to the current OAuth attempt. The spec does not pin down which; both must be prevented from rendering during the callback window.
- The intent is to remove the flash entirely, not to merely shorten it. A "shorter flash" still fails this spec.
- The dev-mode "Dev Login (skip OAuth)" path is out of scope for this bug — the report is specifically about the real OAuth round-trip.
- Server-side OAuth behavior (token exchange, session cookie issuance) is assumed correct and out of scope; this is purely a client UI lifecycle concern.
- No persistence, schema, or API contract changes are needed.
