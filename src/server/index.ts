import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
    startOAuthFlow,
    exchangeCode,
    createSessionCookie,
    verifySessionCookie,
    destroySessionCookie,
    type OAuthSession,
    type OAuthState
} from './auth/oauth.js'
import { UserDO } from './durable-objects/index.js'
import { withIsolationHeaders } from './isolation-headers.js'
import {
    BILLING_PLAN_IDS,
    isValidPlanId,
    useLive as billingUseLive,
    getOrCreateCustomer,
    attachCheckout,
    verifySubscription,
    getCustomerPortalUrl,
    type BillingPlanId
} from './autumn-billing.js'
import {
    sendSubscriptionStarted,
    sendPaymentFailed
} from './email.js'
import type { Context, Next } from 'hono'

// Re-export the Durable Object class for Wrangler
export { UserDO }

export interface Env {
    USER_DO:DurableObjectNamespace<UserDO>;
    SESSIONS:KVNamespace;
    ASSETS:Fetcher;
    SESSION_SECRET:string;
    OAUTH_CLIENT_ID?:string;
    AUTUMN_SECRET_KEY?:string;
    AUTUMN_DISABLED?:string;
    RESEND_API_KEY?:string;
    RESEND_DISABLED?:string;
    RESEND_FROM?:string;
    ADMIN_TOKEN?:string;
    APP_ORIGIN?:string;
    NODE_ENV:string;
}

interface CachedBilling {
    planId:string;
    status:'active'|'scheduled'|'none';
    refreshedAt:number;
}

const BILLING_CACHE_TTL_SECONDS = 600
const DEFAULT_PLAN_ID:BillingPlanId = 'local-first'

function billingCacheKey (did:string):string {
    return `billing:${did}`
}

function pendingEmailKey (did:string):string {
    return `billing_pending_email:${did}`
}

const PENDING_EMAIL_TTL_SECONDS = 60 * 60 * 24 * 2  // 2 days

async function stashPendingEmail (
    env:Env,
    did:string,
    email:string
):Promise<void> {
    await env.SESSIONS.put(
        pendingEmailKey(did),
        email,
        { expirationTtl: PENDING_EMAIL_TTL_SECONDS }
    )
}

async function readPendingEmail (
    env:Env,
    did:string
):Promise<string|null> {
    return env.SESSIONS.get(pendingEmailKey(did))
}

/**
 * Resolve the user's contact email for billing notifications.
 * The checkout path stashes the email returned by Autumn when live
 * billing creates or updates the customer, so notification paths can
 * use KV instead of re-fetching the same customer record.
 */
async function resolveContactEmail (
    env:Env,
    did:string
):Promise<string|null> {
    return readPendingEmail(env, did)
}

function isProbablyEmail (s:unknown):s is string {
    return typeof s === 'string'
        && s.length > 3
        && s.length < 320
        && /.+@.+\..+/.test(s)
}

async function readCachedBilling (
    env:Env,
    did:string
):Promise<CachedBilling|null> {
    const raw = await env.SESSIONS.get(billingCacheKey(did))
    if (!raw) return null
    try {
        return JSON.parse(raw) as CachedBilling
    } catch {
        return null
    }
}

async function writeCachedBilling (
    env:Env,
    did:string,
    value:CachedBilling
):Promise<void> {
    await env.SESSIONS.put(
        billingCacheKey(did),
        JSON.stringify(value),
        { expirationTtl: BILLING_CACHE_TTL_SECONDS }
    )
}

function isEntitled (b:CachedBilling|null):boolean {
    if (!b) return false
    return b.status === 'active' || b.status === 'scheduled'
}

function canUseDevBillingShortcut (env:Env):boolean {
    return env.NODE_ENV === 'development' && !billingUseLive(env)
}

/**
 * Resolve current entitlement, refreshing from Autumn when there's
 * no cached value. Local dev (no Autumn key) treats the cached value
 * as authoritative -- /api/billing/checkout writes 'active' directly.
 */
