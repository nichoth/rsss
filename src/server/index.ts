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
    USER_DO:DurableObjectNamespace<UserDO>
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
 * OAuth callback -- API endpoint.
 * The SPA handles the /oauth/callback route client-side
 * and POSTs the params here, because Cloudflare's
 * SPA fallback intercepts GET /oauth/callback before
 * the Worker runs.
 */
app.post('/api/auth/callback', async (c) => {
    // If already authenticated, no need to process
    // the callback again -- state is likely expired.
    const existing = c.get('session')
    if (existing) {
        return c.json({ success: true, returnTo: '/' })
    }

    const body = await c.req.json<{
        code?:string;
        state?:string;
        iss?:string;
        error?:string;
        error_description?:string;
    }>()

    if (body.error) {
        return c.json({
            error: body.error_description || body.error
        }, 400)
    }

    if (!body.code) {
        return c.json({
            error: 'No authorization code'
        }, 400)
    }

    const nonce = body.state || ''

    try {
        const stateKey = `oauth:${nonce}`
        const storedStateJson = await c.env.SESSIONS.get(
            stateKey
        )

        if (!storedStateJson) {
            console.error(
                'OAuth state not found in KV:',
                stateKey
            )
            return c.json({
                error: 'Invalid or expired OAuth state'
                    + ' -- please try logging in again'
            }, 400)
        }

        const storedState = JSON.parse(
            storedStateJson
        ) as OAuthState

        if (!body.iss) {
            return c.json({
                error: 'Missing issuer'
            }, 400)
        }

        const baseUrl = new URL(c.req.url).origin
        const clientId = (
            c.env.OAUTH_CLIENT_ID ||
            `${baseUrl}/oauth/client-metadata.json`
        )
        const redirectUri = `${baseUrl}/oauth/callback`

        const session = await exchangeCode(
            body.code,
            storedState,
            clientId,
            redirectUri,
            body.iss
        )

        // Delete the used state
        await c.env.SESSIONS.delete(stateKey)

        // Track this user in KV for admin tools
        await c.env.SESSIONS.put(
            `user:${session.did}`,
            session.handle
        )

        // Create session cookie
        const sessionCookie = await createSessionCookie(
            session,
            c.env.SESSION_SECRET
        )

        setCookie(c, 'session', sessionCookie, {
            httpOnly: true,
            secure: c.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            path: '/',
            maxAge: 30 * 24 * 60 * 60 // 30 days
        })

        return c.json({
            success: true,
            returnTo: storedState.returnTo || '/'
        })
    } catch (err) {
        console.error('OAuth callback error:', err)
        return c.json({
            error: err instanceof Error ?
                err.message :
                'Authentication failed'
        }, 500)
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
function getUserDO (
    env:Env,
    did:string
):DurableObjectStub<UserDO> {
    // Use the DID as the DO name for consistent routing
    const id = env.USER_DO.idFromName(did)
    return env.USER_DO.get(id)
}

/**
 * Development mode: mock authentication for testing.
 * Must be before the /api/* catch-all.
 */
app.post('/api/auth/dev-login', async (c) => {
    // Only allow in development mode
    if (c.env.NODE_ENV !== 'development') {
        return c.json(
            { error: 'Not allowed in production' },
            403
        )
    }

    const body = await c.req.json<{
        did?:string;
        handle?:string
    }>()

    const session:OAuthSession = {
        did: body.did || 'did:plc:test123',
        handle: body.handle || 'test.bsky.social',
        accessToken: 'dev-token',
        refreshToken: 'dev-refresh',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    }

    const secret = (
        c.env.SESSION_SECRET
            || 'dev-secret-key-32-chars-long!!'
    )
    const sessionCookie = await createSessionCookie(
        session, secret
    )

    // Track this user in KV for admin tools
    await c.env.SESSIONS.put(
        `user:${session.did}`,
        session.handle
    )

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
 * Proxy requests to user's Durable Object.
 * All /api/* routes go to the user's DO.
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
    const response = await stub.fetch(
        new Request(doUrl.toString(), {
            method: c.req.method,
            headers: c.req.raw.headers,
            body: c.req.raw.body
        })
    )

    return response
})

/**
 * Admin: list all tracked users
 */
app.get('/admin/users', async (c) => {
    const result = await c.env.SESSIONS.list({
        prefix: 'user:'
    })
    const users = await Promise.all(
        result.keys.map(async (key) => {
            const did = key.name.replace('user:', '')
            const handle = await c.env.SESSIONS.get(
                key.name
            )
            return { did, handle }
        })
    )
    return c.json({ users })
})

/**
 * Admin: refresh all feeds for all tracked users.
 * Accepts optional `dids` array in body to refresh
 * specific users only.
 */
app.post('/admin/refresh-all', async (c) => {
    let dids:string[]

    // Check if specific DIDs were provided
    const body = await c.req.json<{
        dids?:string[]
    }>().catch(() => ({ dids: undefined }))

    if (body.dids && body.dids.length > 0) {
        dids = body.dids
    } else {
        // List all tracked users from KV
        const result = await c.env.SESSIONS.list({
            prefix: 'user:'
        })
        dids = result.keys.map(
            (key) => key.name.replace('user:', '')
        )
    }

    if (dids.length === 0) {
        return c.json({
            error: 'No users found. Log in first.',
            results: []
        }, 404)
    }

    const results:Record<string, unknown>[] = []
    for (const did of dids) {
        try {
            const stub = getUserDO(c.env, did)
            const res = await stub.fetch(
                new Request(
                    'http://do/feeds/refresh',
                    { method: 'POST' }
                )
            )
            const data = await res.json() as Record<
                string, unknown
            >
            const handle = await c.env.SESSIONS.get(
                `user:${did}`
            )
            results.push({
                did,
                handle,
                success: true,
                ...data
            })
        } catch (err) {
            results.push({
                did,
                success: false,
                error: err instanceof Error
                    ? err.message
                    : 'Unknown error'
            })
        }
    }

    return c.json({ results })
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
