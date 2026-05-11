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
            if (
                query.includes('SELECT') &&
                query.includes('FROM feeds') &&
                query.includes('WHERE id = ?')
            ) {
                // FEED_SYNC_COLUMNS projection used by the refresh
                // response (returns the post-fetch row).
                return result(feeds.filter(f => f.id === params[0]))
            }
            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return result([])
            }
            if (
                query.includes('UPDATE feeds') &&
                query.includes('last_pulled_at')
            ) {
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
    const body = await res.json() as { feed?:{ id:number } }

    t.equal(res.status, 200, 'refresh returns 200')
    t.ok(body.feed, 'refresh response wraps the post-fetch row')
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
        const body = await res.json() as { feed?:{ id:number } }

        t.equal(res.status, 200, 'refresh returns 200')
        t.ok(body.feed, 'refresh response wraps the post-fetch row')

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
    ctx:{
        storage:{
            get:<T>(key:string) => Promise<T|undefined>
            put:(key:string, value:unknown) => Promise<void>
            delete:(key:string) => Promise<void>
        }
    }
    getFeedsWithUpdates:() => string[]
    getFeedUpdateCounts:() => Record<string, number>
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
    doFetchFeedText:(
        url:string,
        validators?:{ etag?:string; lastModified?:string }
    ) => Promise<{
        text:string
        url:string
        notModified:boolean
        etag?:string
        lastModified?:string
    }>
    updateNewItemThumbnails:(items:unknown[]) => Promise<void>
    rowsWritten:(result:unknown) => number
    fetchFeed:(feed:FeedRow) => Promise<void>
}

function createFetchFeedHarness (opts:{
    initialUnsyncedIds?:string[]
    postInsertUnsyncedIds?:string[]
    newItemCount?:number
    postInsertCounts?:Record<string, number>
    fetchResult?:{
        notModified?:boolean
        etag?:string
        lastModified?:string
        throw?:Error
    }
} = {}) {
    const broadcasts:BroadcastCall[] = []
    const {
        initialUnsyncedIds = [],
        postInsertUnsyncedIds = ['1'],
        newItemCount = 1,
        postInsertCounts = { 1: 1 },
        fetchResult
    } = opts
    const validatorsSeen:Array<{ etag?:string; lastModified?:string }> = []

    let getFeedsCallCount = 0
    let _insertCallCount = 0

    const userDo = Object.create(UserDO.prototype) as FetchFeedDoType
    userDo.broadcasts = broadcasts

    const harnessStorage = new Map<string, unknown>()
    userDo.ctx = {
        storage: {
            async get<T> (key:string) {
                return harnessStorage.get(key) as T|undefined
            },
            async put (key:string, value:unknown) {
                harnessStorage.set(key, value)
            },
            async delete (key:string) {
                harnessStorage.delete(key)
            }
        }
    }

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

    userDo.getFeedUpdateCounts = () => postInsertCounts

    userDo.doFetchFeedText = async (url, validators) => {
        validatorsSeen.push({
            etag: validators?.etag,
            lastModified: validators?.lastModified
        })
        if (fetchResult?.throw) throw fetchResult.throw
        if (fetchResult?.notModified) {
            return {
                text: '',
                url,
                notModified: true,
                etag: undefined,
                lastModified: undefined
            }
        }
        return {
            text: '<rss/>',
            url,
            notModified: false,
            etag: fetchResult?.etag,
            lastModified: fetchResult?.lastModified
        }
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
        feed: feedRow(1, 'https://a.example/feed', null),
        storage: harnessStorage,
        validatorsSeen
    }
}

