import { test } from '@substrate-system/tapzero'
import type {
    DbAdapter,
    Feed,
    FeedsResponse,
    Item,
    ItemsResponse,
    CountsResponse
} from '../src/client/db/types.js'
import { TABLES_SQL } from '../src/shared/schema.js'
import { linkMatchesItemRoute } from '../src/shared/item-route.js'

/**
 * Tests for the database adapter interface
 *
 * These tests verify that the adapter (remote or local)
 * correctly implements the DbAdapter interface contract.
 */

// Mock in-memory adapter for testing the interface contract
function createMockAdapter ():DbAdapter & {
    _feeds:Feed[]
    _items:Item[]
    } {
    const feeds:Feed[] = []
    const items:Item[] = []
    let nextFeedId = 1

    return {
        _feeds: feeds,
        _items: items,

        async getFeeds ():Promise<FeedsResponse> {
            return {
                feeds: [...feeds].sort((a, b) =>
                    (a.title || '').localeCompare(b.title || '')
                )
            }
        },

        async addFeed (url:string):Promise<Feed> {
            const now = new Date().toISOString()
            const feed:Feed = {
                id: nextFeedId++,
                url,
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: now,
                updated_at: now
            }
            feeds.push(feed)
            return feed
        },

        async deleteFeed (id: number): Promise<void> {
            const index = feeds.findIndex(f => f.id === id)
            if (index !== -1) {
                feeds.splice(index, 1)
                // Also delete associated items
                for (let i = items.length - 1; i >= 0; i--) {
                    if (items[i].feed_id === id) {
                        items.splice(i, 1)
                    }
                }
            }
        },

        async getItems (options = {}): Promise<ItemsResponse> {
            const { feedId, isRead, isStarred, limit = 50, offset = 0 } = options

            let filtered = [...items]

            if (feedId !== undefined) {
                filtered = filtered.filter(i => i.feed_id === feedId)
            }
            if (isRead !== undefined) {
                filtered = filtered.filter(i => (i.is_read === 1) === isRead)
            }
            if (isStarred !== undefined) {
                filtered = filtered.filter(i => (i.is_starred === 1) === isStarred)
            }

            // Sort by pub_date desc
            filtered.sort((a, b) => {
                const dateA = a.pub_date || ''
                const dateB = b.pub_date || ''
                return dateB.localeCompare(dateA)
            })

            const total = filtered.length
            const paginated = filtered.slice(offset, offset + limit)

            return { items: paginated, total, limit, offset }
        },

        async getItemByRoute (itemRoute:string): Promise<Item|null> {
            const item = items.find((entry) =>
                linkMatchesItemRoute(entry.link, itemRoute)
            )
            return item || null
        },

        async getCounts (): Promise<CountsResponse> {
            const perFeed:Record<string, number> = {}
            for (const item of items) {
                if (item.is_read === 0) {
                    const key = String(item.feed_id)
                    perFeed[key] = (perFeed[key] ?? 0) + 1
                }
            }
            return {
                unread: items.filter(i => i.is_read === 0).length,
                starred: items.filter(i => i.is_starred === 1).length,
                total: items.length,
                perFeed
            }
        },

        async updateItem (
            id: number,
            updates: { is_read?: boolean; is_starred?: boolean }
        ): Promise<void> {
            const item = items.find(i => i.id === id)
            if (item) {
                if (updates.is_read !== undefined) {
                    item.is_read = updates.is_read ? 1 : 0
                }
                if (updates.is_starred !== undefined) {
                    item.is_starred = updates.is_starred ? 1 : 0
                }
                item.updated_at = new Date().toISOString()
            }
        },

        async markAllRead (feedId?: number): Promise<void> {
            const now = new Date().toISOString()
            for (const item of items) {
                if (feedId === undefined || item.feed_id === feedId) {
                    item.is_read = 1
                    item.updated_at = now
                }
            }
        }
    }
}

