/**
 * Tests for the account-deletion path inside UserDO.alarm().
 *
 * When the DO storage holds a `pending_deletion` record whose
 * scheduledFor timestamp has passed, alarm() must drop the user
 * data tables, clear the user's KV entries, and skip the normal
 * feed-refresh path.
 */
import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

interface FakeStorage {
    get:<T>(key:string) => Promise<T | undefined>
    put:(key:string, value:unknown) => Promise<void>
    delete:(key:string) => Promise<void>
    setAlarm:(time:number) => Promise<void>
    deleteAll:() => Promise<void>
}

interface FakeKv {
    get:(key:string) => Promise<string|null>
    delete:(key:string) => Promise<void>
}

function emptyResult ():QueryResult {
    return {
        toArray () { return [] },
        one () { return null }
    }
}

function createDeletionDo (initial:{
    scheduledFor:number;
    did:string
}|null) {
    const sqlExecutions:string[] = []
    const kvDeletions:string[] = []
    const setAlarms:number[] = []
    const stored = new Map<string, unknown>()
    if (initial) stored.set('pending_deletion', initial)
    let deletedAll = false
    let scheduledRefresh = false
    let refreshedFeeds = false

    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        ctx:{ storage:FakeStorage }
        env:{ SESSIONS:FakeKv } & Record<string, unknown>
        alarm:() => Promise<void>
    }

    userDo.sql = {
        exec (query:string) {
            sqlExecutions.push(query)
            return emptyResult()
        }
    }

    userDo.ctx = {
        storage: {
            get: async <T>(key:string) =>
                stored.get(key) as T | undefined,
            put: async (key:string, value:unknown) => {
                stored.set(key, value)
            },
            delete: async (key:string) => {
                stored.delete(key)
            },
            setAlarm: async (time:number) => {
                scheduledRefresh = true
                setAlarms.push(time)
            },
            deleteAll: async () => {
                deletedAll = true
                stored.clear()
            }
        }
    }

    userDo.env = {
        SESSIONS: {
            get: async () => null,
            delete: async (key:string) => {
                kvDeletions.push(key)
            }
        }
    }

    // Mark whether the normal refresh path was taken so the test
    // can assert it did NOT run when deletion was due.
    Object.defineProperty(userDo, 'refreshFeedBatches', {
        value: async () => {
            refreshedFeeds = true
        },
        writable: true,
        configurable: true
    })

    return {
        userDo,
        sqlExecutions,
        kvDeletions,
        setAlarms,
        wasDeletedAll: () => deletedAll,
        wasRescheduled: () => scheduledRefresh,
        wasFeedRefresh: () => refreshedFeeds
    }
}

test('alarm runs deletion when pending_deletion is due', async t => {
    const did = 'did:plc:alice'
    const harness = createDeletionDo({
        scheduledFor: Date.now() - 1000,
        did
    })

    await harness.userDo.alarm()

    t.ok(
        harness.sqlExecutions.some(q =>
            q.includes('DROP TABLE') && q.includes('feeds')),
        'drops the feeds table'
    )
    t.ok(
        harness.sqlExecutions.some(q =>
            q.includes('DROP TABLE') && q.includes('items')),
        'drops the items table'
    )
    t.ok(
        harness.sqlExecutions.some(q =>
            q.includes('DROP TABLE') && q.includes('dead_letter_outbox')),
        'drops the dead_letter_outbox table'
    )

    t.ok(
        harness.kvDeletions.includes(`user:${did}`),
        'deletes user KV entry'
    )
    t.ok(
        harness.kvDeletions.includes(`billing:${did}`),
        'deletes billing KV entry'
    )
    t.ok(
        harness.kvDeletions.includes(`billing_pending_email:${did}`),
        'deletes pending email KV entry'
    )
    t.ok(
        harness.kvDeletions.includes(`billing_contact_email:${did}`),
        'deletes contact email KV entry'
    )

    t.ok(harness.wasDeletedAll(), 'wipes DO storage via deleteAll()')
    t.equal(
        harness.wasFeedRefresh(),
        false,
        'does not run the feed-refresh path'
    )
    t.equal(
        harness.wasRescheduled(),
        false,
        'does not reschedule the alarm'
    )
})

test(
    'alarm skips deletion when scheduledFor is in the future',
    async t => {
        const harness = createDeletionDo({
            scheduledFor: Date.now() + 60_000,
            did: 'did:plc:alice'
        })

        await harness.userDo.alarm()

        t.equal(
            harness.wasDeletedAll(),
            false,
            'does not wipe DO storage'
        )
        t.equal(
            harness.kvDeletions.length,
            0,
            'does not delete KV entries'
        )
        t.ok(
            harness.wasRescheduled(),
            'reschedules the next alarm'
        )
    }
)

test(
    'alarm runs normally when no pending_deletion exists',
    async t => {
        const harness = createDeletionDo(null)

        await harness.userDo.alarm()

        t.equal(
            harness.wasDeletedAll(),
            false,
            'no deletion runs'
        )
        t.ok(harness.wasRescheduled(), 'reschedules the next alarm')
    }
)