test(
    'fetchFeed emits feed-updates-available with feedUpdateCounts for new feed',
    async t => {
        const { userDo, broadcasts, feed } = createFetchFeedHarness({
            initialUnsyncedIds: [],
            newItemCount: 1,
            postInsertCounts: { 1: 1 }
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
        const data = availableBroadcasts[0].data as {
            feedUpdateCounts:Record<string, number>
        }
        t.deepEqual(
            data.feedUpdateCounts,
            { 1: 1 },
            'payload carries feedUpdateCounts for the touched feed'
        )
    }
)

test(
    'fetchFeed re-broadcasts feed-updates-available when feed already unsynced ' +
        '(count grows)',
    async t => {
        const { userDo, broadcasts, feed } = createFetchFeedHarness({
            initialUnsyncedIds: ['1'],
            newItemCount: 1,
            postInsertCounts: { 1: 3 }
        })

        await userDo.fetchFeed(feed)

        const availableBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-available'
        )
        t.equal(
            availableBroadcasts.length,
            1,
            'feed-updates-available re-emitted even when feed was already ' +
                'unsynced (Acceptance 2.2)'
        )
        const data = availableBroadcasts[0].data as {
            feedUpdateCounts:Record<string, number>
        }
        t.deepEqual(
            data.feedUpdateCounts,
            { 1: 3 },
            'payload carries the canonical (grown) pending count'
        )
    }
)

test(
    'fetchFeed does not emit feed-updates-available when no new items arrive',
    async t => {
        const { userDo, broadcasts, feed } = createFetchFeedHarness({
            initialUnsyncedIds: [],
            newItemCount: 0,
            postInsertCounts: {}
        })

        await userDo.fetchFeed(feed)

        const availableBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-available'
        )
        t.equal(
            availableBroadcasts.length,
            0,
            'feed-updates-available skipped when newItems.length === 0'
        )
    }
)

// ---- Per-feed poller state machine tests (FR-005, FR-007, FR-010) ----

test(
    'fetchFeed 304 path inserts no items, emits no SSE updates, ' +
        'resets failures, advances nextDueAt by base cadence',
    async t => {
        const {
            userDo,
            broadcasts,
            feed,
            storage,
            validatorsSeen
        } = createFetchFeedHarness({
            fetchResult: { notModified: true }
        })
        // Seed an existing PollerFeedState with prior validators
        // and a non-zero failure count.
        storage.set('poll:feed:1', {
            etag: '"abc"',
            lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
            consecutiveFailures: 3,
            lastAttemptAt: Date.now() - 3_600_000,
            nextDueAt: Date.now() - 60_000
        })

        const beforeAt = Date.now()
        await userDo.fetchFeed(feed)
        const afterAt = Date.now()

        t.deepEqual(
            validatorsSeen[0],
            { etag: '"abc"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' },
            'prior validators are sent to fetchFeedText'
        )
        const updateBroadcasts = broadcasts.filter(
            b => b.event === 'feed-updates-available'
        )
        t.equal(
            updateBroadcasts.length,
            0,
            '304 emits NO feed-updates-available (FR-005, FR-010)'
        )
        const newState = storage.get('poll:feed:1') as {
            etag?:string
            lastModified?:string
            consecutiveFailures:number
            nextDueAt:number
        }
        t.equal(
            newState.consecutiveFailures,
            0,
            'consecutiveFailures reset on 304 (304 is success)'
        )
        const expectedMin = beforeAt + 10 * 60 * 1000
        const expectedMax = afterAt + 10 * 60 * 1000
        t.ok(
            newState.nextDueAt >= expectedMin &&
                newState.nextDueAt <= expectedMax,
            'nextDueAt advances by base cadence (10 minutes)'
        )
        t.equal(
            newState.etag,
            '"abc"',
            'prior etag is preserved (304 carries no new validator)'
        )
        const lastAnySuccess = storage.get(
            'poll:account:last_any_success_at'
        ) as { lastAnySuccessAt:number }|undefined
        t.ok(
            lastAnySuccess &&
                lastAnySuccess.lastAnySuccessAt >= beforeAt,
            'last_any_success_at advances on a 304 (it is a success)'
        )
    }
)

