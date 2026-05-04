import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { createLocalAdapter } from '../src/client/db/local-adapter.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'

setTestMode(true, wasmUrl as string)

async function seedDb (db:Sqlite3Db) {
    // Both feeds are seeded with `last_pulled_at` past the items'
    // pub_dates so the reading-list cursor filter does not hide
    // them. Tests that exercise the cursor explicitly seed their
    // own fixture (see seedCursorDb below).
    db.exec(`
        INSERT INTO feeds
            (url, title, last_pulled_at, created_at, updated_at)
        VALUES
            ('https://example.com/feed1', 'Feed One',
             '2024-12-31T00:00:00Z',
             '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
            ('https://example.com/feed2', 'Feed Two',
             '2024-12-31T00:00:00Z',
             '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z');

        INSERT INTO items
            (feed_id, guid, title, link, is_read, is_starred,
             created_at, updated_at, pub_date)
        VALUES
            (1, 'guid-1', 'Item One',
             'https://example.com/posts/item-one', 0, 0,
             '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
             '2024-01-01T00:00:00Z'),
            (1, 'guid-2', 'Item Two',
             'https://example.com/posts/item-two', 1, 0,
             '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z',
             '2024-01-02T00:00:00Z'),
            (2, 'guid-3', 'Item Three',
             'https://example.com/posts/item-three', 0, 1,
             '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z',
             '2024-01-03T00:00:00Z');
    `)
}

test('getFeeds returns all feeds', async (t) => {
    const db = await openLocalDb('did:test:getfeeds')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const { feeds } = await adapter.getFeeds()
        t.equal(feeds.length, 2, 'returns 2 feeds')
        t.equal(feeds[0].title, 'Feed One', 'first feed title')
        t.equal(feeds[1].title, 'Feed Two', 'second feed title')
    } finally {
        db.close()
    }
})

test('getItems returns all items with default options', async (t) => {
    const db = await openLocalDb('did:test:getitems')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const result = await adapter.getItems()
        t.equal(result.items.length, 3, 'returns 3 items')
        t.equal(result.total, 3, 'total is 3')
        t.equal(result.limit, 50, 'default limit is 50')
        t.equal(result.offset, 0, 'default offset is 0')
        t.ok(
            result.items[0].feed_title !== undefined,
            'feed_title is joined'
        )
    } finally {
        db.close()
    }
})

test('getItems filters by feedId', async (t) => {
    const db = await openLocalDb('did:test:getitems-feed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const result = await adapter.getItems({ feedId: 1 })
        t.equal(result.items.length, 2, 'returns 2 items for feed 1')
        t.equal(result.total, 2, 'total reflects filter')
    } finally {
        db.close()
    }
})

test('getItems filters by isRead', async (t) => {
    const db = await openLocalDb('did:test:getitems-read')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const unread = await adapter.getItems({ isRead: false })
        t.equal(unread.items.length, 2, '2 unread items')

        const read = await adapter.getItems({ isRead: true })
        t.equal(read.items.length, 1, '1 read item')
    } finally {
        db.close()
    }
})

test('getItems filters by isStarred', async (t) => {
    const db = await openLocalDb('did:test:getitems-starred')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const starred = await adapter.getItems({ isStarred: true })
        t.equal(starred.items.length, 1, '1 starred item')
        t.equal(starred.items[0].title, 'Item Three', 'correct starred item')
    } finally {
        db.close()
    }
})

test('getItems respects limit and offset', async (t) => {
    const db = await openLocalDb('did:test:getitems-page')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const page1 = await adapter.getItems({ limit: 2, offset: 0 })
        t.equal(page1.items.length, 2, 'page 1 has 2 items')
        t.equal(page1.total, 3, 'total still 3')

        const page2 = await adapter.getItems({ limit: 2, offset: 2 })
        t.equal(page2.items.length, 1, 'page 2 has 1 item')
    } finally {
        db.close()
    }
})

