import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface PollerFeedState {
    etag?:string
    lastModified?:string
    consecutiveFailures:number
    lastAttemptAt?:number
    lastSuccessfulAt?:number
    nextDueAt:number
}

interface AccountActivityMarker {
    lastActiveAt:number
}

interface LastAnySuccessRecord {
    lastAnySuccessAt:number
}

function createPollDo () {
    const storage = new Map<string, unknown>()
    const userDo = Object.create(UserDO.prototype) as {
        ctx:{
            storage:{
                get:<T>(key:string) => Promise<T|undefined>
                put:<T>(key:string, value:T) => Promise<void>
                delete:(key:string) => Promise<void>
            }
        }
        readPollerFeedState:(feedId:number) => Promise<PollerFeedState|undefined>
        writePollerFeedState:(feedId:number, state:PollerFeedState) => Promise<void>
        deletePollerFeedState:(feedId:number) => Promise<void>
        readAccountActivity:() => Promise<AccountActivityMarker|undefined>
        writeAccountActivity:(now:number) => Promise<void>
        readLastAnySuccess:() => Promise<number|undefined>
        writeLastAnySuccess:(now:number) => Promise<void>
    }

    userDo.ctx = {
        storage: {
            async get<T> (key:string) {
                return storage.get(key) as T|undefined
            },
            async put<T> (key:string, value:T) {
                storage.set(key, value)
            },
            async delete (key:string) {
                storage.delete(key)
            }
        }
    }

    return { userDo, storage }
}

test('readPollerFeedState returns undefined when no record exists', async t => {
    const { userDo } = createPollDo()
    const state = await userDo.readPollerFeedState(1)
    t.equal(state, undefined, 'no record yet returns undefined')
})

test('writePollerFeedState round-trips a record', async t => {
    const { userDo } = createPollDo()
    const written:PollerFeedState = {
        etag: '"abc"',
        lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        consecutiveFailures: 0,
        lastAttemptAt: 1700000000000,
        lastSuccessfulAt: 1700000000000,
        nextDueAt: 1700000600000
    }
    await userDo.writePollerFeedState(7, written)
    const readBack = await userDo.readPollerFeedState(7)
    t.deepEqual(readBack, written, 'round trip preserves all fields')
})

test('deletePollerFeedState removes the record', async t => {
    const { userDo } = createPollDo()
    await userDo.writePollerFeedState(2, {
        consecutiveFailures: 0,
        nextDueAt: 0
    })
    await userDo.deletePollerFeedState(2)
    const readBack = await userDo.readPollerFeedState(2)
    t.equal(readBack, undefined, 'record is gone after delete')
})

test('writePollerFeedState clears etag when undefined', async t => {
    const { userDo } = createPollDo()
    await userDo.writePollerFeedState(5, {
        etag: '"abc"',
        lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        consecutiveFailures: 0,
        nextDueAt: 1700000600000
    })
    await userDo.writePollerFeedState(5, {
        consecutiveFailures: 0,
        nextDueAt: 1700001200000
    })
    const readBack = await userDo.readPollerFeedState(5)
    t.ok(readBack, 'record exists')
    t.equal(readBack?.etag, undefined, 'stale etag is not retained')
    t.equal(
        readBack?.lastModified,
        undefined,
        'stale lastModified is not retained'
    )
})

test(
    'writeAccountActivity coalesces writes within 60 seconds',
    async t => {
        const { userDo, storage } = createPollDo()
        const t0 = 1_700_000_000_000
        await userDo.writeAccountActivity(t0)
        const first = storage
            .get('poll:account:last_active_at') as AccountActivityMarker
        t.equal(first.lastActiveAt, t0, 'first write stores the timestamp')

        await userDo.writeAccountActivity(t0 + 30_000)
        const second = storage
            .get('poll:account:last_active_at') as AccountActivityMarker
        t.equal(
            second.lastActiveAt,
            t0,
            '30s-later write is coalesced (skipped)'
        )

        await userDo.writeAccountActivity(t0 + 60_001)
        const third = storage
            .get('poll:account:last_active_at') as AccountActivityMarker
        t.equal(
            third.lastActiveAt,
            t0 + 60_001,
            'past-60s write advances the timestamp'
        )
    }
)

test(
    'writeLastAnySuccess uses max(prev, now)',
    async t => {
        const { userDo, storage } = createPollDo()
        const t0 = 1_700_000_000_000
        await userDo.writeLastAnySuccess(t0)
        let stored = storage
            .get('poll:account:last_any_success_at') as LastAnySuccessRecord
        t.equal(stored.lastAnySuccessAt, t0, 'first write stores t0')

        await userDo.writeLastAnySuccess(t0 - 5_000)
        stored = storage
            .get('poll:account:last_any_success_at') as LastAnySuccessRecord
        t.equal(
            stored.lastAnySuccessAt,
            t0,
            'out-of-order earlier write does not regress'
        )

        await userDo.writeLastAnySuccess(t0 + 1_000)
        stored = storage
            .get('poll:account:last_any_success_at') as LastAnySuccessRecord
        t.equal(
            stored.lastAnySuccessAt,
            t0 + 1_000,
            'later write advances'
        )

        const readBack = await userDo.readLastAnySuccess()
        t.equal(readBack, t0 + 1_000, 'read returns the stored value')
    }
)

test('poll-state tests done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
