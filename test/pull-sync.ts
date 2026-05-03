import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { createLocalAdapter } from
    '../src/client/db/local-adapter.js'
import { purgeStoredContent } from
    '../src/client/db/content-storage.js'
import * as pullSyncModule from '../src/client/db/pull-sync.js'
import { pushSync } from '../src/client/db/push-sync.js'
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
    thumbnail_url: 'https://cdn.example.com/item-10.jpg',
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

function makePagedItem (id:number):Record<string, unknown> {
    const updatedAt = `2026-01-01 00:${String(id).padStart(4, '0')}:00`
    return {
        ...ITEM,
        id,
        guid: `guid-${id}`,
        title: `Item ${id}`,
        link: `https://example.com/item-${id}`,
        updated_at: updatedAt
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

function queryAll<T> (db:Sqlite3Db, sql:string, bind?:unknown[]):T[] {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind as Parameters<typeof db.exec>[0]['bind'],
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows
}

async function withMockedNow (
    iso:string,
    fn:() => Promise<void>
):Promise<void> {
    const RealDate = Date
    const fixedMs = RealDate.parse(iso)
    class MockDate extends RealDate {
        constructor (...args:unknown[]) {
            if (args.length === 0) {
                super(fixedMs)
                return
            }
            super(...(args as [number]))
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

test('full sync writes last_pulled_at on insert', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-cursor-insert')
    try {
        const syncData = {
            feeds: [{ ...FEED, last_pulled_at: '2026-04-15 00:00:00' }],
            items: [],
            syncedAt: '2026-04-16 00:00:00',
            latestUpdatedAt: '2026-04-15 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const feed = queryOne<{ last_pulled_at:string|null }>(
            db, 'SELECT last_pulled_at FROM feeds WHERE id = 1'
        )
        t.equal(
            feed?.last_pulled_at,
            '2026-04-15 00:00:00',
            'last_pulled_at is written on insert'
        )
    } finally {
        db.close()
    }
})

test('full sync writes last_pulled_at as NULL when server sends NULL',
    async (t) => {
        storeContent.value = true
        const db = await openLocalDb('did:test:pull-cursor-null')
        try {
            const syncData = {
                feeds: [{ ...FEED, last_pulled_at: null }],
                items: [],
                syncedAt: '2026-04-16 00:00:00',
                latestUpdatedAt: '2026-04-15 00:00:00',
                isFullSync: true
            }
            await pullSync(db, makeFetch(syncData))

            const feed = queryOne<{ last_pulled_at:string|null }>(
                db, 'SELECT last_pulled_at FROM feeds WHERE id = 1'
            )
            t.equal(
                feed?.last_pulled_at,
                null,
                'last_pulled_at is NULL for never-refreshed feeds'
            )
        } finally {
            db.close()
        }
    }
)

test('incremental sync updates last_pulled_at on existing rows',
    async (t) => {
        storeContent.value = true
        const db = await openLocalDb('did:test:pull-cursor-update')
        try {
            const initial = {
                feeds: [{ ...FEED, last_pulled_at: null }],
                items: [],
                syncedAt: '2026-04-15 00:00:00',
                latestUpdatedAt: '2026-04-15 00:00:00',
                isFullSync: true
            }
            await pullSync(db, makeFetch(initial))

            const after = {
                feeds: [{
                    ...FEED,
                    last_pulled_at: '2026-04-20 00:00:00',
                    updated_at: '2026-04-20 00:00:00'
                }],
                items: [],
                syncedAt: '2026-04-21 00:00:00',
                latestUpdatedAt: '2026-04-20 00:00:00',
                isFullSync: false
            }
            await pullSync(db, makeFetch(after))

            const feed = queryOne<{ last_pulled_at:string|null }>(
                db, 'SELECT last_pulled_at FROM feeds WHERE id = 1'
            )
            t.equal(
                feed?.last_pulled_at,
                '2026-04-20 00:00:00',
                'last_pulled_at is updated via ON CONFLICT'
            )
        } finally {
            db.close()
        }
    }
)

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

test('full sync round-trips item full_content columns', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-fullcontent')
    try {
        const syncData = {
            feeds: [FEED],
            items: [{
                ...ITEM,
                full_content: '<p>fetched body</p>',
                full_content_fetched_at: '2026-04-30 12:00:00',
                full_content_status: 'succeeded'
            }],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-01 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const item = queryOne<{
            full_content:string|null
            full_content_fetched_at:string|null
            full_content_status:string|null
        }>(
            db,
            'SELECT full_content, full_content_fetched_at, ' +
            'full_content_status FROM items WHERE id = 10'
        )
        t.equal(
            item?.full_content,
            '<p>fetched body</p>',
            'full_content is mirrored locally'
        )
        t.equal(
            item?.full_content_fetched_at,
            '2026-04-30 12:00:00',
            'full_content_fetched_at is mirrored'
        )
        t.equal(
            item?.full_content_status,
            'succeeded',
            'full_content_status is mirrored'
        )
    } finally {
        db.close()
    }
})

test('full_content stripped when storeContent is false', async (t) => {
    storeContent.value = false
    const db = await openLocalDb('did:test:pull-fullcontent-nostore')
    try {
        const syncData = {
            feeds: [FEED],
            items: [{
                ...ITEM,
                full_content: '<p>fetched body</p>',
                full_content_fetched_at: '2026-04-30 12:00:00',
                full_content_status: 'succeeded'
            }],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-01 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const item = queryOne<{
            full_content:string|null
            full_content_status:string|null
        }>(
            db,
            'SELECT full_content, full_content_status ' +
            'FROM items WHERE id = 10'
        )
        t.equal(item?.full_content, null, 'full_content dropped at upsert')
        t.equal(
            item?.full_content_status,
            'succeeded',
            'status preserved (privacy gate is body-only)'
        )
    } finally {
        storeContent.value = true
        db.close()
    }
})

test('full sync stores item thumbnail_url', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-thumbnail')
    try {
        const syncData = {
            feeds: [FEED],
            items: [ITEM],
            syncedAt: '2026-01-02 00:00:00',
            latestUpdatedAt: '2026-01-01 00:00:00',
            isFullSync: true
        }
        await pullSync(db, makeFetch(syncData))

        const item = queryOne<{ thumbnail_url:string|null }>(
            db,
            'SELECT thumbnail_url FROM items WHERE id = 10'
        )
        t.equal(
            item?.thumbnail_url,
            'https://cdn.example.com/item-10.jpg',
            'thumbnail_url is stored locally'
        )
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

test('local writes after a server watermark remain pull-visible',
    async (t) => {
        storeContent.value = true
        const db = await openLocalDb('did:test:pull-clock-skew-feed')
        const adapter = createLocalAdapter(db)
        let capturedSince:string|null = null
        let serverReturnedFeed = false

        try {
            await pullSync(db, makeFetch({
                feeds: [],
                items: [],
                syncedAt: '2026-04-25 10:00:00',
                latestUpdatedAt: '2026-04-25 10:00:00',
                isFullSync: true
            }))

            await withMockedNow(
                '2026-04-25T09:59:59.000Z',
                async () => {
                    await adapter.addFeed('https://clock.example.com/feed')
                }
            )

            const feed = queryOne<{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                created_at:string
                updated_at:string
            }>(db, 'SELECT * FROM feeds WHERE url = ?', [
                'https://clock.example.com/feed'
            ])
            const outbox = queryOne<{ client_updated_at:string }>(
                db,
                `SELECT client_updated_at FROM outbox
                 WHERE op = 'add_feed'`
            )

            const deltaFetch:typeof fetch = async (url) => {
                const parsed = new URL(url.toString(), 'https://rsss.test')
                capturedSince = parsed.searchParams.get('since')
                const feeds = (
                    feed &&
                    capturedSince &&
                    feed.updated_at > capturedSince
                ) ? [feed] : []
                serverReturnedFeed = feeds.length === 1

                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        feeds,
                        items: [],
                        syncedAt: '2026-04-25 10:01:00',
                        latestUpdatedAt: '2026-04-25 10:01:00',
                        isFullSync: false
                    })
                } as Response
            }

            await pullSync(db, deltaFetch)

            t.equal(
                capturedSince,
                '2026-04-25 10:00:00',
                'next pull uses the server watermark as since'
            )
            t.ok(
                feed && feed.updated_at > '2026-04-25 10:00:00',
                'local feed timestamp sorts after the server watermark'
            )
            t.equal(
                outbox?.client_updated_at,
                feed?.updated_at,
                'outbox and feed row use the same sortable timestamp'
            )
            t.ok(
                serverReturnedFeed,
                'server-style updated_at > since query can see the write'
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

test('skipped pending item is pulled after outbox clears', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-after-outbox-clear')
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
            sql: `UPDATE sync_meta
                  SET last_pull_at = '2026-01-02 00:00:00'
                  WHERE id = 1`
        })
        db.exec({
            sql: `INSERT INTO outbox
                (op, target_id, payload, client_op_id, client_updated_at)
                VALUES ('update_item', 10, ?, 'op-clears-after-skip',
                    '2026-01-03 00:00:00')`,
            bind: [JSON.stringify({ id: 10, is_read: true })]
        })

        const serverItem = {
            ...ITEM,
            title: 'Server reparsed',
            description: 'updated summary',
            is_read: 1,
            updated_at: '2026-01-04 00:00:00'
        }
        const incrementalFetch:typeof fetch = async (url) => {
            const parsed = new URL(url.toString(), 'https://rsss.test')
            const since = parsed.searchParams.get('since')
            const items = since && serverItem.updated_at > since
                ? [serverItem]
                : []

            return {
                ok: true,
                status: 200,
                json: async () => ({
                    feeds: [],
                    items,
                    syncedAt: '2026-01-05 00:00:00',
                    latestUpdatedAt: '2026-01-04 00:00:00',
                    isFullSync: false
                })
            } as Response
        }

        await pullSync(db, incrementalFetch)

        const skipped = queryOne<{ title:string }>(
            db, 'SELECT title FROM items WHERE id = 10'
        )
        t.equal(
            skipped?.title,
            'Local optimistic',
            'pending outbox row protects local state'
        )

        await pushSync(db, async () => ({
            ok: true,
            status: 200,
            json: async () => ({})
        }))
        await pullSync(db, incrementalFetch)

        const item = queryOne<{
            title:string
            description:string|null
            updated_at:string
        }>(db, 'SELECT title, description, updated_at FROM items WHERE id = 10')
        t.equal(item?.title, 'Server reparsed', 'server row is re-pulled')
        t.equal(item?.description, 'updated summary', 'server change lands')
        t.equal(
            item?.updated_at,
            '2026-01-04 00:00:00',
            'server updated_at lands'
        )
    } finally {
        db.close()
    }
})

test('pullSync resumes paged bootstrap after interrupted page', async (t) => {
    storeContent.value = true
    const db = await openLocalDb('did:test:pull-paged-resume')
    const items = Array.from({ length: 1500 }, (_, i) => {
        return makePagedItem(i + 1)
    })
    const requestedUrls:string[] = []
    let failAfterPageTwo = true

    const pagedFetch:typeof fetch = async (url:RequestInfo|URL) => {
        const urlText = url.toString()
        requestedUrls.push(urlText)
        const parsed = new URL(urlText, 'https://rsss.test')
        const cursor = parsed.searchParams.get('cursor')
        const start = cursor ? Number(cursor) : 0
        const page = items.slice(start, start + 500)
        const next = start + page.length

        if (failAfterPageTwo && start === 1000) {
            throw new Error('interrupted between pages')
        }

        return {
            ok: true,
            status: 200,
            json: async () => ({
                feeds: start === 0 ? [FEED] : [],
                items: page,
                hasMore: next < items.length,
                nextCursor: next < items.length ? String(next) : null,
                syncedAt: '2026-01-02 00:00:00',
                latestUpdatedAt: page.at(-1)?.updated_at ?? null,
                isFullSync: true
            })
        } as Response
    }

    try {
        let caught:unknown
        try {
            await pullSync(db, pagedFetch)
        } catch (err) {
            caught = err
        }

        t.ok(caught instanceof Error, 'interrupted sync throws')

        const partialCount = queryOne<{ count:number }>(
            db, 'SELECT COUNT(*) AS count FROM items'
        )
        t.equal(partialCount?.count, 1000, 'commits completed pages')

        failAfterPageTwo = false
        await pullSync(db, pagedFetch)

        const finalCount = queryOne<{ count:number }>(
            db, 'SELECT COUNT(*) AS count FROM items'
        )
        t.equal(finalCount?.count, 1500, 'resumed sync stores every item')

        const duplicateIds = queryAll<{ id:number; count:number }>(
            db,
            `SELECT id, COUNT(*) AS count
             FROM items
             GROUP BY id
             HAVING COUNT(*) > 1`
        )
        t.equal(duplicateIds.length, 0, 'resume does not duplicate rows')
        t.equal(requestedUrls.length, 4, 'only missing page is re-fetched')
        t.ok(
            requestedUrls[3].includes('cursor=1000'),
            'resume starts at committed cursor'
        )
    } finally {
        db.close()
    }
})
