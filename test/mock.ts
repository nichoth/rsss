export const mockFeeds = [
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

export const mockItems = [
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
        thumbnail_url: 'https://cdn.example.com/post-1.jpg',
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
        thumbnail_url: null,
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
        thumbnail_url: null,
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
export function simulateSyncEndpoint (
    feeds:typeof mockFeeds,
    items:typeof mockItems,
    since?:string
) {
    let filteredFeeds:typeof mockFeeds
    let filteredItems:typeof mockItems

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
