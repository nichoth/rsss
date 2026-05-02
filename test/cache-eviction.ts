import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    evictByMaxAge,
    evictByFeedSizeCap,
    evictByAccountSizeCap
} from '../src/client/db/cache-eviction.js'
import {
    setCurrentlyOpenItemId,
    _resetOpenItemRegistry
} from '../src/client/open-item-registry.js'
import { upsertFeedCachePolicy } from '../src/client/db/feed-cache-policy.js'
import { recordCachedImage } from '../src/client/db/cached-images.js'
import {
    defaultMaxSizeBytes,
    defaultAccountMaxSizeBytes
} from '../src/client/local-first-settings.js'

setTestMode(true, wasmUrl as string)

const OLDER_DATE = '2023-01-01T00:00:00Z'
const OLD_DATE = '2000-01-01T00:00:00Z'
const BASE_DATE = '2024-01-01T00:00:00Z'
const NEWER_DATE = '2025-01-01T00:00:00Z'
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

// --- evictByFeedSizeCap tests ---

test(
    'evictByFeedSizeCap no-op when feed is under cap',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:sizecap-noop')
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
                VALUES (1, 'g1', 'T1', 'http://a', 'abc', NULL,
                        '${BASE_DATE}', '${BASE_DATE}')
            `)
            await upsertFeedCachePolicy(db, 1, {
                cache_mode: null,
                max_size_bytes: 10_000,
                max_age_seconds: null
            })
            const { storage } = mockCacheStorage()
            const result = await evictByFeedSizeCap(db, storage)

            t.equal(result.feedsTrimmed, 0, 'no feeds trimmed')
            t.equal(result.bytesFreed, 0, 'no bytes freed')

            const rows: Array<{ content: string | null }> = []
            db.exec({
                sql: 'SELECT content FROM items',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, 'abc', 'content preserved')
        } finally {
            db.close()
        }
    }
)

test(
    'evictByFeedSizeCap respects per-feed max_size_bytes override',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:sizecap-per-feed')
        try {
            db.exec(`
                INSERT INTO feeds (url, title, created_at, updated_at)
                VALUES
                    ('https://a.com/feed', 'A', '${BASE_DATE}', '${BASE_DATE}'),
                    ('https://b.com/feed', 'B', '${BASE_DATE}', '${BASE_DATE}')
            `)
            db.exec(`
                INSERT INTO items
                    (feed_id, guid, title, link, content, description,
                     created_at, updated_at)
                VALUES
                    (1, 'g1', 'T1', 'http://a', 'hello', 'world',
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (2, 'g2', 'T2', 'http://b', 'hello', NULL,
                     '${OLD_DATE}', '${OLD_DATE}')
            `)
            await upsertFeedCachePolicy(db, 1, {
                cache_mode: null,
                max_size_bytes: 5,
                max_age_seconds: null
            })
            const { storage } = mockCacheStorage()
            const result = await evictByFeedSizeCap(db, storage)

            t.equal(result.feedsTrimmed, 1, 'only feed 1 trimmed')

            const rows: Array<{ feed_id: number; content: string | null }> = []
            db.exec({
                sql: 'SELECT feed_id, content FROM items ORDER BY feed_id',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, null, 'feed 1 item content evicted')
            t.equal(rows[1].content, 'hello', 'feed 2 item preserved')
        } finally {
            db.close()
        }
    }
)

test(
    'evictByFeedSizeCap uses site default when no per-feed override',
    async (t) => {
        _resetOpenItemRegistry()
        const saved = defaultMaxSizeBytes.value
        defaultMaxSizeBytes.value = 5
        const db = await openLocalDb('did:test:sizecap-default')
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
                VALUES (1, 'g1', 'T1', 'http://a', 'hello world', NULL,
                        '${OLD_DATE}', '${OLD_DATE}')
            `)
            const { storage } = mockCacheStorage()
            const result = await evictByFeedSizeCap(db, storage)

            t.equal(result.feedsTrimmed, 1, 'feed trimmed using site default')
            t.ok(result.bytesFreed > 0, 'bytes freed')

            const rows: Array<{ content: string | null }> = []
            db.exec({
                sql: 'SELECT content FROM items',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, null, 'content nulled')
        } finally {
            defaultMaxSizeBytes.value = saved
            db.close()
        }
    }
)

