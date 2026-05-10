import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    DEAD_LETTER_ATTEMPT_LIMIT,
    pushSync,
    PushSyncAuthError,
    PushSyncBillingError
} from '../src/client/db/push-sync.js'
import {
    syncStatus,
    syncDeadLetters,
    isLocalFirstActive
} from '../src/client/db/sync-status.js'
import { createLocalAdapter } from '../src/client/db/local-adapter.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'

setTestMode(true, wasmUrl as string)

type FakeFetch = (
    url:string,
    init?:RequestInit
) => Promise<{ ok:boolean; status:number; json:() => Promise<unknown> }>

function makeFetch (
    status:number,
    body:unknown = {}
):FakeFetch {
    return async (_url, _init) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    })
}

function queryOne<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:unknown[]
):T|undefined {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind as Parameters<typeof db.exec>[0]['bind'],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows[0]
}

function queryAll<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:unknown[]
):T[] {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind as Parameters<typeof db.exec>[0]['bind'],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows
}

function seedFeed (db:Sqlite3Db):number {
    db.exec({
        sql: `INSERT INTO feeds (url, created_at, updated_at)
              VALUES ('https://example.com/feed',
                '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
    })
    const row = queryOne<{ id:number }>(
        db,
        'SELECT id FROM feeds ORDER BY id DESC LIMIT 1'
    )
    return row!.id
}

function seedItem (db:Sqlite3Db, feedId:number):number {
    db.exec({
        sql: `INSERT INTO items
            (feed_id, guid, title, link, is_read, is_starred,
             created_at, updated_at)
            VALUES (?, 'guid-1', 'Item 1', 'https://example.com/1',
                0, 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
        bind: [feedId]
    })
    const row = queryOne<{ id:number }>(
        db,
        'SELECT id FROM items ORDER BY id DESC LIMIT 1'
    )
    return row!.id
}

async function withMockedNow (
    iso:string,
    fn:() => Promise<void>
):Promise<void> {
    const RealDate = Date
    const fixedMs = RealDate.parse(iso)
    class MockDate extends RealDate {
        constructor () {
            super(fixedMs)
        }

        static now ():number {
            return fixedMs
        }
    }
    globalThis.Date = MockDate as DateConstructor
    try {
        await fn()
    } finally {
        globalThis.Date = RealDate
    }
}

// ── happy path ────────────────────────────────────────────────────────────────

test('pushSync: happy path deletes outbox row on 2xx', async (t) => {
    const db = await openLocalDb('did:test:push-happy')
    try {
        const feedId = seedFeed(db)
        const itemId = seedItem(db, feedId)

        // Insert a manual outbox row (update_item)
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('update_item', ?, ?, ?, ?)`,
            bind: [
                itemId,
                JSON.stringify({ id: itemId, is_read: true }),
                'op-uuid-1',
                '2026-01-02 00:00:00'
            ]
        })

        let capturedUrl = ''
        let capturedBody = ''
        const okFetch:FakeFetch = async (url, init) => {
            capturedUrl = url
            capturedBody = init?.body as string
            return { ok: true, status: 200, json: async () => ({}) }
        }

        await pushSync(db, okFetch)

        t.ok(capturedUrl.includes('/api/items/'), 'called correct endpoint')
        const parsed = JSON.parse(capturedBody) as Record<string, unknown>
        t.equal(parsed.client_op_id, 'op-uuid-1', 'client_op_id in body')
        t.equal(
            parsed.client_updated_at,
            '2026-01-02 00:00:00',
            'client_updated_at in body'
        )

        const row = queryOne(db, 'SELECT * FROM outbox WHERE id IS NOT NULL')
        t.equal(row, undefined, 'outbox row deleted on 2xx')
    } finally {
        db.close()
    }
})

test(
    'pushSync: same-tick updateItem writes final state to server',
    async (t) => {
        const db = await openLocalDb('did:test:push-same-tick-update')
        try {
            const feedId = seedFeed(db)
            const itemId = seedItem(db, feedId)
            const adapter = createLocalAdapter(db)
            const sameTick = '2032-03-04 05:06:07'
            const serverItem = {
                id: itemId,
                feed_id: feedId,
                guid: 'guid-1',
                title: 'Item 1',
                link: 'https://example.com/1',
                description: null,
                content: null,
                author: null,
                pub_date: null,
                is_read: 0,
                is_starred: 0,
                created_at: '2026-01-01 00:00:00',
                updated_at: sameTick
            }
            let requests = 0

            await withMockedNow('2032-03-04T05:06:07.000Z', async () => {
                await adapter.updateItem(itemId, { is_read: true })
                await adapter.updateItem(itemId, { is_starred: true })
            })

            const fakeServer:FakeFetch = async (_url, init) => {
                requests += 1
                const body = JSON.parse(
                    init?.body as string
                ) as Record<string, unknown>

                t.equal(
                    body.client_updated_at,
                    sameTick,
                    'server sees the equal client timestamp'
                )

                if (serverItem.updated_at > body.client_updated_at!) {
                    return {
                        ok: false,
                        status: 409,
                        json: async () => ({ item: serverItem })
                    }
                }

                if (body.is_read !== undefined) {
                    serverItem.is_read = body.is_read ? 1 : 0
                }
                if (body.is_starred !== undefined) {
                    serverItem.is_starred = body.is_starred ? 1 : 0
                }
                serverItem.updated_at = body.client_updated_at as string

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ item: serverItem })
                }
            }

            await pushSync(db, fakeServer)

            t.equal(requests, 1, 'coalesced updates send one request')
            t.equal(serverItem.is_read, 1, 'server has final read state')
            t.equal(
                serverItem.is_starred,
                1,
                'server has final starred state'
            )
            t.equal(
                queryAll(db, 'SELECT * FROM outbox').length,
                0,
                'outbox row drains after equal timestamp write'
            )
        } finally {
            db.close()
        }
    }
)

test('pushSync: add_feed 2xx replaces optimistic feed ID', async (t) => {
    const db = await openLocalDb('did:test:push-add-feed-id')
    try {
        const adapter = createLocalAdapter(db)
        const optimisticFeed = await adapter.addFeed(
            'https://example.com/canonical.xml'
        )
        const serverFeed = {
            id: optimisticFeed.id + 100,
            url: 'https://example.com/canonical.xml',
            title: 'Canonical Feed',
            description: null,
            site_url: 'https://example.com',
            last_fetched: '2026-01-03 00:00:00',
            created_at: '2026-01-03 00:00:00',
            updated_at: '2026-01-03 00:00:00'
        }

        await pushSync(db, makeFetch(201, { feed: serverFeed }))

        const feeds = queryAll<{ id:number; title:string|null }>(
            db,
            `SELECT id, title
             FROM feeds
             WHERE url = ?
             ORDER BY id ASC`,
            ['https://example.com/canonical.xml']
        )

        t.equal(feeds.length, 1, 'only one feed row remains')
        t.equal(feeds[0]?.id, serverFeed.id, 'server feed ID is stored')
        t.equal(feeds[0]?.title, 'Canonical Feed', 'server row is upserted')

        const outboxRows = queryAll(db, 'SELECT * FROM outbox')
        t.equal(outboxRows.length, 0, 'outbox row deleted after reconcile')
    } finally {
        db.close()
    }
})

test(
    'pushSync: add_feed rewrite lets pending delete use server ID',
    async (t) => {
        const db = await openLocalDb('did:test:push-add-delete-feed')
        try {
            const adapter = createLocalAdapter(db)
            const optimisticFeed = await adapter.addFeed(
                'https://example.com/delete-me.xml'
            )
            await adapter.deleteFeed(optimisticFeed.id)

            const serverFeed = {
                id: optimisticFeed.id + 100,
                url: 'https://example.com/delete-me.xml',
                title: 'Deleted Feed',
                description: null,
                site_url: 'https://example.com',
                last_fetched: '2026-01-03 00:00:00',
                created_at: '2026-01-03 00:00:00',
                updated_at: '2026-01-03 00:00:00'
            }
            const urls:string[] = []
            const fetchFn:FakeFetch = async (url) => {
                urls.push(url)
                if (url === '/api/feeds') {
                    return {
                        ok: true,
                        status: 201,
                        json: async () => ({ feed: serverFeed })
                    }
                }
                return {
                    ok: url === `/api/feeds/${serverFeed.id}`,
                    status: url === `/api/feeds/${serverFeed.id}` ? 204 : 404,
                    json: async () => ({})
                }
            }

            await pushSync(db, fetchFn)

            t.deepEqual(urls, [
                '/api/feeds',
                `/api/feeds/${serverFeed.id}`
            ], 'delete request uses canonical server id')

            const feeds = queryAll(db, 'SELECT * FROM feeds')
            t.equal(feeds.length, 0, 'no local feed is recreated')

            const outboxRows = queryAll(db, 'SELECT * FROM outbox')
            t.equal(outboxRows.length, 0, 'both outbox rows are drained')
        } finally {
            db.close()
        }
    }
)

test(
    'pushSync: add_feed reconcile preserves attached item state',
    async (t) => {
        const db = await openLocalDb('did:test:push-add-feed-items')
        try {
            const adapter = createLocalAdapter(db)
            const optimisticFeed = await adapter.addFeed(
                'https://example.com/offline.xml'
            )

            db.exec({
                sql: `INSERT INTO items
                    (feed_id, guid, title, link, is_read, is_starred,
                     created_at, updated_at)
                    VALUES
                        (?, 'offline-1', 'Offline 1',
                         'https://example.com/offline/1', 1, 0,
                         '2026-01-01 00:00:00', '2026-01-02 00:00:00'),
                        (?, 'offline-2', 'Offline 2',
                         'https://example.com/offline/2', 0, 1,
                         '2026-01-01 00:00:00', '2026-01-02 00:00:00')`,
                bind: [
                    optimisticFeed.id,
                    optimisticFeed.id
                ]
            })

            const serverFeed = {
                id: optimisticFeed.id + 100,
                url: 'https://example.com/offline.xml',
                title: 'Offline Feed',
                description: null,
                site_url: 'https://example.com',
                last_fetched: '2026-01-03 00:00:00',
                created_at: '2026-01-03 00:00:00',
                updated_at: '2026-01-03 00:00:00'
            }

            await pushSync(db, makeFetch(201, { feed: serverFeed }))

            const items = queryAll<{
                guid:string
                feed_id:number
                is_read:number
                is_starred:number
            }>(
                db,
                `SELECT guid, feed_id, is_read, is_starred
                 FROM items
                 WHERE feed_id = ?
                 ORDER BY guid ASC`,
                [serverFeed.id]
            )

            t.equal(items.length, 2, 'both attached items survive reconcile')
            t.equal(
                items[0]?.feed_id,
                serverFeed.id,
                'items use server feed id'
            )
            t.equal(items[0]?.is_read, 1, 'read flag survives')
            t.equal(items[1]?.is_starred, 1, 'starred flag survives')
        } finally {
            db.close()
        }
    }
)

// ── 5xx retry ─────────────────────────────────────────────────────────────────

test('pushSync: 5xx increments attempts and preserves row', async (t) => {
    const db = await openLocalDb('did:test:push-5xx')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('add_feed', NULL, ?, 'op-uuid-2', '2026-01-01 00:00:00')`,
            bind: [JSON.stringify({ url: 'https://ex.com/feed' })]
        })

        await pushSync(db, makeFetch(500))

        const row = queryOne<{
            attempts:number
            last_error:string
        }>(db, 'SELECT attempts, last_error FROM outbox LIMIT 1')
        t.equal(row?.attempts, 1, 'attempts incremented to 1')
        t.ok(
            row?.last_error?.includes('500'),
            'last_error records HTTP status'
        )
    } finally {
        db.close()
    }
})

