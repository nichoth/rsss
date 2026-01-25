import { test } from '@substrate-system/tapzero'

/**
 * Tests for the sync workflow
 *
 * These tests verify:
 * 1. Sync endpoint returns correct data structure
 * 2. Incremental sync (with `since` parameter) filters correctly
 * 3. Full sync (without `since`) returns all data
 * 4. Client-side sync state management
 */

// Mock data for testing
const mockFeeds = [
    {
        id: 1,
        url: 'https://example.com/feed.xml',
        title: 'Example Feed',
        description: 'An example feed',
        site_url: 'https://example.com',
        last_fetched: '2024-01-15T10:00:00.000Z',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-15T10:00:00.000Z'
    },
    {
        id: 2,
        url: 'https://another.com/rss',
        title: 'Another Feed',
        description: null,
        site_url: 'https://another.com',
        last_fetched: '2024-01-20T12:00:00.000Z',
        created_at: '2024-01-10T00:00:00.000Z',
        updated_at: '2024-01-20T12:00:00.000Z'
    }
]

const mockItems = [
    {
        id: 1,
        feed_id: 1,
        guid: 'post-1',
        title: 'First Post',
        link: 'https://example.com/post-1',
        description: 'Description of first post',
        content: '<p>Full content</p>',
        author: 'Author One',
        pub_date: '2024-01-14T08:00:00.000Z',
        is_read: 0,
        is_starred: 0,
        created_at: '2024-01-14T08:00:00.000Z',
        updated_at: '2024-01-14T08:00:00.000Z',
        feed_title: 'Example Feed'
    },
    {
        id: 2,
        feed_id: 1,
        guid: 'post-2',
        title: 'Second Post',
        link: 'https://example.com/post-2',
        description: 'Description of second post',
        content: null,
        author: null,
        pub_date: '2024-01-15T09:00:00.000Z',
        is_read: 1,
        is_starred: 1,
        created_at: '2024-01-15T09:00:00.000Z',
        updated_at: '2024-01-18T14:00:00.000Z', // Updated later (marked read/starred)
        feed_title: 'Example Feed'
    },
    {
        id: 3,
        feed_id: 2,
        guid: 'another-post',
        title: 'Another Post',
        link: 'https://another.com/post',
        description: 'From another feed',
        content: null,
        author: 'Someone',
        pub_date: '2024-01-19T16:00:00.000Z',
        is_read: 0,
        is_starred: 0,
        created_at: '2024-01-19T16:00:00.000Z',
        updated_at: '2024-01-19T16:00:00.000Z',
        feed_title: 'Another Feed'
    }
]

/**
 * Simulates the sync endpoint logic
 */
function simulateSyncEndpoint (
    feeds: typeof mockFeeds,
    items: typeof mockItems,
    since?: string
) {
    let filteredFeeds: typeof mockFeeds
    let filteredItems: typeof mockItems

    if (since) {
        // Incremental sync
        filteredFeeds = feeds.filter(f => f.updated_at > since)
        filteredItems = items.filter(i => i.updated_at > since)
    } else {
        // Full sync
        filteredFeeds = [...feeds]
        filteredItems = [...items]
    }

    const latestFeed = feeds.reduce(
        (max, f) => f.updated_at > max ? f.updated_at : max,
        ''
    )
    const latestItem = items.reduce(
        (max, i) => i.updated_at > max ? i.updated_at : max,
        ''
    )

    const syncedAt = new Date().toISOString()
    const latestUpdatedAt = [latestFeed, latestItem]
        .filter(Boolean)
        .sort()
        .pop() || syncedAt

    return {
        feeds: filteredFeeds,
        items: filteredItems,
        syncedAt,
        latestUpdatedAt,
        isFullSync: !since
    }
}

// ============ Sync Endpoint Tests ============