test(
    'fetchFeed failure path increments failures and ' +
        'stretches nextDueAt exponentially, capped at ceiling',
    async t => {
        const oneDayMs = 24 * 60 * 60 * 1000
        const cadenceMs = 10 * 60 * 1000

        // Failure 1: cadence × 2^1 = 20 min
        // Failure 2: cadence × 2^2 = 40 min
        // ...
        // Failure 8: cadence × 2^8 = 2560 min ≈ 42.7 h → capped at 24h
        const cases = [1, 2, 3, 8]
        for (const failNumber of cases) {
            const consoleError = console.error
            console.error = () => {}
            try {
                const error = new Error('boom')
                const { userDo, feed, storage } = createFetchFeedHarness({
                    fetchResult: { throw: error }
                })
                if (failNumber > 1) {
                    storage.set('poll:feed:1', {
                        consecutiveFailures: failNumber - 1,
                        nextDueAt: 0
                    })
                }

                const beforeAt = Date.now()
                await userDo.fetchFeed(feed)
                const newState = storage.get('poll:feed:1') as {
                    consecutiveFailures:number
                    nextDueAt:number
                }
                const expectedBackoff = Math.min(
                    cadenceMs * Math.pow(2, failNumber),
                    oneDayMs
                )
                t.equal(
                    newState.consecutiveFailures,
                    failNumber,
                    `consecutiveFailures = ${failNumber} after ${failNumber} failures`
                )
                const minExpected = beforeAt + expectedBackoff - 1_000
                const maxExpected = beforeAt + expectedBackoff + 5_000
                t.ok(
                    newState.nextDueAt >= minExpected &&
                        newState.nextDueAt <= maxExpected,
                    `nextDueAt at fail ${failNumber} is ` +
                        `now + ${expectedBackoff}ms`
                )
            } finally {
                console.error = consoleError
            }
        }
    }
)

