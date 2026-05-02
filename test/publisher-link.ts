import { test } from '@substrate-system/tapzero'
import {
    publisherLinkLabel,
    publisherLinkHref
} from '../src/shared/publisher-link.js'

test('publisherLinkLabel - basic host', t => {
    t.equal(
        publisherLinkLabel('https://brittanyellich.com/post'),
        'Read the full article on brittanyellich.com',
        'host appears verbatim'
    )
})

test('publisherLinkHref - basic host', t => {
    t.equal(
        publisherLinkHref('https://brittanyellich.com/post'),
        'https://brittanyellich.com/post',
        'href is the parsed URL'
    )
})

test('publisherLinkLabel - strips leading www.', t => {
    t.equal(
        publisherLinkLabel('https://www.example.com/x'),
        'Read the full article on example.com',
        'www. prefix removed from host'
    )
})

test('publisherLinkLabel - keeps non-www subdomain', t => {
    t.equal(
        publisherLinkLabel('https://blog.example.com/x'),
        'Read the full article on blog.example.com',
        'blog. subdomain preserved'
    )
})

test('publisherLinkLabel - empty / null / malformed → null', t => {
    t.equal(publisherLinkLabel(''), null, 'empty → null')
    t.equal(publisherLinkLabel('not a url'), null, 'malformed → null')
})

test('publisherLinkHref - empty / null / malformed → null', t => {
    t.equal(publisherLinkHref(''), null, 'empty → null')
    t.equal(publisherLinkHref('not a url'), null, 'malformed → null')
})

test('publisherLinkLabel - non-http(s) → null', t => {
    t.equal(
        publisherLinkLabel('mailto:hi@example.com'),
        null,
        'mailto → null'
    )
    t.equal(
        publisherLinkLabel('javascript:alert(1)'),
        null,
        'javascript: → null'
    )
})

test('publisherLinkHref - non-http(s) → null', t => {
    t.equal(
        publisherLinkHref('mailto:hi@example.com'),
        null,
        'mailto → null'
    )
    t.equal(
        publisherLinkHref('javascript:alert(1)'),
        null,
        'javascript: → null'
    )
})

test('publisherLinkLabel - host is lower-cased', t => {
    t.equal(
        publisherLinkLabel('https://EXAMPLE.com/x'),
        'Read the full article on example.com',
        'uppercase host folded to lowercase'
    )
})

test('publisherLinkLabel - always starts with the prefix', t => {
    const cases = [
        'https://example.com/',
        'https://www.example.com/',
        'http://example.com/'
    ]
    for (const link of cases) {
        const label = publisherLinkLabel(link)
        t.ok(
            label && label.startsWith('Read the full article on '),
            `label for ${link} starts with prefix`
        )
    }
})

test('publisherLinkHref - preserves path and query', t => {
    t.equal(
        publisherLinkHref('https://example.com/post?x=1#h'),
        'https://example.com/post?x=1#h',
        'href round-trips path/query/hash'
    )
})

test('item-reader rendering decision (null when helpers return null)', t => {
    // Simulate the route's decision: render iff label && href.
    const cases = [
        { link: '', shouldRender: false },
        { link: 'mailto:a@b.com', shouldRender: false },
        { link: 'javascript:alert(1)', shouldRender: false },
        { link: 'https://example.com/x', shouldRender: true },
        { link: 'https://www.example.com/x', shouldRender: true }
    ]
    for (const c of cases) {
        const label = publisherLinkLabel(c.link)
        const href = publisherLinkHref(c.link)
        const rendered = Boolean(label && href)
        t.equal(
            rendered,
            c.shouldRender,
            `${JSON.stringify(c.link)} renders=${c.shouldRender}`
        )
    }
})