async function resolveBilling (
    env:Env,
    did:string,
    planId:BillingPlanId = DEFAULT_PLAN_ID
):Promise<CachedBilling> {
    const cached = await readCachedBilling(env, did)
    if (cached) return cached

    if (!billingUseLive(env)) {
        // No Autumn configured -- treat as not entitled. Dev path
        // creates entitlement explicitly via /api/billing/checkout.
        const fresh:CachedBilling = {
            planId,
            status: 'none',
            refreshedAt: Date.now()
        }
        await writeCachedBilling(env, did, fresh)
        return fresh
    }

    const verified = await verifySubscription(env, did, planId)
    const fresh:CachedBilling = {
        planId,
        status: verified ? verified.status : 'none',
        refreshedAt: Date.now()
    }
    await writeCachedBilling(env, did, fresh)
    return fresh
}

type Variables = {
    session:OAuthSession|null;
}

type AppContext = Context<{
    Bindings:Env;
    Variables:Variables;
}>

const STATE_CHANGING_METHODS = new Set([
    'DELETE',
    'PATCH',
    'POST',
    'PUT'
])

function productionConfigErrors (env:Env):string[] {
    const errors:string[] = []

    if (env.NODE_ENV === 'production' && !env.AUTUMN_SECRET_KEY) {
        errors.push('missing_autumn_secret')
    }

    if (!env.APP_ORIGIN) {
        errors.push('missing_app_origin')
    }

    return errors
}

function isLoopbackHostname (hostname:string):boolean {
    return hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'
}

function shouldUseSecureSessionCookie (requestUrl:string):boolean {
    return !isLoopbackHostname(new URL(requestUrl).hostname)
}

function isStateChangingMethod (method:string):boolean {
    return STATE_CHANGING_METHODS.has(method)
}

function isCsrfExemptPath (path:string):boolean {
    return path === '/api/auth/login' ||
        path === '/api/auth/callback' ||
        path === '/api/auth/dev-login'
}

function generateCsrfToken ():string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const binary = String.fromCharCode(...bytes)
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function setCsrfCookie (c:AppContext):void {
    setCookie(c, 'csrf_token', generateCsrfToken(), {
        httpOnly: false,
        secure: shouldUseSecureSessionCookie(c.req.url),
        sameSite: 'Lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60
    })
}

export function isAllowedRequestOrigin (
    origin:string,
    _requestUrl:string,
    appOrigin?:string
):boolean {
    return Boolean(appOrigin) && origin === appOrigin
}

export function isCrossOriginStateChange (
    method:string,
    requestUrl:string,
    origin:string|null|undefined,
    fetchSite:string|null|undefined,
    appOrigin?:string
):boolean {
    if (!isStateChangingMethod(method)) return false
    if (!origin && !fetchSite) return true
    if (origin && !isAllowedRequestOrigin(
        origin,
        requestUrl,
        appOrigin
    )) {
        return true
    }
    return fetchSite === 'cross-site'
        || (!origin && fetchSite === 'same-site')
}

export function hasValidCsrfToken (
    cookieHeader:string|null|undefined,
    headerToken:string|null|undefined
):boolean {
    const cookieToken = cookieHeader?.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith('csrf_token='))
        ?.slice('csrf_token='.length)
    return Boolean(cookieToken && headerToken && cookieToken === headerToken)
}

function allowedCorsOrigin (
    origin:string,
    c:Context
):string|null {
    const appContext = c as AppContext
    if (!origin) return null
    const appOrigin = appContext.env.APP_ORIGIN
    return isAllowedRequestOrigin(origin, appContext.req.url, appOrigin) ?
        origin :
        null
}

const rejectCrossOriginStateChanges = async (
    c:AppContext,
    next:Next
) => {
    const origin = c.req.header('origin')
    const fetchSite = c.req.header('sec-fetch-site')
    const appOrigin = c.env.APP_ORIGIN
    const path = new URL(c.req.url).pathname

    if (
        !isCsrfExemptPath(path) &&
        isCrossOriginStateChange(
            c.req.method,
            c.req.url,
            origin,
            fetchSite,
            appOrigin
        )
    ) {
        return c.json({ error: 'Cross-origin request rejected' }, 403)
    }

    if (
        isStateChangingMethod(c.req.method) &&
        !isCsrfExemptPath(path) &&
        !hasValidCsrfToken(
            c.req.header('cookie'),
            c.req.header('x-csrf-token')
        )
    ) {
        return c.json({ error: 'CSRF token mismatch' }, 403)
    }

    await next()
}

