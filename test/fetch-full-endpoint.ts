import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'
import type { FetchFullArticleResult } from '../src/server/article-fetch.js'

interface ItemRow {
    id:number
    feed_id:number
    guid:string
    title:string|null
    link:string|null
    description:string|null
    content:string|null
    author:string|null
    pub_date:string|null
    thumbnail_url:string|null
    is_read:number
    is_starred:number
    created_at:string
    updated_at:string
    full_content:string|null
    full_content_fetched_at:string|null
    full_content_status:string|null
}

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

function result (rows:unknown[]):QueryResult {
    return {
        toArray () { return rows },
        one () { return rows[0] || null }
    }
}

function makeItem (overrides:Partial<ItemRow> = {}):ItemRow {
    return {
        id: 1,
        feed_id: 1,
        guid: 'g1',
        title: 't',
        link: 'https://example.com/post',
        description: 'd',
        content: null,
        author: null,
        pub_date: null,
        thumbnail_url: null,
        is_read: 0,
        is_starred: 0,
        created_at: '2026-04-26 00:00:00',
        updated_at: '2026-04-26 00:00:00',
        full_content: null,
        full_content_fetched_at: null,
        full_content_status: null,
        ...overrides
    }
}

function createSql (items:ItemRow[]) {
    return {
        items,
        exec (query:string, ...params:unknown[]) {
            const q = query.replace(/\s+/g, ' ').trim()

            if (q.startsWith('SELECT') && q.includes('FROM items WHERE id = ?')) {
                const id = params[0] as number
                return result(items.filter(i => i.id === id))
            }

            const updateMatch = q.match(/^UPDATE items SET (.+) WHERE id = \?$/)
            if (updateMatch) {
                const setClause = updateMatch[1]
                const id = params[params.length - 1] as number
                const item = items.find(i => i.id === id)
                if (!item) return result([])

                // Parse "col = ?, col = ?, col = ?"
                const assignments = setClause.split(',').map(s => s.trim())
                let pIdx = 0
                for (const a of assignments) {
                    const m = a.match(/^(\w+)\s*=\s*(\?|datetime\('now'\))$/)
                    if (!m) continue
                    const col = m[1]
                    const valuePart = m[2]
                    let value:unknown
                    if (valuePart === "datetime('now')") {
                        value = '2026-05-01 12:00:00'
                    } else {
                        value = params[pIdx++]
                    }
                    ;(item as unknown as Record<string, unknown>)[col] = value
                }
                return result([])
            }

            throw new Error(`Unexpected SQL: ${q}`)
        }
    }
}

interface Harness {
    app:{ request:(path:string, init?:RequestInit) => Promise<Response> }
    items:ItemRow[]
    fetcher:{
        calls:number
        next:FetchFullArticleResult|null
    }
    storage:Map<string, unknown>
}

function createHarness (
    items:ItemRow[],
    fetchResult:FetchFullArticleResult|null
):Harness {
    const sql = createSql(items)
    const storage = new Map<string, unknown>()
    const fetcher = { calls: 0, next: fetchResult }
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
        doFetchFullArticle:(link:string) => Promise<FetchFullArticleResult>
        createRouter:() => {
            request:(path:string, init?:RequestInit) => Promise<Response>
        }
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
        waitUntil () {}
    }
    userDo.doFetchFullArticle = async (_link:string) => {
        fetcher.calls++
        if (!fetcher.next) {
            throw new Error('no fetch result configured')
        }
        return fetcher.next
    }

    return {
        app: userDo.createRouter(),
        items,
        fetcher,
        storage
    }
}

test('fetch-full - 200 + succeeded row when pipeline succeeds', async t => {
    const items = [makeItem()]
    const { app, fetcher } = createHarness(items, {
        status: 'succeeded',
        html: '<p>full body</p>',
        fetchedAt: '2026-05-01 12:00:00'
    })

    const r = await app.request('/items/1/fetch-full', { method: 'POST' })
    t.equal(r.status, 200, '200 OK')
    const body = await r.json() as { item:ItemRow }
    t.equal(body.item.full_content_status, 'succeeded', 'status saved')
    t.equal(body.item.full_content, '<p>full body</p>', 'body saved')
    t.equal(fetcher.calls, 1, 'fetch attempted once')
})

test('fetch-full - 200 + failed_status on 404', async t => {
    const items = [makeItem()]
    const { app, fetcher } = createHarness(items, {
        status: 'failed_status'
    })

    const r = await app.request('/items/1/fetch-full', { method: 'POST' })
    t.equal(r.status, 200, '200 OK (failure recorded inline)')
    const body = await r.json() as { item:ItemRow }
    t.equal(body.item.full_content_status, 'failed_status',
        'failure status saved')
    t.equal(body.item.full_content, null, 'no body written')
    t.equal(fetcher.calls, 1, 'fetch attempted')
})

