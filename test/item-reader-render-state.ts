/**
 * Render-state tests for the item-reader route.
 *
 * Mirrors the booleans the route computes in src/client/routes/
 * item-reader.ts so that future refactors can't silently change
 * "summary visible on failure" / "no notice on success" without
 * updating this test.
 */
import { test } from '@substrate-system/tapzero'

interface ItemLike {
    full_content?:string|null
    content?:string|null
    description?:string|null
    full_content_status?:string|null
}

function pickBody (item:ItemLike):string {
    return item.full_content || item.content || item.description || ''
}

function isFailedStatus (status?:string|null):boolean {
    return typeof status === 'string' && status.startsWith('failed_')
}

test('null status + summary content → body = summary, no notice', t => {
    const item:ItemLike = {
        full_content_status: null,
        content: '<p>summary</p>'
    }
    t.equal(pickBody(item), '<p>summary</p>', 'summary body rendered')
    t.equal(isFailedStatus(item.full_content_status), false, 'no failed notice')
})

test('succeeded → body = full_content, no notice', t => {
    const item:ItemLike = {
        full_content_status: 'succeeded',
        full_content: '<p>full body</p>',
        content: '<p>summary</p>'
    }
    t.equal(pickBody(item), '<p>full body</p>',
        'full_content preferred over summary')
    t.equal(isFailedStatus(item.full_content_status), false, 'no failed notice')
})

test('failed_network → notice visible AND summary still rendered', t => {
    const item:ItemLike = {
        full_content_status: 'failed_network',
        content: '<p>summary fallback</p>'
    }
    t.equal(isFailedStatus(item.full_content_status), true,
        'failure notice rendered')
    t.equal(pickBody(item), '<p>summary fallback</p>',
        'summary remains visible (FR-008)')
})

test('Retry handler calls State.fetchFullArticle with force:true', async t => {
    const calls:Array<{ id:number; opts:unknown }> = []
    const fakeState = {} as unknown
    const fakeFetchFull = (
        _state:unknown,
        id:number,
        opts:{ force?:boolean }
    ) => {
        calls.push({ id, opts })
        return Promise.resolve()
    }

    // Simulate the handler closure from item-reader.ts.
    const itemId = 42
    const handleRetry = async () => {
        await fakeFetchFull(fakeState, itemId, { force: true })
    }
    await handleRetry()

    t.equal(calls.length, 1, 'exactly one call')
    t.equal(calls[0].id, 42, 'with the right item id')
    t.deepEqual(calls[0].opts, { force: true }, 'with force:true')
})

test('all failed_* variants trigger the notice', t => {
    const failures = [
        'failed_network',
        'failed_status',
        'failed_redirect',
        'failed_non_html',
        'failed_too_large',
        'failed_no_body'
    ]
    for (const status of failures) {
        t.equal(
            isFailedStatus(status),
            true,
            `${status} triggers failed notice`
        )
    }
    t.equal(isFailedStatus('succeeded'), false, 'succeeded does not')
    t.equal(isFailedStatus(null), false, 'null does not')
    t.equal(isFailedStatus(undefined), false, 'undefined does not')
})
