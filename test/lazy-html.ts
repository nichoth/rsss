import { test } from '@substrate-system/tapzero'
import {
    buildLazyHtmlCacheKey,
    injectInitialFeed,
    serializeInitialFeed,
    shouldSkipLazyHtml,
    type InitialFeedPayload
} from '../src/server/lazy-html.js'
import type { Feed } from '../src/client/db/types.js'

function feedFixture (id = 2):Feed {
    return {
        id,
        url: 'https://example.com/feed.xml',
        title: 'Example Feed',
        description: null,
        site_url: 'https://example.com',
        last_fetched: '2026-05-09T00:00:00.000Z',
        last_error: null,
        last_status: 200,
        created_at: '2026-05-09T00:00:00.000Z',
        updated_at: '2026-05-09T00:00:00.000Z'
    }
}

function payload (
    title = 'Title'
):InitialFeedPayload {
    return {
        version: 7,
        has_more: false,
        feeds: [feedFixture()],
        counts: {
            unread: 1,
            starred: 0,
            total: 1,
            perFeed: { 2: 1 }
        },
        items: [{
            id: 1,
            feed_id: 2,
            guid: 'guid-1',
            title,
            link: 'https://example.com/item',
            description: null,
            content: null,
            author: null,
            pub_date: '2026-05-09T00:00:00.000Z',
            thumbnail_url: null,
            og_image_url: 'https://example.com/image.jpg',
            blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
            image_width: 1200,
            image_height: 630,
            is_read: 0,
            is_starred: 0,
            created_at: '2026-05-09T00:00:00.000Z',
            updated_at: '2026-05-09T00:00:00.000Z',
            feed_title: 'Example Feed'
        }]
    }
}

function bootstrapJson (html:string):string {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const script = doc.querySelector('#initial-feed')

    if (!script?.textContent) {
        throw new Error('missing initial-feed bootstrap')
    }

    return script.textContent
}

test('buildLazyHtmlCacheKey is deterministic and version-keyed', t => {
    t.equal(
        buildLazyHtmlCacheKey('did:plc:abc', 3),
        'html:v3:did:plc:abc:3',
        'cache key includes DID and version'
    )
    t.equal(
        buildLazyHtmlCacheKey('did:plc:abc', 4),
        'html:v3:did:plc:abc:4',
        'new versions get distinct keys'
    )
})

test('buildLazyHtmlCacheKey is prefixed with the v3 schema marker', t => {
    const key = buildLazyHtmlCacheKey('did:plc:test', 7)

    t.equal(
        key.startsWith('html:v3:'),
        true,
        'cache key starts with html:v3: after schema bump'
    )
})

test('serializeInitialFeed round-trips through JSON.parse', t => {
    const expected = payload()
    const serialized = serializeInitialFeed(expected)

    t.deepEqual(
        JSON.parse(serialized),
        expected,
        'serialized payload parses back to the same object'
    )
})

test('serializeInitialFeed round-trips feeds and counts', t => {
    const expected = payload()
    const parsed = JSON.parse(serializeInitialFeed(expected))

    t.deepEqual(parsed.feeds, expected.feeds, 'feeds round-trip')
    t.deepEqual(parsed.counts, expected.counts, 'counts round-trip')
})

test('serializeInitialFeed escapes less-than signs', t => {
    const serialized = serializeInitialFeed(
        payload('</script><script>alert(1)</script>')
    )

    t.equal(
        serialized.includes('<'),
        false,
        'serialized payload contains no raw less-than signs'
    )
    t.deepEqual(
        JSON.parse(serialized),
        payload('</script><script>alert(1)</script>'),
        'escaped JSON still parses to the original payload'
    )
})

test('injectInitialFeed inserts parseable bootstrap before head close', t => {
    const html = '<!doctype html><html><head><title>RSSS</title></head></html>'
    const injected = injectInitialFeed(html, payload())
    const headCloseIndex = injected.indexOf('</head>')
    const scriptIndex = injected.indexOf('id="initial-feed"')

    t.ok(scriptIndex > -1, 'bootstrap script is inserted')
    t.ok(scriptIndex < headCloseIndex, 'bootstrap appears before </head>')
    t.deepEqual(
        JSON.parse(bootstrapJson(injected)),
        payload(),
        'bootstrap JSON is parseable'
    )
})

test('injectInitialFeed pre-renders the feeds list when seeded', t => {
    const expected = payload()
    const html = injectInitialFeed(
        '<html><head></head><body><div id="root"></div></body></html>',
        expected
    )

    t.equal(
        html.includes('Example Feed'),
        true,
        'feed title appears in pre-rendered sidebar markup'
    )
    t.equal(
        html.includes('class="sidebar"'),
        true,
        'sidebar shell is rendered server-side'
    )
})

test('injectInitialFeed returns input unchanged without head close', t => {
    const html = '<!doctype html><html><body>RSSS</body></html>'

    t.equal(
        injectInitialFeed(html, payload()),
        html,
        'HTML without </head> is not modified'
    )
})

test('shouldSkipLazyHtml returns true in dev mode', t => {
    t.equal(
        shouldSkipLazyHtml({ dev: true }),
        true,
        'returns true when dev is true'
    )
})

test('shouldSkipLazyHtml returns false in production mode', t => {
    t.equal(
        shouldSkipLazyHtml({ dev: false }),
        false,
        'returns false when dev is false'
    )
})
