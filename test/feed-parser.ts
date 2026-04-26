import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface ParsedFeed {
    title:string|null
    description:string|null
    link:string|null
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
