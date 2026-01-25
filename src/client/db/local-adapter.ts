/**
 * Local SQLite adapter for Tauri desktop app
 * Uses tauri-plugin-sql to interact with local SQLite database
 */

import type {
    DbAdapter,
    Feed,
    Item,
    ItemsResponse,
    CountsResponse,
    SyncState,
    SyncResponse
} from './types.js'

// Tauri SQL plugin types
interface Database {
    execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>
    select<T>(query: string, bindValues?: unknown[]): Promise<T[]>
}

let db: Database | null = null

/**
 * Initialize the local database connection
 */
async function getDb (): Promise<Database> {
    if (db) return db

    // Dynamic import to avoid issues when running in browser
    // @ts-expect-error - Module will be available at runtime in Tauri
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    db = await Database.load('sqlite:rsss.db') as Database
    return db
}

/**
 * Local SQLite adapter implementation
 */
export const localAdapter: DbAdapter & {
    sync(remoteUrl: string): Promise<SyncResponse>
    getSyncState(): Promise<SyncState>
} = {
    async getFeeds (): Promise<Feed[]> {
        const database = await getDb()
        return database.select<Feed>('SELECT * FROM feeds ORDER BY title ASC')
    },

    async addFeed (url: string): Promise<Feed> {
        const database = await getDb()
        const now = new Date().toISOString()

        await database.execute(
            'INSERT INTO feeds (url, created_at, updated_at) VALUES (?, ?, ?)',
            [url, now, now]
        )

        const feeds = await database.select<Feed>(
            'SELECT * FROM feeds WHERE url = ?',
            [url]
        )

        return feeds[0]
    },

    async deleteFeed (id: number): Promise<void> {
        const database = await getDb()
        await database.execute('DELETE FROM items WHERE feed_id = ?', [id])
        await database.execute('DELETE FROM feeds WHERE id = ?', [id])
    },

    async getItems (options = {}): Promise<ItemsResponse> {
        const database = await getDb()
        const { feedId, isRead, isStarred, limit = 50, offset = 0 } = options

        let query = 'SELECT * FROM items WHERE 1=1'
        const params: unknown[] = []

        if (feedId !== undefined) {
            query += ' AND feed_id = ?'
            params.push(feedId)
        }

        if (isRead !== undefined) {
            query += ' AND is_read = ?'
            params.push(isRead ? 1 : 0)
        }

        if (isStarred !== undefined) {
            query += ' AND is_starred = ?'
            params.push(isStarred ? 1 : 0)
        }

        // Count query
        let countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count')
        const countResult = await database.select<{ count: number }>(countQuery, params)
        const total = countResult[0]?.count || 0

        // Add ordering and pagination
        query += ' ORDER BY pub_date DESC, created_at DESC LIMIT ? OFFSET ?'
        params.push(limit, offset)

        const items = await database.select<Item>(query, params)

        return { items, total, limit, offset }
    },

    async getCounts (): Promise<CountsResponse> {
        const database = await getDb()

        const unread = await database.select<{ count: number }>(
            'SELECT COUNT(*) as count FROM items WHERE is_read = 0'
        )
        const starred = await database.select<{ count: number }>(
            'SELECT COUNT(*) as count FROM items WHERE is_starred = 1'
        )
        const total = await database.select<{ count: number }>(
            'SELECT COUNT(*) as count FROM items'
        )

        return {
            unread: unread[0]?.count || 0,
            starred: starred[0]?.count || 0,
            total: total[0]?.count || 0
        }
    },

    async updateItem (
        id: number,
        updates: { is_read?: boolean; is_starred?: boolean }
    ): Promise<void> {
        const database = await getDb()
        const now = new Date().toISOString()

        if (updates.is_read !== undefined) {
            await database.execute(
                'UPDATE items SET is_read = ?, updated_at = ? WHERE id = ?',
                [updates.is_read ? 1 : 0, now, id]
            )
        }

        if (updates.is_starred !== undefined) {
            await database.execute(
                'UPDATE items SET is_starred = ?, updated_at = ? WHERE id = ?',
                [updates.is_starred ? 1 : 0, now, id]
            )
        }
    },

    async markAllRead (feedId?: number): Promise<void> {
        const database = await getDb()
        const now = new Date().toISOString()

        if (feedId !== undefined) {
            await database.execute(
                'UPDATE items SET is_read = 1, updated_at = ? WHERE feed_id = ?',
                [now, feedId]
            )
        } else {
            await database.execute(
                'UPDATE items SET is_read = 1, updated_at = ?',
                [now]
            )
        }
    },

    async getSyncState (): Promise<SyncState> {
        const database = await getDb()
        const result = await database.select<{
            last_synced_at: string | null
            remote_url: string | null
        }>('SELECT last_synced_at, remote_url FROM sync_state WHERE id = 1')

        return {
            lastSyncedAt: result[0]?.last_synced_at || null,
            remoteUrl: result[0]?.remote_url || null
        }
    },

    async sync (remoteUrl: string): Promise<SyncResponse> {
        const database = await getDb()

        // Get last sync time
        const syncState = await this.getSyncState()
        const since = syncState.lastSyncedAt

        // Build sync URL
        const url = new URL('/api/collie/sync', remoteUrl)
        if (since) {
            url.searchParams.set('since', since)
        }

        // Fetch from remote
        // Note: In Tauri, we need to use tauri-plugin-http for cross-origin requests
        // @ts-expect-error - Module will be available at runtime in Tauri
        const { fetch } = await import('@tauri-apps/plugin-http') as { fetch: typeof globalThis.fetch }
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        })

        if (!response.ok) {
            throw new Error(`Sync failed: ${response.status} ${response.statusText}`)
        }

        const data = await response.json() as SyncResponse

        // Upsert feeds
        for (const feed of data.feeds) {
            await database.execute(`
                INSERT INTO feeds (id, url, title, description, site_url, last_fetched, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    url = excluded.url,
                    title = excluded.title,
                    description = excluded.description,
                    site_url = excluded.site_url,
                    last_fetched = excluded.last_fetched,
                    updated_at = excluded.updated_at
            `, [
                feed.id,
                feed.url,
                feed.title,
                feed.description,
                feed.site_url,
                feed.last_fetched,
                feed.created_at,
                feed.updated_at
            ])
        }

        // Upsert items
        for (const item of data.items) {
            await database.execute(`
                INSERT INTO items (id, feed_id, guid, title, link, description, content, author, pub_date, is_read, is_starred, created_at, updated_at, feed_title)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    updated_at = excluded.updated_at,
                    feed_title = excluded.feed_title
            `, [
                item.id,
                item.feed_id,
                item.guid,
                item.title,
                item.link,
                item.description,
                item.content,
                item.author,
                item.pub_date,
                item.is_read,
                item.is_starred,
                item.created_at,
                item.updated_at,
                item.feed_title
            ])
        }

        // Update sync state
        await database.execute(
            'UPDATE sync_state SET last_synced_at = ?, remote_url = ? WHERE id = 1',
            [data.latestUpdatedAt, remoteUrl]
        )

        return data
    }
}
