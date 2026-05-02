import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface FeedRow {
    id:number
    url:string
    title:string|null
    last_pulled_at:string|null
    last_fetched:string|null
    updated_at:string
}

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

function result (rows:unknown[] = []):QueryResult {
    return {
        toArray () { return rows },
        one () { return rows[0] || null }
    }
}

function feedRow (
    id:number,
    url:string,
    lastPulledAt:string|null = null
):FeedRow {
    return {
        id,
        url,
        title: null,
        last_pulled_at: lastPulledAt,
        last_fetched: null,
        updated_at: '2026-05-01 00:00:00'
    }
}

// ---- getFeedsWithUpdates helper tests ----

test('getFeedsWithUpdates returns string IDs of feeds with newer items',
    t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
            getFeedsWithUpdates:() => string[]
        }

        userDo.sql = {
            exec () {
                return result([{ id: 1 }, { id: 3 }])
            }
        }

        const ids = userDo.getFeedsWithUpdates()
        t.deepEqual(ids, ['1', '3'], 'returns string IDs')
    }
)

test('getFeedsWithUpdates query uses last_pulled_at', t => {
    let capturedQuery = ''
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
        getFeedsWithUpdates:() => string[]
    }

    userDo.sql = {
        exec (query:string) {
            capturedQuery = query
            return result([])
        }
    }

    userDo.getFeedsWithUpdates()
    t.ok(
        capturedQuery.includes('last_pulled_at'),
        'query references last_pulled_at cursor'
    )
    t.ok(
        capturedQuery.includes('pub_date'),
        'query compares against item pub_date'
    )
})

test('getFeedsWithUpdates returns empty when all feeds caught up', t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
        getFeedsWithUpdates:() => string[]
    }

    userDo.sql = {
        exec () { return result([]) }
    }

    t.deepEqual(userDo.getFeedsWithUpdates(), [], 'empty when no stale feeds')
})

// ---- Route-level cursor advancement tests ----

interface CursorDoType {
    sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
    ctx:{
        storage:{
            get:<T>(key:string) => Promise<T|undefined>
            put:(key:string, value:unknown) => Promise<void>
            delete:(key:string) => Promise<void>
        }
        waitUntil:(p:Promise<unknown>) => void
    }
    fetchFeed:(feed:FeedRow) => Promise<void>
    broadcast:(event:string, data:unknown) => void
    getFeedsWithUpdates:() => string[]
    createRouter:() => {
        request:(path:string, init?:RequestInit) => Promise<Response>
    }
}

function createCursorHarness (pendingFeedIds:string[] = []) {
    const feeds:FeedRow[] = [feedRow(1, 'https://a.example/feed', null)]
    const cursorUpdates:number[] = []
    const waitUntilPromises:Promise<unknown>[] = []
    const storage = new Map<string, unknown>()

    const userDo = Object.create(UserDO.prototype) as CursorDoType

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('SELECT * FROM feeds WHERE id = ?')) {
                return result(feeds.filter(f => f.id === params[0]))
            }
            if (query.includes('SELECT * FROM feeds ORDER BY title ASC')) {
                return result([...feeds])
            }
            if (query.includes('SELECT * FROM feeds')) {
                return result([...feeds])
            }
            if (query.includes('last_pulled_at')) {
                cursorUpdates.push(params[params.length - 1] as number)
                return result([])
            }
            return result([])
        }
    }

    userDo.ctx = {
        storage: {
            async get<T> (key:string) { return storage.get(key) as T|undefined },
            async put (key:string, value:unknown) { storage.set(key, value) },
            async delete (key:string) { storage.delete(key) }
        },
        waitUntil (p) { waitUntilPromises.push(p) }
    }

    userDo.fetchFeed = async () => {}
    userDo.broadcast = () => {}
    userDo.getFeedsWithUpdates = () => pendingFeedIds

    return {
        app: userDo.createRouter(),
        cursorUpdates,
        waitUntilPromises
    }
}

test('cursor advances after per-feed refresh', async t => {
    const { app, cursorUpdates } = createCursorHarness()

    const res = await app.request('/feeds/1/refresh', { method: 'POST' })
    const body = await res.json() as { success:boolean }

    t.equal(res.status, 200, 'refresh returns 200')
    t.equal(body.success, true, 'refresh reports success')
    t.equal(cursorUpdates.length, 1, 'cursor updated once')
    t.equal(cursorUpdates[0], 1, 'cursor updated for feed 1')
})

test('cursor advances after full refresh for each feed', async t => {
    const { app, cursorUpdates, waitUntilPromises } = createCursorHarness()

    const res = await app.request('/feeds/refresh', { method: 'POST' })
    await Promise.all(waitUntilPromises)

    t.equal(res.status, 200, 'full refresh returns 200')
    t.equal(cursorUpdates.length, 1, 'cursor updated for the one feed')
    t.equal(cursorUpdates[0], 1, 'cursor updated for feed 1')
})

// ---- GET /feeds bootstrap response shape tests ----

test('GET /feeds includes feedUpdateStatus synced when no pending feeds',
    async t => {
        const { app } = createCursorHarness([])
        const res = await app.request('/feeds')
        const body = await res.json() as {
            feeds:unknown[]
            feedUpdateStatus:string
            feedsWithUpdates:string[]
        }

        t.equal(res.status, 200, 'GET /feeds returns 200')
        t.ok(Array.isArray(body.feeds), 'feeds array present')
        t.equal(
            body.feedUpdateStatus,
            'synced',
            'feedUpdateStatus is synced when no pending feeds'
        )
        t.deepEqual(
            body.feedsWithUpdates,
            [],
            'feedsWithUpdates is empty when no pending feeds'
        )
    }
)

test('GET /feeds includes feedUpdateStatus updates when feeds pending',
    async t => {
        const { app } = createCursorHarness(['1'])
        const res = await app.request('/feeds')
        const body = await res.json() as {
            feeds:unknown[]
            feedUpdateStatus:string
            feedsWithUpdates:string[]
        }

        t.equal(
            body.feedUpdateStatus,
            'updates',
            'feedUpdateStatus is updates when feeds have newer items'
        )
        t.deepEqual(
            body.feedsWithUpdates,
            ['1'],
            'feedsWithUpdates contains the pending feed ID'
        )
    }
)
