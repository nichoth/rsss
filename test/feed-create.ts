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

function result (rows:unknown[]) {
    return {
        toArray () {
            return rows
        },
        one () {
            return rows[0] || null
        }
    }
}

function createFeedSql () {
    const feeds:FeedRow[] = []

    return {
        feeds,
        exec (query:string, ...params:unknown[]) {
            if (query.includes('SELECT id FROM feeds WHERE url = ?')) {
                return result(feeds
                    .filter(feed => feed.url === params[0])
                    .map(feed => ({ id: feed.id })))
            }

            if (query.includes('INSERT INTO feeds (url) VALUES (?)')) {
                const url = params[0] as string
                feeds.push({
                    id: feeds.length + 1,
                    url,
                    title: null,
                    description: null,
                    site_url: null,
                    last_fetched: null,
                    created_at: '2026-04-26 00:00:00',
                    updated_at: '2026-04-26 00:00:00'
                })
                return result([])
            }

            if (query.includes('SELECT * FROM feeds WHERE url = ?')) {
                return result(feeds.filter(feed => feed.url === params[0]))
            }

            if (query.includes('SELECT * FROM feeds WHERE id = ?')) {
                return result(feeds)
            }

            if (query.includes('SELECT COUNT(*) as count')) {
                return result([{ count: 0 }])
            }

            // POST /feeds unread count query
            if (query.includes('SELECT COUNT(*) as unread FROM items') &&
                query.includes('WHERE feed_id = ?') &&
                query.includes('AND is_read = 0')) {
                return result([{ unread: 0 }])
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor (
    predicate:() => boolean,
    maxTurns = 25
):Promise<void> {
    for (let i = 0; i < maxTurns; i++) {
        if (predicate()) return
        await nextTask()
    }
}

function createStorageStub () {
    let alarm:number|null = null
    return {
        getAlarm: async () => alarm,
        setAlarm: async (when:number) => { alarm = when },
        deleteAlarm: async () => { alarm = null }
    }
}

function createRouterForPostFeeds (
    waitUntil:(promise:Promise<unknown>) => void,
    fetchFeed:(feed:FeedRow) => Promise<void>
) {
    const sql = createFeedSql()
    const userDo = Object.create(UserDO.prototype) as {
        sql:ReturnType<typeof createFeedSql>
        ctx:{
            waitUntil:(promise:Promise<unknown>) => void
            storage:ReturnType<typeof createStorageStub>
        }
        fetchFeed:(feed:FeedRow) => Promise<void>
        createRouter:() => { request:(path:string, init:RequestInit) =>
            Promise<Response> }
    }

    userDo.sql = sql
    userDo.ctx = { waitUntil, storage: createStorageStub() }
    userDo.fetchFeed = fetchFeed

    return {
        app: userDo.createRouter(),
        sql
    }
}

test('POST /feeds hybrid race: fast fetch returns resolved state immediately', async t => {
    let waitUntilCalled = false
    let fetchStarted = false
    const { app, sql } = createRouterForPostFeeds(
        () => {
            waitUntilCalled = true
        },
        async () => {
            fetchStarted = true
            // Fast fetch resolves immediately
        }
    )

    let response:Response|null = null
    const startTime = Date.now()
    const responsePromise = app.request('/feeds', {
        method: 'POST',
        body: JSON.stringify({
            url: 'https://example.com/feed.xml'
        })
    }).then((res) => {
        response = res
        return res
    })

    await responsePromise
    const elapsedTime = Date.now() - startTime

    t.ok(
        elapsedTime < 500,
        `fast fetch responds quickly (actual: ${elapsedTime}ms)`
    )
    t.equal(fetchStarted, true, 'fetch was attempted')
    t.equal(
        waitUntilCalled,
        false,
        'fast path does not use waitUntil'
    )
    t.equal(sql.feeds.length, 1, 'feed row is inserted')

    const settledResponse = response as Response | null

    if (settledResponse) {
        const body = await settledResponse.json() as { feed:FeedRow; unread?:number }
        t.equal(settledResponse.status, 201, 'feed create returns 201')
        t.equal(body.feed.url, 'https://example.com/feed.xml')
        t.equal(body.unread, 0, 'response includes unread count')
    }
})
