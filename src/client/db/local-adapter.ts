import type { Sqlite3Db } from './sqlite-init.js'
import type {
    DbAdapter,
    Feed,
    Item,
    ItemsResponse,
    CountsResponse
} from './types.js'

function escapeLike (value:string):string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
}

function routeCandidates (route:string):string[] {
    const normalized = route
        .trim()
        .replace(/^\/post\//, '')
        .replace(/^\/+/, '')

    if (!normalized) return []

    const candidates = new Set<string>()
    candidates.add(normalized)

    try {
        candidates.add(decodeURIComponent(normalized))
    } catch {
        // Ignore malformed URI sequences
    }

    return Array.from(candidates)
}

function query<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:(string|number)[]
):T[] {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind && bind.length ? bind : undefined,
        rowMode: 'object',
        resultRows: rows as unknown[]
    })
    return rows
}

function queryOne<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:(string|number)[]
):T | undefined {
    const rows = query<T>(db, sql, bind)
    return rows[0]
}

export function createLocalAdapter (db:Sqlite3Db):DbAdapter {
    return {
        async getFeeds ():Promise<Feed[]> {
            return query<Feed>(
                db,
                'SELECT * FROM feeds ORDER BY title ASC'
            )
        },

        // write methods added in US-009
        async addFeed (_url:string):Promise<Feed> {
            throw new Error('addFeed not yet implemented in localAdapter')
        },

        async deleteFeed (_id:number):Promise<void> {
            throw new Error('deleteFeed not yet implemented in localAdapter')
        },

        async getItems (options = {}):Promise<ItemsResponse> {
            const {
                feedId,
                isRead,
                isStarred,
                limit = 50,
                offset = 0
            } = options

            let where = ' WHERE 1=1'
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

            const countRow = queryOne<{ count:number }>(
                db,
                'SELECT COUNT(*) as count FROM items' + where,
                params
            )

            const listParams = [...params, limit, offset]
            const items = query<Item>(
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
            const candidates = routeCandidates(itemRoute)
            if (candidates.length === 0) return null

            const routeQuery = candidates
                .map(() => "items.link LIKE ? ESCAPE '\\'")
                .join(' OR ')
            const likeParams = candidates.map(
                c => `%${escapeLike(c)}%`
            )

            const item = queryOne<Item>(
                db,
                `SELECT items.*, feeds.title as feed_title
                 FROM items
                 JOIN feeds ON items.feed_id = feeds.id
                 WHERE items.link IS NOT NULL
                 AND (${routeQuery})
                 ORDER BY pub_date DESC, created_at DESC
                 LIMIT 1`,
                likeParams
            )

            return item ?? null
        },

        async getCounts ():Promise<CountsResponse> {
            const row = queryOne<{
                unread:number
                starred:number
                total:number
            }>(
                db,
                'SELECT ' +
                '  SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread,' +
                '  SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) as starred,' +
                '  COUNT(*) as total ' +
                'FROM items'
            )

            return {
                unread: row?.unread ?? 0,
                starred: row?.starred ?? 0,
                total: row?.total ?? 0
            }
        },

        async updateItem (
            _id:number,
            _updates:{ is_read?:boolean; is_starred?:boolean }
        ):Promise<void> {
            throw new Error('updateItem not yet implemented in localAdapter')
        },

        async markAllRead (_feedId?:number):Promise<void> {
            throw new Error('markAllRead not yet implemented in localAdapter')
        }
    }
}
