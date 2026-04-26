import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { purgeStoredContent } from
    '../src/client/db/content-storage.js'
import * as pullSyncModule from '../src/client/db/pull-sync.js'
import { storeContent } from '../src/client/local-first-settings.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'

const { pullSync } = pullSyncModule

type ErrorCtor = new () => Error

setTestMode(true, wasmUrl as string)

const FEED = {
    id: 1,
    url: 'https://example.com/feed',
    title: 'Example Feed',
    description: 'A feed',
    site_url: 'https://example.com',
    last_fetched: '2026-01-01 00:00:00',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00'
}

const ITEM = {
    id: 10,
    feed_id: 1,
    guid: 'guid-10',
    title: 'An Item',
    link: 'https://example.com/item-10',
    description: 'short desc',
    content: '<p>full content</p>',
    author: 'Alice',
    pub_date: '2026-01-01 00:00:00',
    is_read: 0,
    is_starred: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    feed_title: 'Example Feed'
}

function makeFetch (body:unknown, status = 200):typeof fetch {
    return async (_url:RequestInfo|URL) => {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body
        } as Response
    }
}

function queryOne<T> (db:Sqlite3Db, sql:string, bind?:unknown[]):T|undefined {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind as Parameters<typeof db.exec>[0]['bind'],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows[0]
}

test('full sync upserts feeds and items', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-full')
    try {
        const syncData = {
            feeds: [FEED],
            items: [ITEM],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-01 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const feed = queryOne<{ title:string }>(
            db, 'SELECT title FROM feeds WHERE id = 1'
        )
        t.equal(feed?.title, 'Example Feed', 'feed upserted')

        const item = queryOne<{ title:string; content:string }>(
            db, 'SELECT title, content FROM items WHERE id = 10'
        )
        t.equal(item?.title, 'An Item', 'item upserted')
        t.equal(item?.content, '<p>full content</p>', 'content stored')
    } finally {
        db.close()
    }
})

test('content stripped when storeContent is false', async (t) => {
    storeContent.value = false
    const db = await openLocalDb('did:test:pull-nocontent')
    try {
        const syncData = {
            feeds: [FEED],
            items: [ITEM],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-01 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const item = queryOne<{
            content:string|null
            description:string|null
        }>(db, 'SELECT content, description FROM items WHERE id = 10')
        t.equal(item?.content, null, 'content is NULL')
        t.equal(item?.description, null, 'description is NULL')
    } finally {
        storeContent.value = true
        db.close()
    }
})

test('purgeStoredContent clears content after storeContent is disabled',
    async (t) => {
        storeContent.value = true
        const db = await openLocalDb('did:test:purge-content')
        try {
            const syncData = {
                feeds: [FEED],
                items: [ITEM],
                syncedAt: '2026-01-02 00:00:00',
                latestUpdatedAt: '2026-01-01 00:00:00',
                isFullSync: true
            }
            await pullSync(db, makeFetch(syncData))

            storeContent.value = false
            await purgeStoredContent(db)

            const item = queryOne<{
                content:string|null
                description:string|null
            }>(db, 'SELECT content, description FROM items WHERE id = 10')
            t.equal(item?.content, null, 'content is cleared')
            t.equal(item?.description, null, 'description is cleared')
        } finally {
            storeContent.value = true
            db.close()
        }
    })

test('lastPullAt advances after sync', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-meta')
    try {
        const syncData = {
            feeds: [FEED],
            items: [ITEM],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-05 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const meta = queryOne<{ last_pull_at:string }>(
            db, 'SELECT last_pull_at FROM sync_meta WHERE id = 1'
        )
        t.equal(
            meta?.last_pull_at,
            '2026-01-05 00:00:00',
            'last_pull_at updated to latestUpdatedAt'
        )
    } finally {
        db.close()
    }
})

test('incremental sync uses since param', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-delta')
    let capturedUrl = ''
    try {
        // First sync to set last_pull_at
        const firstData = {
            feeds: [FEED],
            items: [],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-03 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(firstData))

        // Second sync — should use since=
        const secondData = {
            feeds: [],
            items: [],
            syncedAt: '2026-01-04 00:00:00',
            latestUpdatedAt: '2026-01-04 00:00:00',
            isFullSync: false
        }
        const deltaFetch:typeof fetch = async (url:RequestInfo|URL) => {
            capturedUrl = url.toString()
            return makeFetch(secondData)(url)
        }
        await pullSync(db, deltaFetch)

        t.ok(
            capturedUrl.includes('since='),
            'second call includes since param'
        )
        t.ok(
            capturedUrl.includes('2026-01-03'),
            'since value matches previous latestUpdatedAt'
        )
    } finally {
        db.close()
    }
})

test('pullSync throws on non-ok response', async (t) => {
    const db = await openLocalDb('did:test:pull-error')
    try {
        let threw = false
        try {
            await pullSync(db, makeFetch({}, 500))
        } catch {
            threw = true
        }
        t.ok(threw, 'throws on 500')
    } finally {
        db.close()
    }
})

test('pullSync throws PullSyncAuthError on 401 response', async (t) => {
    const db = await openLocalDb('did:test:pull-auth-error')
    try {
        const PullSyncAuthError = (
            pullSyncModule as typeof pullSyncModule & {
                PullSyncAuthError?:ErrorCtor
            }
        ).PullSyncAuthError
        let caught:unknown
        try {
            await pullSync(db, makeFetch({}, 401))
        } catch (err) {
            caught = err
        }

        t.ok(PullSyncAuthError, 'exports typed auth error')
        t.ok(
            PullSyncAuthError && caught instanceof PullSyncAuthError,
            'throws typed auth error'
        )
    } finally {
        db.close()
    }
})

test('pullSync skips items with pending outbox updates', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-pending-item')
    try {
        db.exec({
            sql: `INSERT INTO feeds
                (id, url, title, created_at, updated_at)
                VALUES (1, 'https://example.com/feed', 'Feed',
                    '2026-01-01 00:00:00',
                    '2026-01-01 00:00:00')`
        })
        db.exec({
            sql: `INSERT INTO items
                (id, feed_id, guid, title, link, is_read, is_starred,
                 created_at, updated_at)
                VALUES (10, 1, 'guid-10', 'Local optimistic',
                    'https://example.com/item-10', 1, 0,
                    '2026-01-01 00:00:00',
                    '2026-01-03 00:00:00')`
        })
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('update_item', 10, ?, 'op-pending-item',
                    '2026-01-03 00:00:00')`,
            bind: [JSON.stringify({ id: 10, is_read: true })]
        })

        const staleServerItem = {
            ...ITEM,
            title: 'Stale server',
            is_read: 0,
            updated_at: '2026-01-02 00:00:00'
        }
        const syncData = {
            feeds: [],
            items: [staleServerItem],
            syncedAt: '2026-01-04 00:00:00',
            latestUpdatedAt: '2026-01-04 00:00:00',
            isFullSync: false
        }

        await pullSync(db, makeFetch(syncData))

        const item = queryOne<{
            title:string
            is_read:number
            updated_at:string
        }>(db, 'SELECT title, is_read, updated_at FROM items WHERE id = 10')
        t.equal(item?.title, 'Local optimistic', 'local title preserved')
        t.equal(item?.is_read, 1, 'optimistic read state preserved')
        t.equal(
            item?.updated_at,
            '2026-01-03 00:00:00',
            'local updated_at preserved'
        )
    } finally {
        db.close()
    }
})
