import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

const pollerStorage = new Map<string, unknown>()

;(UserDO.prototype as unknown as {
    ctx:{
        storage:{
            get:<T>(key:string) => Promise<T|undefined>
            put:(key:string, value:unknown) => Promise<void>
            delete:(key:string) => Promise<void>
        }
    }
}).ctx = {
    storage: {
        async get<T> (key:string) {
            return pollerStorage.get(key) as T|undefined
        },
        async put (key:string, value:unknown) {
            pollerStorage.set(key, value)
        },
        async delete (key:string) {
            pollerStorage.delete(key)
        }
    }
}

interface ParsedFeed {
    title:string|null
    description:string|null
    link:string|null
    isTooLarge?:boolean
    items:Array<{
        guid:string|null
        title:string|null
        link:string|null
        description:string|null
        content:string|null
        author:string|null
        pubDate:string|null
        imageUrl:string|null
    }>
}

function parseFeed (xml:string):ParsedFeed {
    const parser = Object.create(UserDO.prototype) as {
        parseFeed:(value:string) => ParsedFeed
    }

    return parser.parseFeed(xml)
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

async function blurhashKeyFor (imageUrl:string):Promise<string> {
    const encoded = new TextEncoder().encode(imageUrl)
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    const bytes = Array.from(new Uint8Array(digest))
    const hex = bytes.map(byte => {
        return byte.toString(16).padStart(2, '0')
    }).join('')

    return `blurhash:${hex.slice(0, 32)}`
}

function itemXml (index:number, content = 'body'):string {
    return `
        <item>
            <guid>item-${index}</guid>
            <title>Item ${index}</title>
            <description>Description ${index}</description>
            <content:encoded><![CDATA[${content}]]></content:encoded>
        </item>
    `
}

function rssFeed (items:string):string {
    return `
        <rss version="2.0"
            xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel>
                <title>Example RSS</title>
                <description>RSS description</description>
                <link>https://example.com/</link>
                ${items}
            </channel>
        </rss>
    `
}

test('parseFeed reads RSS namespaced item fields', t => {
    const feed = parseFeed(`
        <rss version="2.0"
            xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:media="http://search.yahoo.com/mrss/"
            xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel>
                <title>Example RSS</title>
                <description>RSS description</description>
                <link>https://example.com/</link>
                <item>
                    <guid>item-1</guid>
                    <media:title>Namespaced title</media:title>
                    <link>https://example.com/post/1</link>
                    <dc:creator>Jane Author</dc:creator>
                    <content:encoded><![CDATA[
                        <p>Full text</p>
                    ]]></content:encoded>
                </item>
            </channel>
        </rss>
    `)

    t.equal(feed.title, 'Example RSS', 'feed title is parsed')
    t.equal(feed.items.length, 1, 'one item is parsed')
    t.equal(feed.items[0]?.title, 'Namespaced title', 'media:title is parsed')
    t.equal(feed.items[0]?.author, 'Jane Author', 'dc:creator is parsed')
    t.equal(feed.items[0]?.content, '<p>Full text</p>', 'content is parsed')
})

test('parseFeed extracts RSS media and enclosure image hints', t => {
    const feed = parseFeed(`
        <rss version="2.0"
            xmlns:media="http://search.yahoo.com/mrss/">
            <channel>
                <title>Example RSS</title>
                <link>https://example.com/feed/</link>
                <item>
                    <guid>item-1</guid>
                    <link>https://example.com/posts/1</link>
                    <media:thumbnail url="/thumb.jpg" />
                </item>
                <item>
                    <guid>item-2</guid>
                    <link>https://example.com/posts/2</link>
                    <media:content
                        medium="image"
                        url="https://cdn.example.com/media.jpg" />
                </item>
                <item>
                    <guid>item-3</guid>
                    <link>https://example.com/posts/3</link>
                    <enclosure
                        type="image/png"
                        url="https://cdn.example.com/enclosure.png" />
                </item>
                <item>
                    <guid>item-4</guid>
                    <link>https://example.com/posts/4</link>
                    <enclosure
                        type="audio/mpeg"
                        url="https://cdn.example.com/audio.mp3" />
                    <description><![CDATA[
                        <p><img alt="" src="../inline.webp"></p>
                    ]]></description>
                </item>
            </channel>
        </rss>
    `)

    t.equal(
        feed.items[0]?.imageUrl,
        'https://example.com/thumb.jpg',
        'RSS media:thumbnail is resolved against item link'
    )
    t.equal(
        feed.items[1]?.imageUrl,
        'https://cdn.example.com/media.jpg',
        'RSS media:content image is extracted'
    )
    t.equal(
        feed.items[2]?.imageUrl,
        'https://cdn.example.com/enclosure.png',
        'RSS image enclosure is extracted'
    )
    t.equal(
        feed.items[3]?.imageUrl,
        'https://example.com/inline.webp',
        'RSS non-image enclosure is ignored before img fallback'
    )
})

test('parseFeed extracts Atom enclosure and content image hints', t => {
    const feed = parseFeed(`
        <feed xmlns="http://www.w3.org/2005/Atom"
            xmlns:media="http://search.yahoo.com/mrss/">
            <title>Example Atom</title>
            <link href="https://example.com/feed/" rel="alternate" />
            <entry>
                <id>tag:example.com,2026:1</id>
                <link href="https://example.com/atom/1" rel="alternate" />
                <media:thumbnail url="/atom-thumb.jpg" />
            </entry>
            <entry>
                <id>tag:example.com,2026:2</id>
                <link href="https://example.com/atom/2" rel="alternate" />
                <link
                    rel="enclosure"
                    type="image/jpeg"
                    href="https://cdn.example.com/atom.jpg" />
            </entry>
            <entry>
                <id>tag:example.com,2026:3</id>
                <link href="https://example.com/atom/3" rel="alternate" />
                <content><![CDATA[
                    <figure><img src="//cdn.example.com/content.png"></figure>
                ]]></content>
            </entry>
            <entry>
                <id>tag:example.com,2026:4</id>
                <link href="https://example.com/atom/4" rel="alternate" />
                <link
                    rel="enclosure"
                    type="video/mp4"
                    href="https://cdn.example.com/video.mp4" />
            </entry>
        </feed>
    `)

    t.equal(
        feed.items[0]?.imageUrl,
        'https://example.com/atom-thumb.jpg',
        'Atom media:thumbnail is resolved'
    )
    t.equal(
        feed.items[1]?.imageUrl,
        'https://cdn.example.com/atom.jpg',
        'Atom image enclosure is extracted'
    )
    t.equal(
        feed.items[2]?.imageUrl,
        'https://cdn.example.com/content.png',
        'Atom content img is extracted'
    )
    t.equal(
        feed.items[3]?.imageUrl,
        null,
        'Atom non-image enclosure is ignored'
    )
})

test('parseFeed reads Atom entries with attributes', t => {
    const feed = parseFeed(`
        <feed xmlns="http://www.w3.org/2005/Atom">
            <title>Example Atom</title>
            <subtitle>Atom description</subtitle>
            <link href="https://example.com/" rel="alternate" />
            <entry xml:lang="en">
                <id>tag:example.com,2026:1</id>
                <title>Atom entry</title>
                <link href="https://example.com/atom/1" rel="alternate" />
                <summary>Summary text</summary>
                <author><name>Atom Author</name></author>
                <updated>2026-04-25T12:00:00Z</updated>
            </entry>
        </feed>
    `)

    t.equal(feed.title, 'Example Atom', 'feed title is parsed')
    t.equal(feed.description, 'Atom description', 'subtitle is parsed')
    t.equal(feed.link, 'https://example.com/', 'feed link is parsed')
    t.equal(feed.items.length, 1, 'one Atom entry is parsed')
    t.equal(feed.items[0]?.title, 'Atom entry', 'entry title is parsed')
    t.equal(feed.items[0]?.link, 'https://example.com/atom/1', 'link parsed')
    t.equal(feed.items[0]?.author, 'Atom Author', 'author is parsed')
})

test('parseFeed caps hostile RSS item count before insertion', t => {
    const feed = parseFeed(rssFeed(
        Array.from({ length: 5000 }, (_value, index) => {
            return itemXml(index + 1)
        }).join('')
    ))

    t.equal(feed.items.length, 1000, 'only 1000 items are parsed')
    t.equal(feed.items[999]?.guid, 'item-1000', 'excess items are truncated')
    t.equal(feed.isTooLarge, true, 'truncated item count is flagged')
})

test('parseFeed truncates oversized content fields', t => {
    const oversizedContent = 'x'.repeat((4 * 1024 * 1024) + 17)
    const feed = parseFeed(rssFeed(itemXml(1, oversizedContent)))

    t.equal(
        feed.items[0]?.content?.length,
        1024 * 1024,
        'content is capped at 1 MB'
    )
    t.equal(feed.isTooLarge, true, 'truncated content is flagged')
})

test('fetchFeed records feed too large when parsed rows are truncated',
    async t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => []
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        let inserted = 0
        let feedTooLargeUpdate:null | {
            error:unknown
            status:unknown
            id:unknown
        } = null

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    inserted++
                    return { toArray: () => [] }
                }

                if (query.includes('last_error = ?') &&
                    query.includes('last_status = ?')) {
                    feedTooLargeUpdate = {
                        error: params[0],
                        status: params[1],
                        id: params[2]
                    }
                    return { toArray: () => [] }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            return new Response(rssFeed(
                Array.from({ length: 5000 }, (_value, index) => {
                    return itemXml(index + 1)
                }).join('')
            ))
        }

        try {
            await userDo.fetchFeed({
                id: 3,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.equal(inserted, 1000, 'only capped items are inserted')
        t.deepEqual(
            feedTooLargeUpdate,
            {
                error: 'feed too large',
                status: 413,
                id: 3
            },
            'feed row records the truncation warning'
        )
    })

test('fetchFeed stores og image for newly inserted items', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    let itemImageUpdate:null | {
        thumbnail:unknown
        ogImage:unknown
        id:unknown
    } = null

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 1, toArray: () => [] }
            }

            if (query.includes('SELECT id FROM items')) {
                return {
                    toArray: () => [],
                    one: () => ({ id: 42 })
                }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('og_image_url')) {
                itemImageUpdate = {
                    thumbnail: params[0],
                    ogImage: params[1],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        if (urlText === 'https://example.com/post/1') {
            throw new Error('feed image should avoid article fetch')
        }

        return new Response(`
            <rss version="2.0"
                xmlns:media="http://search.yahoo.com/mrss/">
                <channel>
                    <title>Example RSS</title>
                    <link>https://example.com/</link>
                    <item>
                        <guid>item-1</guid>
                        <title>Item 1</title>
                        <link>https://example.com/post/1</link>
                        <media:thumbnail
                            url="https://cdn.example.com/parser.jpg" />
                    </item>
                </channel>
            </rss>
        `)
    }

    try {
        await userDo.fetchFeed({
            id: 5,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
    }

    t.deepEqual(
        itemImageUpdate,
        {
            thumbnail: 'https://cdn.example.com/parser.jpg',
            ogImage: 'https://cdn.example.com/parser.jpg',
            id: 42
        },
        'new item image columns prefer the feed image'
    )
})

test('fetchFeed stores article og:image in og_image_url', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    let itemImageUpdate:null | {
        thumbnail:unknown
        ogImage:unknown
        id:unknown
    } = null

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 1, toArray: () => [] }
            }

            if (query.includes('SELECT id FROM items')) {
                return {
                    toArray: () => [],
                    one: () => ({ id: 43 })
                }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('og_image_url')) {
                itemImageUpdate = {
                    thumbnail: params[0],
                    ogImage: params[1],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        if (urlText === 'https://example.com/post/1') {
            return new Response(
                '<head><meta name="og:image" ' +
                    'content="https://cdn.example.com/og.jpg"></head>',
                { headers: { 'content-type': 'text/html' } }
            )
        }

        return new Response(rssFeed(`
            <item>
                <guid>item-1</guid>
                <title>Item 1</title>
                <link>https://example.com/post/1</link>
            </item>
        `))
    }

    try {
        await userDo.fetchFeed({
            id: 5,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
    }

    t.deepEqual(
        itemImageUpdate,
        {
            thumbnail: 'https://cdn.example.com/og.jpg',
            ogImage: 'https://cdn.example.com/og.jpg',
            id: 43
        },
        'new item og_image_url is set from article metadata'
    )
})

test('fetchFeed writes cached blurhash metadata without queueing',
    async t => {
        const imageUrl = 'https://cdn.example.com/parser.jpg'
        const expectedKey = await blurhashKeyFor(imageUrl)
        const userDo = Object.create(UserDO.prototype) as {
            env:{
                BLURHASH_KV:{
                    get:(key:string) => Promise<string|null>
                }
                BLURHASH_QUEUE:{
                    send:(message:unknown) => Promise<void>
                }
            }
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => unknown[]
                    one?:() => unknown
                    rowsWritten?:number
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        let kvReads = 0
        let itemImageUpdate:null | {
            thumbnail:unknown
            ogImage:unknown
            id:unknown
        } = null
        let blurhashUpdate:null | {
            blurhash:unknown
            width:unknown
            height:unknown
            id:unknown
        } = null
        let feedVersionBumps = 0

        userDo.env = {
            BLURHASH_KV: {
                async get (key:string) {
                    kvReads++
                    t.equal(key, expectedKey, 'KV key hashes image URL')

                    return JSON.stringify({
                        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
                        image_width: 1200,
                        image_height: 630
                    })
                }
            },
            BLURHASH_QUEUE: {
                async send () {
                    throw new Error('KV hit should not enqueue')
                }
            }
        }
        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    return { rowsWritten: 1, toArray: () => [] }
                }

                if (query.includes('SELECT id FROM items')) {
                    return {
                        toArray: () => [],
                        one: () => ({ id: 44 })
                    }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('thumbnail_url')) {
                    itemImageUpdate = {
                        thumbnail: params[0],
                        ogImage: params[1],
                        id: params[2]
                    }
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('blurhash = COALESCE')) {
                    blurhashUpdate = {
                        blurhash: params[0],
                        width: params[1],
                        height: params[2],
                        id: params[3]
                    }
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    feedVersionBumps++
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: feedVersionBumps })
                    }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: 1 })
                    }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            return new Response(`
                <rss version="2.0"
                    xmlns:media="http://search.yahoo.com/mrss/">
                    <channel>
                        <title>Example RSS</title>
                        <link>https://example.com/</link>
                        <item>
                            <guid>item-1</guid>
                            <title>Item 1</title>
                            <media:thumbnail url="${imageUrl}" />
                        </item>
                    </channel>
                </rss>
            `)
        }

        try {
            await userDo.fetchFeed({
                id: 5,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.equal(kvReads, 1, 'one KV read is made for the new image')
        t.deepEqual(
            itemImageUpdate,
            {
                thumbnail: imageUrl,
                ogImage: imageUrl,
                id: 44
            },
            'image columns are still written'
        )
        t.deepEqual(
            blurhashUpdate,
            {
                blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
                width: 1200,
                height: 630,
                id: 44
            },
            'cached blurhash metadata is denormalized to the item row'
        )
        t.equal(
            feedVersionBumps,
            2,
            'new item insert and cached blurhash update each bump version'
        )
    })

test('fetchFeed enqueues blurhash job on cache miss', async t => {
    const imageUrl = 'https://cdn.example.com/miss.jpg'
    const userDo = Object.create(UserDO.prototype) as {
        env:{
            BLURHASH_KV:{
                get:(key:string) => Promise<string|null>
            }
            BLURHASH_QUEUE:{
                send:(message:unknown) => Promise<void>
            }
        }
        ctx:{
            id:{
                toString:() => string
            }
            storage:{
                get:<T>(key:string) => Promise<T|undefined>
                put:(key:string, value:unknown) => Promise<void>
                delete:(key:string) => Promise<void>
            }
        }
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    let kvReads = 0
    let queuedMessage:unknown = null
    let blurhashUpdates = 0
    let feedVersionBumps = 0

    userDo.ctx = {
        id: {
            toString () {
                return 'user-do-id'
            }
        },
        storage: {
            async get<T> (key:string) {
                return pollerStorage.get(key) as T|undefined
            },
            async put (key:string, value:unknown) {
                pollerStorage.set(key, value)
            },
            async delete (key:string) {
                pollerStorage.delete(key)
            }
        }
    }
    userDo.env = {
        BLURHASH_KV: {
            async get () {
                kvReads++
                return null
            }
        },
        BLURHASH_QUEUE: {
            async send (message:unknown) {
                queuedMessage = message
            }
        }
    }
    userDo.sql = {
        exec (query:string) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 1, toArray: () => [] }
            }

            if (query.includes('SELECT id FROM items')) {
                return {
                    toArray: () => [],
                    one: () => ({ id: 45 })
                }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('thumbnail_url')) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('blurhash = COALESCE')) {
                blurhashUpdates++
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                feedVersionBumps++
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: feedVersionBumps })
                }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        return new Response(`
            <rss version="2.0"
                xmlns:media="http://search.yahoo.com/mrss/">
                <channel>
                    <title>Example RSS</title>
                    <link>https://example.com/</link>
                    <item>
                        <guid>item-1</guid>
                        <title>Item 1</title>
                        <media:thumbnail url="${imageUrl}" />
                    </item>
                </channel>
            </rss>
        `)
    }

    try {
        await userDo.fetchFeed({
            id: 5,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
    }

    t.equal(kvReads, 1, 'one KV read is made before enqueue')
    t.equal(blurhashUpdates, 0, 'cache miss does not write blurhash')
    t.equal(feedVersionBumps, 1, 'new item insert bumps version once')
    t.deepEqual(
        queuedMessage,
        {
            imageUrl,
            itemId: 45,
            objectId: 'user-do-id'
        },
        'cache miss enqueues the image job'
    )
})

