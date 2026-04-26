import { test } from '@substrate-system/tapzero'
import {
    sendPaymentFailed,
    sendSubscriptionStarted
} from '../src/server/email.js'

class MemoryKv {
    data = new Map<string, string>()

    async get (key:string):Promise<string|null> {
        return this.data.get(key) ?? null
    }

    async put (key:string, value:string):Promise<void> {
        this.data.set(key, value)
    }
}

function paymentParams () {
    return {
        to: 'reader@example.com',
        did: 'did:plc:reader',
        planId: 'sync',
        signupUrl: 'https://rsss.space/signup'
    }
}

function withDateNow<T> (
    value:number,
    fn:() => T
):T {
    const original = Date.now
    Date.now = () => value
    try {
        return fn()
    } finally {
        Date.now = original
    }
}

test('billing email dedupe key changes with weekly epoch', async t => {
    const kv = new MemoryKv()
    const weekMs = 7 * 24 * 60 * 60 * 1000

    const first = await withDateNow(weekMs * 10, () => {
        return sendPaymentFailed({}, kv, paymentParams())
    })
    const second = await withDateNow((weekMs * 10) + 1000, () => {
        return sendPaymentFailed({}, kv, paymentParams())
    })
    const third = await withDateNow(weekMs * 11, () => {
        return sendPaymentFailed({}, kv, paymentParams())
    })

    t.equal(first.sent, true, 'first email sends')
    t.equal(second.deduped, true, 'same weekly epoch is deduped')
    t.equal(third.sent, true, 'new weekly epoch sends again')
})

test('subscription email retries once after transient Resend failure',
    async t => {
        const originalFetch = globalThis.fetch
        const responses = [
            new Response(JSON.stringify({
                name: 'application_error',
                statusCode: 503,
                message: 'temporarily unavailable'
            }), { status: 503 }),
            new Response(JSON.stringify({ id: 'email_123' }), {
                status: 200
            })
        ]
        let calls = 0
        globalThis.fetch = (async () => {
            const response = responses[calls]
            calls += 1
            return response
        }) as typeof fetch

        try {
            const result = await sendSubscriptionStarted(
                { RESEND_API_KEY: 're_test' },
                new MemoryKv(),
                {
                    to: 'reader@example.com',
                    did: 'did:plc:reader',
                    planId: 'sync'
                }
            )

            t.equal(result.sent, true, 'send succeeds after retry')
            t.equal(calls, 2, 'transient failure is retried once')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

test('subscription email schedules transient retry with waitUntil',
    async t => {
        const originalFetch = globalThis.fetch
        const waitUntilPromises:Promise<unknown>[] = []
        const responses = [
            new Response(JSON.stringify({
                name: 'application_error',
                statusCode: 503,
                message: 'temporarily unavailable'
            }), { status: 503 }),
            new Response(JSON.stringify({ id: 'email_456' }), {
                status: 200
            })
        ]
        let calls = 0
        globalThis.fetch = (async () => {
            const response = responses[calls]
            calls += 1
            return response
        }) as typeof fetch

        try {
            const result = await sendSubscriptionStarted(
                { RESEND_API_KEY: 're_test' },
                new MemoryKv(),
                {
                    to: 'reader@example.com',
                    did: 'did:plc:reader',
                    planId: 'sync'
                },
                {
                    waitUntil (promise) {
                        waitUntilPromises.push(promise)
                    }
                }
            )

            t.equal(result.sent, false, 'initial call does not block')
            t.equal(waitUntilPromises.length, 1, 'retry is scheduled')

            await Promise.all(waitUntilPromises)

            t.equal(calls, 2, 'scheduled retry sends once')
        } finally {
            globalThis.fetch = originalFetch
        }
    })
