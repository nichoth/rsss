import type { Sqlite3Db } from './sqlite-init.js'
import { storeContent } from '../local-first-settings.js'
import { execDb, queryDb } from './local-db.js'
import {
    setSyncSyncing,
    setSyncDone,
    setSyncError,
    isLocalFirstActive
} from './sync-status.js'

export class SyncBillingError extends Error {
    constructor () {
        super('Sync requires an active subscription')
        this.name = 'SyncBillingError'
    }
}

export class PullSyncAuthError extends Error {
    constructor () {
        super('pullSync: 401 unauthorized -- re-auth required')
        this.name = 'PullSyncAuthError'
    }
}

export interface SyncResponse {
    feeds:Record<string, unknown>[]
    items:Record<string, unknown>[]
    syncedAt:string
    latestUpdatedAt:string
    isFullSync:boolean
    hasMore?:boolean
    nextCursor?:string|null
}

interface PendingOutboxRefs {
    feedIds:Set<number>
    itemIds:Set<number>
    markAllReadFeedIds:Set<number>
    markAllReadAll:boolean
}

async function getLastPullAt (db:Sqlite3Db):Promise<string|null> {
    await ensureSyncCursorColumn(db)
    const rows = await queryDb<{ last_pull_at:string|null }>(
        db,
        'SELECT last_pull_at FROM sync_meta WHERE id = 1'
    )
    return rows[0]?.last_pull_at ?? null
}

async function setLastPullAt (db:Sqlite3Db, value:string):Promise<void> {
    await ensureSyncCursorColumn(db)
    await execDb(db, {
        sql: `UPDATE sync_meta
              SET last_pull_at = ?, pull_cursor = NULL
              WHERE id = 1`,
        bind: [value]
    })
}

async function getPullCursor (db:Sqlite3Db):Promise<string|null> {
    await ensureSyncCursorColumn(db)
    const rows = await queryDb<{ pull_cursor:string|null }>(
        db,
        'SELECT pull_cursor FROM sync_meta WHERE id = 1'
    )
    return rows[0]?.pull_cursor ?? null
}

async function setPullCursor (
    db:Sqlite3Db,
    value:string|null
):Promise<void> {
    await ensureSyncCursorColumn(db)
    await execDb(db, {
        sql: 'UPDATE sync_meta SET pull_cursor = ? WHERE id = 1',
        bind: [value]
    })
}

const syncCursorColumnReady = new WeakSet<Sqlite3Db>()

async function ensureSyncCursorColumn (db:Sqlite3Db):Promise<void> {
    if (syncCursorColumnReady.has(db)) return

    const cols = await queryDb<{ name:string }>(
        db,
        'PRAGMA table_info(sync_meta)'
    )
    if (!cols.some((col) => col.name === 'pull_cursor')) {
        await execDb(db, 'ALTER TABLE sync_meta ADD COLUMN pull_cursor TEXT')
    }
    syncCursorColumnReady.add(db)
}

async function upsertFeed (
    db:Sqlite3Db,
    feed:Record<string, unknown>
):Promise<void> {
    await execDb(db, {
        sql: `INSERT INTO feeds
            (id, url, title, description, site_url, last_fetched,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                url = excluded.url,
                title = excluded.title,
                description = excluded.description,
                site_url = excluded.site_url,
                last_fetched = excluded.last_fetched,
                updated_at = excluded.updated_at`,
        bind: [
            feed.id as number,
            feed.url as string,
            (feed.title as string|null) ?? null,
            (feed.description as string|null) ?? null,
            (feed.site_url as string|null) ?? null,
            (feed.last_fetched as string|null) ?? null,
            feed.created_at as string,
            feed.updated_at as string
        ]
    })
}

async function upsertItem (
    db:Sqlite3Db,
    item:Record<string, unknown>,
    keepContent:boolean
):Promise<void> {
    const content = keepContent
        ? (item.content as string|null) ?? null
        : null
    const description = keepContent
        ? (item.description as string|null) ?? null
        : null

    await execDb(db, {
        sql: `INSERT INTO items
            (id, feed_id, guid, title, link, description, content,
             author, pub_date, is_read, is_starred, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                feed_id = excluded.feed_id,
                guid = excluded.guid,
                title = excluded.title,
                link = excluded.link,
                description = excluded.description,
                content = excluded.content,
                author = excluded.author,
                pub_date = excluded.pub_date,
                is_read = excluded.is_read,
                is_starred = excluded.is_starred,
                updated_at = excluded.updated_at`,
        bind: [
            item.id as number,
            item.feed_id as number,
            item.guid as string,
            (item.title as string|null) ?? null,
            (item.link as string|null) ?? null,
            description,
            content,
            (item.author as string|null) ?? null,
            (item.pub_date as string|null) ?? null,
            (item.is_read as number) ?? 0,
            (item.is_starred as number) ?? 0,
            item.created_at as string,
            item.updated_at as string
        ]
    })
}

