import { test } from '@substrate-system/tapzero'
import {
    clampClientUpdatedAt,
    LWW_EQUAL_TIMESTAMP_RULE,
    resolveLwwWrite
} from '../src/shared/lww.js'

/**
 * Simulates the LWW (last-write-wins) check performed by server endpoints.
 * Returns 409 when serverUpdatedAt > clientUpdatedAt, 200 otherwise.
 */
function lwwCheck (
    serverUpdatedAt:string|null,
    clientUpdatedAt:string|undefined
):'ok'|'conflict' {
    return resolveLwwWrite(serverUpdatedAt, clientUpdatedAt)
        === 'conflict' ? 'conflict' : 'ok'
}

// Simulate PATCH /items/:id
function simulatePatchItem (
    item:{ id:number; updated_at:string; is_read:number },
    body:{ is_read?:boolean; client_updated_at?:string }
):{ status:number; body:unknown } {
    const result = lwwCheck(item.updated_at, body.client_updated_at)
    if (result === 'conflict') {
        return { status: 409, body: { item } }
    }
    const updated = {
        ...item,
        is_read: body.is_read !== undefined
            ? (body.is_read ? 1 : 0)
            : item.is_read
    }
    return { status: 200, body: { item: updated } }
}

// Simulate DELETE /feeds/:id
function simulateDeleteFeed (
    feed:{ id:number; updated_at:string },
    body:{ client_updated_at?:string }
):{ status:number; body:unknown } {
    const result = lwwCheck(feed.updated_at, body.client_updated_at)
    if (result === 'conflict') {
        return { status: 409, body: { feed } }
    }
    return { status: 200, body: { success: true } }
}

// Simulate POST /items/mark-all-read
function simulateMarkAllRead (
    items:Array<{
        id:number
        feed_id:number
        updated_at:string
        is_read:number
    }>,
    body:{ feed_id?:number; client_updated_at?:string }
):{ status:number; body:unknown } {
    if (body.client_updated_at !== undefined) {
        const scope = body.feed_id !== undefined
            ? items.filter(i => i.feed_id === body.feed_id)
            : items
        const newer = scope.filter(
            i => i.updated_at > body.client_updated_at!
        )
        if (newer.length > 0) {
            return { status: 409, body: { items: newer } }
        }
    }
    return { status: 200, body: { success: true } }
}

// ========== PATCH /items/:id ==========

test('LWW PATCH item - stale write rejected (409)', t => {
    const item = {
        id: 1,
        updated_at: '2024-01-20 10:00:00',
        is_read: 0
    }
    const res = simulatePatchItem(item, {
        is_read: true,
        client_updated_at: '2024-01-19 10:00:00'  // older than server
    })
    t.equal(res.status, 409, 'should return 409 on stale write')
    t.deepEqual(
        (res.body as { item:unknown }).item,
        item,
        'body should contain authoritative row'
    )
})

test('LWW PATCH item - fresh write accepted (200)', t => {
    const item = {
        id: 1,
        updated_at: '2024-01-18 10:00:00',
        is_read: 0
    }
    const res = simulatePatchItem(item, {
        is_read: true,
        client_updated_at: '2024-01-20 10:00:00'  // newer than server
    })
    t.equal(res.status, 200, 'should accept when client is newer')
    t.equal(
        (res.body as { item:{ is_read:number } }).item.is_read,
        1,
        'is_read should be updated'
    )
})

test('LWW PATCH item - missing client_updated_at uses old behavior', t => {
    const item = {
        id: 1,
        updated_at: '2024-01-20 10:00:00',
        is_read: 0
    }
    const res = simulatePatchItem(item, { is_read: true })
    t.equal(res.status, 200, 'should accept when field is absent')
})

test('LWW PATCH item - same timestamp accepted (not strictly newer)', t => {
    const ts = '2024-01-20 10:00:00'
    const item = { id: 1, updated_at: ts, is_read: 0 }
    const res = simulatePatchItem(item, {
        is_read: true,
        client_updated_at: ts
    })
    t.equal(res.status, 200, 'equal timestamps should not conflict')
    t.equal(
        LWW_EQUAL_TIMESTAMP_RULE,
        'client-wins-equal-timestamp',
        'equal timestamp tie-break rule is documented'
    )
})

