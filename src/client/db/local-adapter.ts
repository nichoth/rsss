import type { Sqlite3Db } from './sqlite-init.js'
import type {
    DbAdapter,
    Feed,
    FeedsResponse,
    Item,
    ItemsResponse,
    CountsResponse
} from './types.js'
import { formatSqliteTs, parseSqliteTs } from './time.js'
import { itemRouteCandidates } from '../../shared/item-route.js'
import { execDb, queryDb, queryOneDb } from './local-db.js'

async function getLocalWriteTimestamp (db:Sqlite3Db):Promise<string> {
    const nowDate = new Date()
    const now = formatSqliteTs(nowDate)
    const meta = await queryOneDb<{ last_pull_at:string|null }>(
        db,
        'SELECT last_pull_at FROM sync_meta WHERE id = 1'
    )
    const lastPullAt = meta?.last_pull_at
    if (!lastPullAt) return now

    const lastPullDate = parseSqliteTs(lastPullAt)
    if (!lastPullDate || nowDate.getTime() > lastPullDate.getTime()) {
        return now
    }

    return formatSqliteTs(new Date(lastPullDate.getTime() + 1000))
}

async function insertOutbox (
    db:Sqlite3Db,
    op:string,
    targetId:number|null,
    payload:Record<string, unknown>,
    clientUpdatedAt:string
):Promise<void> {
    await execDb(db, {
        sql: `INSERT INTO outbox
            (op, target_id, payload, client_op_id, client_updated_at)
            VALUES (?, ?, ?, ?, ?)`,
        bind: [
            op,
            targetId,
            JSON.stringify(payload),
            crypto.randomUUID(),
            clientUpdatedAt
        ]
    })
}

async function upsertUpdateItemOutbox (
    db:Sqlite3Db,
    id:number,
    payload:Record<string, unknown>,
    clientUpdatedAt:string
):Promise<void> {
    const row = await queryOneDb<{ id:number; payload:string }>(
        db,
        `SELECT id, payload FROM outbox
         WHERE op = 'update_item' AND target_id = ?
         ORDER BY id ASC
         LIMIT 1`,
        [id]
    )

    if (!row) {
        await insertOutbox(db, 'update_item', id, payload, clientUpdatedAt)
        return
    }

    let previous:Record<string, unknown> = {}
    try {
        previous = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
        previous = {}
    }

    await execDb(db, {
        sql: `UPDATE outbox
              SET payload = ?, client_updated_at = ?
              WHERE id = ?`,
        bind: [
            JSON.stringify({ ...previous, ...payload }),
            clientUpdatedAt,
            row.id
        ]
    })
}

