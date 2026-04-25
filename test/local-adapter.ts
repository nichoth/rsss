import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { createLocalAdapter } from '../src/client/db/local-adapter.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'

setTestMode(true, wasmUrl as string)

async function seedDb (db:Sqlite3Db) {
    db.exec(`
        INSERT INTO feeds (url, title, created_at, updated_at)
        VALUES
            ('https://example.com/feed1', 'Feed One',
             '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
            ('https://example.com/feed2', 'Feed Two',
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
        const feeds = await adapter.getFeeds()
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

test('getItemByRoute finds item by link substring', async (t) => {
    const db = await openLocalDb('did:test:getitem-route')
    await seedDb(db)
    const adapter = createLocalAdapter(db)
    try {
        const item = await adapter.getItemByRoute('item-one')
        t.ok(item !== null, 'item found')
        t.equal(item!.title, 'Item One', 'correct item returned')
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

test('addFeed inserts a feed and returns it', async (t) => {
    const db = await openLocalDb('did:test:addfeed')
    const adapter = createLocalAdapter(db)
    try {
        const feed = await adapter.addFeed('https://new.example.com/feed')
        t.ok(feed.id > 0, 'feed has an id')
        t.equal(feed.url, 'https://new.example.com/feed', 'url matches')
        t.ok(feed.created_at, 'created_at is set')
        t.ok(feed.updated_at, 'updated_at is set')

        const feeds = await adapter.getFeeds()
        t.equal(feeds.length, 1, 'one feed in db')
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
        const feeds = await adapter.getFeeds()
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
        resultRows: rows as unknown[]
    })
    return rows
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