test(
    'evictByFeedSizeCap evicts oldest-first',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:sizecap-oldest-first')
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
                    (1, 'gA', 'A', 'http://a1', 'hello world', NULL,
                     '${OLDER_DATE}', '${OLDER_DATE}'),
                    (1, 'gB', 'B', 'http://a2', 'hello world', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (1, 'gC', 'C', 'http://a3', 'hello world', NULL,
                     '${NEWER_DATE}', '${NEWER_DATE}')
            `)
            await upsertFeedCachePolicy(db, 1, {
                cache_mode: null,
                max_size_bytes: 15,
                max_age_seconds: null
            })
            const { storage } = mockCacheStorage()
            const result = await evictByFeedSizeCap(db, storage)

            t.equal(result.feedsTrimmed, 1, 'feed trimmed')

            const rows: Array<{ guid: string; content: string | null }> = []
            db.exec({
                sql: 'SELECT guid, content FROM items ORDER BY guid ASC',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, null, 'item gA evicted')
            t.equal(rows[1].content, null, 'item gB evicted')
            t.equal(rows[2].content, 'hello world', 'item gC preserved')
        } finally {
            db.close()
        }
    }
)

test(
    'evictByFeedSizeCap skips currently-open item id',
    async (t) => {
        _resetOpenItemRegistry()
        const db = await openLocalDb('did:test:sizecap-open-item')
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
                    (1, 'gA', 'A', 'http://a1', 'hello', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (1, 'gB', 'B', 'http://a2', 'hello world', NULL,
                     '${OLDER_DATE}', '${OLDER_DATE}')
            `)
            await upsertFeedCachePolicy(db, 1, {
                cache_mode: null,
                max_size_bytes: 5,
                max_age_seconds: null
            })

            const idRows: Array<{ id: number; guid: string }> = []
            db.exec({
                sql: 'SELECT id, guid FROM items ORDER BY updated_at ASC',
                rowMode: 'object',
                resultRows: idRows
            })
            const openId = idRows[0].id
            setCurrentlyOpenItemId(openId)

            const { storage } = mockCacheStorage()
            const result = await evictByFeedSizeCap(db, storage)

            t.equal(result.feedsTrimmed, 1, 'feed trimmed')

            const rows: Array<{ guid: string; content: string | null }> = []
            db.exec({
                sql: 'SELECT guid, content FROM items ORDER BY updated_at ASC',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, 'hello', 'open item A preserved')
            t.equal(rows[1].content, null, 'non-open item B evicted')
        } finally {
            _resetOpenItemRegistry()
            db.close()
        }
    }
)

// --- evictByAccountSizeCap tests ---

test(
    'evictByAccountSizeCap no-op when total cache is under the cap',
    async (t) => {
        _resetOpenItemRegistry()
        const saved = defaultAccountMaxSizeBytes.value
        defaultAccountMaxSizeBytes.value = 10_000
        const db = await openLocalDb('did:test:acctcap-noop')
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
                VALUES (1, 'g1', 'T1', 'http://a', 'abc', NULL,
                        '${BASE_DATE}', '${BASE_DATE}')
            `)
            const { storage } = mockCacheStorage()
            const result = await evictByAccountSizeCap(db, storage)

            t.equal(result.bytesFreed, 0, 'no bytes freed')

            const rows: Array<{ content: string | null }> = []
            db.exec({
                sql: 'SELECT content FROM items',
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows[0].content, 'abc', 'content preserved')
        } finally {
            defaultAccountMaxSizeBytes.value = saved
            db.close()
        }
    }
)

test(
    'evictByAccountSizeCap trims when over cap across multiple feeds',
    async (t) => {
        _resetOpenItemRegistry()
        const saved = defaultAccountMaxSizeBytes.value
        defaultAccountMaxSizeBytes.value = 5
        const db = await openLocalDb('did:test:acctcap-trim')
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
                    (1, 'g1', 'T1', 'http://a', 'hello', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (2, 'g2', 'T2', 'http://b', 'world', NULL,
                     '${OLDER_DATE}', '${OLDER_DATE}')
            `)
            const { storage } = mockCacheStorage()
            const result = await evictByAccountSizeCap(db, storage)

            t.ok(result.bytesFreed > 0, 'bytes freed')

            const rows: Array<{ guid: string; content: string | null }> = []
            db.exec({
                sql: 'SELECT guid, content FROM items ORDER BY guid ASC',
                rowMode: 'object',
                resultRows: rows
            })
            // g1 has OLD_DATE (2000) = oldest → evicted first
            t.equal(rows[0].content, null, 'oldest item g1 evicted')
            // g2 has OLDER_DATE (2023) = newer → preserved
            t.equal(rows[1].content, 'world', 'newer item g2 preserved')
        } finally {
            defaultAccountMaxSizeBytes.value = saved
            db.close()
        }
    }
)