export function createLocalAdapter (db:Sqlite3Db):DbAdapter {
    return {
        async getFeeds ():Promise<FeedsResponse> {
            const feeds = await queryDb<Feed>(
                db,
                'SELECT * FROM feeds ORDER BY title ASC'
            )
            return { feeds }
        },

        async addFeed (url:string):Promise<Feed> {
            const now = await getLocalWriteTimestamp(db)
            await execDb(db, 'BEGIN')
            try {
                await execDb(db, {
                    sql: 'INSERT INTO feeds (url, created_at, updated_at)' +
                        ' VALUES (?, ?, ?)',
                    bind: [url, now, now]
                })
                const feed = await queryOneDb<Feed>(
                    db,
                    'SELECT * FROM feeds WHERE url = ?' +
                        ' ORDER BY id DESC LIMIT 1',
                    [url]
                )
                if (!feed) throw new Error('addFeed: insert failed')
                await insertOutbox(db, 'add_feed', feed.id, { url }, now)
                await execDb(db, 'COMMIT')
                return feed
            } catch (err) {
                await execDb(db, 'ROLLBACK')
                throw err
            }
        },

        async deleteFeed (id:number):Promise<void> {
            const now = await getLocalWriteTimestamp(db)
            await execDb(db, 'BEGIN')
            try {
                await execDb(db, {
                    sql: 'DELETE FROM items WHERE feed_id = ?',
                    bind: [id]
                })
                await execDb(db, {
                    sql: 'DELETE FROM feeds WHERE id = ?',
                    bind: [id]
                })
                await insertOutbox(db, 'delete_feed', id, { id }, now)
                await execDb(db, 'COMMIT')
            } catch (err) {
                await execDb(db, 'ROLLBACK')
                throw err
            }
        },

        async getItems (options = {}):Promise<ItemsResponse> {
            const {
                feedId,
                isRead,
                isStarred,
                limit = 50,
                offset = 0
            } = options

            // Mirror the server's reading-list cursor predicate. Items
            // with NULL pub_date pass unconditionally so they cannot
            // become invisible when their feed has no cursor yet.
            let where = ' WHERE 1=1' +
                ' AND (' +
                ' items.pub_date IS NULL' +
                ' OR (' +
                ' feeds.last_pulled_at IS NOT NULL' +
                ' AND items.pub_date <= feeds.last_pulled_at' +
                ' )' +
                ' )'
            const params:(string|number)[] = []

            if (feedId !== undefined) {
                where += ' AND items.feed_id = ?'
                params.push(feedId)
            }
            if (isRead !== undefined) {
                where += ' AND items.is_read = ?'
                params.push(isRead ? 1 : 0)
            }
            if (isStarred !== undefined) {
                where += ' AND items.is_starred = ?'
                params.push(isStarred ? 1 : 0)
            }

            const countRow = await queryOneDb<{ count:number }>(
                db,
                'SELECT COUNT(*) as count FROM items' +
                ' JOIN feeds ON items.feed_id = feeds.id' +
                where,
                params
            )

            const listParams = [...params, limit, offset]
            const items = await queryDb<Item>(
                db,
                'SELECT items.*, feeds.title as feed_title ' +
                'FROM items JOIN feeds ON items.feed_id = feeds.id' +
                where +
                ' ORDER BY pub_date DESC, created_at DESC LIMIT ? OFFSET ?',
                listParams
            )

            return {
                items,
                total: countRow?.count ?? 0,
                limit,
                offset
            }
        },

        async getItemByRoute (itemRoute:string):Promise<Item|null> {
            const candidates = itemRouteCandidates(itemRoute)
            if (candidates.length === 0) return null

            const routeQuery = candidates
                .map(() => 'items.link = ?')
                .join(' OR ')

            const item = await queryOneDb<Item>(
                db,
                `SELECT items.*, feeds.title as feed_title
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 WHERE items.link IS NOT NULL
                 AND (${routeQuery})
                 ORDER BY pub_date DESC, created_at DESC
                 LIMIT 1`,
                candidates
            )

            return item ?? null
        },

        async getCounts ():Promise<CountsResponse> {
            const row = await queryOneDb<{
                unread:number
                starred:number
                total:number
            }>(
                db,
                'SELECT ' +
                '  SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread,' +
                '  SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) ' +
                'as starred,' +
                '  COUNT(*) as total ' +
                'FROM items'
            )

            const perFeedRows = await queryDb<{
                feed_id:number
                unread:number
            }>(
                db,
                'SELECT feed_id, COUNT(*) as unread FROM items' +
                ' WHERE is_read = 0 GROUP BY feed_id'
            )
            const perFeed:Record<string, number> = {}
            for (const r of perFeedRows) {
                perFeed[String(r.feed_id)] = r.unread
            }

            return {
                unread: row?.unread ?? 0,
                starred: row?.starred ?? 0,
                total: row?.total ?? 0,
                perFeed
            }
        },

        async updateItem (
            id:number,
            updates:{ is_read?:boolean; is_starred?:boolean }
        ):Promise<void> {
            const fields:string[] = []
            const params:(string|number)[] = []

            if (updates.is_read !== undefined) {
                fields.push('is_read = ?')
                params.push(updates.is_read ? 1 : 0)
            }
            if (updates.is_starred !== undefined) {
                fields.push('is_starred = ?')
                params.push(updates.is_starred ? 1 : 0)
            }
            if (fields.length === 0) return

            const now = await getLocalWriteTimestamp(db)
            fields.push('updated_at = ?')
            params.push(now, id)

            await execDb(db, 'BEGIN')
            try {
                await execDb(db, {
                    sql: `UPDATE items SET ${fields.join(', ')} WHERE id = ?`,
                    bind: params
                })

                const item = await queryOneDb<{
                    is_read:number
                    is_starred:number
                }>(
                    db,
                    'SELECT is_read, is_starred FROM items WHERE id = ?',
                    [id]
                )
                if (!item) throw new Error('updateItem: item not found')

                const payload:Record<string, unknown> = { id }
                if (updates.is_read !== undefined) {
                    payload.is_read = item.is_read === 1
                }
                if (updates.is_starred !== undefined) {
                    payload.is_starred = item.is_starred === 1
                }

                await upsertUpdateItemOutbox(db, id, payload, now)
                await execDb(db, 'COMMIT')
            } catch (err) {
                await execDb(db, 'ROLLBACK')
                throw err
            }
        },

        async markAllRead (feedId?:number):Promise<void> {
            const now = await getLocalWriteTimestamp(db)
            await execDb(db, 'BEGIN')
            try {
                if (feedId !== undefined) {
                    await execDb(db, {
                        sql: 'UPDATE items SET is_read = 1,' +
                            ' updated_at = ?' +
                            ' WHERE feed_id = ? AND is_read = 0',
                        bind: [now, feedId]
                    })
                } else {
                    await execDb(db, {
                        sql: 'UPDATE items SET is_read = 1,' +
                            ' updated_at = ? WHERE is_read = 0',
                        bind: [now]
                    })
                }
                await insertOutbox(
                    db,
                    'mark_all_read',
                    feedId ?? null,
                    feedId !== undefined ? { feedId } : {},
                    now
                )
                await execDb(db, 'COMMIT')
            } catch (err) {
                await execDb(db, 'ROLLBACK')
                throw err
            }
        }
    }
}
