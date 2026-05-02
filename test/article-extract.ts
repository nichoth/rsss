import { test } from '@substrate-system/tapzero'
import {
    extractArticleBody,
    sanitiseExtractedHtml
} from '../src/server/article-extract.js'

const longParagraph = (n:number):string => {
    return '<p>' + 'word '.repeat(n) + '</p>'
}

test('extractArticleBody - <article> wins over <main>', t => {
    const html = `
        <html><body>
            <main>${longParagraph(200)}</main>
            <article>${longParagraph(150)}<p>UNIQUE_ARTICLE_MARKER</p></article>
        </body></html>
    `
    const result = extractArticleBody(html, 'https://example.com/')
    if ('error' in result) {
        t.fail('expected success, got ' + result.error)
        return
    }
    t.ok(
        result.html.includes('UNIQUE_ARTICLE_MARKER'),
        'article tag was preferred'
    )
})

test('extractArticleBody - chrome elements removed', t => {
    const html = `
        <html><body>
            <article>
                <header><h1>Title</h1></header>
                <nav>nav links here</nav>
                <p>${'body text '.repeat(120)}</p>
                <aside>${'aside '.repeat(50)}</aside>
                <footer>footer text</footer>
                <div class="comments">${'comment '.repeat(50)}</div>
            </article>
        </body></html>
    `
    const result = extractArticleBody(html, 'https://example.com/')
    if ('error' in result) {
        t.fail('expected success, got ' + result.error)
        return
    }
    t.ok(!/<header/i.test(result.html), 'no <header>')
    t.ok(!/<nav/i.test(result.html), 'no <nav>')
    t.ok(!/<aside/i.test(result.html), 'no <aside>')
    t.ok(!/<footer/i.test(result.html), 'no <footer>')
    t.ok(
        !/comments/i.test(result.html),
        'chrome class .comments removed'
    )
})

test('extractArticleBody - inline <script> stripped', t => {
    const html = `
        <html><body>
            <article>
                <p>${'real text '.repeat(120)}</p>
                <script>alert('xss')</script>
            </article>
        </body></html>
    `
    const result = extractArticleBody(html, 'https://example.com/')
    if ('error' in result) {
        t.fail('expected success')
        return
    }
    t.ok(
        !/<script/i.test(result.html),
        '<script> tag is removed'
    )
})

test('sanitiseExtractedHtml - onclick stripped', t => {
    const out = sanitiseExtractedHtml(
        '<a href="https://x" onclick="alert(1)">link</a>'
    )
    t.ok(!/onclick/i.test(out), 'onclick attribute removed')
    t.ok(/href="https:\/\/x"/.test(out), 'href preserved')
})

test('sanitiseExtractedHtml - javascript: href stripped', t => {
    const out = sanitiseExtractedHtml(
        '<a href="javascript:alert(1)">link</a>'
    )
    t.ok(!/javascript:/i.test(out), 'javascript: URL removed')
})

test('sanitiseExtractedHtml - data:image survives', t => {
    const tiny = 'data:image/png;base64,iVBORw0KGgo='
    const out = sanitiseExtractedHtml(`<img src="${tiny}" />`)
    t.ok(out.includes(tiny), 'data:image/png survives')
})

test('extractArticleBody - paywall stub returns no_body', t => {
    const html = `
        <html><body>
            <article>
                <p>This article is for subscribers only. Subscribe now.</p>
            </article>
        </body></html>
    `
    const result = extractArticleBody(html, 'https://example.com/')
    if (!('error' in result)) {
        t.fail('expected error: no_body')
        return
    }
    t.equal(result.error, 'no_body', 'paywall stub → no_body')
})

test('extractArticleBody - 500 KiB body truncates at </p>', t => {
    const big = '<p>' + 'word '.repeat(200) + '</p>'
    const article = '<article>' + big.repeat(800) + '</article>'
    const result = extractArticleBody(article, 'https://example.com/')
    if ('error' in result) {
        t.fail('expected success, got ' + result.error)
        return
    }
    const utf8 = new TextEncoder().encode(result.html).byteLength
    t.ok(utf8 <= 256 * 1024, 'truncated under 256 KiB')
    t.ok(
        result.html.endsWith('</p>') || result.html.endsWith('</div>'),
        'ends at a clean boundary'
    )
})

test('extractArticleBody - oversized blob with no </p> → too_large', t => {
    const long = 'x'.repeat(300 * 1024)
    const html = `<article>${long}</article>`
    const result = extractArticleBody(html, 'https://example.com/')
    if (!('error' in result)) {
        t.fail('expected error: too_large')
        return
    }
    t.equal(result.error, 'too_large', 'no boundary → too_large')
})
