import { test } from '@substrate-system/tapzero'
import { dataRouter } from '../src/server/index.js'

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
