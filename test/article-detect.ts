import { test } from '@substrate-system/tapzero'
import {
    isSummaryOnly,
    plainTextLength
} from '../src/shared/article-detect.js'

test('plainTextLength - empty string', t => {
    t.equal(plainTextLength(''), 0, 'empty string is length 0')
})

test('plainTextLength - strips HTML tags', t => {
    t.equal(
        plainTextLength('<p>Hello <strong>world</strong></p>'),
        11,
        '11 user-perceived chars'
    )
})

test('plainTextLength - decodes named entities', t => {
    t.equal(
        plainTextLength('&amp;&lt;&gt;'),
        3,
        'three decoded characters'
    )
})

test('plainTextLength - decodes numeric and hex entities', t => {
    t.equal(plainTextLength('&#65;&#x42;'), 2, 'A and B')
})

test('plainTextLength - collapses whitespace', t => {
    t.equal(plainTextLength('a   b\n\n c'), 5, 'collapsed: "a b c"')
})

test('plainTextLength - counts CJK characters as code points', t => {
    t.equal(plainTextLength('你好世界'), 4, '4 CJK code points')
})

test('plainTextLength - counts emoji as code points', t => {
    t.equal(plainTextLength('hi 🎉 ok'), 7, '"hi 🎉 ok" is 7 code points')
})

test('isSummaryOnly - empty content + empty description, has link', t => {
    t.equal(
        isSummaryOnly({
            link: 'https://example.com/x',
            content: '',
            description: ''
        }),
        true,
        'empty body with link is treated as summary'
    )
})

test('isSummaryOnly - long content, has link', t => {
    const big = 'word '.repeat(400)
    t.equal(
        isSummaryOnly({ link: 'https://example.com/x', content: big }),
        false,
        '~2000 char body is not a summary'
    )
})

test('isSummaryOnly - short summary, no link', t => {
    t.equal(
        isSummaryOnly({ link: '', content: 'short' }),
        false,
        'no link means not a summary even with empty body'
    )
    t.equal(
        isSummaryOnly({ link: null, content: 'short' }),
        false,
        'null link is also gating'
    )
})

test('isSummaryOnly - short summary, has link', t => {
    t.equal(
        isSummaryOnly({
            link: 'https://example.com/x',
            content: '<p>One paragraph</p>'
        }),
        true,
        'short body with link is a summary'
    )
})

test('isSummaryOnly - prefers content over description', t => {
    const longContent = 'a'.repeat(2000)
    t.equal(
        isSummaryOnly({
            link: 'https://example.com/x',
            content: longContent,
            description: 'tiny'
        }),
        false,
        'long content beats short description'
    )
})

test('isSummaryOnly - falls back to description when content missing', t => {
    const longDescription = 'a'.repeat(2000)
    t.equal(
        isSummaryOnly({
            link: 'https://example.com/x',
            content: null,
            description: longDescription
        }),
        false,
        'long description without content is not a summary'
    )
})

test('isSummaryOnly - HTML entities and tags do not inflate length', t => {
    const tagHeavy = '<p>' + 'a'.repeat(100) + '</p>'.repeat(100)
    t.equal(
        isSummaryOnly({
            link: 'https://example.com/x',
            content: tagHeavy
        }),
        true,
        'plain text is 100 chars, well under threshold'
    )
})
