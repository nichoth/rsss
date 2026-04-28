import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

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
    }>
}

function parseFeed (xml:string):ParsedFeed {
    const parser = Object.create(UserDO.prototype) as {
        parseFeed:(value:string) => ParsedFeed
    }

    return parser.parseFeed(xml)
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