test('fetchFeed caps concurrent og image requests at four', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    let nextItemId = 100
    let activeArticleFetches = 0
    let maxActiveArticleFetches = 0
    let thumbnailUpdates = 0

    userDo.sql = {
        exec (query:string) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 1, toArray: () => [] }
            }

            if (query.includes('SELECT id FROM items')) {
                const id = nextItemId++

                return {
                    toArray: () => [],
                    one: () => ({ id })
                }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('og_image_url')) {
                thumbnailUpdates++
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        if (urlText.startsWith('https://example.com/post/')) {
            activeArticleFetches++
            maxActiveArticleFetches = Math.max(
                maxActiveArticleFetches,
                activeArticleFetches
            )
            await nextTask()
            activeArticleFetches--

            return new Response(
                '<head><meta property="og:image" ' +
                    `content="${urlText}/og.jpg"></head>`,
                { headers: { 'content-type': 'text/html' } }
            )
        }

        return new Response(rssFeed(
            Array.from({ length: 9 }, (_value, index) => `
                <item>
                    <guid>item-${index}</guid>
                    <title>Item ${index}</title>
                    <link>https://example.com/post/${index}</link>
                </item>
            `).join('')
        ))
    }

    try {
        await userDo.fetchFeed({
            id: 6,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
    }

    t.equal(
        maxActiveArticleFetches,
        4,
        'at most four og image fetches run at once'
    )
    t.equal(thumbnailUpdates, 9, 'all inserted thumbnails are updated')
})

