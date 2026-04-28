import { test } from '@substrate-system/tapzero'
import app from '../src/server/index.js'
import {
    executionCtx,
    makeEnv,
    makeSession,
    TEST_CSRF_TOKEN
} from './signup-helpers.js'

test('GET /logout does not log the user out', async (t) => {
    const env = makeEnv({ APP_ORIGIN: 'https://rsss.space' })
    const { cookieHeader } = await makeSession(env)

    const res = await app.request(
        'https://rsss.space/logout',
        {
            headers: {
                cookie: cookieHeader
            }
        },
        env,
        executionCtx
    )

    t.ok(
        res.status === 404 || res.status === 405,
        'returns 404 or 405'
    )
})

test('POST /api/auth/logout continues to work', async (t) => {
    const env = makeEnv({ APP_ORIGIN: 'https://rsss.space' })
    const { cookieHeader } = await makeSession(env)

    const res = await app.request(
        'https://rsss.space/api/auth/logout',
        {
            method: 'POST',
            headers: {
                cookie: cookieHeader,
                'x-csrf-token': TEST_CSRF_TOKEN,
                'sec-fetch-site': 'same-origin'
            }
        },
        env,
        executionCtx
    )
    const body = await res.json() as { success?:boolean }

    t.equal(res.status, 200, 'returns 200')
    t.equal(body.success, true, 'returns success')
})
