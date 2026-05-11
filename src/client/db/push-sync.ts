import type { Sqlite3Db } from './sqlite-init.js'
import {
    execDb,
    queryDb,
    ensureFeedTerminalStateColumns
} from './local-db.js'
import {
    setSyncSyncing,
    setSyncDone,
    setSyncError,
    isLocalFirstActive
} from './sync-status.js'
import { ensureItemFullContentColumns } from './pull-sync.js'

export const DEAD_LETTER_ATTEMPT_LIMIT = 10

export class PushSyncAuthError extends Error {
    constructor () {
        super('pushSync: 401 unauthorized — halting drain')
        this.name = 'PushSyncAuthError'
    }
}

export class PushSyncBillingError extends Error {
    constructor () {
        super('pushSync: subscription required — halting drain')
        this.name = 'PushSyncBillingError'
    }
}

interface OutboxRow {
    id:number
    op:string
    target_id:number|null
    payload:string
    client_op_id:string
    client_updated_at:string
    attempts:number
    last_error:string|null
}

interface FeedTargetRewrite {
    optimisticId:number
    serverId:number
}

export async function getOutboxCount (db:Sqlite3Db):Promise<number> {
    const rows = await queryDb<{ n:number }>(
        db,
        'SELECT COUNT(*) AS n FROM outbox'
    )
    return rows[0]?.n ?? 0
}

export async function getDeadLetterOutboxCount (
    db:Sqlite3Db
):Promise<number> {
    const rows = await queryDb<{ n:number }>(
        db,
        'SELECT COUNT(*) AS n FROM dead_letter_outbox'
    )
    return rows[0]?.n ?? 0
}

function getOutboxRows (db:Sqlite3Db):Promise<OutboxRow[]> {
    return queryDb<OutboxRow>(db, 'SELECT * FROM outbox ORDER BY id ASC')
}

async function deleteOutboxRow (db:Sqlite3Db, id:number):Promise<void> {
    await execDb(db, {
        sql: 'DELETE FROM outbox WHERE id = ?',
        bind: [id]
    })
}

async function incrementAttempt (
    db:Sqlite3Db,
    id:number,
    error:string
):Promise<void> {
    await execDb(db, {
        sql: `UPDATE outbox
              SET attempts = attempts + 1, last_error = ?
              WHERE id = ?`,
        bind: [error, id]
    })
}