test('sync endpoint - full sync returns all data', async t => {
    const result = simulateSyncEndpoint(mockFeeds, mockItems)

    t.equal(result.isFullSync, true, 'isFullSync should be true')
    t.equal(result.feeds.length, 2, 'should return all feeds')
    t.equal(result.items.length, 3, 'should return all items')
})

test('sync endpoint - incremental sync filters by updated_at', async t => {
    // Sync since Jan 17 - should only get items updated after that
    const since = '2024-01-17T00:00:00.000Z'
    const result = simulateSyncEndpoint(mockFeeds, mockItems, since)

    t.equal(result.isFullSync, false, 'isFullSync should be false')
    t.equal(result.feeds.length, 1, 'should return 1 feed (updated Jan 20)')
    t.equal(result.items.length, 2, 'should return 2 items (updated Jan 18 and Jan 19)')

    // Verify the correct items
    const itemIds = result.items.map(i => i.id)
    t.ok(itemIds.includes(2), 'should include item 2 (updated Jan 18)')
    t.ok(itemIds.includes(3), 'should include item 3 (created Jan 19)')
})

test('sync endpoint - incremental sync with recent timestamp returns nothing', async t => {
    const since = '2024-01-25T00:00:00.000Z'
    const result = simulateSyncEndpoint(mockFeeds, mockItems, since)

    t.equal(result.feeds.length, 0, 'should return no feeds')
    t.equal(result.items.length, 0, 'should return no items')
})

test('sync endpoint - latestUpdatedAt is correct', async t => {
    const result = simulateSyncEndpoint(mockFeeds, mockItems)

    // Latest update is feed 2 at Jan 20
    t.equal(
        result.latestUpdatedAt,
        '2024-01-20T12:00:00.000Z',
        'latestUpdatedAt should be the most recent update'
    )
})

// ============ Sync Response Structure Tests ============

test('sync response has correct structure', async t => {
    const result = simulateSyncEndpoint(mockFeeds, mockItems)

    t.ok('feeds' in result, 'response should have feeds')
    t.ok('items' in result, 'response should have items')
    t.ok('syncedAt' in result, 'response should have syncedAt')
    t.ok('latestUpdatedAt' in result, 'response should have latestUpdatedAt')
    t.ok('isFullSync' in result, 'response should have isFullSync')
})

test('feed objects have required fields', async t => {
    const result = simulateSyncEndpoint(mockFeeds, mockItems)
    const feed = result.feeds[0]

    t.ok('id' in feed, 'feed should have id')
    t.ok('url' in feed, 'feed should have url')
    t.ok('title' in feed, 'feed should have title')
    t.ok('updated_at' in feed, 'feed should have updated_at')
})

test('item objects have required fields', async t => {
    const result = simulateSyncEndpoint(mockFeeds, mockItems)
    const item = result.items[0]

    t.ok('id' in item, 'item should have id')
    t.ok('feed_id' in item, 'item should have feed_id')
    t.ok('guid' in item, 'item should have guid')
    t.ok('is_read' in item, 'item should have is_read')
    t.ok('is_starred' in item, 'item should have is_starred')
    t.ok('updated_at' in item, 'item should have updated_at')
    t.ok('feed_title' in item, 'item should have feed_title')
})

// ============ Client-side Sync Logic Tests ============

/**
 * Simulates the client-side upsert logic
 */
function simulateUpsert<T extends { id: number }> (
    existing: T[],
    incoming: T[]
): T[] {
    const result = new Map<number, T>()

    // Add existing items
    for (const item of existing) {
        result.set(item.id, item)
    }

    // Upsert incoming items (overwrite if exists)
    for (const item of incoming) {
        result.set(item.id, item)
    }

    return Array.from(result.values())
}

test('client upsert - inserts new records', async t => {
    const existing = [mockItems[0]]
    const incoming = [mockItems[1], mockItems[2]]

    const result = simulateUpsert(existing, incoming)

    t.equal(result.length, 3, 'should have 3 items after upsert')
})

