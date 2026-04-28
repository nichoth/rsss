/**
 * Server-side integration tests for the signup / paid-subscription
 * flow. Drives the real Hono app from `src/server/index.ts` with an
 * in-memory KV stub for SESSIONS and `globalThis.fetch` swapped out
 * to impersonate Autumn. Runs in Node so cookie headers can be set
 * on the request (browser fetch strips Cookie).
 */
import { test } from '@substrate-system/tapzero'
import app from '../src/server/index.js'
import {
    makeEnv,
    makeSession,
    withFetch,
    jsonResponse,
    customerBody,
    activeSubscription,
    executionCtx
} from './signup-helpers.js'

const AUTUMN_KEY = 'am_test_secret_key'

function hasCookieAttribute (
    setCookie:string|null,
    attribute:string
):boolean {
    return (setCookie || '')
        .split(';')
        .some(part => part.trim().toLowerCase() === attribute)
}

test(
    'POST /api/auth/dev-login rejects non-loopback hosts',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const res = await app.request(
            'https://rsss.space/api/auth/dev-login',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({})
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }

        t.equal(res.status, 403, 'returns 403')
        t.equal(
            body.error,
            'Not allowed on non-loopback host',
            'rejects public hosts even in development'
        )
    }
)

test(
    'POST /api/auth/dev-login requires SESSION_SECRET',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        delete (env as Partial<typeof env>).SESSION_SECRET

        const res = await app.request(
            'http://127.0.0.1/api/auth/dev-login',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({})
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }

        t.equal(res.status, 500, 'returns 500')
        t.equal(
            body.error,
            'SESSION_SECRET is not configured',
            'does not fall back to a hardcoded secret'
        )
    }
)

test(
    'POST /api/auth/dev-login treats unset NODE_ENV as production',
    async t => {
        const env = makeEnv()
        delete (env as Partial<typeof env>).NODE_ENV

        const res = await app.request(
            'http://127.0.0.1/api/auth/dev-login',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({})
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }

        t.equal(res.status, 403, 'returns 403')
        t.equal(
            body.error,
            'Not allowed in production',
            'unset NODE_ENV is not treated as development'
        )
    }
)

test(
    'POST /api/auth/dev-login omits Secure for loopback cookies',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const res = await app.request(
            'http://127.0.0.1/api/auth/dev-login',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({})
            },
            env,
            executionCtx
        )
        const cookie = res.headers.get('set-cookie')

        t.equal(res.status, 200, 'returns 200')
        t.equal(
            hasCookieAttribute(cookie, 'secure'),
            false,
            'does not set Secure for loopback hosts'
        )
        t.ok(
            cookie?.includes('csrf_token='),
            'sets a readable csrf token cookie'
        )
    }
)

test('POST /api/billing/checkout requires authentication', async t => {
    const env = makeEnv()
    const res = await app.request(
        '/api/billing/checkout',
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: 'csrf_token=test-csrf',
                'x-csrf-token': 'test-csrf',
                'sec-fetch-site': 'same-origin'
            },
            body: JSON.stringify({ planId: 'local-first' })
        },
        env,
        executionCtx
    )
    const body = await res.json() as { error?:string }
    t.equal(res.status, 401, 'returns 401')
    t.equal(body.error, 'Unauthorized', 'returns Unauthorized error')
})

test('POST /api/billing/checkout rejects invalid planId', async t => {
    const env = makeEnv()
    const { cookieHeader } = await makeSession(env)
    const res = await app.request(
        '/api/billing/checkout',
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: cookieHeader,
                'x-csrf-token': 'test-csrf',
                'sec-fetch-site': 'same-origin'
            },
            body: JSON.stringify({ planId: 'enterprise' })
        },
        env,
        executionCtx
    )
    const body = await res.json() as {
        error?:string;
        allowed?:string[]
    }
    t.equal(res.status, 400, 'returns 400')
    t.equal(body.error, 'invalid_plan_id', 'returns invalid_plan_id')
    t.ok(
        Array.isArray(body.allowed) &&
            body.allowed.includes('local-first'),
        'lists allowed plan ids'
    )
})

