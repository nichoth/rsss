import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
    startOAuthFlow,
    exchangeCode,
    createSessionCookie,
    verifySessionCookie,
    type OAuthSession,
    type OAuthState
} from './auth/oauth.js'
import { UserDO } from './durable-objects/index.js'
import type { Context, Next } from 'hono'

// Re-export the Durable Object class for Wrangler
export { UserDO }

export interface Env {
    COLLIE_USER:DurableObjectNamespace<UserDO>
    SESSIONS:KVNamespace
    ASSETS:Fetcher
    SESSION_SECRET:string
    OAUTH_CLIENT_ID?:string
    NODE_ENV:string
}

type Variables = {
    session:OAuthSession|null
}

const app = new Hono<{ Bindings:Env; Variables:Variables }>()

// CORS for API routes
app.use('/api/*', cors())

// Session middleware
app.use('*', async (c, next) => {
    const sessionCookie = getCookie(c, 'session')

    if (sessionCookie && c.env.SESSION_SECRET) {
        const session = await verifySessionCookie(
            sessionCookie,
            c.env.SESSION_SECRET
        )
        c.set('session', session)
    } else {
        c.set('session', null)
    }

    await next()
})

/**
 * Health check
 */
app.get('/api/health', (c) => {
    return c.json({ status: 'ok', service: 'rsss' })
})

app.get('/health', (c) => {
    return c.json({ status: 'ok' })
})

/**
 * OAuth client metadata (AT Protocol OAuth discovery)
 */
app.get('/oauth/client-metadata.json', (c) => {
    const baseUrl = new URL(c.req.url).origin

    return c.json({
        client_id: `${baseUrl}/oauth/client-metadata.json`,
        client_name: 'rsss',
        client_uri: baseUrl,
        logo_uri: `${baseUrl}/logo.png`,
        tos_uri: `${baseUrl}/terms`,
        policy_uri: `${baseUrl}/privacy`,
        redirect_uris: [
            `${baseUrl}/oauth/callback`
        ],
        scope: 'atproto',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        dpop_bound_access_tokens: true
    })
})

/**
 * Get current user info
 */
app.get('/api/me', (c) => {
    const session = c.get('session')

    if (!session) {
        return c.json({ authenticated: false }, 401)
    }

    return c.json({
        authenticated: true,
        did: session.did,
        handle: session.handle
    })
})

/**
 * Start OAuth login flow
 */
app.post('/api/auth/login', async (c) => {
    try {
        const body = await c.req.json<{ handle: string }>()

        if (!body.handle) {
            return c.json({ error: 'Handle is required' }, 400)
        }

        const baseUrl = new URL(c.req.url).origin
        const clientId = (
            c.env.OAUTH_CLIENT_ID ||
            `${baseUrl}/oauth/client-metadata.json`
        )
        const redirectUri = `${baseUrl}/oauth/callback`

        const { authUrl, state } = await startOAuthFlow(
            body.handle,
            clientId,
            redirectUri,
            '/'
        )

        // Store state in KV with 10 minute expiry
        const stateKey = `oauth:${state.nonce}`
        await c.env.SESSIONS.put(stateKey, JSON.stringify(state), {
            expirationTtl: 600
        })

        return c.json({ authUrl, state: state.nonce })
    } catch (err) {
        console.error('OAuth start error:', err)
        return c.json({
            error: err instanceof Error ? err.message : 'Failed to start OAuth'
        }, 500)
    }
})

/**
 * OAuth callback - exchanges code for tokens
 */