async function getPendingOutboxRefs (
    db:Sqlite3Db
):Promise<PendingOutboxRefs> {
    const rows = await queryDb<{ op:string; target_id:number|null }>(
        db,
        `SELECT op, target_id
         FROM outbox
         WHERE op IN (
            'add_feed',
            'delete_feed',
            'update_item',
            'mark_all_read'
         )`
    )

    const refs:PendingOutboxRefs = {
        feedIds: new Set(),
        itemIds: new Set(),
        markAllReadFeedIds: new Set(),
        markAllReadAll: false
    }

    for (const row of rows) {
        if (
            (row.op === 'add_feed' || row.op === 'delete_feed') &&
            row.target_id !== null
        ) {
            refs.feedIds.add(row.target_id)
        } else if (row.op === 'update_item' && row.target_id !== null) {
            refs.itemIds.add(row.target_id)
        } else if (row.op === 'mark_all_read') {
            if (row.target_id === null) {
                refs.markAllReadAll = true
            } else {
                refs.markAllReadFeedIds.add(row.target_id)
            }
        }
    }

    return refs
}

function shouldSkipFeed (
    feed:Record<string, unknown>,
    refs:PendingOutboxRefs
):boolean {
    return refs.feedIds.has(feed.id as number)
}

function shouldSkipItem (
    item:Record<string, unknown>,
    refs:PendingOutboxRefs
):boolean {
    const id = item.id as number
    const feedId = item.feed_id as number
    return (
        refs.itemIds.has(id) ||
        refs.feedIds.has(feedId) ||
        refs.markAllReadAll ||
        refs.markAllReadFeedIds.has(feedId)
    )
}

export interface PullSyncOptions {
    onFeedUpserted?:(count:number) => void
    onItemUpserted?:(count:number) => void
    onFeedPage?:(count:number) => void
    onItemPage?:(count:number) => void
    trackStatus?:boolean
}

/**
 * Pull changes from the server into the local DB.
 * Reads `lastPullAt` from `sync_meta`; first call omits `since`
 * and treats the response as a full snapshot.
 */
export async function pullSync (
    db:Sqlite3Db,
    fetchFn:typeof fetch = fetch,
    opts:PullSyncOptions = {}
):Promise<void> {
    const trackStatus = opts.trackStatus ?? isLocalFirstActive.value
    if (trackStatus) setSyncSyncing()

    const lastPullAt = await getLastPullAt(db)
    let cursor = await getPullCursor(db)
    const keepContent = storeContent.value
    const pendingRefs = await getPendingOutboxRefs(db)
    let done = false

    while (!done) {
        const url = buildSyncUrl(lastPullAt, cursor)
        let res:Response
        try {
            res = await fetchFn(url)
        } catch (err) {
            if (trackStatus) {
                setSyncError(
                    err instanceof Error ? err.message : String(err)
                )
            }
            throw err
        }

        if (res.status === 401) {
            throw new PullSyncAuthError()
        }

        if (res.status === 402) {
            // Subscription required -- swallow silently so the
            // local-only fallback is quiet rather than spammy.
            if (trackStatus) setSyncDone(0)
            throw new SyncBillingError()
        }

        if (!res.ok) {
            const msg = `pullSync: server returned ${res.status}`
            if (trackStatus) setSyncError(msg)
            throw new Error(msg)
        }

        const data = (await res.json()) as SyncResponse

        await execDb(db, 'BEGIN')
        try {
            let feedCount = 0
            for (const feed of data.feeds) {
                if (shouldSkipFeed(feed, pendingRefs)) continue
                await upsertFeed(db, feed)
                feedCount++
                opts.onFeedUpserted?.(feedCount)
            }
            let itemCount = 0
            for (const item of data.items) {
                if (shouldSkipItem(item, pendingRefs)) continue
                await upsertItem(db, item, keepContent)
                itemCount++
                opts.onItemUpserted?.(itemCount)
            }

            if (data.hasMore) {
                cursor = data.nextCursor ?? null
                await setPullCursor(db, cursor)
            } else {
                await setLastPullAt(db, data.latestUpdatedAt)
                cursor = null
                done = true
            }
            await execDb(db, 'COMMIT')
            opts.onFeedPage?.(feedCount)
            opts.onItemPage?.(itemCount)
        } catch (err) {
            await execDb(db, 'ROLLBACK')
            if (trackStatus) {
                setSyncError(
                    err instanceof Error ? err.message : String(err)
                )
            }
            throw err
        }
    }

    if (trackStatus) setSyncDone(0)
}

function buildSyncUrl (since:string|null, cursor:string|null):string {
    const params = new URLSearchParams()
    if (since) params.set('since', since)
    if (cursor) params.set('cursor', cursor)

    const qs = params.toString()
    return qs ? `/api/sync?${qs}` : '/api/sync'
}