test(
    'POST /api/billing/checkout (dev) entitles user without payment',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const { session, cookieHeader } = await makeSession(env)
        const res = await app.request(
            '/api/billing/checkout',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({
                    planId: 'local-first',
                    email: 'alice@example.com'
                })
            },
            env,
            executionCtx
        )
        const body = await res.json() as {
            paymentUrl:string|null;
            status:string;
            planId:string;
        }
        t.equal(res.status, 200, 'returns 200')
        t.equal(body.paymentUrl, null, 'no payment URL in dev mode')
        t.equal(body.status, 'entitled', 'reports entitled status')
        t.equal(body.planId, 'local-first', 'echoes plan id')

        const cached = await env.SESSIONS.get(`billing:${session.did}`)
        t.ok(cached, 'wrote cached billing record')
        const parsed = cached ?
            JSON.parse(cached) as { status:string; planId:string } :
            null
        t.equal(parsed?.status, 'active', 'cached status is active')
        t.equal(
            parsed?.planId,
            'local-first',
            'cached plan id is local-first'
        )

        const stashed = await env.SESSIONS.get(
            `billing_pending_email:${session.did}`
        )
        t.equal(stashed, 'alice@example.com', 'stashed pending email')
    }
)

test(
    'POST /api/billing/checkout returns 503 in production without ' +
        'Autumn config',
    async t => {
        const env = makeEnv({ NODE_ENV: 'production' })
        const { cookieHeader } = await makeSession(env)
        const res = await app.request(
            '/api/billing/checkout',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }
        t.equal(res.status, 503, 'returns 503')
        t.equal(
            body.error,
            'billing_unavailable',
            'returns billing_unavailable'
        )
    }
)

test(
    'POST /api/billing/checkout (dev) records subscription_started ' +
        'email dedupe entry when contact email exists',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const { session, cookieHeader } = await makeSession(env)
        await env.SESSIONS.put(
            `billing_contact_email:${session.did}`,
            'alice@example.com'
        )

        await app.request(
            '/api/billing/checkout',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({
                    planId: 'local-first',
                    email: 'alice@example.com'
                })
            },
            env,
            executionCtx
        )
        const dedupeKeys = Array.from(env.SESSIONS.store.keys())
            .filter(k => k.startsWith('email_sent:'))
        t.equal(
            dedupeKeys.length,
            1,
            'one email_sent entry written'
        )
        const key = dedupeKeys[0]
        t.ok(
            key.includes(session.did),
            'dedupe key includes the user did'
        )
        t.ok(
            key.includes('subscription_started'),
            'dedupe key names the subscription_started event'
        )
    }
)

test(
    'POST /api/billing/checkout does not send email to request body ' +
        'address',
    async t => {
        const env = makeEnv({
            NODE_ENV: 'development',
            RESEND_API_KEY: 're_test_key'
        })
        const { cookieHeader } = await makeSession(env)

        await withFetch(
            () => jsonResponse({ id: 'email_unsafe' }),
            async (calls) => {
                await app.request(
                    '/api/billing/checkout',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: JSON.stringify({
                            planId: 'local-first',
                            email: 'attacker@example.com'
                        })
                    },
                    env,
                    executionCtx
                )

                const resendCalls = calls.filter(c =>
                    c.url.includes('resend.com')
                )
                const sentToAttacker = resendCalls.some(c => {
                    const body = c.body as { to?:unknown }
                    return body.to === 'attacker@example.com'
                })
                t.equal(
                    sentToAttacker,
                    false,
                    'request email is not used as notification recipient'
                )
            }
        )
    }
)

