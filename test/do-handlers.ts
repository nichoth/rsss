import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface FeedRow {
    id:number
    url:string
    title:string|null
    description:string|null
    site_url:string|null
    last_fetched:string|null
    created_at:string
    updated_at:string
}

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

function result (rows:unknown[]):QueryResult {
    return {
        toArray () {
            return rows
        },
        one () {
            return rows[0] || null
        }
    }
}

function feedRow (id:number, url:string, title:string|null):FeedRow {
    return {
        id,
        url,
        title,
        description: null,
        site_url: null,
        last_fetched: null,
        created_at: '2026-04-26 00:00:00',
        updated_at: '2026-04-26 00:00:00'
    }
}

interface PendingCountRow {
    id:number|string
    pending_count:number|string|null
}

function createSql (options:{
    feeds?:FeedRow[]
    pendingCountRows?:PendingCountRow[]
} = {}) {
    const feeds:FeedRow[] = options.feeds ?? [
        feedRow(1, 'https://bravo.example/feed.xml', 'Bravo'),
        feedRow(2, 'https://alpha.example/feed.xml', 'Alpha')
    ]
    let pendingCountRows:PendingCountRow[]|null =
        options.pendingCountRows ?? null

    return {
        feeds,
        setPendingCountRows (rows:PendingCountRow[]) {
            pendingCountRows = rows
        },
        exec (query:string, ...params:unknown[]) {
            if (query.includes('SELECT * FROM feeds ORDER BY title ASC')) {
                return result([...feeds].sort((a, b) => {
                    return (a.title || '').localeCompare(b.title || '')
                }))
            }

            if (query.includes('SELECT id FROM feeds WHERE url = ?')) {
                return result(feeds
                    .filter(feed => feed.url === params[0])
                    .map(feed => ({ id: feed.id })))
            }

            if (query.includes('INSERT INTO feeds (url) VALUES (?)')) {
                const url = params[0] as string
                feeds.push(feedRow(feeds.length + 1, url, null))
                return result([])
            }

            if (query.includes('SELECT * FROM feeds WHERE url = ?')) {
                return result(feeds.filter(feed => feed.url === params[0]))
            }

            if (query.includes('SELECT * FROM feeds WHERE id = ?')) {
                return result(feeds.filter(feed => feed.id === params[0]))
            }

            if (query.includes('DELETE FROM feeds WHERE id = ?')) {
                const index = feeds.findIndex(feed => feed.id === params[0])
                if (index >= 0) feeds.splice(index, 1)
                return result([])
            }

            if (query.includes('pending_count')) {
                if (pendingCountRows !== null) {
                    return result(pendingCountRows)
                }
                return result(feeds.map(feed => ({
                    id: feed.id,
                    pending_count: 0
                })))
            }

            if (query.includes('last_pulled_at')) {
                return result([])
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }
}

function createDoHarness (options:{
    feeds?:FeedRow[]
    pendingCountRows?:PendingCountRow[]
} = {}) {
    const sql = createSql(options)
    const refreshed:number[] = []
    const waitUntilPromises:Promise<unknown>[] = []
    const storage = new Map<string, unknown>()
    const refreshFeedBatchesCalls:number[] = []
    const userDo = Object.create(UserDO.prototype) as {
        sql:ReturnType<typeof createSql>
        ctx:{
            storage:{
                get:<T>(key:string) => Promise<T|undefined>
                put:(key:string, value:unknown) => Promise<void>
                delete:(key:string) => Promise<void>
            }
            waitUntil:(promise:Promise<unknown>) => void
        }
        fetchFeed:(feed:FeedRow) => Promise<void>
        refreshFeedBatches:() => Promise<void>
        createRouter:() => { request:(path:string, init?:RequestInit) =>
            Promise<Response> }
    }

    userDo.sql = sql
    userDo.ctx = {
        storage: {
            async get<T> (key:string) {
                return storage.get(key) as T|undefined
            },
            async put (key:string, value:unknown) {
                storage.set(key, value)
            },
            async delete (key:string) {
                storage.delete(key)
            }
        },
        waitUntil (promise) {
            waitUntilPromises.push(promise)
        }
    }
    userDo.fetchFeed = async (feed) => {
        refreshed.push(feed.id)
    }
    userDo.refreshFeedBatches = async () => {
        refreshFeedBatchesCalls.push(Date.now())
    }

    return {
        app: userDo.createRouter(),
        sql,
        refreshed,
        storage,
        waitUntilPromises,
        refreshFeedBatchesCalls,
        userDo
    }
}

test('UserDO feed handlers list create and refresh feeds', async t => {
    const {
        app,
        sql,
        refreshed,
        waitUntilPromises
    } = createDoHarness()

    const listResponse = await app.request('/feeds')
    const listBody = await listResponse.json() as { feeds:FeedRow[] }

    t.equal(listResponse.status, 200, 'list returns 200')
    t.deepEqual(
        listBody.feeds.map(feed => feed.title),
        ['Alpha', 'Bravo'],
        'feeds are listed alphabetically'
    )

    const createResponse = await app.request('/feeds', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://charlie.example/feed.xml' })
    })
    const createBody = await createResponse.json() as { feed:FeedRow }

    t.equal(createResponse.status, 201, 'create returns 201')
    t.equal(
        createBody.feed.url,
        'https://charlie.example/feed.xml',
        'created feed is returned'
    )
    t.equal(sql.feeds.length, 3, 'feed row is inserted')
    t.equal(waitUntilPromises.length, 1, 'create schedules initial refresh')

    await Promise.all(waitUntilPromises)

    const refreshResponse = await app.request('/feeds/3/refresh', {
        method: 'POST'
    })
    const refreshBody = await refreshResponse.json() as { success:boolean }

    t.equal(refreshResponse.status, 200, 'refresh returns 200')
    t.equal(refreshBody.success, true, 'refresh reports success')
    t.deepEqual(refreshed, [3, 3], 'created feed is refreshed')
})

test('UserDO manual feed refresh is rate limited per feed', async t => {
    const { app, refreshed, storage } = createDoHarness()
    const responses = await Promise.all(Array.from({ length: 100 }, () => {
        return app.request('/feeds/1/refresh', { method: 'POST' })
    }))
    const body = await responses[0].json() as { success:boolean }

    t.equal(responses[0].status, 200, 'first refresh returns 200')
    t.equal(body.success, true, 'first refresh reports success')
    t.equal(refreshed.length, 1, 'rapid refreshes fetch the feed once')
    t.equal(refreshed[0], 1, 'the requested feed is refreshed')
    t.equal(storage.size, 1, 'manual refresh timestamp is stored')
})

test(
    'UserDO add feed treats client_op_id duplicate URL as idempotent',
    async t => {
        const { app, sql, waitUntilPromises } = createDoHarness()

        const response = await app.request('/feeds', {
            method: 'POST',
            body: JSON.stringify({
                url: 'https://alpha.example/feed.xml',
                client_op_id: 'op-duplicate-alpha',
                client_updated_at: '2026-04-25 00:00:00'
            })
        })
        const body = await response.json() as { feed:FeedRow }

        t.equal(response.status, 200, 'duplicate outbox retry is success')
        t.equal(body.feed.id, 2, 'authoritative feed is returned')
        t.equal(body.feed.url, 'https://alpha.example/feed.xml', 'URL matches')
        t.equal(sql.feeds.length, 2, 'no duplicate feed row is inserted')
        t.equal(waitUntilPromises.length, 0, 'no refresh is scheduled')
    }
)

test('UserDO add feed deduplicates canonical URL variants', async t => {
    const { app, sql, waitUntilPromises } = createDoHarness()

    const createResponse = await app.request('/feeds', {
        method: 'POST',
        body: JSON.stringify({
            url: 'https://Example.COM/feed/'
        })
    })
    const createBody = await createResponse.json() as { feed:FeedRow }

    const duplicateResponse = await app.request('/feeds', {
        method: 'POST',
        body: JSON.stringify({
            url: 'https://example.com/feed'
        })
    })

    t.equal(createResponse.status, 201, 'variant creates the feed')
    t.equal(
        createBody.feed.url,
        'https://example.com/feed',
        'created feed stores canonical URL'
    )
    t.equal(duplicateResponse.status, 409, 'canonical duplicate conflicts')
    t.equal(sql.feeds.length, 3, 'no duplicate feed row is inserted')
    t.equal(
        waitUntilPromises.length,
        1,
        'only the created feed schedules a refresh'
    )
})

test(
    'UserDO delete feed treats client_op_id missing row as idempotent',
    async t => {
        const { app, sql } = createDoHarness()

        const response = await app.request('/feeds/99', {
            method: 'DELETE',
            body: JSON.stringify({
                client_op_id: 'op-delete-missing',
                client_updated_at: '2026-04-25 00:00:00'
            })
        })
        const body = await response.json() as { success:boolean }

        t.equal(response.status, 200, 'missing deleted row is success')
        t.equal(body.success, true, 'response matches delete success shape')
        t.equal(sql.feeds.length, 2, 'no feed rows are changed')
    }
)

test(
    'GET /feed-status returns empty counts when no feeds are pending',
    async t => {
        const { app } = createDoHarness({
            feeds: [],
            pendingCountRows: []
        })

        const response = await app.request('/feed-status')
        const body = await response.json() as {
            feedUpdateCounts:Record<string, number>
            totalPending:number
        }

        t.equal(response.status, 200, 'returns 200')
        t.deepEqual(
            body.feedUpdateCounts,
            {},
            'feedUpdateCounts is an empty object'
        )
        t.equal(body.totalPending, 0, 'totalPending is 0')
    }
)

test('GET /feed-status returns mixed pending counts', async t => {
    const { app } = createDoHarness({
        pendingCountRows: [
            { id: 1, pending_count: 3 },
            { id: 2, pending_count: 0 },
            { id: 5, pending_count: 7 }
        ]
    })

    const response = await app.request('/feed-status')
    const body = await response.json() as {
        feedUpdateCounts:Record<string, number>
        totalPending:number
    }

    t.equal(response.status, 200, 'returns 200')
    t.deepEqual(
        body.feedUpdateCounts,
        { 1: 3, 2: 0, 5: 7 },
        'feedUpdateCounts contains stringified ids and integer counts'
    )
    t.equal(body.totalPending, 10, 'totalPending sums values across feeds')
})

test('GET /feed-status returns zeros when fully synced', async t => {
    const { app } = createDoHarness({
        pendingCountRows: [
            { id: 1, pending_count: 0 },
            { id: 2, pending_count: 0 }
        ]
    })

    const response = await app.request('/feed-status')
    const body = await response.json() as {
        feedUpdateCounts:Record<string, number>
        totalPending:number
    }

    t.equal(response.status, 200, 'returns 200')
    t.deepEqual(
        body.feedUpdateCounts,
        { 1: 0, 2: 0 },
        'each subscribed feed reported as 0 pending'
    )
    t.equal(body.totalPending, 0, 'totalPending sums to 0')
})

test(
    'GET /feed-status triggers catch-up when returning after long absence',
    async t => {
        const {
            app,
            storage,
            refreshFeedBatchesCalls
        } = createDoHarness()
        const now = Date.now()
        // Seed last_active_at to 31 days ago.
        storage.set('poll:account:last_active_at', {
            lastActiveAt: now - 31 * 24 * 60 * 60 * 1000
        })

        const response = await app.request('/feed-status')

        t.equal(response.status, 200, 'returns 200')
        t.equal(
            refreshFeedBatchesCalls.length,
            1,
            'exactly one refreshFeedBatches call is queued via waitUntil'
        )
        const updated = storage.get('poll:account:last_active_at') as {
            lastActiveAt:number
        }
        t.ok(
            updated.lastActiveAt >= now,
            'last_active_at is advanced to current time'
        )
    }
)

test(
    'GET /feed-status does NOT trigger catch-up at steady state',
    async t => {
        const {
            app,
            storage,
            refreshFeedBatchesCalls
        } = createDoHarness()
        const now = Date.now()
        // Seed both markers as recent.
        storage.set('poll:account:last_active_at', {
            lastActiveAt: now - 30_000
        })
        storage.set('poll:account:last_any_success_at', {
            lastAnySuccessAt: now - 30_000
        })

        const response = await app.request('/feed-status')

        t.equal(response.status, 200, 'returns 200')
        t.equal(
            refreshFeedBatchesCalls.length,
            0,
            'steady-state hits do NOT trigger catch-up'
        )
    }
)

test(
    'GET /feed-status advances last_active_at subject to 60s coalescing',
    async t => {
        const { app, storage } = createDoHarness({
            pendingCountRows: []
        })
        const now = Date.now()
        // First request — no prior marker. Triggers catch-up but
        // also writes the marker.
        await app.request('/feed-status')
        const first = storage.get('poll:account:last_active_at') as {
            lastActiveAt:number
        }
        t.ok(
            first && first.lastActiveAt >= now,
            'first call seeds last_active_at'
        )

        // Second request — within 60s coalescing window. Should be
        // skipped (storage value unchanged).
        const seededAt = first.lastActiveAt
        await app.request('/feed-status')
        const second = storage.get('poll:account:last_active_at') as {
            lastActiveAt:number
        }
        t.equal(
            second.lastActiveAt,
            seededAt,
            'within-60s call does NOT advance the marker'
        )
    }
)

test('UserDO delete feed clamps future client timestamps', async t => {
    const { app, sql } = createDoHarness()
    const originalWarn = console.warn
    const warnings:unknown[][] = []
    console.warn = (...args:unknown[]) => {
        warnings.push(args)
    }
    sql.feeds[0].updated_at = '9999-12-31T23:59:58'

    try {
        const response = await app.request('/feeds/1', {
            method: 'DELETE',
            body: JSON.stringify({
                client_updated_at: '9999-12-31T23:59:59'
            })
        })
        const body = await response.json() as { feed:FeedRow }

        t.equal(response.status, 409, 'clamped write is rejected')
        t.equal(body.feed.id, 1, 'authoritative feed is returned')
        t.equal(sql.feeds.length, 2, 'feed row is not deleted')
        t.equal(warnings.length, 1, 'clamp event is logged')
    } finally {
        console.warn = originalWarn
    }
})
