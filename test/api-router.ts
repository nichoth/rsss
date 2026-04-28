import { test } from '@substrate-system/tapzero'
import { Hono } from 'hono'
import app, {
    dataRouter,
    hasValidCsrfToken,
    isAllowedRequestOrigin,
    isCrossOriginStateChange
} from '../src/server/index.js'

const TEST_SESSION = {
    did: 'did:plc:reader',
    handle: 'reader.example'
}
const GATED_DATA_ROUTES = [
    { method: 'GET', path: '/api/sync', status: 200 },
    { method: 'GET', path: '/api/feeds', status: 200 },
    { method: 'GET', path: '/api/items', status: 200 },
    { method: 'POST', path: '/api/items/mark-all-read', status: 204 },
    { method: 'POST', path: '/api/feeds/1/refresh', status: 201 }
]

class MemoryKv {
    data = new Map<string, string>()

    async get (key:string):Promise<string|null> {
        return this.data.get(key) ?? null
    }

    async put (key:string, value:string):Promise<void> {
        this.data.set(key, value)
    }

    async delete (key:string):Promise<void> {
        this.data.delete(key)
    }
}

function billingCacheKey (did:string):string {
    return `billing:${did}`
}

function activeBilling ():string {
    return JSON.stringify({
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now()
    })
}

function authenticatedDataRouter () {
    const router = new Hono<{
        Variables:{ session:typeof TEST_SESSION }
    }>()

    router.use('*', async (c, next) => {
        c.set('session', TEST_SESSION)
        await next()
    })
    router.route('/api', dataRouter)
    return router
}

function makeDataEnv (
    kv:MemoryKv,
    proxied:string[],
    statusForPath:(path:string) => number
) {
    return {
        USER_DO: {
            idFromName: () => 'id',
            get: () => ({
                fetch: async (request:Request) => {
                    const path = new URL(request.url).pathname
                    proxied.push(`${request.method} ${path}`)
                    return new Response(null, {
                        status: statusForPath(path)
                    })
                }
            })
        },
        SESSIONS: kv as unknown as KVNamespace,
        NODE_ENV: 'test'
    }
}

test('dataRouter strips client authorization before DO proxy', async (t) => {
    const kv = new MemoryKv()
    const router = authenticatedDataRouter()
    const proxiedHeaders = {
        authorization: 'not proxied',
        contentType: null as string|null,
        rsssClientOpId: null as string|null
    }
    const env = {
        USER_DO: {
            idFromName: () => 'id',
            get: () => ({
                fetch: async (request:Request) => {
                    proxiedHeaders.authorization =
                        request.headers.get('authorization') ?? 'not proxied'
                    proxiedHeaders.contentType =
                        request.headers.get('content-type')
                    proxiedHeaders.rsssClientOpId =
                        request.headers.get('x-rsss-client-op-id')
                    return new Response(null, { status: 200 })
                }
            })
        },
        SESSIONS: kv as unknown as KVNamespace,
        NODE_ENV: 'test'
    }

    await kv.put(billingCacheKey(TEST_SESSION.did), activeBilling())

    const res = await router.request(
        'https://rsss.space/api/feeds',
        {
            method: 'GET',
            headers: {
                authorization: 'Bearer xyz',
                'content-type': 'application/json',
                'x-rsss-client-op-id': 'op-1'
            }
        },
        env
    )

    t.equal(res.status, 200)
    t.equal(proxiedHeaders.authorization, 'not proxied')
    t.equal(proxiedHeaders.contentType, 'application/json')
    t.equal(proxiedHeaders.rsssClientOpId, 'op-1')
})

test('dataRouter applies auth before proxying to the DO', async (t) => {
    let didProxy = false
    const env = {
        USER_DO: {
            idFromName: () => 'id',
            get: () => ({
                fetch: async () => {
                    didProxy = true
                    return new Response('proxied')
                }
            })
        },
        SESSIONS: {
            get: async () => null
        }
    }

    const res = await dataRouter.request(
        '/feeds',
        { method: 'GET' },
        env
    )
    const body = await res.json() as { error?:string }

    t.equal(res.status, 401)
    t.equal(body.error, 'Unauthorized')
    t.equal(didProxy, false)
})

test('dataRouter blocks unentitled data routes', async (t) => {
    const kv = new MemoryKv()
    const proxied:string[] = []
    const router = authenticatedDataRouter()
    const env = makeDataEnv(kv, proxied, () => 200)

    for (const route of GATED_DATA_ROUTES) {
        const res = await router.request(
            `https://rsss.space${route.path}`,
            {
                method: route.method
            },
            env
        )

        t.equal(
            res.status,
            402,
            `${route.method} ${route.path} requires entitlement`
        )
    }

    t.deepEqual(proxied, [], 'unentitled requests do not reach the DO')
})