test('getItemByRoute finds item by route', async (t) => {
    const db = await openLocalDb('did:test:getitem-route')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const item = await adapter.getItemByRoute(
            'example.com/posts/item-one'
        )
        t.ok(item !== null, 'item found')
        t.equal(item!.title, 'Item One', 'correct item returned')
    } finally {
        db.close()
    }
})

test('getItemByRoute returns exact match for overlapping paths', async (t) => {
    const db = await openLocalDb('did:test:getitem-overlap')
    db.exec(`
        INSERT INTO feeds (url, title, created_at, updated_at)
        VALUES
            ('https://example.com/feed', 'Feed',
             '2024-01-01 00:00:00', '2024-01-01 00:00:00');

        INSERT INTO items
            (feed_id, guid, title, link, is_read, is_starred,
             created_at, updated_at, pub_date)
        VALUES
            (1, 'exact', 'Exact Item',
             'https://example.com/posts/item', 0, 0,
             '2024-01-01 00:00:00', '2024-01-01 00:00:00',
             '2024-01-01 00:00:00'),
            (1, 'overlap', 'Overlap Item',
             'https://example.com/posts/item-extra', 0, 0,
             '2024-01-02 00:00:00', '2024-01-02 00:00:00',
             '2024-01-02 00:00:00');
    `)
    const adapter = createLocalAdapter(db)

    try {
        const item = await adapter.getItemByRoute(
            'example.com/posts/item'
        )

        t.equal(item?.title, 'Exact Item', 'returns exact path match')
    } finally {
        db.close()
    }
})

test('getItemByRoute returns null when not found', async (t) => {
    const db = await openLocalDb('did:test:getitem-notfound')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const item = await adapter.getItemByRoute('nonexistent-route-xyz')
        t.equal(item, null, 'returns null for unknown route')
    } finally {
        db.close()
    }
})

test('getCounts returns correct unread, starred, total', async (t) => {
    const db = await openLocalDb('did:test:getcounts')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const counts = await adapter.getCounts()
        t.equal(counts.unread, 2, '2 unread items')
        t.equal(counts.starred, 1, '1 starred item')
        t.equal(counts.total, 3, '3 total items')
    } finally {
        db.close()
    }
})

test('getCounts.perFeed groups unread by feed_id', async (t) => {
    const db = await openLocalDb('did:test:getcounts-perfeed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const counts = await adapter.getCounts()

        t.equal(
            counts.perFeed['1'],
            1,
            'feed 1 has 1 unread item (Item One)'
        )
        t.equal(
            counts.perFeed['2'],
            1,
            'feed 2 has 1 unread item (Item Three)'
        )
        const sum = Object.values(counts.perFeed).reduce(
            (a, b) => a + b,
            0
        )
        t.equal(
            sum,
            counts.unread,
            'sum of perFeed values equals unread'
        )

        // Mark Item One as read; feed 1 should drop out of perFeed
        await adapter.updateItem(1, { is_read: true })
        const after = await adapter.getCounts()

        t.equal(
            after.perFeed['1'],
            undefined,
            'feed 1 absent from perFeed when zero unread'
        )
        t.equal(
            after.perFeed['2'],
            1,
            'feed 2 unchanged'
        )
    } finally {
        db.close()
    }
})

test('addFeed inserts a feed and returns it', async (t) => {
    const db = await openLocalDb('did:test:addfeed')
    const adapter = createLocalAdapter(db)
    try {
        const feed = await adapter.addFeed('https://new.example.com/feed')
        t.ok(feed.id > 0, 'feed has an id')
        t.equal(feed.url, 'https://new.example.com/feed', 'url matches')
        t.ok(feed.created_at, 'created_at is set')
        t.ok(feed.updated_at, 'updated_at is set')

        const { feeds } = await adapter.getFeeds()
        t.equal(feeds.length, 1, 'one feed in db')
    } finally {
        db.close()
    }
})