test('pushSync: permanent failure moves row to dead letters', async (t) => {
    const db = await openLocalDb('did:test:push-deadletter')
    try {
        const attemptsBeforeFinalFailure = DEAD_LETTER_ATTEMPT_LIMIT - 1

        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id,
                 client_updated_at, attempts)
                VALUES ('add_feed', NULL, ?, 'op-uuid-dead',
                    '2026-01-01 00:00:00', ?)`,
            bind: [
                JSON.stringify({ url: 'https://ex.com/dead.xml' }),
                attemptsBeforeFinalFailure
            ]
        })

        await pushSync(db, makeFetch(400))

        const outboxRows = queryAll(db, 'SELECT * FROM outbox')
        t.equal(outboxRows.length, 0, 'outbox row promoted')

        const deadRows = queryAll<{
            op:string
            client_op_id:string
            attempts:number
            last_error:string|null
        }>(db, 'SELECT * FROM dead_letter_outbox')
        t.equal(deadRows.length, 1, 'dead-letter row inserted')
        t.equal(deadRows[0]?.op, 'add_feed', 'op is preserved')
        t.equal(
            deadRows[0]?.client_op_id,
            'op-uuid-dead',
            'client_op_id is preserved'
        )
        t.equal(
            deadRows[0]?.attempts,
            DEAD_LETTER_ATTEMPT_LIMIT,
            'final attempt is recorded'
        )
        t.ok(
            deadRows[0]?.last_error?.includes('HTTP 400'),
            'last_error is preserved'
        )
    } finally {
        db.close()
    }
})

test('pushSync: dead-letter rows are not retried', async (t) => {
    const db = await openLocalDb('did:test:push-deadletter-not-retried')
    try {
        db.exec({
            sql: `INSERT INTO dead_letter_outbox
                (op, target_id, payload, client_op_id,
                 client_updated_at, attempts, last_error)
                VALUES ('add_feed', NULL, ?, 'op-uuid-already-dead',
                    '2026-01-01 00:00:00', ?, 'HTTP 400')`,
            bind: [
                JSON.stringify({ url: 'https://ex.com/already-dead.xml' }),
                DEAD_LETTER_ATTEMPT_LIMIT
            ]
        })

        let calls = 0
        await pushSync(db, async () => {
            calls += 1
            return {
                ok: true,
                status: 200,
                json: async () => ({})
            }
        })

        t.equal(calls, 0, 'dead-letter row is not sent')
        t.equal(
            queryAll(db, 'SELECT * FROM dead_letter_outbox').length,
            1,
            'dead-letter row remains for manual recovery'
        )
    } finally {
        db.close()
    }
})

test(
    'pushSync: repeated 5xx does not consume dead-letter budget',
    async (t) => {
        const db = await openLocalDb('did:test:push-5xx-then-success')
        try {
            const feedId = seedFeed(db)
            const itemId = seedItem(db, feedId)
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id, client_updated_at)
                    VALUES ('update_item', ?, ?, 'op-uuid-5xx-success',
                        '2026-01-01 00:00:00')`,
                bind: [
                    itemId,
                    JSON.stringify({ id: itemId, is_read: true })
                ]
            })

            let calls = 0
            const transientThenOk:FakeFetch = async () => {
                calls += 1
                const status = calls <= 10 ? 500 : 200
                return {
                    ok: status >= 200 && status < 300,
                    status,
                    json: async () => ({})
                }
            }

            for (let i = 0; i < 11; i += 1) {
                await pushSync(db, transientThenOk)
            }

            t.equal(queryAll(db, 'SELECT * FROM outbox').length, 0)
            t.equal(
                queryAll(db, 'SELECT * FROM dead_letter_outbox').length,
                0,
                'transient failures are not dead-lettered'
            )
        } finally {
            db.close()
        }
    }
)