// Helper to add items to the mock adapter
function addMockItem (
    adapter: ReturnType<typeof createMockAdapter>,
    feedId: number,
    overrides: Partial<Item> = {}
): Item {
    const now = new Date().toISOString()
    const item: Item = {
        id: adapter._items.length + 1,
        feed_id: feedId,
        guid: `guid-${adapter._items.length + 1}`,
        title: `Item ${adapter._items.length + 1}`,
        link: `https://example.com/item-${adapter._items.length + 1}`,
        description: 'Description',
        content: null,
        author: null,
        pub_date: now,
        thumbnail_url: null,
        is_read: 0,
        is_starred: 0,
        created_at: now,
        updated_at: now,
        feed_title: 'Test Feed',
        ...overrides
    }
    adapter._items.push(item)
    return item
}

// ============ Feed Operations Tests ============

test('schema - items table includes thumbnail_url after pub_date', t => {
    const pubDateIndex = TABLES_SQL.indexOf('pub_date TEXT')
    const thumbnailIndex = TABLES_SQL.indexOf('thumbnail_url TEXT')
    const isReadIndex = TABLES_SQL.indexOf('is_read INTEGER DEFAULT 0')

    t.ok(thumbnailIndex !== -1, 'items table should include thumbnail_url')
    t.ok(
        pubDateIndex < thumbnailIndex && thumbnailIndex < isReadIndex,
        'thumbnail_url should be between pub_date and is_read'
    )
})

test('types - Item includes nullable thumbnail_url', t => {
    const item = addMockItem(createMockAdapter(), 1, {
        thumbnail_url: 'https://example.com/thumb.jpg'
    })

    t.equal(
        item.thumbnail_url,
        'https://example.com/thumb.jpg',
        'item exposes thumbnail_url'
    )
})

test('adapter - addFeed creates a new feed', async t => {
    const adapter = createMockAdapter()

    const feed = await adapter.addFeed('https://example.com/feed.xml')

    t.ok(feed.id, 'feed should have an id')
    t.equal(feed.url, 'https://example.com/feed.xml', 'feed should have correct url')
    t.ok(feed.created_at, 'feed should have created_at')
    t.ok(feed.updated_at, 'feed should have updated_at')
})

test('adapter - getFeeds returns all feeds sorted by title', async t => {
    const adapter = createMockAdapter()

    await adapter.addFeed('https://z-site.com/feed')
    await adapter.addFeed('https://a-site.com/feed')

    // Manually set titles for sorting test
    adapter._feeds[0].title = 'Zebra Feed'
    adapter._feeds[1].title = 'Alpha Feed'

    const { feeds } = await adapter.getFeeds()

    t.equal(feeds.length, 2, 'should return 2 feeds')
    t.equal(feeds[0].title, 'Alpha Feed', 'feeds should be sorted by title')
    t.equal(feeds[1].title, 'Zebra Feed', 'feeds should be sorted by title')
})

test('adapter - deleteFeed removes feed and associated items', async t => {
    const adapter = createMockAdapter()

    const feed = await adapter.addFeed('https://example.com/feed')
    addMockItem(adapter, feed.id)
    addMockItem(adapter, feed.id)

    t.equal(adapter._items.length, 2, 'should have 2 items before delete')

    await adapter.deleteFeed(feed.id)

    const { feeds } = await adapter.getFeeds()
    const { items } = await adapter.getItems()

    t.equal(feeds.length, 0, 'feed should be deleted')
    t.equal(items.length, 0, 'associated items should be deleted')
})

// ============ Item Operations Tests ============

test('adapter - getItems returns items with pagination', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')

    // Add 5 items
    for (let i = 0; i < 5; i++) {
        addMockItem(adapter, feed.id)
    }

    const page1 = await adapter.getItems({ limit: 2, offset: 0 })
    const page2 = await adapter.getItems({ limit: 2, offset: 2 })

    t.equal(page1.items.length, 2, 'page 1 should have 2 items')
    t.equal(page1.total, 5, 'total should be 5')
    t.equal(page2.items.length, 2, 'page 2 should have 2 items')
    t.equal(page2.offset, 2, 'page 2 offset should be 2')
})

test('adapter - getItems filters by feedId', async t => {
    const adapter = createMockAdapter()
    const feed1 = await adapter.addFeed('https://site1.com/feed')
    const feed2 = await adapter.addFeed('https://site2.com/feed')

    addMockItem(adapter, feed1.id)
    addMockItem(adapter, feed1.id)
    addMockItem(adapter, feed2.id)

    const result = await adapter.getItems({ feedId: feed1.id })

    t.equal(result.items.length, 2, 'should return only items from feed1')
    t.ok(
        result.items.every(i => i.feed_id === feed1.id),
        'all items should belong to feed1'
    )
})