async function moveOutboxRowToDeadLetters (
    db:Sqlite3Db,
    row:OutboxRow,
    error:string
):Promise<void> {
    await execDb(db, 'BEGIN')
    try {
        await execDb(db, {
            sql: `INSERT INTO dead_letter_outbox
                (op, target_id, payload, client_op_id, client_updated_at,
                 attempts, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
            bind: [
                row.op,
                row.target_id,
                row.payload,
                row.client_op_id,
                row.client_updated_at,
                row.attempts + 1,
                error
            ]
        })
        await deleteOutboxRow(db, row.id)
        await execDb(db, 'COMMIT')
    } catch (err) {
        await execDb(db, 'ROLLBACK')
        throw err
    }
}

async function recordTransientFailure (
    db:Sqlite3Db,
    row:OutboxRow,
    error:string
):Promise<void> {
    await incrementAttempt(db, row.id, error)
}

async function recordPermanentFailure (
    db:Sqlite3Db,
    row:OutboxRow,
    error:string
):Promise<void> {
    await moveOutboxRowToDeadLetters(db, row, error)
}

export async function upsertFeedFromServer (
    db:Sqlite3Db,
    feed:Record<string, unknown>
):Promise<void> {
    await ensureFeedTerminalStateColumns(db)
    await execDb(db, {
        sql: `INSERT INTO feeds
            (id, url, title, description, site_url, last_fetched,
             last_error, last_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                url = excluded.url,
                title = excluded.title,
                description = excluded.description,
                site_url = excluded.site_url,
                last_fetched = excluded.last_fetched,
                last_error = excluded.last_error,
                last_status = excluded.last_status,
                updated_at = excluded.updated_at`,
        bind: [
            feed.id as number,
            feed.url as string,
            (feed.title as string|null) ?? null,
            (feed.description as string|null) ?? null,
            (feed.site_url as string|null) ?? null,
            (feed.last_fetched as string|null) ?? null,
            (feed.last_error as string|null) ?? null,
            (feed.last_status as number|null) ?? null,
            feed.created_at as string,
            feed.updated_at as string
        ]
    })
}

function extractFeed (
    body:unknown
):Record<string, unknown>|null {
    if (!body || typeof body !== 'object') return null

    const record = body as Record<string, unknown>
    if (typeof record.id === 'number') return record

    const feed = record.feed
    if (!feed || typeof feed !== 'object') return null

    return feed as Record<string, unknown>
}

async function replaceOptimisticFeed (
    db:Sqlite3Db,
    optimisticId:number,
    feed:Record<string, unknown>
):Promise<void> {
    const serverId = feed.id as number

    if (optimisticId === serverId) {
        await upsertFeedFromServer(db, feed)
        return
    }

    await execDb(db, 'PRAGMA defer_foreign_keys = ON')
    await execDb(db, {
        sql: `UPDATE feeds
              SET id = ?,
                  url = ?,
                  title = ?,
                  description = ?,
                  site_url = ?,
                  last_fetched = ?,
                  created_at = ?,
                  updated_at = ?
              WHERE id = ?`,
        bind: [
            serverId,
            feed.url as string,
            (feed.title as string|null) ?? null,
            (feed.description as string|null) ?? null,
            (feed.site_url as string|null) ?? null,
            (feed.last_fetched as string|null) ?? null,
            feed.created_at as string,
            feed.updated_at as string,
            optimisticId
        ]
    })
    await execDb(db, {
        sql: 'UPDATE items SET feed_id = ? WHERE feed_id = ?',
        bind: [serverId, optimisticId]
    })
}

async function rewritePendingDeleteFeedTargets (
    db:Sqlite3Db,
    rewrite:FeedTargetRewrite
):Promise<void> {
    await execDb(db, {
        sql: `UPDATE outbox
              SET target_id = ?
              WHERE op = 'delete_feed'
              AND target_id = ?`,
        bind: [rewrite.serverId, rewrite.optimisticId]
    })
}

function rewriteQueuedDeleteFeedTargets (
    rows:OutboxRow[],
    rewrite:FeedTargetRewrite
):void {
    for (const pending of rows) {
        if (
            pending.op === 'delete_feed' &&
            pending.target_id === rewrite.optimisticId
        ) {
            pending.target_id = rewrite.serverId
        }
    }
}

function extractItem (
    body:unknown
):Record<string, unknown>|null {
    if (!body || typeof body !== 'object') return null

    const record = body as Record<string, unknown>
    if (typeof record.id === 'number') return record

    const item = record.item
    if (!item || typeof item !== 'object') return null

    return item as Record<string, unknown>
}

function extractItems (
    body:unknown
):Record<string, unknown>[] {
    if (Array.isArray(body)) return body as Record<string, unknown>[]
    if (!body || typeof body !== 'object') return []

    const items = (body as Record<string, unknown>).items
    if (Array.isArray(items)) return items as Record<string, unknown>[]

    const item = extractItem(body)
    return item ? [item] : []
}

async function reconcileSuccessfulAddFeed (
    db:Sqlite3Db,
    row:OutboxRow,
    body:unknown
):Promise<FeedTargetRewrite|null> {
    const feed = extractFeed(body)
    if (!feed || typeof feed.id !== 'number') {
        throw new Error('pushSync: add_feed response missing feed')
    }

    if (row.target_id !== null) {
        await replaceOptimisticFeed(db, row.target_id, feed)
        const rewrite = {
            optimisticId: row.target_id,
            serverId: feed.id
        }
        await rewritePendingDeleteFeedTargets(db, rewrite)
        return rewrite
    }
    await upsertFeedFromServer(db, feed)
    return null
}

async function upsertItemFromServer (
    db:Sqlite3Db,
    item:Record<string, unknown>
):Promise<void> {
    await ensureItemFullContentColumns(db)
    await execDb(db, {
        sql: `INSERT INTO items
            (id, feed_id, guid, title, link, description, content,
             author, pub_date, thumbnail_url, og_image_url, blurhash,
             image_width, image_height, is_read, is_starred, created_at,
             updated_at,
             full_content, full_content_fetched_at, full_content_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                feed_id = excluded.feed_id,
                guid = excluded.guid,
                title = excluded.title,
                link = excluded.link,
                description = excluded.description,
                content = excluded.content,
                author = excluded.author,
                pub_date = excluded.pub_date,
                thumbnail_url = excluded.thumbnail_url,
                og_image_url = excluded.og_image_url,
                blurhash = excluded.blurhash,
                image_width = excluded.image_width,
                image_height = excluded.image_height,
                is_read = excluded.is_read,
                is_starred = excluded.is_starred,
                updated_at = excluded.updated_at,
                full_content = excluded.full_content,
                full_content_fetched_at = excluded.full_content_fetched_at,
                full_content_status = excluded.full_content_status`,
        bind: [
            item.id as number,
            item.feed_id as number,
            item.guid as string,
            (item.title as string|null) ?? null,
            (item.link as string|null) ?? null,
            (item.description as string|null) ?? null,
            (item.content as string|null) ?? null,
            (item.author as string|null) ?? null,
            (item.pub_date as string|null) ?? null,
            (item.thumbnail_url as string|null) ?? null,
            (item.og_image_url as string|null) ?? null,
            (item.blurhash as string|null) ?? null,
            (item.image_width as number|null) ?? null,
            (item.image_height as number|null) ?? null,
            (item.is_read as number) ?? 0,
            (item.is_starred as number) ?? 0,
            item.created_at as string,
            item.updated_at as string,
            (item.full_content as string|null) ?? null,
            (item.full_content_fetched_at as string|null) ?? null,
            (item.full_content_status as string|null) ?? null
        ]
    })
}

type FetchLike = (
    url:string,
    init?:RequestInit
) => Promise<{ ok:boolean; status:number; json:() => Promise<unknown> }>

export interface PushSyncOptions {
    trackStatus?:boolean
}

function buildRequest (
    row:OutboxRow
):{
    url:string
    method:string
    body:Record<string, unknown>
} | null {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const base = {
        client_op_id: row.client_op_id,
        client_updated_at: row.client_updated_at
    }

    if (row.op === 'add_feed') {
        return {
            url: '/api/feeds',
            method: 'POST',
            body: { url: payload.url as string, ...base }
        }
    }

    if (row.op === 'delete_feed' && row.target_id !== null) {
        return {
            url: `/api/feeds/${row.target_id}`,
            method: 'DELETE',
            body: base
        }
    }

    if (row.op === 'update_item' && row.target_id !== null) {
        return {
            url: `/api/items/${row.target_id}`,
            method: 'PATCH',
            body: { ...payload, ...base }
        }
    }

    if (row.op === 'mark_all_read') {
        return {
            url: '/api/items/mark-all-read',
            method: 'POST',
            body: {
                feed_id: row.target_id ?? undefined,
                ...base
            }
        }
    }

    return null
}

/**
 * Drain the outbox by replaying pending writes to the server.
 * Throws `PushSyncAuthError` on 401 so callers can redirect to login.
 */
export async function pushSync (
    db:Sqlite3Db,
    fetchFn:FetchLike = fetch as unknown as FetchLike,
    opts:PushSyncOptions = {}
):Promise<void> {
    const trackStatus = opts.trackStatus ?? isLocalFirstActive.value
    const rows = await getOutboxRows(db)
    if (trackStatus && rows.length > 0) setSyncSyncing()

    for (const row of rows) {
        const req = buildRequest(row)
        if (!req) {
            // Unknown op — skip silently
            await deleteOutboxRow(db, row.id)
            continue
        }

        try {
            const res = await fetchFn(req.url, {
                method: req.method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body)
            })

            if (res.ok) {
                if (row.op === 'add_feed') {
                    const body = await res.json()
                    let rewrite:FeedTargetRewrite|null = null
                    await execDb(db, 'BEGIN')
                    try {
                        rewrite = await reconcileSuccessfulAddFeed(
                            db,
                            row,
                            body
                        )
                        await deleteOutboxRow(db, row.id)
                        await execDb(db, 'COMMIT')
                    } catch (err) {
                        await execDb(db, 'ROLLBACK')
                        throw err
                    }
                    if (rewrite) {
                        rewriteQueuedDeleteFeedTargets(rows, rewrite)
                    }
                    continue
                }
                await deleteOutboxRow(db, row.id)
                continue
            }

            if (res.status === 401) {
                throw new PushSyncAuthError()
            }

            if (res.status === 402) {
                throw new PushSyncBillingError()
            }

            if (res.status === 409) {
                const body = await res.json()
                await execDb(db, 'BEGIN')
                let rewrite:FeedTargetRewrite|null = null
                try {
                    if (row.op === 'add_feed') {
                        rewrite = await reconcileSuccessfulAddFeed(
                            db,
                            row,
                            body
                        )
                    } else if (row.op === 'delete_feed') {
                        const feed = extractFeed(body)
                        if (feed) await upsertFeedFromServer(db, feed)
                    } else if (
                        row.op === 'update_item' ||
                        row.op === 'mark_all_read'
                    ) {
                        for (const item of extractItems(body)) {
                            await upsertItemFromServer(db, item)
                        }
                    }
                    await deleteOutboxRow(db, row.id)
                    await execDb(db, 'COMMIT')
                } catch (err) {
                    await execDb(db, 'ROLLBACK')
                    throw err
                }
                if (rewrite) {
                    rewriteQueuedDeleteFeedTargets(rows, rewrite)
                }
                continue
            }

            if (res.status >= 500) {
                await recordTransientFailure(db, row, `HTTP ${res.status}`)
                continue
            }

            await recordPermanentFailure(db, row, `HTTP ${res.status}`)
        } catch (err) {
            if (err instanceof PushSyncAuthError) throw err
            if (err instanceof PushSyncBillingError) throw err
            const errMsg = err instanceof Error ? err.message : String(err)
            await recordTransientFailure(db, row, errMsg)
            if (trackStatus) setSyncError(errMsg)
        }
    }

    if (trackStatus) {
        const pending = await getOutboxCount(db)
        const deadLetters = await getDeadLetterOutboxCount(db)
        setSyncDone(pending, deadLetters)
    }
}
