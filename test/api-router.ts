import { test } from '@substrate-system/tapzero'
import { Hono } from 'hono'
import app, {
    dataRouter,
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
            'https://rsss.space/api/health'
        ),
        true
    )
    t.equal(
        isAllowedRequestOrigin(
            'https://rsss.space',
            'https://preview.example/api/health'
        ),
        true
    )
    t.equal(
        isAllowedRequestOrigin(
            'https://evil.example',
            'https://rsss.space/api/health'
        ),
        false
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
            'same-origin'
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

test('same-origin state-changing api requests continue to work', async (t) => {
    const res = await app.request(
        'https://rsss.space/api/auth/logout',
        {
            method: 'POST'
        },
        {
            SESSIONS: {
                get: async () => null
            },
            SESSION_SECRET: 'test-secret'
        }
    )
    const body = await res.json() as { success?:boolean }

    t.equal(res.status, 200)
    t.equal(body.success, true)
})