test('fetch-full - 200 cache hit when already succeeded, no force',
    async t => {
        const items = [makeItem({
            full_content: '<p>cached</p>',
            full_content_status: 'succeeded',
            full_content_fetched_at: '2026-04-30 10:00:00'
        })]
        const { app, fetcher } = createHarness(items, null)

        const r = await app.request('/items/1/fetch-full', { method: 'POST' })
        t.equal(r.status, 200, '200 OK')
        const body = await r.json() as { item:ItemRow }
        t.equal(body.item.full_content, '<p>cached</p>', 'cached body returned')
        t.equal(fetcher.calls, 0, 'no fetch attempted on cache hit')
    }
)

test('fetch-full - 200 forced re-fetch overwrites a succeeded row',
    async t => {
        const items = [makeItem({
            full_content: '<p>old</p>',
            full_content_status: 'succeeded',
            full_content_fetched_at: '2026-04-30 10:00:00'
        })]
        const { app, fetcher } = createHarness(items, {
            status: 'succeeded',
            html: '<p>new</p>',
            fetchedAt: '2026-05-01 12:00:00'
        })

        const r = await app.request('/items/1/fetch-full', {
            method: 'POST',
            body: JSON.stringify({ force: true })
        })
        t.equal(r.status, 200, '200 OK')
        const body = await r.json() as { item:ItemRow }
        t.equal(body.item.full_content, '<p>new</p>', 'body updated')
        t.equal(fetcher.calls, 1, 'fetch attempted on force')
    }
)

test('fetch-full - 400 on non-integer id', async t => {
    const items = [makeItem()]
    const { app } = createHarness(items, null)

    const r = await app.request('/items/abc/fetch-full', { method: 'POST' })
    t.equal(r.status, 400, '400 Bad Request')
    const body = await r.json() as { error:string }
    t.equal(body.error, 'invalid_id', 'invalid_id error')
})

test('fetch-full - 400 on invalid JSON body', async t => {
    const items = [makeItem()]
    const { app } = createHarness(items, null)

    const r = await app.request('/items/1/fetch-full', {
        method: 'POST',
        body: 'not json',
        headers: { 'content-type': 'application/json' }
    })
    t.equal(r.status, 400, '400 Bad Request')
    const body = await r.json() as { error:string }
    t.equal(body.error, 'invalid_body', 'invalid_body error')
})

test('fetch-full - 404 on unknown id', async t => {
    const items:ItemRow[] = []
    const { app } = createHarness(items, null)

    const r = await app.request('/items/99/fetch-full', { method: 'POST' })
    t.equal(r.status, 404, '404 Not Found')
})

test('fetch-full - 409 on item with empty link', async t => {
    const items = [makeItem({ link: '' })]
    const { app, fetcher } = createHarness(items, null)

    const r = await app.request('/items/1/fetch-full', { method: 'POST' })
    t.equal(r.status, 409, '409 Conflict')
    const body = await r.json() as { error:string }
    t.equal(body.error, 'item_has_no_link', 'item_has_no_link error')
    t.equal(fetcher.calls, 0, 'no fetch attempted')
})

test('fetch-full - 429 + Retry-After on rapid second call without force',
    async t => {
        const items = [makeItem()]
        const { app, fetcher } = createHarness(items, {
            status: 'failed_network'
        })

        const first = await app.request('/items/1/fetch-full', {
            method: 'POST'
        })
        t.equal(first.status, 200, 'first call records failure')

        const second = await app.request('/items/1/fetch-full', {
            method: 'POST'
        })
        t.equal(second.status, 429, '429 Too Many Requests')
        t.ok(
            second.headers.get('Retry-After'),
            'Retry-After header set'
        )
        t.equal(fetcher.calls, 1, 'second call did not re-fetch')
    }
)

test('fetch-full - force bypasses throttle', async t => {
    const items = [makeItem()]
    const { app, fetcher } = createHarness(items, {
        status: 'failed_network'
    })

    const first = await app.request('/items/1/fetch-full', {
        method: 'POST'
    })
    t.equal(first.status, 200, 'first attempt')

    const forced = await app.request('/items/1/fetch-full', {
        method: 'POST',
        body: JSON.stringify({ force: true })
    })
    t.equal(forced.status, 200, 'force bypasses throttle')
    t.equal(fetcher.calls, 2, 'force re-fetches')
})
