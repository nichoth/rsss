import { test } from '@substrate-system/tapzero'
import {
    didToCustomerId,
    getOrCreateCustomer,
    verifySubscription,
    type VerifiedSubscription
} from '../src/server/autumn-billing.js'

function customerBody (
    did:string,
    email:string|null = 'reader@example.com',
    subscriptions:unknown[] = []
) {
    return {
        id: didToCustomerId(did),
        name: 'reader.test',
        email,
        created_at: 1700000000000,
        fingerprint: null,
        stripe_id: null,
        env: 'live',
        metadata: {},
        send_email_receipts: true,
        billing_controls: {},
        subscriptions,
        purchases: [],
        balances: {},
        flags: {}
    }
}

function jsonResponse (body:unknown):Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    })
}

function subscriptionBody (status:string) {
    return {
        id: `sub_${status}`,
        plan_id: 'sync',
        auto_enable: false,
        add_on: false,
        status,
        past_due: false,
        canceled_at: null,
        expires_at: null,
        trial_ends_at: null,
        started_at: 1700000000000,
        current_period_start: null,
        current_period_end: null,
        quantity: 1
    }
}

test('VerifiedSubscription status is narrowed to known statuses', t => {
    const verified:VerifiedSubscription = {
        planId: 'sync',
        status: 'active'
    }
    const status:'active'|'scheduled' = verified.status

    t.equal(status, 'active', 'status is assignable to the known union')
})

test('getOrCreateCustomer returns the Autumn customer contact', async t => {
    const originalFetch = globalThis.fetch
    const did = 'did:plc:reader'
    globalThis.fetch = (async () => {
        return jsonResponse(customerBody(did, 'autumn@example.com'))
    }) as typeof fetch

    try {
        const customer = await getOrCreateCustomer(
            { AUTUMN_SECRET_KEY: 'test-secret' },
            did,
            'reader.test',
            'input@example.com'
        )

        t.equal(
            customer.customerId,
            didToCustomerId(did),
            'returns the Autumn customer id'
        )
        t.equal(
            customer.email,
            'autumn@example.com',
            'returns the email from Autumn'
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('verifySubscription accepts active subscriptions', async t => {
    const originalFetch = globalThis.fetch
    const did = 'did:plc:reader'
    globalThis.fetch = (async () => {
        return jsonResponse(customerBody(did, 'reader@example.com', [
            subscriptionBody('active')
        ]))
    }) as typeof fetch

    try {
        const subscription = await verifySubscription(
            { AUTUMN_SECRET_KEY: 'test-secret' },
            did,
            'sync'
        )

        t.deepEqual(
            subscription,
            { planId: 'sync', status: 'active' },
            'returns active matching subscription'
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('verifySubscription accepts scheduled subscriptions', async t => {
    const originalFetch = globalThis.fetch
    const did = 'did:plc:reader'
    globalThis.fetch = (async () => {
        return jsonResponse(customerBody(did, 'reader@example.com', [
            subscriptionBody('scheduled')
        ]))
    }) as typeof fetch

    try {
        const subscription = await verifySubscription(
            { AUTUMN_SECRET_KEY: 'test-secret' },
            did,
            'sync'
        )

        t.deepEqual(
            subscription,
            { planId: 'sync', status: 'scheduled' },
            'returns scheduled matching subscription'
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('verifySubscription ignores unknown subscription statuses', async t => {
    const originalFetch = globalThis.fetch
    const did = 'did:plc:reader'
    globalThis.fetch = (async () => {
        return jsonResponse(customerBody(did, 'reader@example.com', [
            subscriptionBody('trialing')
        ]))
    }) as typeof fetch

    try {
        const subscription = await verifySubscription(
            { AUTUMN_SECRET_KEY: 'test-secret' },
            did,
            'sync'
        )

        t.equal(
            subscription,
            null,
            'unknown status is not treated as verified'
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})
