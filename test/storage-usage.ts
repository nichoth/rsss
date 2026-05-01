import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    getTextBytesForFeed,
    getTextBytesTotal
} from '../src/client/db/storage-usage.js'
import { formatBytes } from '../src/client/util.js'

setTestMode(true, wasmUrl as string)

test('formatBytes returns 0 B for zero', (t) => {
    t.equal(formatBytes(0), '0 B')
})

test('formatBytes returns bytes for small values', (t) => {
    t.equal(formatBytes(500), '500 B')
})

test('formatBytes returns KB for values >= 1000', (t) => {
    t.equal(formatBytes(340_000), '340.0 KB')
})

test('formatBytes returns MB for values >= 1_000_000', (t) => {
    t.equal(formatBytes(1_200_000), '1.2 MB')
})

test('getTextBytesForFeed sums content + description per feed', async (t) => {
    const db = await openLocalDb('did:test:su-text-feed')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES ('https://a.com/feed', 'Feed A',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        db.exec(`
            INSERT INTO items
                (feed_id, guid, title, link, content, description,
                 created_at, updated_at)
            VALUES
                (1, 'g1', 'T1', 'http://a', 'hello', 'world',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                (1, 'g2', 'T2', 'http://b', 'foo', NULL,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        const total = await getTextBytesForFeed(db, 1)
        t.equal(total, 13, 'sums content+description: 5+5+3+0=13')
    } finally {
        db.close()
    }
})

test('getTextBytesForFeed returns 0 for empty feed', async (t) => {
    const db = await openLocalDb('did:test:su-empty-feed')
    try {
        const total = await getTextBytesForFeed(db, 999)
        t.equal(total, 0, 'returns 0 for feed with no items')
    } finally {
        db.close()
    }
})

test('getTextBytesForFeed excludes other feeds', async (t) => {
    const db = await openLocalDb('did:test:su-feed-scope')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES ('https://a.com/feed', 'Feed A',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                   ('https://b.com/feed', 'Feed B',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        db.exec(`
            INSERT INTO items
                (feed_id, guid, title, link, content, description,
                 created_at, updated_at)
            VALUES
                (1, 'g1', 'T', 'http://a', 'aaaa', NULL,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                (2, 'g2', 'T', 'http://b', 'bbbbb', NULL,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        const f1 = await getTextBytesForFeed(db, 1)
        const f2 = await getTextBytesForFeed(db, 2)
        t.equal(f1, 4, 'feed 1 has 4 bytes')
        t.equal(f2, 5, 'feed 2 has 5 bytes')
    } finally {
        db.close()
    }
})

test('getTextBytesTotal sums text across all feeds', async (t) => {
    const db = await openLocalDb('did:test:su-total')
    try {
        db.exec(`
            INSERT INTO feeds (url, title, created_at, updated_at)
            VALUES ('https://a.com/feed', 'Feed A',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                   ('https://b.com/feed', 'Feed B',
                    '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        db.exec(`
            INSERT INTO items
                (feed_id, guid, title, link, content, description,
                 created_at, updated_at)
            VALUES
                (1, 'g1', 'T', 'http://a', 'ab', NULL,
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
                (2, 'g2', 'T', 'http://b', 'xyz', 'qr',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
        `)
        const total = await getTextBytesTotal(db)
        t.equal(total, 7, '2+3+2=7 bytes across all feeds')
    } finally {
        db.close()
    }
})

test('getTextBytesTotal returns 0 when no items', async (t) => {
    const db = await openLocalDb('did:test:su-total-empty')
    try {
        const total = await getTextBytesTotal(db)
        t.equal(total, 0, 'returns 0 when items table is empty')
    } finally {
        db.close()
    }
})
