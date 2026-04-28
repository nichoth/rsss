/**
 * Server-side integration tests for the account-deletion flow.
 *
 * Drives the real Hono app from `src/server/index.ts` with an
 * in-memory KV stub for SESSIONS, a stub USER_DO that records
 * forwarded requests, and `globalThis.fetch` swapped out so
 * Autumn calls can be impersonated.
 */
import { test } from '@substrate-system/tapzero'
import app from '../src/server/index.js'
import {
    makeEnv,
    makeSession,
    withFetch,
    jsonResponse,
    customerBody,
    executionCtx,
    type TestEnv
} from './signup-helpers.js'

const AUTUMN_KEY = 'am_test_secret_key'

interface RecordedDoCall {
    method:string
    path:string
    body:string|null
}

interface FakeDoState {
    pendingDeletion:{ scheduledFor:number }|null
}

function makeFakeDo (state:FakeDoState, calls:RecordedDoCall[]) {
    return {
        idFromName: (_name:string) => 'id',
        get: (_id:string) => ({
            fetch: async (request:Request) => {
                const url = new URL(request.url)
                const body = request.body ?
                    await request.text() :
                    null
                calls.push({
                    method: request.method,
                    path: url.pathname,
                    body
                })

                if (url.pathname === '/internal/account/deletion') {
                    if (request.method === 'GET') {
                        return new Response(
                            JSON.stringify({
                                pendingDeletion: state.pendingDeletion
                            }),
                            {
                                status: 200,
                                headers: {
                                    'content-type': 'application/json'
                                }
                            }
                        )
                    }
                    if (request.method === 'POST') {
                        const parsed = body ?
                            JSON.parse(body) as { scheduledFor:number } :
                            { scheduledFor: 0 }
                        state.pendingDeletion = {
                            scheduledFor: parsed.scheduledFor
                        }
                        return new Response(
                            JSON.stringify({
                                scheduledFor: parsed.scheduledFor
                            }),
                            {
                                status: 200,
                                headers: {
                                    'content-type': 'application/json'
                                }
                            }
                        )
                    }
                    if (request.method === 'DELETE') {
                        state.pendingDeletion = null
                        return new Response(
                            JSON.stringify({ ok: true }),
                            {
                                status: 200,
                                headers: {
                                    'content-type': 'application/json'
                                }
                            }
                        )
                    }
                }

                return new Response(
                    JSON.stringify({ error: 'unhandled' }),
                    { status: 404 }
                )
            }
        })
    }
}

function makeEnvWithDo (
    state:FakeDoState,
    calls:RecordedDoCall[],
    overrides:Partial<TestEnv> = {}
):TestEnv {
    const env = makeEnv(overrides)
    env.USER_DO = makeFakeDo(state, calls)
    return env
}

test(
    'POST /api/account/delete requires authentication',
    async t => {
        const state:FakeDoState = { pendingDeletion: null }
        const calls:RecordedDoCall[] = []
        const env = makeEnvWithDo(state, calls)
        const res = await app.request(
            '/api/account/delete',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: 'csrf_token=test-csrf',
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                }
            },
            env,
            executionCtx
        )
        const body = await res.json() as { error?:string }
        t.equal(res.status, 401, 'returns 401')
        t.equal(body.error, 'Unauthorized', 'returns Unauthorized error')
        t.equal(
            calls.length,
            0,
            'does not forward to the DO without auth'
        )
    }
)

test(
    'POST /api/account/delete (free tier) deletes immediately',
    async t => {
        const state:FakeDoState = { pendingDeletion: null }
        const calls:RecordedDoCall[] = []
        const env = makeEnvWithDo(state, calls, {
            NODE_ENV: 'development'
        })
        const { cookieHeader } = await makeSession(env)
        const before = Date.now()

        const res = await app.request(
            '/api/account/delete',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                }
            },
            env,
            executionCtx
        )
        const body = await res.json() as { scheduledFor:number }
        const after = Date.now()

        t.equal(res.status, 200, 'returns 200')
        t.ok(
            body.scheduledFor >= before && body.scheduledFor <= after,
            'scheduledFor is roughly now (immediate)'
        )
        t.equal(
            state.pendingDeletion?.scheduledFor,
            body.scheduledFor,
            'DO recorded the scheduled time'
        )
        t.equal(
            calls.filter(c => c.method === 'POST').length,
            1,
            'forwarded one POST to the DO'
        )
    }
)

