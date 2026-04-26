import { test } from '@substrate-system/tapzero'
import app, {
    dataRouter,
    isAllowedRequestOrigin,
    isCrossOriginStateChange
} from '../src/server/index.js'

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
