import type { Sqlite3Db } from './sqlite-init.js'
import {
    setSyncSyncing,
    setSyncDone,
    setSyncError,
    isLocalFirstActive
} from './sync-status.js'

export class PushSyncAuthError extends Error {
    constructor () {
        super('pushSync: 401 unauthorized — halting drain')
        this.name = 'PushSyncAuthError'
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

export function getOutboxCount (db:Sqlite3Db):number {
    const rows:Array<{ n:number }> = []
    db.exec({
        sql: 'SELECT COUNT(*) AS n FROM outbox',
        rowMode: 'object',
        resultRows: rows as unknown[]
    })
    return rows[0]?.n ?? 0
}

function getOutboxRows (db:Sqlite3Db):OutboxRow[] {
    const rows:OutboxRow[] = []
    db.exec({
        sql: 'SELECT * FROM outbox ORDER BY id ASC',
        rowMode: 'object',
        resultRows: rows as unknown[]
    })
    return rows
}

function deleteOutboxRow (db:Sqlite3Db, id:number):void {
    db.exec({ sql: 'DELETE FROM outbox WHERE id = ?', bind: [id] })
}

function incrementAttempt (
    db:Sqlite3Db,
    id:number,
    error:string
):void {
    db.exec({
        sql: `UPDATE outbox
              SET attempts = attempts + 1, last_error = ?
              WHERE id = ?`,
        bind: [error, id]
    })
}

function upsertFeedFromServer (
    db:Sqlite3Db,
    feed:Record<string, unknown>
):void {
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

function upsertItemFromServer (
    db:Sqlite3Db,
    item:Record<string, unknown>
):void {
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
            (item.description as string|null) ?? null,
            (item.content as string|null) ?? null,
            (item.author as string|null) ?? null,
            (item.pub_date as string|null) ?? null,
            (item.is_read as number) ?? 0,
            (item.is_starred as number) ?? 0,
            item.created_at as string,
            item.updated_at as string
        ]
    })
}

type FetchLike = (
    url:string,
    init?:RequestInit
) => Promise<{ ok:boolean; status:number; json:() => Promise<unknown> }>

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
                feedId: row.target_id ?? undefined,
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
    fetchFn:FetchLike = fetch as unknown as FetchLike
):Promise<void> {
    const trackStatus = isLocalFirstActive.value
    const rows = getOutboxRows(db)
    if (trackStatus && rows.length > 0) setSyncSyncing()

    for (const row of rows) {
        const req = buildRequest(row)
        if (!req) {
            // Unknown op — skip silently
            deleteOutboxRow(db, row.id)
            continue
        }

        try {
            const res = await fetchFn(req.url, {
                method: req.method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body)
            })

            if (res.ok) {
                deleteOutboxRow(db, row.id)
                continue
            }

            if (res.status === 401) {
                throw new PushSyncAuthError()
            }

            if (res.status === 409) {
                const body = await res.json() as Record<string, unknown>
                db.exec('BEGIN')
                try {
                    if (row.op === 'add_feed' || row.op === 'delete_feed') {
                        const feed = body as Record<string, unknown>
                        if (feed.id) upsertFeedFromServer(db, feed)
                    } else if (
                        row.op === 'update_item' ||
                        row.op === 'mark_all_read'
                    ) {
                        if (Array.isArray(body)) {
                            for (const item of body as Record<
                                string, unknown
                            >[]) {
                                upsertItemFromServer(db, item)
                            }
                        } else if (body.id) {
                            upsertItemFromServer(
                                db,
                                body as Record<string, unknown>
                            )
                        }
                    }
                    deleteOutboxRow(db, row.id)
                    db.exec('COMMIT')
                } catch (err) {
                    db.exec('ROLLBACK')
                    throw err
                }
                continue
            }

            // 5xx or other non-success
            incrementAttempt(
                db,
                row.id,
                `HTTP ${res.status}`
            )
        } catch (err) {
            if (err instanceof PushSyncAuthError) throw err
            const errMsg = err instanceof Error ? err.message : String(err)
            incrementAttempt(db, row.id, errMsg)
            if (trackStatus) setSyncError(errMsg)
        }
    }

    if (trackStatus) {
        const pending = getOutboxCount(db)
        setSyncDone(pending)
    }
}