test(
    'POST /api/billing/checkout (live) calls Autumn customers ' +
        'get_or_create + billing.attach and returns paymentUrl',
    async t => {
        const env = makeEnv({ AUTUMN_SECRET_KEY: AUTUMN_KEY })
        const { session, cookieHeader } = await makeSession(env)
        const checkoutUrl =
            'https://checkout.useautumn.com/sess_test_abc'

        await withFetch(
            (call) => {
                if (call.url.includes('/v1/customers.get_or_create')) {
                    return jsonResponse(customerBody(
                        session.did,
                        'alice@example.com'
                    ))
                }
                if (call.url.includes('/v1/billing.attach')) {
                    return jsonResponse({
                        payment_url: checkoutUrl,
                        paymentUrl: checkoutUrl
                    })
                }
                return jsonResponse({}, 404)
            },
            async (calls) => {
                const res = await app.request(
                    '/api/billing/checkout',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: JSON.stringify({
                            planId: 'local-first',
                            email: 'attacker@example.com'
                        })
                    },
                    env,
                    executionCtx
                )
                const body = await res.json() as {
                    paymentUrl:string|null;
                    status:string;
                    planId:string;
                }
                t.equal(res.status, 200, 'returns 200')
                t.equal(
                    body.paymentUrl,
                    checkoutUrl,
                    'returns the Autumn checkout URL'
                )
                t.equal(
                    body.status,
                    'payment_pending',
                    'reports payment_pending status'
                )

                const customerCall = calls.find(c =>
                    c.url.includes('/v1/customers.get_or_create')
                )
                t.ok(
                    customerCall,
                    'called Autumn customers.get_or_create'
                )
                t.equal(
                    customerCall?.method,
                    'POST',
                    'used POST method for customer'
                )
                t.equal(
                    customerCall?.headers.authorization,
                    `Bearer ${AUTUMN_KEY}`,
                    'authenticated with bearer token'
                )

                const attachCall = calls.find(c =>
                    c.url.includes('/v1/billing.attach')
                )
                t.ok(attachCall, 'called Autumn billing.attach')
                const attachBody = attachCall?.body as Record<
                    string,
                    unknown
                >
                t.equal(
                    attachBody?.plan_id ?? attachBody?.planId,
                    'local-first',
                    'attach body contains plan id'
                )
                t.ok(
                    typeof (attachBody?.success_url ??
                        attachBody?.successUrl) === 'string',
                    'attach body includes success URL'
                )

                const pending = await env.SESSIONS.get(
                    `billing_pending_email:${session.did}`
                )
                t.equal(
                    pending,
                    'attacker@example.com',
                    'stashed request email for Autumn binding'
                )

                const contact = await env.SESSIONS.get(
                    `billing_contact_email:${session.did}`
                )
                t.equal(
                    contact,
                    'alice@example.com',
                    'stashed contact email from Autumn response'
                )
            }
        )
    }
)

test(
    'POST /api/billing/checkout (live) returns 503 when Autumn errors',
    async t => {
        const env = makeEnv({ AUTUMN_SECRET_KEY: AUTUMN_KEY })
        const { cookieHeader } = await makeSession(env)
        await withFetch(
            () => jsonResponse(
                { error: 'autumn_unreachable' },
                500
            ),
            async () => {
                const res = await app.request(
                    '/api/billing/checkout',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: JSON.stringify({
                            planId: 'local-first'
                        })
                    },
                    env,
                    executionCtx
                )
                const body = await res.json() as {
                    error?:string
                }
                t.equal(
                    res.status,
                    503,
                    'returns 503 billing_unavailable'
                )
                t.equal(
                    body.error,
                    'billing_unavailable',
                    'returns billing_unavailable error'
                )
            }
        )
    }
)