test('pushSync: 400 moves row to dead letters immediately', async (t) => {
    const db = await openLocalDb('did:test:push-400-deadletter')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('add_feed', NULL, ?, 'op-uuid-400',
                    '2026-01-01 00:00:00')`,
            bind: [JSON.stringify({ url: 'https://ex.com/bad.xml' })]
        })

        await pushSync(db, makeFetch(400))

        t.equal(queryAll(db, 'SELECT * FROM outbox').length, 0)
        const deadRows = queryAll<{
            client_op_id:string
            attempts:number
            last_error:string|null
        }>(db, 'SELECT * FROM dead_letter_outbox')
        t.equal(deadRows.length, 1, 'dead-letter row inserted')
        t.equal(deadRows[0]?.client_op_id, 'op-uuid-400')
        t.equal(deadRows[0]?.attempts, 1)
        t.ok(deadRows[0]?.last_error?.includes('HTTP 400'))
    } finally {
        db.close()
    }
})

test('pushSync: dead letters set a sync warning count', async (t) => {
    const db = await openLocalDb('did:test:push-deadletter-status')
    try {
        isLocalFirstActive.value = true
        syncStatus.value = 'idle'
        syncDeadLetters.value = 0

        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id,
                 client_updated_at, attempts)
                VALUES ('add_feed', NULL, ?, 'op-uuid-dead-status',
                    '2026-01-01 00:00:00', 9)`,
            bind: [JSON.stringify({ url: 'https://ex.com/dead-status.xml' })]
        })

        await pushSync(db, makeFetch(400))

        t.equal(syncStatus.value, 'warning', 'sync status is warning')
        t.equal(syncDeadLetters.value, 1, 'dead-letter count is exposed')
    } finally {
        isLocalFirstActive.value = false
        db.close()
    }
})