test('fetchFeed silently handles og failures, uses parser image', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    const originalError = console.error
    let loggedOgFailure = false
    let feedErrorUpdate:null | {
        error:unknown
        status:unknown
        id:unknown
    } = null
    let thumbnailUpdate:null | {
        thumbnail:unknown
        id:unknown
    } = null

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 1, toArray: () => [] }
            }

            if (query.includes('SELECT id FROM items')) {
                return {
                    toArray: () => [],
                    one: () => ({ id: 77 })
                }
            }

            if (query.includes('UPDATE items SET') &&
                query.includes('og_image_url')) {
                thumbnailUpdate = {
                    thumbnail: params[0],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('last_error = ?') &&
                query.includes('last_status = ?')) {
                feedErrorUpdate = {
                    error: params[0],
                    status: params[1],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    console.error = (...args:unknown[]) => {
        loggedOgFailure = loggedOgFailure ||
            args.some(arg => String(arg).includes('post/1'))
    }
    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        if (urlText === 'https://example.com/post/1') {
            return new Response('server error', { status: 500 })
        }

        return new Response(`
            <rss version="2.0"
                xmlns:media="http://search.yahoo.com/mrss/">
                <channel>
                    <title>Example RSS</title>
                    <link>https://example.com/</link>
                    <item>
                        <guid>item-1</guid>
                        <title>Item 1</title>
                        <link>https://example.com/post/1</link>
                        <media:thumbnail
                            url="https://cdn.example.com/parser.jpg" />
                    </item>
                </channel>
            </rss>
        `)
    }

    try {
        await userDo.fetchFeed({
            id: 7,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
        console.error = originalError
    }

    t.equal(loggedOgFailure, false, 'og fetch failure is silent')
    t.equal(feedErrorUpdate, null, 'feed error status is not set')
    t.deepEqual(
        thumbnailUpdate,
        {
            thumbnail: 'https://cdn.example.com/parser.jpg',
            id: 77
        },
        'parser image is used after og failure'
    )
})

test('fetchFeed records non-duplicate item insert failures', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => []
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    const originalError = console.error
    let insertAttempts = 0
    let feedErrorUpdate:null | {
        error:unknown
        status:unknown
        id:unknown
    } = null
    let loggedError = false

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                insertAttempts++
                throw new Error('SQLITE_TOOBIG: string or blob too big')
            }

            if (query.includes('last_error = ?') &&
                query.includes('last_status = ?')) {
                feedErrorUpdate = {
                    error: params[0],
                    status: params[1],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    console.error = (...args:unknown[]) => {
        loggedError = args.some(arg => {
            return String(arg).includes('SQLITE_TOOBIG')
        })
    }
    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        return new Response(rssFeed(itemXml(1)))
    }

    try {
        await userDo.fetchFeed({
            id: 4,
            url: 'https://example.com/feed.xml',
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
        console.error = originalError
    }

    t.equal(insertAttempts, 1, 'item insert was attempted')
    t.equal(loggedError, true, 'insert failure is logged')
    t.deepEqual(
        feedErrorUpdate,
        {
            error: 'SQLITE_TOOBIG: string or blob too big',
            status: 500,
            id: 4
        },
        'feed row records the insert failure'
    )
})

test('fetchFeed stays quiet when article URL exceeds redirect budget',
    async t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => unknown[]
                    one?:() => unknown
                    rowsWritten?:number
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        const originalError = console.error
        const errorMessages:string[] = []

        userDo.sql = {
            exec (query:string) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    return { rowsWritten: 1, toArray: () => [] }
                }

                if (query.includes('SELECT id FROM items')) {
                    return {
                        toArray: () => [],
                        one: () => ({ id: 88 })
                    }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('og_image_url')) {
                    return { toArray: () => [] }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: 1 })
                    }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        console.error = (...args:unknown[]) => {
            errorMessages.push(args.map(arg => String(arg)).join(' '))
        }
        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            if (urlText.startsWith('https://example.com/post/')) {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/post/1' }
                })
            }

            return new Response(`
                <rss version="2.0">
                    <channel>
                        <title>Example RSS</title>
                        <link>https://example.com/</link>
                        <item>
                            <guid>item-1</guid>
                            <title>Item 1</title>
                            <link>https://example.com/post/1</link>
                        </item>
                    </channel>
                </rss>
            `)
        }

        try {
            await userDo.fetchFeed({
                id: 8,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
            console.error = originalError
        }

        const noisy = errorMessages.filter(message => {
            return /redirected too many times/i.test(message) ||
                /og image/i.test(message)
        })

        t.deepEqual(noisy, [], 'no og-failure error lines logged')
    }
)

