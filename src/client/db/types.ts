/**
 * Shared types for database operations
 */

export interface Feed {
    id: number
    url: string
    title: string | null
    description: string | null
    site_url: string | null
    last_fetched: string | null
    created_at: string
    updated_at: string
}

export interface Item {
    id: number
    feed_id: number
    guid: string
    title: string | null
    link: string | null
    description: string | null
    content: string | null
    author: string | null
    pub_date: string | null
    is_read: number
    is_starred: number
    created_at: string
    updated_at: string
    feed_title?: string
}

export interface SyncState {
    lastSyncedAt: string | null
    remoteUrl: string | null
}

export interface SyncResponse {
    feeds: Feed[]
    items: Item[]
    syncedAt: string
    latestUpdatedAt: string
    isFullSync: boolean
}

export interface ItemsResponse {
    items: Item[]
    total: number
    limit: number
    offset: number
}

export interface CountsResponse {
    unread: number
    starred: number
    total: number
}

/**
 * Database adapter interface - implemented by both remote API and local SQLite
 */
export interface DbAdapter {
    // Feeds
    getFeeds(): Promise<Feed[]>
    addFeed(url: string): Promise<Feed>
    deleteFeed(id: number): Promise<void>

    // Items
    getItems(options?: {
        feedId?: number
        isRead?: boolean
        isStarred?: boolean
        limit?: number
        offset?: number
    }): Promise<ItemsResponse>
    getCounts(): Promise<CountsResponse>
    updateItem(id: number, updates: { is_read?: boolean; is_starred?: boolean }): Promise<void>
    markAllRead(feedId?: number): Promise<void>

    // Sync (only for local adapter)
    sync?(remoteUrl: string): Promise<SyncResponse>
    getSyncState?(): Promise<SyncState>
}