test(
    'POST /api/billing/checkout/return (dev) returns 402 if not yet ' +
        'entitled',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const { cookieHeader } = await makeSession(env)
        const res = await app.request(
            '/api/billing/checkout/return',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        t.equal(res.status, 402, 'returns 402 payment_incomplete')
        const body = await res.json() as { error?:string }
        t.equal(
            body.error,
            'payment_incomplete',
            'returns payment_incomplete'
        )
    }
)

test(
    'POST /api/billing/checkout/return returns 503 in production ' +
        'without Autumn config',
    async t => {
        const env = makeEnv({ NODE_ENV: 'production' })
        const { cookieHeader } = await makeSession(env)
        const res = await app.request(
            '/api/billing/checkout/return',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }
        t.equal(res.status, 503, 'returns 503')
        t.equal(
            body.error,
            'billing_unavailable',
            'returns billing_unavailable'
        )
    }
)

test(
    'POST /api/billing/checkout/return (dev) returns entitled when ' +
        'cached billing exists',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const { session, cookieHeader } = await makeSession(env)
        // Prime cached billing as if checkout already ran.
        await env.SESSIONS.put(
            `billing:${session.did}`,
            JSON.stringify({
                planId: 'local-first',
                status: 'active',
                refreshedAt: Date.now()
            })
        )
        const res = await app.request(
            '/api/billing/checkout/return',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const body = await res.json() as {
            status:string;
            planId:string;
        }
        t.equal(res.status, 200, 'returns 200')
        t.equal(body.status, 'entitled', 'reports entitled status')
        t.equal(body.planId, 'local-first', 'echoes plan id')
    }
)

test(
    'POST /api/billing/checkout/return (live) verifies Autumn ' +
        'subscription, caches entitlement, and triggers welcome email',
    async t => {
        const env = makeEnv({ AUTUMN_SECRET_KEY: AUTUMN_KEY })
        const { session, cookieHeader } = await makeSession(env)
        // The welcome email path reads the contact email from KV.
        await env.SESSIONS.put(
            `billing_contact_email:${session.did}`,
            'alice@example.com'
        )

        await withFetch(
            (call) => {
                if (call.url.includes('/v1/customers.get_or_create')) {
                    return jsonResponse(customerBody(
                        session.did,
                        'alice@example.com',
                        [activeSubscription()]
                    ))
                }
                return jsonResponse({}, 404)
            },
            async () => {
                const res = await app.request(
                    '/api/billing/checkout/return',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: JSON.stringify({
                            planId: 'local-first'
                        })
                    },
                    env,
                    executionCtx
                )
                const body = await res.json() as {
                    status:string;
                    planId:string;
                }
                t.equal(res.status, 200, 'returns 200')
                t.equal(
                    body.status,
                    'entitled',
                    'reports entitled status'
                )

                const cached = await env.SESSIONS.get(
                    `billing:${session.did}`
                )
                t.ok(cached, 'wrote cached billing entry')
                const parsed = cached ?
                    JSON.parse(cached) as { status:string } :
                    null
                t.equal(
                    parsed?.status,
                    'active',
                    'cached billing has active status'
                )

                const dedupeKeys = Array.from(
                    env.SESSIONS.store.keys()
                ).filter(k => k.startsWith('email_sent:'))
                t.equal(
                    dedupeKeys.length,
                    1,
                    'one welcome email dedupe entry written'
                )
                t.ok(
                    dedupeKeys[0].includes('subscription_started'),
                    'dedupe entry is for subscription_started'
                )
            }
        )
    }
)

test(
    'POST /api/billing/checkout/return (live) returns 402 when no ' +
        'active subscription is found',
    async t => {
        const env = makeEnv({ AUTUMN_SECRET_KEY: AUTUMN_KEY })
        const { session, cookieHeader } = await makeSession(env)

        await withFetch(
            (call) => {
                if (call.url.includes('/v1/customers.get_or_create')) {
                    return jsonResponse(customerBody(
                        session.did,
                        'alice@example.com',
                        []
                    ))
                }
                return jsonResponse({}, 404)
            },
            async () => {
                const res = await app.request(
                    '/api/billing/checkout/return',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: JSON.stringify({
                            planId: 'local-first'
                        })
                    },
                    env,
                    executionCtx
                )
                const body = await res.json() as { error?:string }
                t.equal(
                    res.status,
                    402,
                    'returns 402 payment_incomplete'
                )
                t.equal(
                    body.error,
                    'payment_incomplete',
                    'returns payment_incomplete'
                )
            }
        )
    }
)

