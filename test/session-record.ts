/**
 * Runs in Node because browser fetch strips Cookie request headers.
 */
import { test } from '@substrate-system/tapzero'
import app from '../src/server/index.js'
import {
    executionCtx,
    makeEnv,
    makeSession
} from './signup-helpers.js'

test('malformed KV session records clear cookie and return 401', async t => {
    const env = makeEnv()
    const { cookieHeader, session } = await makeSession(env)
    const sessionKey = Array.from(env.SESSIONS.store.keys())
        .find(key => key.startsWith('session:'))

    if (!sessionKey) {
        t.fail('expected session key to be stored in KV')
        return
    }

    env.SESSIONS.store.set(sessionKey, JSON.stringify({
        session: {
            did: 123,
            handle: session.handle
        },
        sessionExpiresAt: Date.now() + 60_000,
        createdAt: Date.now()
    }))

    const res = await app.request(
        '/api/me',
        {
            headers: {
                cookie: cookieHeader
            }
        },
        env,
        executionCtx
    )
    const setCookie = res.headers.get('set-cookie') ?? ''

    t.equal(res.status, 401)
    t.equal(env.SESSIONS.store.has(sessionKey), false)
    t.ok(
        setCookie.includes('session=') &&
            setCookie.toLowerCase().includes('max-age=0'),
        'clears the malformed session cookie'
    )
})
