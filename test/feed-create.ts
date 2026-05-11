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

            if (query.includes('SELECT COUNT(*) as count')) {
                return result([{ count: 0 }])
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

test('POST /feeds returns before initial feed fetch settles', async t => {
    let waitUntilCalled = false
    let fetchStarted = false
    let releaseFetch = () => {}
    const deferredFetch = new Promise<void>((resolve) => {
        releaseFetch = resolve
    })
    const waitUntilPromises:Promise<unknown>[] = []
    const { app, sql } = createRouterForPostFeeds(
        (promise) => {
            waitUntilCalled = true
            waitUntilPromises.push(promise)
        },
        async () => {
            fetchStarted = true
            await deferredFetch
        }
    )

    let response:Response|null = null
    const responsePromise = app.request('/feeds', {
        method: 'POST',
        body: JSON.stringify({
            url: 'https://example.com/feed.xml'
        })
    }).then((res) => {
        response = res
        return res
    })

    await waitFor(() => fetchStarted || waitUntilCalled)

    t.equal(response !== null, true, 'response resolves immediately')
    t.equal(
        waitUntilCalled,
        true,
        'initial fetch is registered with waitUntil'
    )
    t.equal(fetchStarted, true, 'initial fetch starts in the background')
    t.equal(sql.feeds.length, 1, 'feed row is inserted before response')

    const settledResponse = response as Response | null

    if (settledResponse) {
        const body = await settledResponse.json() as { feed:FeedRow }
        t.equal(settledResponse.status, 201, 'feed create returns 201')
        t.equal(body.feed.url, 'https://example.com/feed.xml')
        t.equal(body.feed.title, null, 'response does not wait for metadata')
    }

    releaseFetch()
    await responsePromise
    await Promise.all(waitUntilPromises)
})