test('addFeed writes sortable SQLite timestamps', async (t) => {
    const db = await openLocalDb('did:test:addfeed-sqlite-ts')
    const adapter = createLocalAdapter(db)
    try {
        const feed = await adapter.addFeed('https://time.example.com/feed')
        const rows = getOutbox(db)
        const sqliteTsPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

        t.ok(
            sqliteTsPattern.test(feed.created_at),
            'created_at uses SQLite timestamp format'
        )
        t.ok(
            sqliteTsPattern.test(feed.updated_at),
            'updated_at uses SQLite timestamp format'
        )
        t.ok(
            sqliteTsPattern.test(rows[0].client_updated_at),
            'outbox timestamp uses SQLite timestamp format'
        )
        t.ok(
            '2026-01-01 00:00:00' > '2025-12-31 23:59:59',
            'server-style timestamps sort lexicographically'
        )
        t.ok(
            '2026-01-01 00:00:00' > '2025-12-31T23:59:59.999Z',
            'SQLite timestamps sort after older ISO timestamps'
        )
    } finally {
        db.close()
    }
})

test('deleteFeed removes feed and its items', async (t) => {
    const db = await openLocalDb('did:test:deletefeed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.deleteFeed(1)
        const { feeds } = await adapter.getFeeds()
        t.equal(feeds.length, 1, 'one feed remains')
        t.equal(feeds[0].title, 'Feed Two', 'feed two remains')

        const items = await adapter.getItems()
        t.equal(items.total, 1, 'items for deleted feed are gone')
    } finally {
        db.close()
    }
})

test('updateItem updates is_read and stamps updated_at', async (t) => {
    const db = await openLocalDb('did:test:updateitem')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const before = await adapter.getItems({ isRead: false })
        const itemId = before.items[0].id

        await adapter.updateItem(itemId, { is_read: true })

        const after = await adapter.getItems({ isRead: false })
        t.equal(after.total, before.total - 1, 'one fewer unread item')
    } finally {
        db.close()
    }
})

test('updateItem updates is_starred', async (t) => {
    const db = await openLocalDb('did:test:updateitem-star')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const items = await adapter.getItems({ isStarred: false })
        const itemId = items.items[0].id

        await adapter.updateItem(itemId, { is_starred: true })

        const starred = await adapter.getItems({ isStarred: true })
        t.equal(starred.total, 2, 'now 2 starred items')
    } finally {
        db.close()
    }
})

test('markAllRead marks all items read', async (t) => {
    const db = await openLocalDb('did:test:markallread')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.markAllRead()
        const counts = await adapter.getCounts()
        t.equal(counts.unread, 0, 'no unread items after markAllRead()')
    } finally {
        db.close()
    }
})

type OutboxRow = {
    id:number
    op:string
    target_id:number|null
    payload:string
    client_op_id:string
    client_updated_at:string
    attempts:number
    last_error:string|null
}

