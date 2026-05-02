import { test } from '@substrate-system/tapzero'
import { fetchFullArticle } from '../src/server/article-fetch.js'

const okResolve = async () => ['93.184.216.34']

const longParagraph = '<p>' + 'word '.repeat(200) + '</p>'

function htmlResponse (html:string, init:ResponseInit = {}):Response {
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) {
        headers.set('content-type', 'text/html; charset=utf-8')
    }
    return new Response(html, { ...init, headers })
}

test('fetchFullArticle - 200 + readable HTML → succeeded', async t => {
    const html = `<html><body><article>${longParagraph.repeat(20)}</article></body></html>`
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => htmlResponse(html),
        resolveHostname: okResolve
    })

    t.equal(result.status, 'succeeded', 'status is succeeded')
    if (result.status === 'succeeded') {
        t.ok(result.html.length > 0, 'has html')
        t.ok(/^\d{4}-\d{2}-\d{2} /.test(result.fetchedAt),
            'fetchedAt is a SQLite-style timestamp')
    }
})

test('fetchFullArticle - 404 → failed_status', async t => {
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => new Response('not found', { status: 404 }),
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_status', '404 maps to failed_status')
})

test('fetchFullArticle - 6-redirect chain → failed_redirect', async t => {
    let calls = 0
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => {
            calls++
            return new Response(null, {
                status: 302,
                headers: { location: '/loop' }
            })
        },
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_redirect', '6 redirects → failed_redirect')
    t.equal(calls, 6, '5 redirect cap + 1 initial = 6 calls')
})

test('fetchFullArticle - non-HTML content-type → failed_non_html', async t => {
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => new Response('%PDF-1.4', {
            status: 200,
            headers: { 'content-type': 'application/pdf' }
        }),
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_non_html', 'PDF → failed_non_html')
})

test('fetchFullArticle - 2 MiB body → failed_too_large', async t => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => htmlResponse(big),
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_too_large', '2 MiB → failed_too_large')
})

test('fetchFullArticle - paywall stub (<500 chars) → failed_no_body',
    async t => {
        const stub = `<html><body><article>
            <p>Subscribe to read this article.</p>
        </article></body></html>`
        const result = await fetchFullArticle('https://example.com/post', {
            fetchFn: async () => htmlResponse(stub),
            resolveHostname: okResolve
        })
        t.equal(result.status, 'failed_no_body',
            'paywall stub → failed_no_body')
    }
)

test('fetchFullArticle - AbortError → failed_network', async t => {
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => {
            throw new DOMException('aborted', 'AbortError')
        },
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_network', 'abort → failed_network')
})

test('fetchFullArticle - SSRF-blocked hostname → failed_network', async t => {
    const result = await fetchFullArticle('https://example.com/post', {
        fetchFn: async () => htmlResponse('<html></html>'),
        resolveHostname: async () => ['10.0.0.1']
    })
    t.equal(result.status, 'failed_network',
        'private resolved IP blocked at validate stage')
})

test('fetchFullArticle - invalid URL → failed_network', async t => {
    const result = await fetchFullArticle('not a url', {
        fetchFn: async () => htmlResponse('<html></html>'),
        resolveHostname: okResolve
    })
    t.equal(result.status, 'failed_network',
        'invalid URL → failed_network')
})
