import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { evictByMaxAge } from '../src/client/db/cache-eviction.js'
import {
    setCurrentlyOpenItemId,
    _resetOpenItemRegistry
} from '../src/client/open-item-registry.js'
import { upsertFeedCachePolicy } from '../src/client/db/feed-cache-policy.js'
import { recordCachedImage } from '../src/client/db/cached-images.js'

setTestMode(true, wasmUrl as string)

const OLD_DATE = '2000-01-01T00:00:00Z'
const BASE_DATE = '2024-01-01T00:00:00Z'
const FUTURE_DATE = '2099-12-31T00:00:00Z'

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
    'evictByMaxAge falls back to site default TTL',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:evict-default-ttl')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES ('https://a.com/feed', 'A',
                        '${BASE_DATE}', '${BASE_DATE}')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES (1, 'g1', 'T1', 'http://a', 'body', 'desc',
                        '${OLD_DATE}', '${OLD_DATE}')
            `)
            const { storage } = mockCacheStorage()
            const result = await evictByMaxAge(db, storage)

            t.equal(result.itemsEvicted, 1, 'one item evicted')
            t.equal(result.imagesEvicted, 0, 'no images evicted')

            const rows:Array<{
                content:string|null
                description:string|null
            }> = []
            db.exec({
                sql: 'SELECT content, description FROM items',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, null, 'content nulled')
            t.equal(rows[0].description, null, 'description nulled')
        } finally {
            db.close()
        }
    }
)

test(
    'evictByMaxAge respects per-feed max_age_seconds override',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:evict-per-feed')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES
                    ('https://a.com/feed', 'A',
                     '${BASE_DATE}', '${BASE_DATE}'),
                    ('https://b.com/feed', 'B',
                     '${BASE_DATE}', '${BASE_DATE}')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES
                    (1, 'g1', 'T1', 'http://a', 'body1', 'desc1',
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (2, 'g2', 'T2', 'http://b', 'body2', 'desc2',
                     '${OLD_DATE}', '${OLD_DATE}')
            `)
            await upsertFeedCachePolicy(db, 1, {
                cache_mode: null,
                max_size_bytes: null,
                max_age_seconds: 9_999_999_999
            })
            const { storage } = mockCacheStorage()
            const result = await evictByMaxAge(db, storage)

            t.equal(result.itemsEvicted, 1, 'one item evicted (feed 2)')

            const rows:Array<{
                feed_id:number
                content:string|null
            }> = []
            db.exec({
                sql: 'SELECT feed_id, content FROM items' +
                    ' ORDER BY feed_id',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(
                rows[0].content,
                'body1',
                'feed 1 item preserved by long TTL override'
            )
            t.equal(
                rows[1].content,
                null,
                'feed 2 item evicted by site default TTL'
            )
        } finally {
            db.close()
        }
    }
)

test(
    'evictByMaxAge skips currently-open item id',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:evict-open-item')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES ('https://a.com/feed', 'A',
                        '${BASE_DATE}', '${BASE_DATE}')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES
                    (1, 'g1', 'T1', 'http://a1', 'body1', 'desc1',
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (1, 'g2', 'T2', 'http://a2', 'body2', 'desc2',
                     '${OLD_DATE}', '${OLD_DATE}')
            `)

            const idRows:Array<{ id:number }> = []
            db.exec({
                sql: 'SELECT id FROM items ORDER BY id',
                rowMode: 'object',
                resultRows: idRows
            })
            const openId = idRows[0].id
            setCurrentlyOpenItemId(openId)

            const { storage } = mockCacheStorage()
            const result = await evictByMaxAge(db, storage)

            t.equal(
                result.itemsEvicted,
                1,
                'only the non-open item evicted'
            )

            const rows:Array<{ id:number; content:string|null }> = []
            db.exec({
                sql: 'SELECT id, content FROM items ORDER BY id',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(
                rows[0].content,
                'body1',
                'open item content preserved'
            )
            t.equal(
                rows[1].content,
                null,
                'non-open item content evicted'
            )
        } finally {
            _resetOpenItemRegistry()
            db.close()
        }
    }
)

test(
    'evictByMaxAge returns accurate itemsEvicted and imagesEvicted counts',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:evict-counts')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES
                    ('https://a.com/feed', 'A',
                     '${BASE_DATE}', '${BASE_DATE}'),
                    ('https://b.com/feed', 'B',
                     '${BASE_DATE}', '${BASE_DATE}')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES
                    (1, 'g1', 'T1', 'http://a1', 'body1', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (1, 'g2', 'T2', 'http://a2', 'body2', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (2, 'g3', 'T3', 'http://b1', 'body3', NULL,
                     '${FUTURE_DATE}', '${FUTURE_DATE}')
            `)

            const idRows:Array<{ id:number; feed_id:number }> = []
            db.exec({
                sql: 'SELECT id, feed_id FROM items ORDER BY id',
                rowMode: 'object',
                resultRows: idRows
            })
            const item1Id = idRows[0].id
            const item2Id = idRows[1].id

            await recordCachedImage(db, {
                url: 'https://a.com/img1.jpg',
                feedId: 1,
                itemId: item1Id,
                sizeBytes: 500
            })
            await recordCachedImage(db, {
                url: 'https://a.com/img2.jpg',
                feedId: 1,
                itemId: item2Id,
                sizeBytes: 600
            })

            const { storage, deleted } = mockCacheStorage()
            const result = await evictByMaxAge(db, storage)

            t.equal(result.itemsEvicted, 2, '2 stale items evicted')
            t.equal(
                result.imagesEvicted,
                2,
                '2 images evicted from cache'
            )
            t.equal(
                deleted.length,
                2,
                '2 URLs deleted from Cache Storage'
            )
            t.ok(
                deleted.includes('https://a.com/img1.jpg'),
                'img1 evicted'
            )
            t.ok(
                deleted.includes('https://a.com/img2.jpg'),
                'img2 evicted'
            )
        } finally {
            db.close()
        }
    }
)
