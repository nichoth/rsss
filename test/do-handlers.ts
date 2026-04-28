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

function createSql () {
    const feeds:FeedRow[] = [
        feedRow(1, 'https://bravo.example/feed.xml', 'Bravo'),
        feedRow(2, 'https://alpha.example/feed.xml', 'Alpha')
    ]

    return {
        feeds,
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

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }
}

function createDoHarness () {
    const sql = createSql()
    const refreshed:number[] = []
    const waitUntilPromises:Promise<unknown>[] = []
    const userDo = Object.create(UserDO.prototype) as {
        sql:ReturnType<typeof createSql>
        ctx:{ waitUntil:(promise:Promise<unknown>) => void }
        fetchFeed:(feed:FeedRow) => Promise<void>
        createRouter:() => { request:(path:string, init?:RequestInit) =>
            Promise<Response> }
    }

    userDo.sql = sql
    userDo.ctx = {
        waitUntil (promise) {
            waitUntilPromises.push(promise)
        }
    }
    userDo.fetchFeed = async (feed) => {
        refreshed.push(feed.id)
    }

    return {
        app: userDo.createRouter(),
        sql,
        refreshed,
        waitUntilPromises
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
