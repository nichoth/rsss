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