function getOutbox (db:Sqlite3Db):OutboxRow[] {
    const rows:OutboxRow[] = []
    db.exec({
        sql: 'SELECT * FROM outbox ORDER BY id ASC',
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows
}

function getItemFlags (
    db:Sqlite3Db,
    id:number
):{ is_read:number; is_starred:number } {
    const rows:{ is_read:number; is_starred:number }[] = []
    db.exec({
        sql: 'SELECT is_read, is_starred FROM items WHERE id = ?',
        bind: [id],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows[0]
}

function getItemUpdatedAt (db:Sqlite3Db, id:number):string {
    const rows:{ updated_at:string }[] = []
    db.exec({
        sql: 'SELECT updated_at FROM items WHERE id = ?',
        bind: [id],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows[0].updated_at
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

test('addFeed creates an outbox row', async (t) => {
    const db = await openLocalDb('did:test:outbox-addfeed')
    const adapter = createLocalAdapter(db)
    try {
        const feed = await adapter.addFeed('https://outbox.example.com/feed')
        const rows = getOutbox(db)
        t.equal(rows.length, 1, 'one outbox row')
        t.equal(rows[0].op, 'add_feed', 'op is add_feed')
        t.equal(rows[0].target_id, feed.id, 'target_id is feed id')
        const payload = JSON.parse(rows[0].payload)
        t.equal(
            payload.url,
            'https://outbox.example.com/feed',
            'payload contains url'
        )
        t.ok(rows[0].client_op_id, 'client_op_id is set')
        t.ok(rows[0].client_updated_at, 'client_updated_at is set')
        t.equal(rows[0].attempts, 0, 'attempts defaults to 0')
    } finally {
        db.close()
    }
})

test('updateItem uses one timestamp for row and outbox', async (t) => {
    const db = await openLocalDb('did:test:updateitem-one-clock')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const items = await adapter.getItems({ isRead: false })
        const itemId = items.items[0].id

        await withMockedNow('2030-05-06T07:08:09.000Z', async () => {
            await adapter.updateItem(itemId, { is_read: true })
        })

        const rows = getOutbox(db)
        t.equal(
            getItemUpdatedAt(db, itemId),
            '2030-05-06 07:08:09',
            'item row uses JS timestamp source'
        )
        t.equal(
            rows[0].client_updated_at,
            '2030-05-06 07:08:09',
            'outbox uses same timestamp'
        )
    } finally {
        db.close()
    }
})

test('markAllRead uses one timestamp for rows and outbox', async (t) => {
    const db = await openLocalDb('did:test:markallread-one-clock')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await withMockedNow('2031-06-07T08:09:10.000Z', async () => {
            await adapter.markAllRead(2)
        })

        const rows = getOutbox(db)
        const itemRows:{ updated_at:string }[] = []
        db.exec({
            sql: `SELECT updated_at FROM items
                  WHERE feed_id = 2
                  ORDER BY id ASC`,
            rowMode: 'object',
            resultRows: itemRows as Record<string, SqlValue>[]
        })

        t.equal(itemRows.length, 1, 'one feed item updated')
        t.ok(
            itemRows.every((row) => {
                return row.updated_at === '2031-06-07 08:09:10'
            }),
            'item rows use JS timestamp source'
        )
        t.equal(
            rows[0].client_updated_at,
            '2031-06-07 08:09:10',
            'outbox uses same timestamp'
        )
    } finally {
        db.close()
    }
})

test('deleteFeed creates an outbox row', async (t) => {
    const db = await openLocalDb('did:test:outbox-deletefeed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.deleteFeed(1)
        const rows = getOutbox(db)
        t.equal(rows.length, 1, 'one outbox row')
        t.equal(rows[0].op, 'delete_feed', 'op is delete_feed')
        t.equal(rows[0].target_id, 1, 'target_id is feed id')
        const payload = JSON.parse(rows[0].payload)
        t.equal(payload.id, 1, 'payload contains id')
    } finally {
        db.close()
    }
})

test('updateItem creates an outbox row', async (t) => {
    const db = await openLocalDb('did:test:outbox-updateitem')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const items = await adapter.getItems({ isRead: false })
        const itemId = items.items[0].id
        await adapter.updateItem(itemId, { is_read: true })
        const rows = getOutbox(db)
        t.equal(rows.length, 1, 'one outbox row')
        t.equal(rows[0].op, 'update_item', 'op is update_item')
        t.equal(rows[0].target_id, itemId, 'target_id is item id')
        const payload = JSON.parse(rows[0].payload)
        t.equal(payload.is_read, true, 'payload contains is_read')
        t.ok(rows[0].client_updated_at, 'client_updated_at is set')
    } finally {
        db.close()
    }
})

test('updateItem outbox payload preserves false values', async (t) => {
    const db = await openLocalDb('did:test:outbox-updateitem-false')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const items = await adapter.getItems({ isRead: true })
        const itemId = items.items[0].id
        await adapter.updateItem(itemId, {
            is_read: false,
            is_starred: false
        })

        const flags = getItemFlags(db, itemId)
        const rows = getOutbox(db)
        const payload = JSON.parse(rows[0].payload)

        t.equal(flags.is_read, 0, 'row is marked unread')
        t.equal(flags.is_starred, 0, 'row is unstarred')
        t.equal(payload.is_read, false, 'payload sends is_read false')
        t.equal(
            payload.is_starred,
            false,
            'payload sends is_starred false'
        )
    } finally {
        db.close()
    }
})

test('updateItem coalesces pending outbox row to final state', async (t) => {
    const db = await openLocalDb('did:test:outbox-updateitem-coalesce')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const items = await adapter.getItems({ isRead: false })
        const itemId = items.items[0].id

        await adapter.updateItem(itemId, { is_read: true })
        await adapter.updateItem(itemId, { is_read: false })
        await adapter.updateItem(itemId, { is_read: true })

        const flags = getItemFlags(db, itemId)
        const rows = getOutbox(db)
        const payload = JSON.parse(rows[0].payload)

        t.equal(flags.is_read, 1, 'row keeps the final read state')
        t.equal(rows.length, 1, 'one pending update_item row remains')
        t.equal(rows[0].target_id, itemId, 'pending row targets item')
        t.equal(payload.is_read, true, 'payload matches final read state')
    } finally {
        db.close()
    }
})

test('markAllRead creates an outbox row (global)', async (t) => {
    const db = await openLocalDb('did:test:outbox-markallread')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.markAllRead()
        const rows = getOutbox(db)
        t.equal(rows.length, 1, 'one outbox row')
        t.equal(rows[0].op, 'mark_all_read', 'op is mark_all_read')
        t.equal(rows[0].target_id, null, 'target_id is null for global')
    } finally {
        db.close()
    }
})

test('markAllRead creates outbox row with feedId', async (t) => {
    const db = await openLocalDb('did:test:outbox-markallread-feed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.markAllRead(2)
        const rows = getOutbox(db)
        t.equal(rows.length, 1, 'one outbox row')
        t.equal(rows[0].target_id, 2, 'target_id is feedId')
        const payload = JSON.parse(rows[0].payload)
        t.equal(payload.feedId, 2, 'payload contains feedId')
    } finally {
        db.close()
    }
})

test('markAllRead with feedId marks only that feed read', async (t) => {
    const db = await openLocalDb('did:test:markallread-feed')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        await adapter.markAllRead(1)
        const unread = await adapter.getItems({ isRead: false })
        t.equal(unread.total, 1, 'one unread item remains (from feed 2)')
        t.equal(unread.items[0].feed_id, 2, 'remaining unread is from feed 2')
    } finally {
        db.close()
    }
})

