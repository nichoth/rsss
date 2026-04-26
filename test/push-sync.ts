import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    pushSync,
    PushSyncAuthError
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

test('pushSync: 10th failed attempt moves row to dead letters', async (t) => {
    const db = await openLocalDb('did:test:push-deadletter')
    try {
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id,
                 client_updated_at, attempts)
                VALUES ('add_feed', NULL, ?, 'op-uuid-dead',
                    '2026-01-01 00:00:00', 9)`,
            bind: [JSON.stringify({ url: 'https://ex.com/dead.xml' })]
        })

        await pushSync(db, makeFetch(500))

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
        t.equal(deadRows[0]?.attempts, 10, 'final attempt is recorded')
        t.ok(
            deadRows[0]?.last_error?.includes('HTTP 500'),
            'last_error is preserved'
        )
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

        await pushSync(db, makeFetch(500))

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

            await pushSync(db, makeFetch(500))
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
                is_read: 0,
                is_starred: 0,
                created_at: '2026-01-01 00:00:00',
                updated_at: '2026-01-05 00:00:00'
            }

            await pushSync(db, makeFetch(409, { item: serverItem }))

            const item = queryOne<{ title:string; updated_at:string }>(
                db,
                'SELECT title, updated_at FROM items WHERE id = ?',
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