test(
    'evictByAccountSizeCap skips currently-open item id',
    async (t) => {
        _resetOpenItemRegistry()
        const saved = defaultAccountMaxSizeBytes.value
        defaultAccountMaxSizeBytes.value = 5
        const db = await openLocalDb('did:test:acctcap-open-item')
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
                    (1, 'gA', 'A', 'http://a1', 'hello', NULL,
                     '${OLDER_DATE}', '${OLDER_DATE}'),
                    (1, 'gB', 'B', 'http://a2', 'world', NULL,
                     '${OLD_DATE}', '${OLD_DATE}')
            `)
            const idRows: Array<{ id: number; guid: string }> = []
            db.exec({
                sql: 'SELECT id, guid FROM items ORDER BY updated_at ASC',
                rowMode: 'object',
                resultRows: idRows
            })
            const openId = idRows[0].id
            setCurrentlyOpenItemId(openId)

            const { storage } = mockCacheStorage()
            const result = await evictByAccountSizeCap(db, storage)

            t.ok(result.bytesFreed > 0, 'some bytes freed')

            const rows: Array<{ guid: string; content: string | null }> = []
            db.exec({
                sql: 'SELECT guid, content FROM items ORDER BY guid ASC',
                rowMode: 'object',
                resultRows: rows
            })
            // gA has OLDER_DATE (2023) = not-open, evicted
            t.equal(
                rows[0].content,
                null,
                'non-open item gA evicted'
            )
            // gB has OLD_DATE (2000) = oldest = open, preserved
            t.equal(
                rows[1].content,
                'world',
                'open item gB preserved'
            )
        } finally {
            _resetOpenItemRegistry()
            defaultAccountMaxSizeBytes.value = saved
            db.close()
        }
    }
)

test(
    'evictByAccountSizeCap evicts oldest-first across feeds',
    async (t) => {
        _resetOpenItemRegistry()
        const saved = defaultAccountMaxSizeBytes.value
        defaultAccountMaxSizeBytes.value = 6
        const db = await openLocalDb('did:test:acctcap-oldest-first')
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
                    (1, 'gA', 'A', 'http://a1', 'hello', NULL,
                     '${OLDER_DATE}', '${OLDER_DATE}'),
                    (2, 'gB', 'B', 'http://b1', 'world', NULL,
                     '${OLD_DATE}', '${OLD_DATE}'),
                    (1, 'gC', 'C', 'http://a2', 'newer', NULL,
                     '${NEWER_DATE}', '${NEWER_DATE}')
            `)
            const { storage } = mockCacheStorage()
            const result = await evictByAccountSizeCap(db, storage)

            t.ok(result.bytesFreed > 0, 'bytes freed')

            const rows: Array<{ guid: string; content: string | null }> = []
            db.exec({
                sql: 'SELECT guid, content FROM items ORDER BY guid ASC',
                rowMode: 'object',
                resultRows: rows
            })
            // gA (OLDER_DATE=2023, feed 1) evicted (2nd oldest)
            t.equal(rows[0].content, null, 'second-oldest gA evicted')
            // gB (OLD_DATE=2000, feed 2) evicted (oldest across feeds)
            t.equal(rows[1].content, null, 'oldest gB evicted')
            // gC (NEWER_DATE=2025, feed 1) preserved
            t.equal(rows[2].content, 'newer', 'newest gC preserved')
        } finally {
            defaultAccountMaxSizeBytes.value = saved
            db.close()
        }
    }
)