test(
    'fetchFeed success after failure run resets failures + ' +
        'nextDueAt to now + base cadence',
    async t => {
        const cadenceMs = 10 * 60 * 1000
        const { userDo, feed, storage } = createFetchFeedHarness({
            fetchResult: { etag: '"v2"' }
        })
        storage.set('poll:feed:1', {
            consecutiveFailures: 5,
            nextDueAt: 0
        })

        const beforeAt = Date.now()
        await userDo.fetchFeed(feed)
        const newState = storage.get('poll:feed:1') as {
            etag?:string
            consecutiveFailures:number
            nextDueAt:number
        }

        t.equal(
            newState.consecutiveFailures,
            0,
            'consecutiveFailures resets to 0 after a success'
        )
        t.ok(
            newState.nextDueAt >= beforeAt + cadenceMs - 1_000 &&
                newState.nextDueAt <= beforeAt + cadenceMs + 5_000,
            'nextDueAt set to now + base cadence after a success'
        )
        t.equal(
            newState.etag,
            '"v2"',
            'fresh etag from response is stored'
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
            feedUpdateCounts:Record<string, number>
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
        t.deepEqual(
            body.feedUpdateCounts,
            {},
            'feedUpdateCounts is empty when no feeds have pending items'
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
            feedUpdateCounts:Record<string, number>
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
        t.deepEqual(
            body.feedUpdateCounts,
            {},
            'feedUpdateCounts defaults to empty when no counts are available'
        )
    }
)

test('GET /feeds includes per-feed update counts from cached items',
    async t => {
        const userDo = Object.create(UserDO.prototype) as CursorDoType

        userDo.sql = {
            exec (query:string) {
                if (query.includes('SELECT * FROM feeds ORDER BY title ASC')) {
                    return result([
                        feedRow(1, 'https://a.example/feed', '2026-04-02'),
                        feedRow(2, 'https://b.example/feed', '2026-04-20'),
                        feedRow(3, 'https://c.example/feed', null)
                    ])
                }
                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return result([
                        { id: 1, pending_count: 2 },
                        { id: 2, pending_count: 0 },
                        { id: 3, pending_count: 1 }
                    ])
                }
                return result([])
            }
        }
        userDo.ctx = {
            storage: {
                async get<T> (_key:string) { return undefined as T|undefined },
                async put (_key:string, _value:unknown) {},
                async delete (_key:string) {}
            },
            waitUntil (_p:Promise<unknown>) {}
        }
        userDo.fetchFeed = async () => {}
        userDo.broadcast = () => {}
        userDo.getFeedsWithUpdates = () => ['1', '3']

        const res = await userDo.createRouter().request('/feeds')
        const body = await res.json() as {
            feedUpdateCounts:Record<string, number>
        }

        t.deepEqual(
            body.feedUpdateCounts,
            { 1: 2, 2: 0, 3: 1 },
            'response includes zero and non-zero per-feed pending counts'
        )
    }
)

// ---- GET /feeds/:id/pending tests ----

function createPendingHarness (opts:{
    lastPulledAt?:string|null
    dbItems?:Array<{
        id:number
        title:string
        pub_date:string
    }>
} = {}) {
    const {
        lastPulledAt = null,
        dbItems = []
    } = opts

    const feed:FeedRow = feedRow(1, 'https://a.example/feed', lastPulledAt)

    const userDo = Object.create(UserDO.prototype) as CursorDoType

    userDo.sql = {
        exec (query:string, ..._params:unknown[]) {
            if (query.includes('SELECT * FROM feeds WHERE id = ?')) {
                return result([feed])
            }
            if (
                query.includes('FROM items') &&
                query.includes('pub_date') &&
                query.includes('LIMIT 50')
            ) {
                const cursor = lastPulledAt ?? '1970-01-01'
                const rows = dbItems
                    .filter(i => i.pub_date > cursor)
                    .sort((a, b) =>
                        b.pub_date.localeCompare(a.pub_date)
                    )
                    .slice(0, 50)
                    .map(i => ({
                        id: String(i.id),
                        title: i.title,
                        published_at: i.pub_date
                    }))
                return result(rows)
            }
            return result([])
        }
    }

    userDo.ctx = {
        storage: {
            async get<T> (_key:string) { return undefined as T|undefined },
            async put (_key:string, _value:unknown) {},
            async delete (_key:string) {}
        },
        waitUntil (_p:Promise<unknown>) {}
    }

    userDo.fetchFeed = async () => {}
    userDo.broadcast = () => {}
    userDo.getFeedsWithUpdates = () => []

    return { app: userDo.createRouter() }
}

test('GET /feeds/:id/pending returns only items past the cursor',
    async t => {
        const { app } = createPendingHarness({
            lastPulledAt: '2026-04-15',
            dbItems: [
                { id: 10, title: 'Old item', pub_date: '2026-04-01' },
                { id: 11, title: 'New item', pub_date: '2026-04-20' }
            ]
        })

        const res = await app.request('/feeds/1/pending')
        const body = await res.json() as {
            items:Array<{ id:string; title:string; published_at:string }>
        }

        t.equal(res.status, 200, 'returns 200')
        t.equal(body.items.length, 1, 'returns only 1 item past cursor')
        t.equal(body.items[0].id, '11', 'returns the newer item')
        t.equal(body.items[0].title, 'New item', 'returns correct title')
    }
)

test('GET /feeds/:id/pending returns items newest first', async t => {
    const { app } = createPendingHarness({
        lastPulledAt: '2026-01-01',
        dbItems: [
            { id: 1, title: 'Oldest', pub_date: '2026-02-01' },
            { id: 2, title: 'Middle', pub_date: '2026-03-01' },
            { id: 3, title: 'Newest', pub_date: '2026-04-01' }
        ]
    })

    const res = await app.request('/feeds/1/pending')
    const body = await res.json() as {
        items:Array<{ id:string }>
    }

    t.deepEqual(
        body.items.map(i => i.id),
        ['3', '2', '1'],
        'items are ordered newest first'
    )
})

test('GET /feeds/:id/pending honors limit of 50', async t => {
    const manyItems = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        title: `Item ${i + 1}`,
        pub_date: `2026-04-${String(i + 1).padStart(2, '0')}`
    }))

    const { app } = createPendingHarness({
        lastPulledAt: null,
        dbItems: manyItems
    })

    const res = await app.request('/feeds/1/pending')
    const body = await res.json() as {
        items:unknown[]
    }

    t.equal(body.items.length, 50, 'returns at most 50 items')
})

// ---- GET /items reading-list cursor filter tests ----
// These guard the change made for 003-defer-new-feed-items: items
// from feeds whose `last_pulled_at IS NULL` MUST NOT appear in the
// reading list, and items past the cursor are also excluded.

interface ItemsHarness {
    app:{
        request:(path:string, init?:RequestInit) => Promise<Response>
    }
    capturedListQuery:{ value:string }
    capturedCountQuery:{ value:string }
}