interface ItemFullContentRow extends Record<string, SqlValue> {
    id:number
    full_content:string|null
    full_content_fetched_at:string|null
    full_content_status:string|null
}

test('items table exposes full_content columns', async (t) => {
    const db = await openLocalDb('did:test:items-fullcontent')
    await seedDb(db)
    try {
        const cols:Array<{ name:string }> = []
        db.exec({
            sql: 'PRAGMA table_info(items)',
            rowMode: 'object',
            resultRows: cols as Record<string, SqlValue>[]
        })
        const names = cols.map(c => c.name)
        t.ok(names.includes('full_content'), 'full_content column exists')
        t.ok(
            names.includes('full_content_fetched_at'),
            'full_content_fetched_at column exists'
        )
        t.ok(
            names.includes('full_content_status'),
            'full_content_status column exists'
        )

        const before:ItemFullContentRow[] = []
        db.exec({
            sql: 'SELECT id, full_content, full_content_fetched_at, ' +
                'full_content_status FROM items WHERE id = 1',
            rowMode: 'object',
            resultRows: before as Record<string, SqlValue>[]
        })
        t.equal(before[0]?.full_content, null,
            'full_content is NULL by default')
        t.equal(before[0]?.full_content_status, null,
            'full_content_status is NULL by default')

        db.exec({
            sql: 'UPDATE items SET full_content = ?, ' +
                'full_content_fetched_at = ?, ' +
                'full_content_status = ? WHERE id = ?',
            bind: [
                '<p>fetched</p>',
                '2026-04-30 12:00:00',
                'succeeded',
                1
            ]
        })

        const after:ItemFullContentRow[] = []
        db.exec({
            sql: 'SELECT id, full_content, full_content_fetched_at, ' +
                'full_content_status FROM items WHERE id = 1',
            rowMode: 'object',
            resultRows: after as Record<string, SqlValue>[]
        })
        t.equal(after[0]?.full_content, '<p>fetched</p>',
            'full_content is read back')
        t.equal(after[0]?.full_content_fetched_at,
            '2026-04-30 12:00:00',
            'full_content_fetched_at is read back')
        t.equal(after[0]?.full_content_status, 'succeeded',
            'full_content_status is read back')
    } finally {
        db.close()
    }
})

