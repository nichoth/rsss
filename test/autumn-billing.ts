import { test } from '@substrate-system/tapzero'
import type { VerifiedSubscription } from '../src/server/autumn-billing.js'

test('VerifiedSubscription status is narrowed to known statuses', t => {
    const verified:VerifiedSubscription = {
        planId: 'sync',
        status: 'active'
    }
    const status:'active'|'scheduled' = verified.status

    t.equal(status, 'active', 'status is assignable to the known union')
})
