import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    recordCachedImage,
    sumByFeed,
    sumTotal,
    deleteByFeed
} from '../src/client/db/cached-images.js'

setTestMode(true, wasmUrl as string)

test('cached_images table exists with correct columns', async (t) => {
    const db = await openLocalDb('did:test:ci-columns')
    try {
        const rows:Array<{ name:string }> = []
        db.exec({
            sql: 'PRAGMA table_info(cached_images)',
            rowMode: 'object',
            resultRows: rows
        })
        const names = rows.map((r) => r.name)
        t.ok(names.includes('id'), 'has id column')
        t.ok(names.includes('url'), 'has url column')
        t.ok(names.includes('feed_id'), 'has feed_id column')
        t.ok(names.includes('item_id'), 'has item_id column')
        t.ok(names.includes('size_bytes'), 'has size_bytes column')
        t.ok(names.includes('cached_at'), 'has cached_at column')
    } finally {
        db.close()
    }
})

test('recordCachedImage inserts a row', async (t) => {
    const db = await openLocalDb('did:test:ci-record')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES (
                'https://example.com/feed',
                'Test Feed',
                '2024-01-01T00:00:00Z',
                '2024-01-01T00:00:00Z'
            )
        `)

        await recordCachedImage(db, {
            url: 'https://example.com/image.jpg',
            feedId: 1,
            itemId: null,
            sizeBytes: 12345
        })

        const rows:Array<{
            url:string
            feed_id:number
            item_id:number|null
            size_bytes:number
        }> = []
        db.exec({
            sql: 'SELECT * FROM cached_images',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'one row inserted')
        t.equal(rows[0].url, 'https://example.com/image.jpg', 'url stored')
        t.equal(rows[0].feed_id, 1, 'feed_id stored')
        t.equal(rows[0].item_id, null, 'item_id nullable')
        t.equal(rows[0].size_bytes, 12345, 'size_bytes stored')
    } finally {
        db.close()
    }
})

test('recordCachedImage is idempotent (INSERT OR IGNORE)', async (t) => {
    const db = await openLocalDb('did:test:ci-idempotent')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES (
                'https://example.com/feed',
                'Test Feed',
                '2024-01-01T00:00:00Z',
                '2024-01-01T00:00:00Z'
            )
        `)

        await recordCachedImage(db, {
            url: 'https://example.com/img.png',
            feedId: 1,
            sizeBytes: 500
        })
        await recordCachedImage(db, {
            url: 'https://example.com/img.png',
            feedId: 1,
            sizeBytes: 999
        })

        const rows:Array<{ size_bytes:number }> = []
        db.exec({
            sql: 'SELECT size_bytes FROM cached_images',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'second insert ignored')
        t.equal(rows[0].size_bytes, 500, 'original size preserved')
    } finally {
        db.close()
    }
})

test('sumByFeed returns total size_bytes for a feed', async (t) => {
    const db = await openLocalDb('did:test:ci-sum-feed')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES
                ('https://a.com/feed', 'Feed A',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                ('https://b.com/feed', 'Feed B',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)

        await recordCachedImage(db, {
            url: 'https://a.com/img1.jpg',
            feedId: 1,
            sizeBytes: 1000
        })
        await recordCachedImage(db, {
            url: 'https://a.com/img2.jpg',
            feedId: 1,
            sizeBytes: 2000
        })
        await recordCachedImage(db, {
            url: 'https://b.com/img1.jpg',
            feedId: 2,
            sizeBytes: 500
        })

        const total1 = await sumByFeed(db, 1)
        t.equal(total1, 3000, 'sum for feed 1 is 3000')

        const total2 = await sumByFeed(db, 2)
        t.equal(total2, 500, 'sum for feed 2 is 500')
    } finally {
        db.close()
    }
})

test('sumByFeed returns 0 for a feed with no images', async (t) => {
    const db = await openLocalDb('did:test:ci-sum-empty')
    try {
        const total = await sumByFeed(db, 99)
        t.equal(total, 0, 'returns 0 for missing feed')
    } finally {
        db.close()
    }
})

test('sumTotal returns grand total across all feeds', async (t) => {
    const db = await openLocalDb('did:test:ci-sum-total')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES
                ('https://a.com/feed', 'Feed A',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                ('https://b.com/feed', 'Feed B',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)

        await recordCachedImage(db, {
            url: 'https://a.com/img.jpg',
            feedId: 1,
            sizeBytes: 4000
        })
        await recordCachedImage(db, {
            url: 'https://b.com/img.jpg',
            feedId: 2,
            sizeBytes: 6000
        })

        const total = await sumTotal(db)
        t.equal(total, 10000, 'grand total is 10000')
    } finally {
        db.close()
    }
})

test('sumTotal returns 0 when no images cached', async (t) => {
    const db = await openLocalDb('did:test:ci-sum-zero')
    try {
        const total = await sumTotal(db)
        t.equal(total, 0, 'returns 0 when table is empty')
    } finally {
        db.close()
    }
})

test('deleteByFeed removes rows for that feed only', async (t) => {
    const db = await openLocalDb('did:test:ci-delete')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES
                ('https://a.com/feed', 'Feed A',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                ('https://b.com/feed', 'Feed B',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)

        await recordCachedImage(db, {
            url: 'https://a.com/img.jpg',
            feedId: 1,
            sizeBytes: 1000
        })
        await recordCachedImage(db, {
            url: 'https://b.com/img.jpg',
            feedId: 2,
            sizeBytes: 2000
        })

        await deleteByFeed(db, 1)

        const rows:Array<{ feed_id:number }> = []
        db.exec({
            sql: 'SELECT feed_id FROM cached_images',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'one row remains')
        t.equal(rows[0].feed_id, 2, 'feed 2 row preserved')
    } finally {
        db.close()
    }
})

test('deleteByFeed is idempotent', async (t) => {
    const db = await openLocalDb('did:test:ci-delete-idem')
    try {
        await deleteByFeed(db, 42)
        const total = await sumTotal(db)
        t.equal(total, 0, 'delete on empty table does not throw')
    } finally {
        db.close()
    }
})