test('pushSync: sequential dead letters do not collide on id', async (t) => {
    const db = await openLocalDb('did:test:push-deadletter-sequential')
    try {
        for (const opId of ['op-uuid-dead-a', 'op-uuid-dead-b']) {
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at, attempts)
                    VALUES ('add_feed', NULL, ?, ?,
                        '2026-01-01 00:00:00', 9)`,
                bind: [
                    JSON.stringify({ url: `https://ex.com/${opId}.xml` }),
                    opId
                ]
            })

            await pushSync(db, makeFetch(400))
        }

        const deadRows = queryAll<{ client_op_id:string }>(
            db,
            `SELECT client_op_id
             FROM dead_letter_outbox
             ORDER BY id ASC`
        )
        t.equal(deadRows.length, 2, 'both failed rows are dead-lettered')
        t.equal(
            deadRows[0]?.client_op_id,
            'op-uuid-dead-a',
            'first operation is preserved'
        )
        t.equal(
            deadRows[1]?.client_op_id,
            'op-uuid-dead-b',
            'second operation is preserved'
        )
    } finally {
        db.close()
    }
})

// ── 409 reconciliation ────────────────────────────────────────────────────────

test('pushSync: 409 upserts server row and deletes outbox', async (t) => {
    const db = await openLocalDb('did:test:push-409')
    try {
        const feedId = seedFeed(db)
        const itemId = seedItem(db, feedId)

        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('update_item', ?, ?, 'op-uuid-3', '2026-01-01 00:00:00')`,
            bind: [
                itemId,
                JSON.stringify({ id: itemId, is_read: true })
            ]
        })

        const serverItem = {
            id: itemId,
            feed_id: feedId,
            guid: 'guid-1',
            title: 'Updated by server',
            link: 'https://example.com/1',
            description: null,
            content: null,
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2026-01-01 00:00:00',
            updated_at: '2026-01-03 00:00:00'
        }

        await pushSync(db, makeFetch(409, serverItem))

        const item = queryOne<{ title:string; updated_at:string }>(
            db,
            'SELECT title, updated_at FROM items WHERE id = ?',
            [itemId]
        )
        t.equal(item?.title, 'Updated by server', 'server title upserted')
        t.equal(
            item?.updated_at,
            '2026-01-03 00:00:00',
            'server updated_at upserted'
        )

        const remaining = queryAll(db, 'SELECT * FROM outbox')
        t.equal(remaining.length, 0, 'outbox row removed after 409')
    } finally {
        db.close()
    }
})

test(
    'pushSync: duplicate add-feed retry reconciles wrapped 409 feed',
    async (t) => {
        const db = await openLocalDb('did:test:push-add-feed-409')
        try {
            const adapter = createLocalAdapter(db)
            const optimisticFeed = await adapter.addFeed(
                'https://example.com/retry.xml'
            )
            const serverFeed = {
                id: optimisticFeed.id + 200,
                url: 'https://example.com/retry.xml',
                title: 'Retry Feed',
                description: null,
                site_url: 'https://example.com',
                last_fetched: '2026-01-04 00:00:00',
                created_at: '2026-01-04 00:00:00',
                updated_at: '2026-01-04 00:00:00'
            }

            await pushSync(db, makeFetch(409, { feed: serverFeed }))

            const feeds = queryAll<{ id:number; title:string|null }>(
                db,
                `SELECT id, title
                 FROM feeds
                 WHERE url = ?
                 ORDER BY id ASC`,
                ['https://example.com/retry.xml']
            )

            t.equal(feeds.length, 1, 'only the authoritative feed remains')
            t.equal(feeds[0]?.id, serverFeed.id, 'server feed ID is stored')
            t.equal(feeds[0]?.title, 'Retry Feed', 'server feed is upserted')

            const remaining = queryAll(db, 'SELECT * FROM outbox')
            t.equal(remaining.length, 0, 'outbox row removed after conflict')
        } finally {
            db.close()
        }
    }
)

test(
    'pushSync: wrapped item conflict upserts item and deletes outbox',
    async (t) => {
        const db = await openLocalDb('did:test:push-item-409-wrapped')
        try {
            const feedId = seedFeed(db)
            const itemId = seedItem(db, feedId)

            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id, client_updated_at)
                    VALUES ('update_item', ?, ?, 'op-uuid-item-wrap',
                        '2026-01-01 00:00:00')`,
                bind: [
                    itemId,
                    JSON.stringify({ id: itemId, is_starred: true })
                ]
            })

            const serverItem = {
                id: itemId,
                feed_id: feedId,
                guid: 'guid-1',
                title: 'Wrapped conflict item',
                link: 'https://example.com/1',
                description: null,
                content: null,
                author: null,
                pub_date: null,
                thumbnail_url: 'https://cdn.example.com/wrapped.jpg',
                is_read: 0,
                is_starred: 0,
                created_at: '2026-01-01 00:00:00',
                updated_at: '2026-01-05 00:00:00',
                og_image_url: 'https://cdn.example.com/og.jpg',
                blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
                image_width: 1200,
                image_height: 630
            }

            await pushSync(db, makeFetch(409, { item: serverItem }))

            const item = queryOne<{
                title:string
                thumbnail_url:string|null
                og_image_url:string|null
                blurhash:string|null
                image_width:number|null
                image_height:number|null
                updated_at:string
            }>(
                db,
                `SELECT title, thumbnail_url, og_image_url, blurhash,
                 image_width, image_height, updated_at
                 FROM items
                 WHERE id = ?`,
                [itemId]
            )
            t.equal(
                item?.title,
                'Wrapped conflict item',
                'server item upserted'
            )
            t.equal(
                item?.updated_at,
                '2026-01-05 00:00:00',
                'server updated_at upserted'
            )
            t.equal(
                item?.thumbnail_url,
                'https://cdn.example.com/wrapped.jpg',
                'server thumbnail_url upserted'
            )
            t.equal(
                item?.og_image_url,
                'https://cdn.example.com/og.jpg',
                'server og_image_url upserted'
            )
            t.equal(
                item?.blurhash,
                'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
                'server blurhash upserted'
            )
            t.equal(item?.image_width, 1200, 'server image_width upserted')
            t.equal(item?.image_height, 630, 'server image_height upserted')

            const remaining = queryAll(db, 'SELECT * FROM outbox')
            t.equal(remaining.length, 0, 'outbox row removed after conflict')
        } finally {
            db.close()
        }
    }
)