function createItemsHarness (opts:{
    items?:Array<{
        id:number
        feed_id:number
        pub_date:string|null
        title:string
    }>
    feeds?:Array<{
        id:number
        last_pulled_at:string|null
    }>
} = {}):ItemsHarness {
    const items = opts.items ?? []
    const feeds = opts.feeds ?? []
    const capturedListQuery = { value: '' }
    const capturedCountQuery = { value: '' }

    const userDo = Object.create(UserDO.prototype) as CursorDoType

    function applyCursor (
        rows:typeof items,
        feedRows:typeof feeds
    ):typeof items {
        const byFeed = new Map(feedRows.map(f => [f.id, f.last_pulled_at]))
        return rows.filter(item => {
            if (item.pub_date === null) return true
            const cursor = byFeed.get(item.feed_id) ?? null
            if (cursor === null) return false
            return item.pub_date <= cursor
        })
    }

    userDo.sql = {
        exec (query:string, ..._params:unknown[]) {
            const upper = query.toUpperCase()
            if (
                upper.includes('SELECT') &&
                upper.includes('FROM ITEMS') &&
                upper.includes('JOIN FEEDS') &&
                !upper.includes('COUNT(') &&
                !upper.includes('PENDING')
            ) {
                capturedListQuery.value = query
                // The handler is expected to filter via the cursor
                // predicate inside SQL. The harness honors that by
                // applying the predicate only if the query references
                // `last_pulled_at`; otherwise it returns the raw set
                // so an unfiltered handler regresses these tests.
                const rows = query.includes('last_pulled_at')
                    ? applyCursor(items, feeds)
                    : items
                return result(rows.map(i => ({
                    id: i.id,
                    feed_id: i.feed_id,
                    title: i.title,
                    pub_date: i.pub_date,
                    feed_title: 'Feed'
                })))
            }
            if (
                upper.includes('SELECT COUNT(*)') &&
                upper.includes('FROM ITEMS')
            ) {
                capturedCountQuery.value = query
                const rows = query.includes('last_pulled_at')
                    ? applyCursor(items, feeds)
                    : items
                return {
                    toArray: () => [{ count: rows.length }],
                    one: () => ({ count: rows.length })
                } as unknown as QueryResult
            }
            return result([])
        }
    }

    userDo.ctx = {
        storage: {
            async get<T> (_key:string) { return undefined as T|undefined },
            async put (_key:string, _value:unknown) {},
            async delete (_key:string) {}
        },
        waitUntil (_p:Promise<unknown>) {}
    }

    userDo.fetchFeed = async () => {}
    userDo.broadcast = () => {}
    userDo.getFeedsWithUpdates = () => []

    return {
        app: userDo.createRouter(),
        capturedListQuery,
        capturedCountQuery
    }
}

test('GET /items list query references last_pulled_at cursor', async t => {
    const { app, capturedListQuery, capturedCountQuery } = createItemsHarness()
    await app.request('/items')

    t.ok(
        capturedListQuery.value.includes('last_pulled_at'),
        'list query references last_pulled_at'
    )
    t.ok(
        capturedListQuery.value.includes('pub_date'),
        'list query compares against pub_date'
    )
    t.ok(
        capturedCountQuery.value.includes('last_pulled_at'),
        'count query references last_pulled_at'
    )
})

test('GET /items excludes items from feeds with NULL cursor', async t => {
    const { app } = createItemsHarness({
        feeds: [
            { id: 1, last_pulled_at: null },
            { id: 2, last_pulled_at: '2026-04-15' }
        ],
        items: [
            { id: 10, feed_id: 1, pub_date: '2026-04-01', title: 'Hidden' },
            { id: 11, feed_id: 2, pub_date: '2026-04-10', title: 'Visible' }
        ]
    })

    const res = await app.request('/items')
    const body = await res.json() as {
        items:Array<{ id:number; title:string }>
        total:number
    }

    t.equal(body.items.length, 1, 'one item returned')
    t.equal(body.items[0].title, 'Visible', 'visible item is from feed 2')
    t.equal(body.total, 1, 'count reflects cursor filter')
})

