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

function createCursorHarness (
    pendingFeedIds:string[] = [],
    getUpdatesOverride?:() => string[]
) {
    const feeds:FeedRow[] = [feedRow(1, 'https://a.example/feed', null)]
    const cursorUpdates:number[] = []
    const broadcasts:BroadcastCall[] = []
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
    userDo.broadcast = (event, data) => { broadcasts.push({ event, data }) }
    userDo.getFeedsWithUpdates = getUpdatesOverride ??
        (() => pendingFeedIds)

    return {
        app: userDo.createRouter(),
        cursorUpdates,
        broadcasts,
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

test('feed-updates-cleared emitted after per-feed refresh catches feed up',
    async t => {
        // getFeedsWithUpdates returns [] after cursor advance (feed is synced)
        const { app, broadcasts } = createCursorHarness([], () => [])

        const res = await app.request('/feeds/1/refresh', { method: 'POST' })
        const body = await res.json() as { success:boolean }

        t.equal(res.status, 200, 'refresh returns 200')
        t.equal(body.success, true, 'refresh reports success')

        const clearedBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-cleared'
        )
        t.equal(
            clearedBroadcasts.length,
            1,
            'feed-updates-cleared emitted once'
        )
        t.deepEqual(
            (clearedBroadcasts[0].data as { feedIds:string[] }).feedIds,
            ['1'],
            'cleared payload contains the feed ID'
        )
    }
)

test('feed-updates-cleared not emitted if feed still has newer items', async t => {
    // getFeedsWithUpdates returns ['1'] even after cursor advance (still unsynced)
    const { app, broadcasts } = createCursorHarness([], () => ['1'])

    await app.request('/feeds/1/refresh', { method: 'POST' })

    const clearedBroadcasts = broadcasts.filter(
        b => b.event === 'feed-updates-cleared'
    )
    t.equal(
        clearedBroadcasts.length,
        0,
        'feed-updates-cleared not emitted when feed still has new items'
    )
})

// ---- SSE broadcast tests ----

interface BroadcastCall {
    event:string
    data:unknown
}

interface FetchFeedDoType {
    sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
    broadcasts:BroadcastCall[]
    getFeedsWithUpdates:() => string[]
    broadcast:(event:string, data:unknown) => void
    parseFeed:(text:string) => {
        title:string|null
        description:string|null
        link:string|null
        isTooLarge?:boolean
        items:Array<{
            guid:string|null
            title:string|null
            link:string|null
            description:string|null
            content:string|null
            author:string|null
            pubDate:string|null
            imageUrl:string|null
        }>
    }
    doFetchFeedText:(url:string) => Promise<string>
    updateNewItemThumbnails:(items:unknown[]) => Promise<void>
    rowsWritten:(result:unknown) => number
    fetchFeed:(feed:FeedRow) => Promise<void>
}

function createFetchFeedHarness (opts:{
    initialUnsyncedIds?:string[]
    postInsertUnsyncedIds?:string[]
    newItemCount?:number
} = {}) {
    const broadcasts:BroadcastCall[] = []
    const {
        initialUnsyncedIds = [],
        postInsertUnsyncedIds = ['1'],
        newItemCount = 1
    } = opts

    let getFeedsCallCount = 0
    let _insertCallCount = 0

    const userDo = Object.create(UserDO.prototype) as FetchFeedDoType
    userDo.broadcasts = broadcasts

    userDo.sql = {
        exec (query:string) {
            if (
                query.includes('INSERT OR IGNORE INTO items') ||
                query.includes('INSERT OR REPLACE INTO items')
            ) {
                _insertCallCount++
                return {
                    toArray: () => [],
                    one: () => null,
                    rowsWritten: newItemCount
                } as unknown as QueryResult
            }
            if (query.includes('SELECT id FROM items')) {
                return result(newItemCount > 0 ? [{ id: 1 }] : [])
            }
            if (query.includes('UPDATE feeds SET')) {
                return result([])
            }
            return result([])
        }
    }

    userDo.broadcast = (event, data) => {
        broadcasts.push({ event, data })
    }

    userDo.getFeedsWithUpdates = () => {
        getFeedsCallCount++
        return getFeedsCallCount === 1 ?
            initialUnsyncedIds :
            postInsertUnsyncedIds
    }

    userDo.doFetchFeedText = async () => {
        return '<rss/>'
    }

    userDo.parseFeed = () => ({
        title: 'Test Feed',
        description: null,
        link: null,
        items: newItemCount > 0 ? [{
            guid: 'item-1',
            title: 'Item 1',
            link: null,
            description: null,
            content: null,
            author: null,
            pubDate: '2026-05-01',
            imageUrl: null
        }] : []
    })

    userDo.updateNewItemThumbnails = async () => {}

    userDo.rowsWritten = (res:unknown) => {
        if (res && typeof res === 'object' &&
            'rowsWritten' in res) {
            return (res as { rowsWritten:number }).rowsWritten
        }
        return newItemCount
    }

    return {
        userDo,
        broadcasts,
        feed: feedRow(1, 'https://a.example/feed', null)
    }
}

test('fetchFeed emits feed-updates-available when new items arrive for new feed',
    async t => {
        const { userDo, broadcasts, feed } = createFetchFeedHarness({
            initialUnsyncedIds: [],
            newItemCount: 1
        })

        await userDo.fetchFeed(feed)

        const availableBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-available'
        )
        t.equal(
            availableBroadcasts.length,
            1,
            'feed-updates-available emitted once'
        )
        t.deepEqual(
            (availableBroadcasts[0].data as { feedIds:string[] }).feedIds,
            ['1'],
            'payload contains the feed ID'
        )
    }
)

test(
    'fetchFeed does not emit feed-updates-available when feed already unsynced',
    async t => {
        const { userDo, broadcasts, feed } = createFetchFeedHarness({
            initialUnsyncedIds: ['1'],
            newItemCount: 1
        })

        await userDo.fetchFeed(feed)

        const availableBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-available'
        )
        t.equal(
            availableBroadcasts.length,
            0,
            'feed-updates-available not re-emitted for already-unsynced feed'
        )
    }
)

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
