import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { clearFeedCache } from '../src/client/db/content-storage.js'
import { recordCachedImage } from '../src/client/db/cached-images.js'

setTestMode(true, wasmUrl as string)

function makeDb (name:string) {
    return openLocalDb(name)
}

function mockCacheStorage () {
    const deleted:string[] = []
    const storage:Pick<CacheStorage, 'open'> = {
        open: async () => ({
            delete: async (url:string) => {
                deleted.push(url)
                return true
            }
        } as unknown as Cache)
    }
    return { storage, deleted }
}

test(
    'clearFeedCache nulls content and description for the feed',
    async (t) => {
        const db = await makeDb('did:test:cfc-text')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES
                    ('https://a.com/feed', 'A',
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                    ('https://b.com/feed', 'B',
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES
                    (1, 'g1', 'T1', 'http://a', 'body1', 'desc1',
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                    (2, 'g2', 'T2', 'http://b', 'body2', 'desc2',
                     '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
            `)
            const { storage } = mockCacheStorage()
            await clearFeedCache(db, 1, storage)

            const rows:Array<{
                feed_id:number
                content:string|null
                description:string|null
            }> = []
            db.exec({
                sql: 'SELECT feed_id, content, description FROM items ORDER BY feed_id',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, null, 'feed 1 content nulled')
            t.equal(rows[0].description, null, 'feed 1 description nulled')
            t.equal(rows[1].content, 'body2', 'feed 2 content untouched')
            t.equal(rows[1].description, 'desc2', 'feed 2 description untouched')
        } finally {
            db.close()
        }
    }
)

test('clearFeedCache removes cached_images rows for the feed', async (t) => {
    const db = await makeDb('did:test:cfc-images')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES
                ('https://a.com/feed', 'A',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                ('https://b.com/feed', 'B',
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
        const { storage } = mockCacheStorage()
        await clearFeedCache(db, 1, storage)

        const rows:Array<{ feed_id:number }> = []
        db.exec({
            sql: 'SELECT feed_id FROM cached_images',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'feed 1 row removed')
        t.equal(rows[0].feed_id, 2, 'feed 2 row preserved')
    } finally {
        db.close()
    }
})

test('clearFeedCache returns the URL list for cache eviction', async (t) => {
    const db = await makeDb('did:test:cfc-urls')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES ('https://a.com/feed', 'A',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        await recordCachedImage(db, {
            url: 'https://a.com/img1.jpg',
            feedId: 1,
            sizeBytes: 500
        })
        await recordCachedImage(db, {
            url: 'https://a.com/img2.jpg',
            feedId: 1,
            sizeBytes: 600
        })
        const { storage, deleted } = mockCacheStorage()
        const urls = await clearFeedCache(db, 1, storage)

        t.equal(urls.length, 2, 'returned 2 URLs')
        t.ok(
            urls.includes('https://a.com/img1.jpg'),
            'img1 in returned URLs'
        )
        t.ok(
            urls.includes('https://a.com/img2.jpg'),
            'img2 in returned URLs'
        )
        t.ok(
            deleted.includes('https://a.com/img1.jpg'),
            'img1 evicted from cache bucket'
        )
        t.ok(
            deleted.includes('https://a.com/img2.jpg'),
            'img2 evicted from cache bucket'
        )
    } finally {
        db.close()
    }
})

test('clearFeedCache is idempotent', async (t) => {
    const db = await makeDb('did:test:cfc-idem')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES ('https://a.com/feed', 'A',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        db.exec(`
            INSERT INTO items
                (feed_id, guid, title, link, content, description,
                 created_at, updated_at)
            VALUES (1, 'g1', 'T', 'http://a', 'body', 'desc',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        const { storage } = mockCacheStorage()
        await clearFeedCache(db, 1, storage)
        await clearFeedCache(db, 1, storage)

        const rows:Array<{ content:string|null }> = []
        db.exec({
            sql: 'SELECT content FROM items',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows[0].content, null, 'content still null after second call')
    } finally {
        db.close()
    }
})

test(
    'clearFeedCache returns empty array when feed has no cached images',
    async (t) => {
        const db = await makeDb('did:test:cfc-no-images')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES ('https://a.com/feed', 'A',
                        '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
            `)
            const { storage } = mockCacheStorage()
            const urls = await clearFeedCache(db, 1, storage)
            t.equal(urls.length, 0, 'empty array when no images')
        } finally {
            db.close()
        }
    }
)