test('LWW client timestamp is clamped before conflict checks', t => {
    const now = new Date('2026-04-27T12:00:00Z')
    const clamped = clampClientUpdatedAt(
        '9999-12-31T23:59:59',
        now
    )

    t.equal(
        clamped.clientUpdatedAt,
        '2026-04-27 12:05:00',
        'timestamp is capped at now plus five minutes'
    )
    t.equal(clamped.wasClamped, true, 'clamp event is reported')
    t.equal(
        resolveLwwWrite(
            '2026-04-27 12:06:00',
            clamped.clientUpdatedAt
        ),
        'conflict',
        'conflict check uses the clamped value'
    )
})

// ========== DELETE /feeds/:id ==========

test('LWW DELETE feed - stale delete rejected (409)', t => {
    const feed = { id: 1, updated_at: '2024-01-20 10:00:00' }
    const res = simulateDeleteFeed(feed, {
        client_updated_at: '2024-01-15 10:00:00'
    })
    t.equal(res.status, 409, 'should return 409 on stale delete')
    t.deepEqual(
        (res.body as { feed:unknown }).feed,
        feed,
        'body should contain authoritative feed'
    )
})

test('LWW DELETE feed - fresh delete accepted (200)', t => {
    const feed = { id: 1, updated_at: '2024-01-10 10:00:00' }
    const res = simulateDeleteFeed(feed, {
        client_updated_at: '2024-01-20 10:00:00'
    })
    t.equal(res.status, 200, 'should accept when client is newer')
})

test('LWW DELETE feed - missing client_updated_at uses old behavior', t => {
    const feed = { id: 1, updated_at: '2024-01-20 10:00:00' }
    const res = simulateDeleteFeed(feed, {})
    t.equal(res.status, 200, 'should accept when field is absent')
})

// ========== POST /items/mark-all-read ==========

test('LWW mark-all-read - stale write rejected when newer items exist', t => {
    const items = [
        { id: 1, feed_id: 1, updated_at: '2024-01-20 10:00:00', is_read: 0 },
        { id: 2, feed_id: 1, updated_at: '2024-01-18 10:00:00', is_read: 0 }
    ]
    const res = simulateMarkAllRead(items, {
        client_updated_at: '2024-01-19 10:00:00'
    })
    t.equal(res.status, 409, 'should return 409 when some items are newer')
    const body = res.body as { items:unknown[] }
    t.equal(body.items.length, 1, 'should return only the newer items')
})

test('LWW mark-all-read - accepted when client is newest', t => {
    const items = [
        { id: 1, feed_id: 1, updated_at: '2024-01-15 10:00:00', is_read: 0 }
    ]
    const res = simulateMarkAllRead(items, {
        client_updated_at: '2024-01-20 10:00:00'
    })
    t.equal(res.status, 200, 'should accept when client is newest')
})

test('LWW mark-all-read - missing client_updated_at uses old behavior', t => {
    const items = [
        { id: 1, feed_id: 1, updated_at: '2024-01-20 10:00:00', is_read: 0 }
    ]
    const res = simulateMarkAllRead(items, {})
    t.equal(res.status, 200, 'should accept when field is absent')
})

test('LWW mark-all-read - scoped to feed_id', t => {
    const items = [
        { id: 1, feed_id: 1, updated_at: '2024-01-20 10:00:00', is_read: 0 },
        { id: 2, feed_id: 2, updated_at: '2024-01-20 10:00:00', is_read: 0 }
    ]
    // Only checking feed 2; feed 2 item is newer
    const res = simulateMarkAllRead(items, {
        feed_id: 2,
        client_updated_at: '2024-01-19 10:00:00'
    })
    t.equal(res.status, 409, 'should reject based on scoped feed_id')
    const body = res.body as { items:Array<{ id:number }> }
    t.equal(body.items[0].id, 2, 'should include the conflicting item')
})