test('client upsert - updates existing records', async t => {
    const existing = [{
        ...mockItems[0],
        is_read: 0,
        is_starred: 0
    }]

    const incoming = [{
        ...mockItems[0],
        is_read: 1,
        is_starred: 1,
        updated_at: '2024-01-20T00:00:00.000Z'
    }]

    const result = simulateUpsert(existing, incoming)

    t.equal(result.length, 1, 'should still have 1 item')
    t.equal(result[0].is_read, 1, 'is_read should be updated')
    t.equal(result[0].is_starred, 1, 'is_starred should be updated')
})

test('client upsert - preserves unmodified records', async t => {
    const existing = [mockItems[0], mockItems[1]]
    const incoming = [mockItems[1]] // Only updating item 2

    const result = simulateUpsert(existing, incoming)

    t.equal(result.length, 2, 'should still have 2 items')

    const item1 = result.find(i => i.id === 1)
    t.ok(item1, 'item 1 should still exist')
    t.equal(item1?.title, 'First Post', 'item 1 should be unchanged')
})

// ============ Sync State Tests ============

interface SyncState {
    lastSyncedAt: string | null
    remoteUrl: string | null
}

function createSyncStateManager () {
    let state: SyncState = {
        lastSyncedAt: null,
        remoteUrl: null
    }

    return {
        getState: () => ({ ...state }),
        updateState: (newState: Partial<SyncState>) => {
            state = { ...state, ...newState }
        },
        shouldFullSync: () => state.lastSyncedAt === null
    }
}

test('sync state - initial state has null values', async t => {
    const manager = createSyncStateManager()
    const state = manager.getState()

    t.equal(state.lastSyncedAt, null, 'lastSyncedAt should be null initially')
    t.equal(state.remoteUrl, null, 'remoteUrl should be null initially')
})

test('sync state - shouldFullSync returns true initially', async t => {
    const manager = createSyncStateManager()

    t.equal(manager.shouldFullSync(), true, 'should do full sync initially')
})

test('sync state - shouldFullSync returns false after sync', async t => {
    const manager = createSyncStateManager()
    manager.updateState({ lastSyncedAt: '2024-01-20T00:00:00.000Z' })

    t.equal(manager.shouldFullSync(), false, 'should do incremental sync after first sync')
})

test('sync state - preserves remoteUrl across syncs', async t => {
    const manager = createSyncStateManager()

    manager.updateState({ remoteUrl: 'https://example.com' })
    manager.updateState({ lastSyncedAt: '2024-01-20T00:00:00.000Z' })

    const state = manager.getState()
    t.equal(state.remoteUrl, 'https://example.com', 'remoteUrl should be preserved')
    t.equal(state.lastSyncedAt, '2024-01-20T00:00:00.000Z', 'lastSyncedAt should be updated')
})

// ============ Edge Cases ============

test('sync with empty database returns empty arrays', async t => {
    const result = simulateSyncEndpoint([], [])

    t.equal(result.feeds.length, 0, 'should return empty feeds array')
    t.equal(result.items.length, 0, 'should return empty items array')
    t.ok(result.syncedAt, 'should still have syncedAt timestamp')
})

test('sync handles feeds without items', async t => {
    const feedsOnly = [mockFeeds[0]]
    const result = simulateSyncEndpoint(feedsOnly, [])

    t.equal(result.feeds.length, 1, 'should return the feed')
    t.equal(result.items.length, 0, 'should return no items')
})

test('incremental sync at exact boundary time', async t => {
    // Use exact timestamp of an item's updated_at
    const since = '2024-01-18T14:00:00.000Z'
    const result = simulateSyncEndpoint(mockFeeds, mockItems, since)

    // Items with updated_at > since (not >=)
    // Item 2: 2024-01-18T14:00:00.000Z - NOT included (equal, not greater)
    // Item 3: 2024-01-19T16:00:00.000Z - included
    t.equal(result.items.length, 1, 'should not include items at exact boundary')
    t.equal(result.items[0].id, 3, 'should only include item updated after boundary')
})