const app = new Hono<{ Bindings:Env; Variables:Variables }>()

// Cross-origin isolation headers required for OPFS sync access handles
app.use('*', async (c, next) => {
    await next()
    c.res = withIsolationHeaders(c.res)
})

// CORS for API routes
app.use('/api/*', cors({
    origin: allowedCorsOrigin,
    credentials: true
}))

app.use('*', rejectCrossOriginStateChanges)

// Session middleware
app.use('*', async (c, next) => {
    const sessionCookie = getCookie(c, 'session')

    if (sessionCookie && c.env.SESSION_SECRET) {
        const session = await verifySessionCookie(
            sessionCookie,
            c.env.SESSION_SECRET,
            c.env.SESSIONS
        )
        c.set('session', session)
        if (!session) {
            deleteCookie(c, 'session', { path: '/' })
        }
    } else {
        c.set('session', null)
    }

    await next()
})

/**
 * Health check
 */
app.get('/api/health', (c) => {
    const configErrors = productionConfigErrors(c.env)

    if (configErrors.length > 0) {
        return c.json({
            status: 'error',
            service: 'rsss',
            error: configErrors[0],
            configErrors
        }, 500)
    }

    return c.json({ status: 'ok', service: 'rsss' })
})

/**
 * Resolve the OAuth client_id and redirect_uri for the current request.
 *
 * Production / any deployment with OAUTH_CLIENT_ID set: use the
 * metadata-document flow (client_id is a public HTTPS URL pointing
 * at /oauth/client-metadata.json).
 *
 * Localhost dev: use the AT Protocol "loopback client" pattern.
 * The spec requires client_id to be the literal string
 * `http://localhost` with optional `redirect_uri` and `scope` query
 * params (not a URL pointing to a metadata document), and the
 * redirect_uri must use 127.0.0.1 (or [::1]) -- not `localhost`.
 *
 * Visit the dev server at http://127.0.0.1:PORT so the session
 * cookie lives on the same origin as the OAuth redirect target.
 */
function resolveOAuthClient (
    requestUrl:string,
    envClientId?:string
):{ clientId:string; redirectUri:string } {
    const url = new URL(requestUrl)
    const isLoopback = isLoopbackHostname(url.hostname)

    if (envClientId || !isLoopback) {
        const baseUrl = url.origin
        return {
            clientId: envClientId ||
                `${baseUrl}/oauth/client-metadata.json`,
            redirectUri: `${baseUrl}/oauth/callback`
        }
    }

    const redirectUri = `http://127.0.0.1:${url.port}/oauth/callback`
    const params = new URLSearchParams({
        redirect_uri: redirectUri,
        scope: 'atproto'
    })
    return {
        clientId: `http://localhost?${params.toString()}`,
        redirectUri
    }
}

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
        handle: session.handle,
        avatar: session.avatar
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

        const { clientId, redirectUri } = resolveOAuthClient(
            c.req.url,
            c.env.OAUTH_CLIENT_ID
        )

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

        const { clientId, redirectUri } = resolveOAuthClient(
            c.req.url,
            c.env.OAUTH_CLIENT_ID
        )

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
            c.env.SESSION_SECRET,
            c.env.SESSIONS
        )

        setCookie(c, 'session', sessionCookie, {
            httpOnly: true,
            secure: shouldUseSecureSessionCookie(c.req.url),
            sameSite: 'Lax',
            path: '/',
            maxAge: 30 * 24 * 60 * 60 // 30 days
        })
        setCsrfCookie(c)

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
app.post('/api/auth/logout', async (c) => {
    const cookie = getCookie(c, 'session')
    if (cookie && c.env.SESSION_SECRET) {
        await destroySessionCookie(
            cookie,
            c.env.SESSION_SECRET,
            c.env.SESSIONS
        )
    }
    deleteCookie(c, 'session', { path: '/' })
    deleteCookie(c, 'csrf_token', { path: '/' })
    return c.json({ success: true })
})