test(
    'GET /api/billing/status reflects entitlement after dev checkout',
    async t => {
        const env = makeEnv({ NODE_ENV: 'development' })
        const { cookieHeader } = await makeSession(env)
        await app.request(
            '/api/billing/checkout',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({
                    planId: 'local-first',
                    email: 'alice@example.com'
                })
            },
            env,
            executionCtx
        )
        const statusRes = await app.request(
            '/api/billing/status',
            {
                headers: {
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                }
            },
            env,
            executionCtx
        )
        const body = await statusRes.json() as {
            entitled:boolean;
            planId:string;
            status:string;
        }
        t.equal(statusRes.status, 200, 'returns 200')
        t.equal(body.entitled, true, 'user is entitled')
        t.equal(body.status, 'active', 'status is active')
        t.equal(body.planId, 'local-first', 'plan id is local-first')
    }
)

test(
    'POST /api/billing/checkout/failed records payment_failed dedupe',
    async t => {
        const env = makeEnv()
        const { session, cookieHeader } = await makeSession(env)
        // Stash a contact email so the failed-email path has a target.
        await env.SESSIONS.put(
            `billing_contact_email:${session.did}`,
            'alice@example.com'
        )

        const res = await app.request(
            '/api/billing/checkout/failed',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const body = await res.json() as {
            emailed?:boolean;
            deduped?:boolean;
        }
        t.equal(res.status, 200, 'returns 200')
        t.equal(body.emailed, true, 'reports email sent')

        const dedupeKeys = Array.from(env.SESSIONS.store.keys())
            .filter(k => k.startsWith('email_sent:'))
        t.equal(
            dedupeKeys.length,
            1,
            'one payment_failed dedupe entry written'
        )
        t.ok(
            dedupeKeys[0].includes('payment_failed'),
            'dedupe key is for payment_failed event'
        )
    }
)

test(
    'POST /api/billing/checkout/failed is idempotent on second call',
    async t => {
        const env = makeEnv()
        const { session, cookieHeader } = await makeSession(env)
        await env.SESSIONS.put(
            `billing_contact_email:${session.did}`,
            'alice@example.com'
        )

        const first = await app.request(
            '/api/billing/checkout/failed',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const firstBody = await first.json() as {
            emailed?:boolean;
            deduped?:boolean;
        }
        t.equal(firstBody.emailed, true, 'first call sends email')

        const second = await app.request(
            '/api/billing/checkout/failed',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const secondBody = await second.json() as {
            emailed?:boolean;
            deduped?:boolean;
        }
        t.equal(
            secondBody.emailed,
            false,
            'second call does not send email'
        )
        t.equal(
            secondBody.deduped,
            true,
            'second call reports deduped'
        )
    }
)

test(
    'POST /api/billing/checkout/failed without contact email reports ' +
        'no_contact_email',
    async t => {
        const env = makeEnv()
        const { cookieHeader } = await makeSession(env)
        const res = await app.request(
            '/api/billing/checkout/failed',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                },
                body: JSON.stringify({ planId: 'local-first' })
            },
            env,
            executionCtx
        )
        const body = await res.json() as {
            emailed?:boolean;
            reason?:string;
        }
        t.equal(res.status, 200, 'returns 200')
        t.equal(body.emailed, false, 'no email sent')
        t.equal(
            body.reason,
            'no_contact_email',
            'reports no_contact_email'
        )
    }
)
