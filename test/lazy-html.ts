import { test } from '@substrate-system/tapzero'
import {
    buildLazyHtmlCacheKey,
    injectInitialFeed,
    serializeInitialFeed,
    type InitialFeedPayload
} from '../src/server/lazy-html.js'

function payload (
    title = 'Title'
):InitialFeedPayload {
    return {
        version: 7,
        has_more: false,
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
        'html:did:plc:abc:3',
        'cache key includes DID and version'
    )
    t.equal(
        buildLazyHtmlCacheKey('did:plc:abc', 4),
        'html:did:plc:abc:4',
        'new versions get distinct keys'
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

test('injectInitialFeed returns input unchanged without head close', t => {
    const html = '<!doctype html><html><body>RSSS</body></html>'

    t.equal(
        injectInitialFeed(html, payload()),
        html,
        'HTML without </head> is not modified'
    )
})