test(
    'pushSync: mark-all-read sends feed_id and reconciles items',
    async (t) => {
        const db = await openLocalDb('did:test:push-mark-all-read-409')
        try {
            const feedId = seedFeed(db)
            const itemId = seedItem(db, feedId)

            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id, client_updated_at)
                    VALUES ('mark_all_read', ?, ?, 'op-uuid-mark-wrap',
                        '2026-01-01 00:00:00')`,
                bind: [
                    feedId,
                    JSON.stringify({ feedId })
                ]
            })

            const serverItem = {
                id: itemId,
                feed_id: feedId,
                guid: 'guid-1',
                title: 'Mark conflict item',
                link: 'https://example.com/1',
                description: null,
                content: null,
                author: null,
                pub_date: null,
                is_read: 0,
                is_starred: 1,
                created_at: '2026-01-01 00:00:00',
                updated_at: '2026-01-06 00:00:00'
            }

            let capturedBody = ''
            const conflictFetch:FakeFetch = async (_url, init) => {
                capturedBody = init?.body as string
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({ items: [serverItem] })
                }
            }

            await pushSync(db, conflictFetch)

            const parsed = JSON.parse(capturedBody) as Record<string, unknown>
            t.equal(parsed.feed_id, feedId, 'scoped request uses server field')
            t.equal(parsed.feedId, undefined, 'camel-case field is not sent')
            t.equal(parsed.client_op_id, 'op-uuid-mark-wrap', 'op id is sent')

            const item = queryOne<{
                title:string
                is_starred:number
                updated_at:string
            }>(
                db,
                'SELECT title, is_starred, updated_at FROM items WHERE id = ?',
                [itemId]
            )
            t.equal(item?.title, 'Mark conflict item', 'server item upserted')
            t.equal(item?.is_starred, 1, 'server item state is upserted')
            t.equal(
                item?.updated_at,
                '2026-01-06 00:00:00',
                'server timestamp is upserted'
            )

            const remaining = queryAll(db, 'SELECT * FROM outbox')
            t.equal(remaining.length, 0, 'outbox row removed after conflict')
        } finally {
            db.close()
        }
    }
)

// ── 401 halt ──────────────────────────────────────────────────────────────────

test('pushSync: 401 throws PushSyncAuthError and preserves outbox', async (t) => {
    const db = await openLocalDb('did:test:push-401')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('add_feed', NULL, ?, 'op-uuid-4', '2026-01-01 00:00:00')`,
            bind: [JSON.stringify({ url: 'https://ex.com/feed2' })]
        })

        let threw = false
        try {
            await pushSync(db, makeFetch(401))
        } catch (err) {
            threw = err instanceof PushSyncAuthError
        }
        t.ok(threw, 'throws PushSyncAuthError')

        const rows = queryAll(db, 'SELECT * FROM outbox')
        t.equal(rows.length, 1, 'outbox row preserved on 401')
    } finally {
        db.close()
    }
})