test(
    'POST /api/account/delete (paid tier) uses billing period end',
    async t => {
        const state:FakeDoState = { pendingDeletion: null }
        const calls:RecordedDoCall[] = []
        const env = makeEnvWithDo(state, calls, {
            NODE_ENV: 'production',
            AUTUMN_SECRET_KEY: AUTUMN_KEY,
            APP_ORIGIN: 'https://rsss.space'
        })
        const { session, cookieHeader } = await makeSession(env)
        const periodEnd = Date.now() + (30 * 24 * 60 * 60 * 1000)

        const res = await withFetch(
            (call) => {
                if (call.url.includes('/v1/customers.get_or_create')) {
                    return jsonResponse(
                        customerBody(session.did, 'alice@example.com', [
                            {
                                id: 'sub_active',
                                plan_id: 'local-first',
                                add_on: false,
                                status: 'active',
                                canceled_at: null,
                                current_period_start: null,
                                current_period_end: periodEnd
                            }
                        ])
                    )
                }
                return jsonResponse({ error: 'unexpected' }, 500)
            },
            async () => {
                return await app.request(
                    'https://rsss.space/api/account/delete',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            cookie: cookieHeader,
                            'x-csrf-token': 'test-csrf',
                            'sec-fetch-site': 'same-origin'
                        }
                    },
                    env,
                    executionCtx
                )
            }
        )
        const body = await res.json() as { scheduledFor:number }
        t.equal(res.status, 200, 'returns 200')
        t.equal(
            body.scheduledFor,
            periodEnd,
            'scheduledFor matches billing period end'
        )
        t.equal(
            state.pendingDeletion?.scheduledFor,
            periodEnd,
            'DO recorded the period end'
        )
    }
)

test(
    'DELETE /api/account/delete clears the pending record',
    async t => {
        const state:FakeDoState = {
            pendingDeletion: { scheduledFor: Date.now() + 1000 }
        }
        const calls:RecordedDoCall[] = []
        const env = makeEnvWithDo(state, calls, {
            NODE_ENV: 'development'
        })
        const { cookieHeader } = await makeSession(env)

        const res = await app.request(
            '/api/account/delete',
            {
                method: 'DELETE',
                headers: {
                    cookie: cookieHeader,
                    'x-csrf-token': 'test-csrf',
                    'sec-fetch-site': 'same-origin'
                }
            },
            env,
            executionCtx
        )
        t.equal(res.status, 200, 'returns 200')
        t.equal(
            state.pendingDeletion,
            null,
            'DO record is cleared'
        )
    }
)

test(
    'GET /api/billing/status surfaces the pending deletion',
    async t => {
        const scheduledFor = Date.now() + 5_000
        const state:FakeDoState = {
            pendingDeletion: { scheduledFor }
        }
        const calls:RecordedDoCall[] = []
        const env = makeEnvWithDo(state, calls, {
            NODE_ENV: 'development'
        })
        const { cookieHeader } = await makeSession(env)

        const res = await app.request(
            '/api/billing/status',
            {
                method: 'GET',
                headers: {
                    cookie: cookieHeader,
                    'sec-fetch-site': 'same-origin'
                }
            },
            env,
            executionCtx
        )
        const body = await res.json() as {
            pendingDeletion?:{ scheduledFor:number }|null
        }
        t.equal(res.status, 200, 'returns 200')
        t.ok(body.pendingDeletion, 'response includes pendingDeletion')
        t.equal(
            body.pendingDeletion?.scheduledFor,
            scheduledFor,
            'scheduledFor matches DO state'
        )
    }
)