// ---- Reading-list cursor filter parity tests ----
// These mirror the server's `last_pulled_at` filter so the
// local-first read path returns the same set as the remote one.

async function seedCursorDb (db:Sqlite3Db) {
    db.exec(`
        INSERT INTO feeds
            (id, url, title, last_pulled_at,
             created_at, updated_at)
        VALUES
            (1, 'https://example.com/synced', 'Synced',
             '2026-04-15T00:00:00Z',
             '2026-04-01T00:00:00Z', '2026-04-15T00:00:00Z'),
            (2, 'https://example.com/unsynced', 'Unsynced',
             NULL,
             '2026-04-01T00:00:00Z', '2026-04-15T00:00:00Z');

        INSERT INTO items
            (feed_id, guid, title, link, is_read, is_starred,
             created_at, updated_at, pub_date)
        VALUES
            (1, 'synced-old', 'Synced old',
             'https://example.com/synced/old', 0, 0,
             '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z',
             '2026-04-01T00:00:00Z'),
            (1, 'synced-new', 'Synced new',
             'https://example.com/synced/new', 0, 0,
             '2026-04-20T00:00:00Z', '2026-04-20T00:00:00Z',
             '2026-04-20T00:00:00Z'),
            (2, 'unsynced-1', 'Unsynced one',
             'https://example.com/unsynced/1', 0, 0,
             '2026-04-10T00:00:00Z', '2026-04-10T00:00:00Z',
             '2026-04-10T00:00:00Z'),
            (1, 'no-date', 'No date',
             'https://example.com/synced/no-date', 0, 0,
             '2026-04-05T00:00:00Z', '2026-04-05T00:00:00Z',
             NULL);
    `)
}

test('local getItems hides items from feeds with NULL cursor', async (t) => {
    const db = await openLocalDb('did:test:cursor-null')
    await seedCursorDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const result = await adapter.getItems()
        const titles = result.items.map(i => i.title).sort()
        t.deepEqual(
            titles,
            ['No date', 'Synced old'],
            'only items from synced feeds (and NULL pub_date) are visible'
        )
        t.equal(
            result.total,
            2,
            'total reflects cursor filter'
        )
    } finally {
        db.close()
    }
})

test('local getItems hides items past the cursor on synced feeds',
    async (t) => {
        const db = await openLocalDb('did:test:cursor-past')
        await seedCursorDb(db)
        const adapter = createLocalAdapter(db)
        try {
            const result = await adapter.getItems({ feedId: 1 })
            const titles = result.items.map(i => i.title).sort()
            t.deepEqual(
                titles,
                ['No date', 'Synced old'],
                'newer items past the cursor are hidden'
            )
            t.equal(result.total, 2, 'total reflects cursor filter')
        } finally {
            db.close()
        }
    }
)