test('pushSync: 402 throws PushSyncBillingError and preserves outbox', async (
    t
) => {
    const db = await openLocalDb('did:test:push-402')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('add_feed', NULL, ?, 'op-uuid-402',
                    '2026-01-01 00:00:00')`,
            bind: [JSON.stringify({ url: 'https://ex.com/feed' })]
        })

        let threw = false
        try {
            await pushSync(db, makeFetch(402))
        } catch (err) {
            threw = err instanceof PushSyncBillingError
        }
        t.ok(threw, 'throws PushSyncBillingError')

        const rows = queryAll(db, 'SELECT * FROM outbox')
        t.equal(rows.length, 1, 'outbox row preserved on 402')
    } finally {
        db.close()
    }
})

// ── network error retry ───────────────────────────────────────────────────────

test('pushSync: network error increments attempts', async (t) => {
    const db = await openLocalDb('did:test:push-networkerr')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('add_feed', NULL, ?, 'op-uuid-5', '2026-01-01 00:00:00')`,
            bind: [JSON.stringify({ url: 'https://ex.com/feed3' })]
        })

        const errFetch:FakeFetch = async () => {
            throw new Error('Network failure')
        }

        await pushSync(db, errFetch)

        const row = queryOne<{ attempts:number; last_error:string }>(
            db,
            'SELECT attempts, last_error FROM outbox LIMIT 1'
        )
        t.equal(row?.attempts, 1, 'attempts incremented')
        t.ok(
            row?.last_error?.includes('Network failure'),
            'last_error set to error message'
        )
    } finally {
        db.close()
    }
})
