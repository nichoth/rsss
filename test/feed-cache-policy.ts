import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'

setTestMode(true, wasmUrl as string)

test('feed_cache_policy table exists with correct columns', async (t) => {
    const db = await openLocalDb('did:test:fcp-columns')
    try {
        const rows:Array<{ name:string; notnull:number; dflt_value:string|null }> =
            []
        db.exec({
            sql: 'PRAGMA table_info(feed_cache_policy)',
            rowMode: 'object',
            resultRows: rows
        })
        const names = rows.map((r) => r.name)
        t.ok(names.includes('feed_id'), 'has feed_id column')
        t.ok(names.includes('cache_mode'), 'has cache_mode column')
        t.ok(names.includes('max_size_bytes'), 'has max_size_bytes column')
        t.ok(names.includes('max_age_seconds'), 'has max_age_seconds column')
        t.ok(names.includes('updated_at'), 'has updated_at column')

        const updatedAt = rows.find((r) => r.name === 'updated_at')
        t.equal(updatedAt?.notnull, 1, 'updated_at is NOT NULL')
        t.ok(
            updatedAt?.dflt_value?.includes('now'),
            'updated_at has datetime(\'now\') default'
        )

        const cacheMode = rows.find((r) => r.name === 'cache_mode')
        t.equal(cacheMode?.notnull, 0, 'cache_mode is nullable')

        const maxSize = rows.find((r) => r.name === 'max_size_bytes')
        t.equal(maxSize?.notnull, 0, 'max_size_bytes is nullable')

        const maxAge = rows.find((r) => r.name === 'max_age_seconds')
        t.equal(maxAge?.notnull, 0, 'max_age_seconds is nullable')
    } finally {
        db.close()
    }
})

test('feed_cache_policy INSERT OR REPLACE upserts correctly', async (t) => {
    const db = await openLocalDb('did:test:fcp-upsert')
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

        db.exec(`
            INSERT OR REPLACE INTO feed_cache_policy
                (feed_id, cache_mode, max_size_bytes, max_age_seconds)
            VALUES (1, 'text_images', 10000000, 604800)
        `)

        const rows:Array<{
            feed_id:number
            cache_mode:string
            max_size_bytes:number
            max_age_seconds:number
        }> = []
        db.exec({
            sql: 'SELECT * FROM feed_cache_policy WHERE feed_id = 1',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'one row inserted')
        t.equal(rows[0].cache_mode, 'text_images', 'cache_mode stored')
        t.equal(rows[0].max_size_bytes, 10000000, 'max_size_bytes stored')
        t.equal(rows[0].max_age_seconds, 604800, 'max_age_seconds stored')

        // Replace/update the row
        db.exec(`
            INSERT OR REPLACE INTO feed_cache_policy
                (feed_id, cache_mode, max_size_bytes, max_age_seconds)
            VALUES (1, 'text', NULL, NULL)
        `)

        const updated:typeof rows = []
        db.exec({
            sql: 'SELECT * FROM feed_cache_policy WHERE feed_id = 1',
            rowMode: 'object',
            resultRows: updated
        })
        t.equal(updated.length, 1, 'still one row after replace')
        t.equal(updated[0].cache_mode, 'text', 'cache_mode updated')
        t.equal(updated[0].max_size_bytes, null, 'max_size_bytes nullable null')
    } finally {
        db.close()
    }
})

test('feed_cache_policy accepts NULL for optional columns', async (t) => {
    const db = await openLocalDb('did:test:fcp-nulls')
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

        db.exec(`
            INSERT OR REPLACE INTO feed_cache_policy (feed_id)
            VALUES (1)
        `)

        const rows:Array<{
            feed_id:number
            cache_mode:string|null
            max_size_bytes:number|null
            max_age_seconds:number|null
        }> = []
        db.exec({
            sql: 'SELECT * FROM feed_cache_policy WHERE feed_id = 1',
            rowMode: 'object',
            resultRows: rows
        })
        t.equal(rows.length, 1, 'row inserted with all-null optional columns')
        t.equal(rows[0].cache_mode, null, 'cache_mode defaults to NULL')
        t.equal(rows[0].max_size_bytes, null, 'max_size_bytes defaults to NULL')
        t.equal(rows[0].max_age_seconds, null, 'max_age_seconds defaults to NULL')
    } finally {
        db.close()
    }
})
