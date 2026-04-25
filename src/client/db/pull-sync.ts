import type { Sqlite3Db } from './sqlite-init.js'
import { storeContent } from '../local-first-settings.js'
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

export interface SyncResponse {
    feeds:Record<string, unknown>[]
    items:Record<string, unknown>[]
    syncedAt:string
    latestUpdatedAt:string
    isFullSync:boolean
}

function getLastPullAt (db:Sqlite3Db):string|null {
    const rows:{ last_pull_at:string|null }[] = []
    db.exec({
        sql: 'SELECT last_pull_at FROM sync_meta WHERE id = 1',
        rowMode: 'object',
        resultRows: rows as unknown[]
    })
    return rows[0]?.last_pull_at ?? null
}

function setLastPullAt (db:Sqlite3Db, value:string):void {
    db.exec({
        sql: 'UPDATE sync_meta SET last_pull_at = ? WHERE id = 1',
        bind: [value]
    })
}

function upsertFeed (db:Sqlite3Db, feed:Record<string, unknown>):void {
    db.exec({
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

function upsertItem (
    db:Sqlite3Db,
    item:Record<string, unknown>,
    keepContent:boolean
):void {
    const content = keepContent
        ? (item.content as string|null) ?? null
        : null
    const description = keepContent
        ? (item.description as string|null) ?? null
        : null

    db.exec({
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

export interface PullSyncOptions {
    onFeedUpserted?:(count:number) => void
    onItemUpserted?:(count:number) => void
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
    const trackStatus = isLocalFirstActive.value
    if (trackStatus) setSyncSyncing()

    const lastPullAt = getLastPullAt(db)
    const url = lastPullAt
        ? `/api/sync?since=${encodeURIComponent(lastPullAt)}`
        : '/api/sync'

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
    const keepContent = storeContent.value

    db.exec('BEGIN')
    try {
        let feedCount = 0
        for (const feed of data.feeds) {
            upsertFeed(db, feed)
            feedCount++
            opts.onFeedUpserted?.(feedCount)
        }
        let itemCount = 0
        for (const item of data.items) {
            upsertItem(db, item, keepContent)
            itemCount++
            opts.onItemUpserted?.(itemCount)
        }
        setLastPullAt(db, data.latestUpdatedAt)
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        if (trackStatus) {
            setSyncError(
                err instanceof Error ? err.message : String(err)
            )
        }
        throw err
    }

    if (trackStatus) setSyncDone(0)
}