test('fetchFeed resolves og image after multi-hop article redirects',
    async t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => unknown[]
                    one?:() => unknown
                    rowsWritten?:number
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        let articleHops = 0
        let thumbnailUpdate:null | {
            thumbnail:unknown
            id:unknown
        } = null

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    return { rowsWritten: 1, toArray: () => [] }
                }

                if (query.includes('SELECT id FROM items')) {
                    return {
                        toArray: () => [],
                        one: () => ({ id: 101 })
                    }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('og_image_url')) {
                    thumbnailUpdate = {
                        thumbnail: params[0],
                        id: params[2]
                    }
                    return { toArray: () => [] }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: 1 })
                    }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            if (urlText.startsWith('https://example.com/post/')) {
                articleHops++
                if (articleHops <= 3) {
                    return new Response(null, {
                        status: 302,
                        headers: {
                            location: `/post/hop-${articleHops}`
                        }
                    })
                }

                return new Response(
                    '<head><meta property="og:image" ' +
                        'content="https://cdn.example.com/og.jpg"></head>',
                    { headers: { 'content-type': 'text/html' } }
                )
            }

            return new Response(`
                <rss version="2.0">
                    <channel>
                        <title>Example RSS</title>
                        <link>https://example.com/</link>
                        <item>
                            <guid>item-1</guid>
                            <title>Item 1</title>
                            <link>https://example.com/post/1</link>
                        </item>
                    </channel>
                </rss>
            `)
        }

        try {
            await userDo.fetchFeed({
                id: 10,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.equal(articleHops, 4, 'article fetch follows three redirects')
        t.deepEqual(
            thumbnailUpdate,
            {
                thumbnail: 'https://cdn.example.com/og.jpg',
                id: 101
            },
            'og image is stored after multi-hop chain'
        )
    }
)

test('fetchFeed falls back to feed image when article redirects loop',
    async t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => unknown[]
                    one?:() => unknown
                    rowsWritten?:number
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        let thumbnailUpdate:null | {
            thumbnail:unknown
            id:unknown
        } = null

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    return { rowsWritten: 1, toArray: () => [] }
                }

                if (query.includes('SELECT id FROM items')) {
                    return {
                        toArray: () => [],
                        one: () => ({ id: 202 })
                    }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('og_image_url')) {
                    thumbnailUpdate = {
                        thumbnail: params[0],
                        id: params[2]
                    }
                    return { toArray: () => [] }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: 1 })
                    }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            if (urlText.startsWith('https://example.com/post/')) {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/post/loop' }
                })
            }

            return new Response(`
                <rss version="2.0"
                    xmlns:media="http://search.yahoo.com/mrss/">
                    <channel>
                        <title>Example RSS</title>
                        <link>https://example.com/</link>
                        <item>
                            <guid>item-1</guid>
                            <title>Item 1</title>
                            <link>https://example.com/post/1</link>
                            <media:thumbnail
                                url="https://cdn.example.com/feed.jpg" />
                        </item>
                    </channel>
                </rss>
            `)
        }

        try {
            await userDo.fetchFeed({
                id: 11,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.deepEqual(
            thumbnailUpdate,
            {
                thumbnail: 'https://cdn.example.com/feed.jpg',
                id: 202
            },
            'feed-supplied thumbnail is used as fallback'
        )
    }
)

test('fetchFeed leaves thumbnail null when article loops and feed has none',
    async t => {
        const userDo = Object.create(UserDO.prototype) as {
            sql:{
                exec:(query:string, ...params:unknown[]) => {
                    toArray:() => unknown[]
                    one?:() => unknown
                    rowsWritten?:number
                }
            }
            fetchFeed:(feed:{
                id:number
                url:string
                title:string|null
                description:string|null
                site_url:string|null
                last_fetched:string|null
                last_error:string|null
                last_status:number|null
                created_at:string
                updated_at:string
            }) => Promise<void>
        }
        const originalFetch = globalThis.fetch
        let inserted = false
        let thumbnailUpdates = 0

        userDo.sql = {
            exec (query:string) {
                if (query.includes('UPDATE feeds SET') &&
                    query.includes('last_error = NULL')) {
                    return { toArray: () => [] }
                }

                if (query.includes('INSERT OR IGNORE INTO items')) {
                    inserted = true
                    return { rowsWritten: 1, toArray: () => [] }
                }

                if (query.includes('SELECT id FROM items')) {
                    return {
                        toArray: () => [],
                        one: () => ({ id: 303 })
                    }
                }

                if (query.includes('UPDATE items SET') &&
                    query.includes('og_image_url')) {
                    thumbnailUpdates++
                    return { toArray: () => [] }
                }

                if (query.includes('SELECT feeds.id FROM feeds')) {
                    return { toArray: () => [] }
                }

                if (
                    query.includes('COUNT(items.id)') &&
                    query.includes('GROUP BY feeds.id')
                ) {
                    return { toArray: () => [] }
                }

                if (query.includes('UPDATE user_state SET feed_version')) {
                    return {
                        toArray: () => [],
                        one: () => ({ feed_version: 1 })
                    }
                }

                throw new Error(`Unexpected SQL: ${query}`)
            }
        }

        globalThis.fetch = async (url) => {
            const urlText = String(url)

            if (urlText.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            if (urlText.startsWith('https://example.com/post/')) {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/post/loop' }
                })
            }

            return new Response(`
                <rss version="2.0">
                    <channel>
                        <title>Example RSS</title>
                        <link>https://example.com/</link>
                        <item>
                            <guid>item-1</guid>
                            <title>Item 1</title>
                            <link>https://example.com/post/1</link>
                        </item>
                    </channel>
                </rss>
            `)
        }

        try {
            await userDo.fetchFeed({
                id: 12,
                url: 'https://example.com/feed.xml',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.equal(inserted, true, 'item is still inserted')
        t.equal(thumbnailUpdates, 0, 'no thumbnail update fires')
    }
)

test('fetchFeed loudly reports feed-XML redirect overflow', async t => {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    const originalFetch = globalThis.fetch
    const originalError = console.error
    const feedUrl = 'https://example.com/feed.xml'
    const errorMessages:string[] = []
    let feedErrorUpdate:null | {
        error:unknown
        status:unknown
        id:unknown
    } = null

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('last_error = ?') &&
                query.includes('last_status = ?')) {
                feedErrorUpdate = {
                    error: params[0],
                    status: params[1],
                    id: params[2]
                }
                return { toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            if (query.includes('UPDATE user_state SET feed_version')) {
                return {
                    toArray: () => [],
                    one: () => ({ feed_version: 1 })
                }
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    console.error = (...args:unknown[]) => {
        errorMessages.push(args.map(arg => String(arg)).join(' '))
    }
    globalThis.fetch = async (url) => {
        const urlText = String(url)

        if (urlText.startsWith('https://cloudflare-dns.com/')) {
            return new Response(JSON.stringify({
                Answer: [{ data: '93.184.216.34' }]
            }))
        }

        return new Response(null, {
            status: 302,
            headers: { location: '/feed.xml' }
        })
    }

    try {
        await userDo.fetchFeed({
            id: 9,
            url: feedUrl,
            title: null,
            description: null,
            site_url: null,
            last_fetched: null,
            last_error: null,
            last_status: null,
            created_at: '2026-04-27 00:00:00',
            updated_at: '2026-04-27 00:00:00'
        })
    } finally {
        globalThis.fetch = originalFetch
        console.error = originalError
    }

    const feedErrors = errorMessages.filter(message => {
        return message.includes('Error fetching feed') &&
            message.includes(feedUrl)
    })

    t.equal(feedErrors.length, 1, 'one feed-level error line is logged')
    t.deepEqual(
        feedErrorUpdate,
        {
            error: 'Feed redirected too many times',
            status: 310,
            id: 9
        },
        'feed row last_error captures the redirect overflow'
    )
})

interface UrlUpdateProbe {
    url:unknown
    id:unknown
}

interface CollisionProbe {
    canonical:unknown
    excludeId:unknown
}

function createUrlPersistHarness (opts:{
    collisionRows:Array<{ id:number }>
}):{
    userDo:{
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }
    state:{
        urlUpdate:UrlUpdateProbe|null
        collisionProbe:CollisionProbe|null
    }
} {
    const state:{
        urlUpdate:UrlUpdateProbe|null
        collisionProbe:CollisionProbe|null
    } = {
        urlUpdate: null,
        collisionProbe: null
    }

    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => {
                toArray:() => unknown[]
                one?:() => unknown
                rowsWritten?:number
            }
        }
        fetchFeed:(feed:{
            id:number
            url:string
            title:string|null
            description:string|null
            site_url:string|null
            last_fetched:string|null
            last_error:string|null
            last_status:number|null
            created_at:string
            updated_at:string
        }) => Promise<void>
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('UPDATE feeds SET') &&
                query.includes('last_error = NULL')) {
                return { toArray: () => [] }
            }

            if (query.includes('SELECT id FROM feeds WHERE url = ?') &&
                query.includes('AND id != ?')) {
                state.collisionProbe = {
                    canonical: params[0],
                    excludeId: params[1]
                }
                return { toArray: () => opts.collisionRows }
            }

            if (query.includes('UPDATE feeds SET') &&
                query.includes('url = ?') &&
                query.includes('updated_at')) {
                state.urlUpdate = {
                    url: params[0],
                    id: params[1]
                }
                return { toArray: () => [] }
            }

            if (query.includes('INSERT OR IGNORE INTO items')) {
                return { rowsWritten: 0, toArray: () => [] }
            }

            if (query.includes('SELECT feeds.id FROM feeds')) {
                return { toArray: () => [] }
            }

            if (
                query.includes('COUNT(items.id)') &&
                query.includes('GROUP BY feeds.id')
            ) {
                return { toArray: () => [] }
            }

            return { toArray: () => [] }
        }
    }

    return { userDo, state }
}

test('fetchFeed persists resolved URL after a trailing-slash redirect',
    async t => {
        const { userDo, state } = createUrlPersistHarness({
            collisionRows: []
        })
        const originalFetch = globalThis.fetch
        const fetched:string[] = []

        globalThis.fetch = async (url) => {
            const text = String(url)

            if (text.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            fetched.push(text)

            if (text === 'https://example.com/rss') {
                return new Response(null, {
                    status: 301,
                    headers: { location: '/rss/' }
                })
            }

            return new Response(rssFeed(itemXml(1)))
        }

        try {
            await userDo.fetchFeed({
                id: 7,
                url: 'https://example.com/rss',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.deepEqual(
            fetched,
            ['https://example.com/rss', 'https://example.com/rss/'],
            'redirect is followed without re-stripping the slash'
        )
        t.deepEqual(
            state.collisionProbe,
            {
                canonical: 'https://example.com/rss/',
                excludeId: 7
            },
            'collision check uses resolved URL and excludes the row itself'
        )
        t.deepEqual(
            state.urlUpdate,
            {
                url: 'https://example.com/rss/',
                id: 7
            },
            'feed.url is rewritten to the canonical, slashed URL'
        )
    }
)

test('fetchFeed leaves URL unchanged when canonical is already taken',
    async t => {
        const { userDo, state } = createUrlPersistHarness({
            collisionRows: [{ id: 99 }]
        })
        const originalFetch = globalThis.fetch

        globalThis.fetch = async (url) => {
            const text = String(url)

            if (text.startsWith('https://cloudflare-dns.com/')) {
                return new Response(JSON.stringify({
                    Answer: [{ data: '93.184.216.34' }]
                }))
            }

            if (text === 'https://example.com/rss') {
                return new Response(null, {
                    status: 301,
                    headers: { location: '/rss/' }
                })
            }

            return new Response(rssFeed(itemXml(1)))
        }

        try {
            await userDo.fetchFeed({
                id: 7,
                url: 'https://example.com/rss',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: null,
                last_status: null,
                created_at: '2026-04-27 00:00:00',
                updated_at: '2026-04-27 00:00:00'
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        t.equal(
            state.urlUpdate,
            null,
            'no UPDATE feeds SET url is issued when collision exists'
        )
        t.deepEqual(
            state.collisionProbe,
            {
                canonical: 'https://example.com/rss/',
                excludeId: 7
            },
            'collision check still runs to detect the conflict'
        )
    }
)