test('adapter - getItems filters by isRead', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')

    addMockItem(adapter, feed.id, { is_read: 0 })
    addMockItem(adapter, feed.id, { is_read: 1 })
    addMockItem(adapter, feed.id, { is_read: 0 })

    const unread = await adapter.getItems({ isRead: false })
    const read = await adapter.getItems({ isRead: true })

    t.equal(unread.items.length, 2, 'should return 2 unread items')
    t.equal(read.items.length, 1, 'should return 1 read item')
})

test('adapter - getItems filters by isStarred', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')

    addMockItem(adapter, feed.id, { is_starred: 0 })
    addMockItem(adapter, feed.id, { is_starred: 1 })

    const starred = await adapter.getItems({ isStarred: true })

    t.equal(starred.items.length, 1, 'should return 1 starred item')
    t.equal(starred.items[0].is_starred, 1, 'item should be starred')
})

test('adapter - getItemByRoute finds a matching item', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')
    addMockItem(adapter, feed.id, {
        link: 'https://example.com/post/alpha'
    })

    const item = await adapter.getItemByRoute(
        'example.com/post/alpha'
    )

    t.ok(item, 'should return the matched item')
    t.equal(
        item?.link,
        'https://example.com/post/alpha',
        'should return the right link'
    )
})

// ============ Update Operations Tests ============

test('adapter - updateItem marks item as read', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')
    const item = addMockItem(adapter, feed.id, { is_read: 0 })

    await adapter.updateItem(item.id, { is_read: true })

    const { items } = await adapter.getItems()
    t.equal(items[0].is_read, 1, 'item should be marked as read')
})

test('adapter - updateItem toggles starred', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')
    const item = addMockItem(adapter, feed.id, { is_starred: 0 })

    await adapter.updateItem(item.id, { is_starred: true })

    const { items } = await adapter.getItems()
    t.equal(items[0].is_starred, 1, 'item should be starred')

    await adapter.updateItem(item.id, { is_starred: false })

    const { items: updated } = await adapter.getItems()
    t.equal(updated[0].is_starred, 0, 'item should be unstarred')
})

test('adapter - updateItem updates updated_at timestamp', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')
    const item = addMockItem(adapter, feed.id)
    const originalUpdatedAt = item.updated_at

    // Wait a tiny bit to ensure timestamp changes
    await new Promise(resolve => setTimeout(resolve, 10))

    await adapter.updateItem(item.id, { is_read: true })

    t.notEqual(
        adapter._items[0].updated_at,
        originalUpdatedAt,
        'updated_at should change after update'
    )
})

test('adapter - markAllRead marks all items as read', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')

    addMockItem(adapter, feed.id, { is_read: 0 })
    addMockItem(adapter, feed.id, { is_read: 0 })
    addMockItem(adapter, feed.id, { is_read: 0 })

    await adapter.markAllRead()

    const { items } = await adapter.getItems()
    t.ok(
        items.every(i => i.is_read === 1),
        'all items should be marked as read'
    )
})

test('adapter - markAllRead with feedId only marks that feed', async t => {
    const adapter = createMockAdapter()
    const feed1 = await adapter.addFeed('https://site1.com/feed')
    const feed2 = await adapter.addFeed('https://site2.com/feed')

    addMockItem(adapter, feed1.id, { is_read: 0 })
    addMockItem(adapter, feed1.id, { is_read: 0 })
    addMockItem(adapter, feed2.id, { is_read: 0 })

    await adapter.markAllRead(feed1.id)

    const feed1Items = await adapter.getItems({ feedId: feed1.id })
    const feed2Items = await adapter.getItems({ feedId: feed2.id })

    t.ok(
        feed1Items.items.every(i => i.is_read === 1),
        'feed1 items should be marked as read'
    )
    t.ok(
        feed2Items.items.every(i => i.is_read === 0),
        'feed2 items should still be unread'
    )
})

// ============ Counts Tests ============