test('GET /items excludes items past the cursor on synced feeds', async t => {
    const { app } = createItemsHarness({
        feeds: [
            { id: 1, last_pulled_at: '2026-04-10' }
        ],
        items: [
            { id: 10, feed_id: 1, pub_date: '2026-04-01', title: 'Old' },
            { id: 11, feed_id: 1, pub_date: '2026-04-15', title: 'Newer' }
        ]
    })

    const res = await app.request('/items')
    const body = await res.json() as {
        items:Array<{ title:string }>
        total:number
    }

    t.equal(body.items.length, 1, 'one item returned')
    t.equal(body.items[0].title, 'Old', 'item before cursor is included')
    t.equal(body.total, 1, 'count matches list')
})

// ---- US2 regression: refresh promotes deferred posts ----

test('advanceFeedCursor SQL sets last_pulled_at = MAX(pub_date)',
    async t => {
        let cursorSql = ''
        const userDo = Object.create(UserDO.prototype) as {
            sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
            getFeedsWithUpdates:() => string[]
            broadcast:() => void
            advanceFeedCursor:(feedId:number) => void
        }
        userDo.sql = {
            exec (query:string, ..._params:unknown[]) {
                if (query.includes('UPDATE feeds SET last_pulled_at')) {
                    cursorSql = query
                }
                return result([])
            }
        }
        userDo.getFeedsWithUpdates = () => []
        userDo.broadcast = () => {}

        userDo.advanceFeedCursor(1)

        t.ok(
            cursorSql.includes('MAX(pub_date)'),
            'SQL assigns MAX(pub_date) to last_pulled_at'
        )
        t.ok(
            cursorSql.includes('WHERE feed_id = ?'),
            'SQL filters items to the target feed'
        )
        t.ok(
            cursorSql.includes('pub_date IS NOT NULL'),
            'SQL guards against NULL pub_date'
        )
    }
)

test('US2: refresh of NULL-cursor feed advances exactly once', async t => {
    const { app, cursorUpdates } = createCursorHarness()

    const res = await app.request('/feeds/1/refresh', { method: 'POST' })

    t.equal(res.status, 200, 'refresh returns 200')
    t.equal(
        cursorUpdates.length,
        1,
        'NULL-cursor feed gets advanced once on first refresh'
    )
    t.equal(
        cursorUpdates[0],
        1,
        'cursor advance targets the right feed id'
    )
})

test('US2: full refresh advances cursor on every subscribed feed',
    async t => {
        // Multi-feed harness: two feeds, both NULL cursor.
        const userDo = Object.create(UserDO.prototype) as CursorDoType
        const cursorIds:number[] = []
        const waitUntilPromises:Promise<unknown>[] = []
        const feeds = [
            feedRow(1, 'https://a.example/feed', null),
            feedRow(2, 'https://b.example/feed', null)
        ]

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                if (query.includes('SELECT * FROM feeds')) {
                    return result([...feeds])
                }
                if (
                    query.includes('UPDATE feeds SET last_pulled_at')
                ) {
                    cursorIds.push(params[params.length - 1] as number)
                }
                return result([])
            }
        }
        userDo.ctx = {
            storage: {
                async get<T> (_k:string) { return undefined as T|undefined },
                async put (_k:string, _v:unknown) {},
                async delete (_k:string) {}
            },
            waitUntil (p) { waitUntilPromises.push(p) }
        }
        userDo.fetchFeed = async () => {}
        userDo.broadcast = () => {}
        userDo.getFeedsWithUpdates = () => []

        const res = await userDo.createRouter()
            .request('/feeds/refresh', { method: 'POST' })
        await Promise.all(waitUntilPromises)

        t.equal(res.status, 200, 'full refresh returns 200')
        t.deepEqual(
            cursorIds.sort(),
            [1, 2],
            'every subscribed feed had its cursor advanced'
        )
    }
)

test('GET /items includes items with NULL pub_date', async t => {
    const { app } = createItemsHarness({
        feeds: [
            { id: 1, last_pulled_at: null }
        ],
        items: [
            { id: 10, feed_id: 1, pub_date: null, title: 'No date' }
        ]
    })

    const res = await app.request('/items')
    const body = await res.json() as {
        items:Array<{ title:string }>
        total:number
    }

    t.equal(body.items.length, 1, 'NULL pub_date item is visible')
    t.equal(body.items[0].title, 'No date', 'correct item returned')
    t.equal(body.total, 1, 'count includes the NULL pub_date item')
})
