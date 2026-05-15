import { test } from '@substrate-system/tapzero'
import { pendingUpdateLabel } from '../src/client/components/pending-update-empty-state.js'

test('pendingUpdateLabel(1) returns "1 pending update"', t => {
    const result = pendingUpdateLabel(1)
    t.equal(result, '1 pending update')
})

test('pendingUpdateLabel(2) returns "2 pending updates"', t => {
    const result = pendingUpdateLabel(2)
    t.equal(result, '2 pending updates')
})

test('pendingUpdateLabel(50) returns "50 pending updates"', t => {
    const result = pendingUpdateLabel(50)
    t.equal(result, '50 pending updates')
})

test('pendingUpdateLabel(0) returns "0 pending updates"', t => {
    const result = pendingUpdateLabel(0)
    t.equal(result, '0 pending updates')
})
