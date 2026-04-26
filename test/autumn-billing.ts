import { test } from '@substrate-system/tapzero'
import {
    didToCustomerId,
    getOrCreateCustomer,
    type VerifiedSubscription
} from '../src/server/autumn-billing.js'

function customerBody (
    did:string,
    email:string|null = 'reader@example.com'
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
        subscriptions: [],
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
