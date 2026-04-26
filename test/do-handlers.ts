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
