# Implementation Plan: No flash of login form during OAuth callback

**Branch**: `017-fix-oauth-callback-flash` | **Date**: 2026-05-10
**Spec**: [spec.md](./spec.md)

## Summary

After a successful Bluesky OAuth handshake, the browser is redirected
back to `/oauth/callback?code=…&state=…&iss=…`. The SPA currently
returns the `LoginPage` component from the `/oauth/callback` route
action while `State.handleOAuthCallback()` is in flight, and the App
shell's "render normally" fall-through has no special case for the
callback route. Result: the user briefly sees the login form (and,
when `state.authError` is stale from a prior attempt, an error message)
for ~500ms-2s between the provider redirect and the authenticated UI.

The fix introduces a single boolean signal, `oauthInFlight`, set
synchronously at app boot when the URL matches the callback shape and
cleared in `handleOAuthCallback`'s `finally`. The App shell short-
circuits to a neutral `<OAuthCallbackLoader/>` whenever that flag is
true, so `LoginPage` cannot render during the callback window from
any route. `handleOAuthCallback` also clears stale `authError` at the
start of every attempt, so a previous failure cannot leak into the
in-flight render even if some other render path were to reach
`LoginPage`. No HTTP, sync, or schema contracts change.

## Technical Context

**Language/Version**: TypeScript (browser, ES2022 lib via Vite for
the SPA; Cloudflare Workers + ES2022 lib for the server, unchanged
here)
**Primary Dependencies**: Preact + `@preact/signals`, `htm/preact`,
`route-event`, `@substrate-system/routes` (all already in use)
**Storage**: N/A. Client signals only; no DO SQLite changes, no local
SQLite changes, no `/api/sync` payload changes.
**Testing**: Existing Vitest + manual browser verification at
`http://127.0.0.1:2222` against a real Bluesky OAuth round-trip
**Target Platform**: Browser (Preact SPA served by Vite in dev, by
the Cloudflare Worker in prod)
**Project Type**: Web application (Worker + Preact SPA, single repo)
**Performance Goals**: Zero rendered frames of `LoginPage` between
the provider redirect and the authenticated UI (SC-001, SC-002).
**Constraints**: Must not regress first-visit unauthenticated users
(SC-005). Must still surface genuine OAuth failures (SC-004). Pure
UI lifecycle — no network, no schema, no server change.
**Scale/Scope**: One new signal, one new component, three edited
files (`state.ts`, `index.ts`, `routes/index.ts`).

## Constitution Check

*Re-evaluated after Phase 1 design — still passes.*

- **I. Local-First Reads.** No read path changes. `loadFeeds`,
  `loadItems`, `loadCounts` are untouched. PASS.
- **II. Idempotent, Outbox-Backed Sync.** No mutations introduced.
  No outbox or `/api/sync` contract change. PASS.
- **III. Edge-Native Topology.** No server code changes; the worker,
  Durable Object, OAuth backend, and KV bindings are untouched. PASS.
- **IV. Capability-Gated Progressive Enhancement.** No
  `getAdapter()` change; the fix is purely a render-time decision
  in the App shell. Works identically in `localAdapter` and
  `remoteAdapter` modes. PASS.
- **V. Bluesky-Anchored Identity.** No auth flow change. The
  existing Bluesky OAuth → cookie-session → `checkAuth` pipeline is
  unchanged; we only reorder when the client kicks off
  `handleOAuthCallback` (boot vs. route action) and gate the visual
  layer during that window. PASS.

No principle violations. No Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/017-fix-oauth-callback-flash/
├── plan.md              # This file
├── spec.md              # Feature spec (already exists)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (client signal model)
├── quickstart.md        # Phase 1 output (manual verification)
└── contracts/
    └── oauth-callback-window.md   # UI contract for the callback window
```

### Source Code (repository root)

```text
src/
├── client/
│   ├── index.ts                 # App shell — short-circuit to loader
│   ├── state.ts                 # oauthInFlight signal + boot dispatch
│   ├── routes/
│   │   └── index.ts             # /oauth/callback action simplified
│   └── components/
│       ├── oauth-loader.ts      # NEW — neutral callback loader
│       └── oauth-loader.css     # NEW — minimal styling, reused vars
└── server/                      # untouched
    └── auth/oauth.ts            # untouched

test/
└── manual/                      # quickstart verification script lives here
```

**Structure Decision**: Existing Preact + Vite SPA layout under
`src/client/`. One new component (`oauth-loader.ts` + `.css`), three
edited files. No new directories.

## Complexity Tracking

No constitution violations — table intentionally empty.