test('dataRouter proxies entitled data routes', async (t) => {
    const kv = new MemoryKv()
    const proxied:string[] = []
    const router = authenticatedDataRouter()
    const expectedByPath = new Map(
        GATED_DATA_ROUTES.map(route => [route.path, route.status])
    )
    const env = makeDataEnv(
        kv,
        proxied,
        path => expectedByPath.get(path) ?? 500
    )

    await kv.put(billingCacheKey(TEST_SESSION.did), activeBilling())

    for (const route of GATED_DATA_ROUTES) {
        const res = await router.request(
            `https://rsss.space${route.path}`,
            {
                method: route.method
            },
            env
        )

        t.equal(
            res.status,
            route.status,
            `${route.method} ${route.path} is proxied`
        )
    }

    t.deepEqual(
        proxied,
        GATED_DATA_ROUTES.map(route => {
            return `${route.method} ${route.path}`
        }),
        'entitled requests reach the matching DO route'
    )
})

test('api CORS only allows the configured app origin', (t) => {
    t.equal(
        isAllowedRequestOrigin(
            'https://rsss.space',
            'https://preview.example/api/health',
            'https://rsss.space'
        ),
        true
    )
    t.equal(
        isAllowedRequestOrigin(
            'https://preview.example',
            'https://preview.example/api/health',
            'https://rsss.space'
        ),
        false
    )
    t.equal(
        isAllowedRequestOrigin(
            'https://evil.example',
            'https://rsss.space/api/health',
            'https://rsss.space'
        ),
        false
    )
})

test('api CORS does not fall back when APP_ORIGIN is missing', async (t) => {
    const res = await app.request(
        'https://preview.example/api/health',
        {
            headers: {
                origin: 'https://rsss.space'
            }
        },
        {
            NODE_ENV: 'test',
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )

    t.equal(
        res.headers.get('Access-Control-Allow-Origin'),
        null
    )
})

test('api CORS rejects non-allowlisted origins', async (t) => {
    const res = await app.request(
        'https://rsss.space/api/health',
        {
            headers: {
                origin: 'https://evil.example'
            }
        },
        {
            NODE_ENV: 'test',
            APP_ORIGIN: 'https://rsss.space',
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )

    t.equal(
        res.headers.get('Access-Control-Allow-Origin'),
        null
    )
})

test('cross-origin state-changing api requests are rejected', (t) => {
    t.equal(
        isCrossOriginStateChange(
            'POST',
            'https://rsss.space/api/auth/logout',
            'https://evil.example',
            null
        ),
        true
    )
    t.equal(
        isCrossOriginStateChange(
            'POST',
            'https://rsss.space/api/auth/logout',
            'https://rsss.space',
            'same-origin',
            'https://rsss.space'
        ),
        false
    )
    t.equal(
        isCrossOriginStateChange(
            'GET',
            'https://rsss.space/api/me',
            'https://evil.example',
            'cross-site'
        ),
        false
    )
})

test('state-changing api requests without csrf context are rejected', (t) => {
    t.equal(
        isCrossOriginStateChange(
            'POST',
            'https://rsss.space/api/auth/logout',
            null,
            null
        ),
        true
    )
})

test('matching csrf cookie and header tokens are accepted', (t) => {
    t.equal(
        hasValidCsrfToken(
            'session=abc; csrf_token=test-csrf',
            'test-csrf'
        ),
        true
    )
})

test('state-changing api requests require a csrf token echo', (t) => {
    t.equal(
        hasValidCsrfToken('csrf_token=test-csrf', null),
        false
    )
})

test('production health check fails without Autumn secret', async (t) => {
    const res = await app.request(
        'https://rsss.space/api/health',
        {},
        {
            NODE_ENV: 'production',
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )
    const body = await res.json() as { error?:string }

    t.equal(res.status, 500)
    t.equal(body.error, 'missing_autumn_secret')
})

test('health check fails without APP_ORIGIN', async (t) => {
    const res = await app.request(
        'https://rsss.space/api/health',
        {},
        {
            NODE_ENV: 'test',
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )
    const body = await res.json() as { error?:string }

    t.equal(res.status, 500)
    t.equal(body.error, 'missing_app_origin')
})

test('production health check fails without app origin', async (t) => {
    const res = await app.request(
        'https://rsss.space/api/health',
        {},
        {
            NODE_ENV: 'production',
            AUTUMN_SECRET_KEY: 'am_test_secret',
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )
    const body = await res.json() as { error?:string }

    t.equal(res.status, 500)
    t.equal(body.error, 'missing_app_origin')
})
