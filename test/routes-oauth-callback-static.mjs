import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routes = readFileSync(
    new URL('../src/client/routes/index.ts', import.meta.url),
    'utf8'
)

const callbackRoute = routes.match(
    /router\.addRoute\('\/oauth\/callback', \(\) => \{[\s\S]*?\n    \}\)/
)?.[0] ?? ''

// The OAuth handshake is dispatched at boot from `State()` so the App
// shell can short-circuit to the loader before any route action runs.
// Calling `handleOAuthCallback` from the route action would
// reintroduce the login-form flash this feature exists to fix.
assert.doesNotMatch(
    callbackRoute,
    /handleOAuthCallback/,
    'OAuth callback route action must not call handleOAuthCallback ' +
        '(boot-dispatched in state.ts; see specs/017-fix-oauth-callback-flash)'
)

// The fallback `LoginPage` return is intentional and depends on the
// App shell short-circuiting to `<OAuthCallbackLoader/>` while
// `state.oauthInFlight` is true. Lock this contract in.
assert.match(
    callbackRoute,
    /return LoginPage/,
    'OAuth callback route action returns LoginPage as fallback'
)