test('adapter - getCounts returns correct counts', async t => {
    const adapter = createMockAdapter()
    const feed = await adapter.addFeed('https://example.com/feed')

    addMockItem(adapter, feed.id, { is_read: 0, is_starred: 0 })
    addMockItem(adapter, feed.id, { is_read: 0, is_starred: 1 })
    addMockItem(adapter, feed.id, { is_read: 1, is_starred: 0 })
    addMockItem(adapter, feed.id, { is_read: 1, is_starred: 1 })

    const counts = await adapter.getCounts()

    t.equal(counts.total, 4, 'total should be 4')
    t.equal(counts.unread, 2, 'unread should be 2')
    t.equal(counts.starred, 2, 'starred should be 2')
})

test('adapter - getCounts with empty database', async t => {
    const adapter = createMockAdapter()

    const counts = await adapter.getCounts()

    t.equal(counts.total, 0, 'total should be 0')
    t.equal(counts.unread, 0, 'unread should be 0')
    t.equal(counts.starred, 0, 'starred should be 0')
    t.deepEqual(
        counts.perFeed,
        {},
        'perFeed should be {} on an empty database'
    )
})

// ============ perFeed Tests ============

test('adapter - getCounts perFeed is keyed by stringified feed_id', async t => {
    const adapter = createMockAdapter()
    const f1 = await adapter.addFeed('https://site1.com/feed')
    const f2 = await adapter.addFeed('https://site2.com/feed')

    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f2.id, { is_read: 0 })

    const counts = await adapter.getCounts()

    t.ok(
        counts.perFeed && typeof counts.perFeed === 'object',
        'perFeed is an object'
    )
    t.equal(
        counts.perFeed[String(f1.id)],
        2,
        'perFeed[String(f1.id)] is 2'
    )
    t.equal(
        counts.perFeed[String(f2.id)],
        1,
        'perFeed[String(f2.id)] is 1'
    )
    t.equal(
        typeof counts.perFeed[String(f1.id)],
        'number',
        'perFeed values are numbers'
    )
})

test('adapter - getCounts perFeed drops as items are marked read', async t => {
    const adapter = createMockAdapter()
    const f1 = await adapter.addFeed('https://site1.com/feed')
    const f2 = await adapter.addFeed('https://site2.com/feed')

    const i1 = addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f2.id, { is_read: 0 })

    const before = await adapter.getCounts()
    t.equal(before.perFeed[String(f1.id)], 2, 'f1 starts with 2 unread')

    await adapter.updateItem(i1.id, { is_read: true })

    const after = await adapter.getCounts()
    t.equal(after.perFeed[String(f1.id)], 1, 'f1 drops to 1 after mark-read')
    t.equal(after.perFeed[String(f2.id)], 1, 'f2 unchanged')
})

test('adapter - getCounts perFeed sum equals unread', async t => {
    const adapter = createMockAdapter()
    const f1 = await adapter.addFeed('https://site1.com/feed')
    const f2 = await adapter.addFeed('https://site2.com/feed')
    const f3 = await adapter.addFeed('https://site3.com/feed')

    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f1.id, { is_read: 1 })
    addMockItem(adapter, f2.id, { is_read: 0 })
    addMockItem(adapter, f3.id, { is_read: 1 })

    const counts = await adapter.getCounts()

    const sum = Object.values(counts.perFeed).reduce(
        (a, b) => a + b,
        0
    )
    t.equal(
        sum,
        counts.unread,
        'Object.values(perFeed).reduce sum === unread'
    )
})

test('adapter - getCounts omits feeds with zero unread', async t => {
    const adapter = createMockAdapter()
    const f1 = await adapter.addFeed('https://site1.com/feed')
    const f2 = await adapter.addFeed('https://site2.com/feed')

    addMockItem(adapter, f1.id, { is_read: 0 })
    addMockItem(adapter, f2.id, { is_read: 1 })

    const counts = await adapter.getCounts()

    t.equal(counts.perFeed[String(f1.id)], 1, 'f1 present in perFeed')
    t.equal(
        counts.perFeed[String(f2.id)],
        undefined,
        'f2 absent from perFeed when zero unread'
    )
    t.ok(
        !(String(f2.id) in counts.perFeed),
        'feeds with zero unread are absent (not present as 0)'
    )
})
