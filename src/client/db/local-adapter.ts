/**
 * Local IndexedDB adapter for PWA offline support
 * Uses the `idb` library for a Promise-based IndexedDB API
 */

import { openDB, type IDBPDatabase } from 'idb'
import type {
    DbAdapter,
    Feed,
    Item,
    ItemsResponse,
    CountsResponse,
    SyncState,
    SyncResponse
} from './types.js'

// Database schema version
const DB_VERSION = 1
const DB_NAME = 'rsss'

// IndexedDB database instance
let dbPromise: Promise<IDBPDatabase> | null = null

/**
 * Initialize and get the IndexedDB database
 */
function getDb (): Promise<IDBPDatabase> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade (db) {
                // Feeds store
                if (!db.objectStoreNames.contains('feeds')) {
                    const feedStore = db.createObjectStore('feeds', { keyPath: 'id' })
                    feedStore.createIndex('url', 'url', { unique: true })
                    feedStore.createIndex('updated_at', 'updated_at')
                }

                // Items store
                if (!db.objectStoreNames.contains('items')) {
                    const itemStore = db.createObjectStore('items', { keyPath: 'id' })
                    itemStore.createIndex('feed_id', 'feed_id')
                    itemStore.createIndex('guid', ['feed_id', 'guid'], { unique: true })
                    itemStore.createIndex('is_read', 'is_read')
                    itemStore.createIndex('is_starred', 'is_starred')
                    itemStore.createIndex('pub_date', 'pub_date')
                    itemStore.createIndex('updated_at', 'updated_at')
                }

                // Sync state store
                if (!db.objectStoreNames.contains('sync_state')) {
                    db.createObjectStore('sync_state', { keyPath: 'id' })
                }
            }
        })
    }
    return dbPromise
}

/**
 * Local IndexedDB adapter implementation
 */
export const localAdapter: DbAdapter & {
    sync(): Promise<SyncResponse>
    getSyncState(): Promise<SyncState>
    isAvailable(): boolean
} = {
    /**
     * Check if IndexedDB is available
     */
    isAvailable (): boolean {
        return typeof indexedDB !== 'undefined'
    },

    async getFeeds (): Promise<Feed[]> {
        const db = await getDb()
        const feeds = await db.getAll('feeds')
        // Sort by title
        return feeds.sort((a, b) =>
            (a.title || '').localeCompare(b.title || '')
        )
    },

    async addFeed (url: string): Promise<Feed> {
        const db = await getDb()
        const now = new Date().toISOString()

        // Generate a temporary ID (will be replaced on sync)
        const tempId = Date.now()

        const feed: Feed = {
            id: tempId,
            url,
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            created_at: now,
            updated_at: now
        }

        await db.put('feeds', feed)
        return feed
    },

    async deleteFeed (id: number): Promise<void> {
        const db = await getDb()

        // Delete all items for this feed
        const tx = db.transaction(['feeds', 'items'], 'readwrite')
        const itemStore = tx.objectStore('items')
        const feedIdIndex = itemStore.index('feed_id')

        // Get all items for this feed and delete them
        let cursor = await feedIdIndex.openCursor(IDBKeyRange.only(id))
        while (cursor) {
            await cursor.delete()
            cursor = await cursor.continue()
        }

        // Delete the feed
        await tx.objectStore('feeds').delete(id)
        await tx.done
    },

    async getItems (options = {}): Promise<ItemsResponse> {
        const db = await getDb()
        const { feedId, isRead, isStarred, limit = 50, offset = 0 } = options

        // Get all items and filter in memory
        // (IndexedDB doesn't support complex queries)
        let items = await db.getAll('items')

        // Apply filters
        if (feedId !== undefined) {
            items = items.filter(i => i.feed_id === feedId)
        }
        if (isRead !== undefined) {
            items = items.filter(i => (i.is_read === 1) === isRead)
        }
        if (isStarred !== undefined) {
            items = items.filter(i => (i.is_starred === 1) === isStarred)
        }

        // Sort by pub_date descending
        items.sort((a, b) => {
            const dateA = a.pub_date || a.created_at || ''
            const dateB = b.pub_date || b.created_at || ''
            return dateB.localeCompare(dateA)
        })

        const total = items.length
        const paginated = items.slice(offset, offset + limit)

        return { items: paginated, total, limit, offset }
    },

    async getCounts (): Promise<CountsResponse> {
        const db = await getDb()
        const items = await db.getAll('items')

        return {
            unread: items.filter(i => i.is_read === 0).length,
            starred: items.filter(i => i.is_starred === 1).length,
            total: items.length
        }
    },

    async updateItem (
        id: number,
        updates: { is_read?: boolean; is_starred?: boolean }
    ): Promise<void> {
        const db = await getDb()
        const item = await db.get('items', id)

        if (item) {
            const now = new Date().toISOString()

            if (updates.is_read !== undefined) {
                item.is_read = updates.is_read ? 1 : 0
            }
            if (updates.is_starred !== undefined) {
                item.is_starred = updates.is_starred ? 1 : 0
            }
            item.updated_at = now

            await db.put('items', item)
        }
    },

    async markAllRead (feedId?: number): Promise<void> {
        const db = await getDb()
        const now = new Date().toISOString()

        const tx = db.transaction('items', 'readwrite')
        const store = tx.objectStore('items')

        let cursor = await store.openCursor()
        while (cursor) {
            const item = cursor.value
            if (feedId === undefined || item.feed_id === feedId) {
                if (item.is_read === 0) {
                    item.is_read = 1
                    item.updated_at = now
                    await cursor.update(item)
                }
            }
            cursor = await cursor.continue()
        }

        await tx.done
    },

    async getSyncState (): Promise<SyncState> {
        const db = await getDb()
        const state = await db.get('sync_state', 1)

        return {
            lastSyncedAt: state?.last_synced_at || null
        }
    },

    async sync (): Promise<SyncResponse> {
        const db = await getDb()

        // Get last sync time
        const syncState = await this.getSyncState()
        const since = syncState.lastSyncedAt

        // Build sync URL - use current origin, user is authenticated via session cookie
        const url = new URL('/api/collie/sync', window.location.origin)
        if (since) {
            url.searchParams.set('since', since)
        }

        // Fetch from remote - credentials included automatically for same-origin
        const response = await fetch(url.toString(), {
            method: 'GET',
            credentials: 'include'
        })

        if (!response.ok) {
            throw new Error(`Sync failed: ${response.status} ${response.statusText}`)
        }

        const data = await response.json() as SyncResponse

        // Upsert feeds
        const feedTx = db.transaction('feeds', 'readwrite')
        for (const feed of data.feeds) {
            await feedTx.store.put(feed)
        }
        await feedTx.done

        // Upsert items
        const itemTx = db.transaction('items', 'readwrite')
        for (const item of data.items) {
            await itemTx.store.put(item)
        }
        await itemTx.done

        // Update sync state
        await db.put('sync_state', {
            id: 1,
            last_synced_at: data.latestUpdatedAt
        })

        return data
    }
}