app.get('/logout', async (c) => {
    const cookie = getCookie(c, 'session')
    if (cookie && c.env.SESSION_SECRET) {
        await destroySessionCookie(
            cookie,
            c.env.SESSION_SECRET,
            c.env.SESSIONS
        )
    }
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

const requireEntitlement = async (c:Context<{
    Bindings:Env;
    Variables:Variables
}>, next:Next) => {
    const session = c.get('session')

    if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
        const billing = await resolveBilling(c.env, session.did)
        if (!isEntitled(billing)) {
            return c.json({ error: 'Payment required' }, 402)
        }
    } catch (err) {
        console.error('data entitlement error:', err)
        return c.json({
            error: 'billing_unavailable'
        }, 503)
    }

    await next()
}

/**
 * Constant-time comparison for admin token verification.
 * Avoids early exit on mismatch to prevent timing leaks.
 */
function timingSafeEqual (a:string, b:string):boolean {
    if (a.length !== b.length) return false
    let result = 0
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return result === 0
}

/**
 * Require an admin bearer token. Reads from `ADMIN_TOKEN` secret;
 * if unset, all admin routes return 503 (closed by default).
 */
const requireAdmin = async (c:Context<{
    Bindings:Env;
    Variables:Variables
}>, next:Next) => {
    const expected = c.env.ADMIN_TOKEN
    if (!expected) {
        return c.json({
            error: 'admin_disabled'
        }, 503)
    }

    const header = c.req.header('authorization') || ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    const provided = match ? match[1] : ''

    if (!provided || !timingSafeEqual(provided, expected)) {
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

    if (!isLoopbackHostname(new URL(c.req.url).hostname)) {
        return c.json(
            { error: 'Not allowed on non-loopback host' },
            403
        )
    }

    if (!c.env.SESSION_SECRET) {
        return c.json(
            { error: 'SESSION_SECRET is not configured' },
            500
        )
    }

    const body = await c.req.json<{
        did?:string;
        handle?:string
    }>()

    const session:OAuthSession = {
        did: body.did || 'did:plc:test123',
        handle: body.handle || 'test.bsky.social'
    }

    const sessionCookie = await createSessionCookie(
        session, c.env.SESSION_SECRET, c.env.SESSIONS
    )

    // Track this user in KV for admin tools
    await c.env.SESSIONS.put(
        `user:${session.did}`,
        session.handle
    )

    setCookie(c, 'session', sessionCookie, {
        httpOnly: true,
        secure: shouldUseSecureSessionCookie(c.req.url),
        sameSite: 'Lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60
    })
    setCsrfCookie(c)

    return c.json({ success: true, session })
})

/**
 * Billing: get current entitlement.
 * Returns cached value if fresh; refreshes from Autumn on miss.
 */
app.get('/api/billing/status', requireAuth, async (c) => {
    const session = c.get('session')!
    try {
        const billing = await resolveBilling(c.env, session.did)
        return c.json({
            entitled: isEntitled(billing),
            planId: billing.planId,
            status: billing.status,
            refreshedAt: billing.refreshedAt,
            useLive: billingUseLive(c.env)
        })
    } catch (err) {
        console.error('billing/status error:', err)
        return c.json({
            error: 'billing_unavailable'
        }, 503)
    }
})

/**
 * Billing: start checkout for a plan.
 * In live mode, returns an Autumn-hosted checkout URL.
 * In dev mode (no Autumn key), marks the user entitled directly
 * so the rest of the flow can be exercised without a real card.
 */
app.post('/api/billing/checkout', requireAuth, async (c) => {
    const session = c.get('session')!
    const body = await c.req.json<{
        planId?:string
        email?:string
    }>().catch(() => ({
        planId: undefined,
        email: undefined
    }))

    const planId = body.planId ?? DEFAULT_PLAN_ID
    if (!isValidPlanId(planId)) {
        return c.json({
            error: 'invalid_plan_id',
            allowed: BILLING_PLAN_IDS
        }, 400)
    }

    const email = isProbablyEmail(body.email) ? body.email : null
    if (email) {
        await stashPendingEmail(c.env, session.did, email)
    }

    // Dev mode: no Autumn -- mark entitled directly. Triggering
    // the success email here exercises the full Resend path
    // without a real card.
    if (!billingUseLive(c.env)) {
        if (!canUseDevBillingShortcut(c.env)) {
            return c.json({
                error: 'billing_unavailable'
            }, 503)
        }

        const billing:CachedBilling = {
            planId,
            status: 'active',
            refreshedAt: Date.now()
        }
        await writeCachedBilling(c.env, session.did, billing)

        if (email) {
            try {
                const baseUrl = new URL(c.req.url).origin
                await sendSubscriptionStarted(
                    c.env,
                    c.env.SESSIONS,
                    {
                        to: email,
                        did: session.did,
                        planId,
                        baseUrl,
                        handle: session.handle
                    }
                )
            } catch (err) {
                console.error(
                    'sendSubscriptionStarted (dev) error:',
                    err
                )
            }
        }

        return c.json({
            paymentUrl: null,
            status: 'entitled',
            planId
        })
    }

    try {
        const customer = await getOrCreateCustomer(
            c.env,
            session.did,
            session.handle,
            email ?? undefined
        )
        if (customer.email) {
            await stashPendingEmail(
                c.env,
                session.did,
                customer.email
            )
        }
        const baseUrl = new URL(c.req.url).origin
        const successUrl =
            `${baseUrl}/payment-success?checkout=return`
        const { paymentUrl } = await attachCheckout(
            c.env,
            session.did,
            planId,
            successUrl
        )
        return c.json({
            paymentUrl,
            status: 'payment_pending',
            planId
        })
    } catch (err) {
        console.error('billing/checkout error:', err)
        return c.json({
            error: 'billing_unavailable'
        }, 503)
    }
})

/**
 * Billing: finalize checkout after Autumn redirect.
 * Re-fetches the customer and asserts an active subscription.
 * Caches the entitlement on success.
 */
app.post(
    '/api/billing/checkout/return',
    requireAuth,
    async (c) => {
        const session = c.get('session')!
        const body = await c.req.json<{
            planId?:string
        }>().catch(() => ({ planId: undefined }))

        const planId = body.planId ?? DEFAULT_PLAN_ID
        if (!isValidPlanId(planId)) {
            return c.json({
                error: 'invalid_plan_id'
            }, 400)
        }

        // Dev mode: there is no Autumn round-trip, just confirm
        // whatever's already cached.
        if (!billingUseLive(c.env)) {
            if (!canUseDevBillingShortcut(c.env)) {
                return c.json({
                    error: 'billing_unavailable'
                }, 503)
            }

            const cached = await readCachedBilling(
                c.env,
                session.did
            )
            if (cached && isEntitled(cached)) {
                return c.json({
                    status: 'entitled',
                    planId: cached.planId
                })
            }
            return c.json({
                error: 'payment_incomplete'
            }, 402)
        }

        try {
            const verified = await verifySubscription(
                c.env,
                session.did,
                planId
            )
            if (!verified) {
                return c.json({
                    error: 'payment_incomplete'
                }, 402)
            }
            const billing:CachedBilling = {
                planId: verified.planId,
                status: verified.status,
                refreshedAt: Date.now()
            }
            await writeCachedBilling(
                c.env,
                session.did,
                billing
            )

            // Best-effort welcome email; failures shouldn't block
            // the entitlement response.
            try {
                const to = await resolveContactEmail(
                    c.env,
                    session.did
                )
                if (to) {
                    const baseUrl = new URL(c.req.url).origin
                    await sendSubscriptionStarted(
                        c.env,
                        c.env.SESSIONS,
                        {
                            to,
                            did: session.did,
                            planId: verified.planId,
                            baseUrl,
                            handle: session.handle
                        },
                        c.executionCtx
                    )
                }
            } catch (err) {
                console.error(
                    'sendSubscriptionStarted error:',
                    err
                )
            }

            return c.json({
                status: 'entitled',
                planId: verified.planId
            })
        } catch (err) {
            console.error(
                'billing/checkout/return error:',
                err
            )
            return c.json({
                error: 'billing_unavailable'
            }, 503)
        }
    }
)

/**
 * Billing: client-driven failure signal. Called by the
 * /payment-success page after finalizeCheckout retries are
 * exhausted without confirming a subscription. Sends the
 * "payment didn't go through" email (idempotently).
 */
app.post(
    '/api/billing/checkout/failed',
    requireAuth,
    async (c) => {
        const session = c.get('session')!
        const body = await c.req.json<{
            planId?:string
            email?:string
        }>().catch(() => ({
            planId: undefined,
            email: undefined
        }))

        const planId = body.planId ?? DEFAULT_PLAN_ID
        if (!isValidPlanId(planId)) {
            return c.json({
                error: 'invalid_plan_id'
            }, 400)
        }

        // Stash the email in case the client supplied a fresh one.
        if (isProbablyEmail(body.email)) {
            await stashPendingEmail(
                c.env,
                session.did,
                body.email
            )
        }

        let to:string|null = null
        try {
            to = await resolveContactEmail(c.env, session.did)
        } catch (err) {
            console.error('resolveContactEmail error:', err)
        }

        if (!to) {
            return c.json({
                emailed: false,
                reason: 'no_contact_email'
            })
        }

        try {
            const baseUrl = new URL(c.req.url).origin
            const result = await sendPaymentFailed(
                c.env,
                c.env.SESSIONS,
                {
                    to,
                    did: session.did,
                    planId,
                    handle: session.handle,
                    signupUrl: `${baseUrl}/signup`
                },
                c.executionCtx
            )
            return c.json({
                emailed: result.sent,
                deduped: result.deduped
            })
        } catch (err) {
            console.error('sendPaymentFailed error:', err)
            return c.json({
                error: 'email_failed'
            }, 503)
        }
    }
)

/**
 * Billing: open the Autumn-hosted customer portal.
 * Used for cancelling, updating payment method, etc.
 */
app.post('/api/billing/portal', requireAuth, async (c) => {
    const session = c.get('session')!

    if (!billingUseLive(c.env)) {
        return c.json({
            error: 'portal_unavailable_in_dev'
        }, 503)
    }

    try {
        const baseUrl = new URL(c.req.url).origin
        const url = await getCustomerPortalUrl(
            c.env,
            session.did,
            `${baseUrl}/settings`
        )
        return c.json({ url })
    } catch (err) {
        console.error('billing/portal error:', err)
        return c.json({
            error: 'billing_unavailable'
        }, 503)
    }
})

export const dataRouter = new Hono<{
    Bindings:Env;
    Variables:Variables
}>()

dataRouter.use('*', requireAuth)
dataRouter.use('*', requireEntitlement)

/**
 * Proxy requests to user's Durable Object.
 * All data routes under /api go to the user's DO.
 */
dataRouter.all('*', async (c) => {
    const session = c.get('session')!
    const stub = getUserDO(c.env, session.did)

    // Build the request URL for the DO
    const url = new URL(c.req.url)
    const doPath = url.pathname
    const doUrl = new URL(doPath || '/', 'http://do')
    doUrl.search = url.search

    console.log(
        `[proxy] ${c.req.method} ${doPath}` +
        ` -> DO(${session.did})`
    )

    // Forward the request to the DO
    const response = await stub.fetch(
        new Request(doUrl.toString(), {
            method: c.req.method,
            headers: c.req.raw.headers,
            body: c.req.raw.body
        })
    )

    console.log(
        `[proxy] DO responded ${response.status}`
    )

    return response
})

app.route('/api', dataRouter)

/**
 * Admin: list all tracked users.
 * Requires ADMIN_TOKEN bearer header.
 */
app.get('/admin/users', requireAdmin, async (c) => {
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
 * Requires ADMIN_TOKEN bearer header.
 */
app.post('/admin/refresh-all', requireAdmin, async (c) => {
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