app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code')
    const _stateParam = c.req.query('state')
    const error = c.req.query('error')
    const errorDescription = c.req.query('error_description')

    if (error) {
        return c.redirect(`/login?error=${encodeURIComponent(errorDescription || error)}`)
    }

    if (!code) {
        return c.redirect('/login?error=No+authorization+code')
    }

    // For simplicity, we'll get the state from the cookie set during login
    // In production, you'd want to validate the state parameter properly
    const nonce = c.req.query('state') || ''

    try {
        // Get stored state from KV
        const stateKey = `oauth:${nonce}`
        const storedStateJson = await c.env.SESSIONS.get(stateKey)

        if (!storedStateJson) {
            return c.redirect('/login?error=Invalid+or+expired+state')
        }

        const storedState = JSON.parse(storedStateJson) as OAuthState

        // Get auth server from the issuer in the callback
        const iss = c.req.query('iss')
        if (!iss) {
            return c.redirect('/login?error=Missing+issuer')
        }

        const baseUrl = new URL(c.req.url).origin
        const clientId = c.env.OAUTH_CLIENT_ID || `${baseUrl}/oauth/client-metadata.json`
        const redirectUri = `${baseUrl}/oauth/callback`

        const session = await exchangeCode(
            code,
            storedState,
            clientId,
            redirectUri,
            iss
        )

        // Delete the used state
        await c.env.SESSIONS.delete(stateKey)

        // Create session cookie
        const sessionCookie = await createSessionCookie(session, c.env.SESSION_SECRET)

        setCookie(c, 'session', sessionCookie, {
            httpOnly: true,
            secure: c.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            path: '/',
            maxAge: 30 * 24 * 60 * 60 // 30 days
        })

        return c.redirect(storedState.returnTo || '/')
    } catch (err) {
        console.error('OAuth callback error:', err)
        return c.redirect(`/login?error=${encodeURIComponent(err instanceof Error ? err.message : 'Authentication failed')}`)
    }
})

/**
 * Logout
 */
app.post('/api/auth/logout', (c) => {
    deleteCookie(c, 'session', { path: '/' })
    return c.json({ success: true })
})

app.get('/logout', (c) => {
    deleteCookie(c, 'session', { path: '/' })
    return c.redirect('/login')
})

const requireAuth = async (c:Context<{
    Bindings:Env;
    Variables:Variables
}>, next:Next) => {
    const session = c.get('session')

    if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
}

/**
 * Get the user's Durable Object
 */
function getUserDO (env:Env, did:string):DurableObjectStub<UserDO> {
    // Use the DID as the DO name for consistent routing
    const id = env.COLLIE_USER.idFromName(did)
    return env.COLLIE_USER.get(id)
}

/**
 * Proxy requests to user's Durable Object
 * All /api/collie/* routes go to the user's DO
 */
app.all('/api/*', requireAuth, async (c) => {
    const session = c.get('session')!
    const stub = getUserDO(c.env, session.did)

    // Build the request URL for the DO
    const url = new URL(c.req.url)
    const doPath = url.pathname.replace('/api', '')
    const doUrl = new URL(doPath || '/', 'http://do')
    doUrl.search = url.search

    // Forward the request to the DO
    const response = await stub.fetch(new Request(doUrl.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body
    }))

    return response
})

/**
 * Development mode: mock authentication for testing
 */
app.post('/api/auth/dev-login', async (c) => {
    // Only allow in development mode
    if (c.env.NODE_ENV !== 'development') {
        return c.json({ error: 'Not allowed in production' }, 403)
    }

    const body = await c.req.json<{ did?:string; handle?:string }>()

    const session: OAuthSession = {
        did: body.did || 'did:plc:test123',
        handle: body.handle || 'test.bsky.social',
        accessToken: 'dev-token',
        refreshToken: 'dev-refresh',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    }

    const sessionCookie = await createSessionCookie(session, c.env.SESSION_SECRET || 'dev-secret-key-32-chars-long!!')

    setCookie(c, 'session', sessionCookie, {
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60
    })

    return c.json({ success: true, session })
})

/**
 * Serve static assets (Preact frontend)
 */
app.all('*', (c) => {
    if (!c.env?.ASSETS) {
        // In dev mode, let Vite handle static assets
        return c.notFound()
    }

    return c.env.ASSETS.fetch(c.req.raw)
})

export default app
