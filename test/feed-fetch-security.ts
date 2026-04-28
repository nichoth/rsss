import { test } from '@substrate-system/tapzero'
import {
    fetchFeedText,
    validateFeedUrl
} from '../src/server/feed-fetch.js'

function responseFromChunks (chunks:string[]):Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
        start (controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk))
            }
            controller.close()
        }
    })

    return new Response(stream, { status: 200 })
}

test('validateFeedUrl accepts http and https URLs', async t => {
    t.equal(
        await validateFeedUrl('https://example.com/feed.xml'),
        'https://example.com/feed.xml'
    )
    t.equal(
        await validateFeedUrl('http://example.com/rss'),
        'http://example.com/rss'
    )
})

test('validateFeedUrl rejects non-http URLs', async t => {
    try {
        await validateFeedUrl('file:///etc/passwd')
        t.fail('expected file URL to be rejected')
    } catch (_err) {
        const err = _err as Error
        t.equal(err.message, 'Feed URL must use http or https')
    }
})

test('validateFeedUrl rejects localhost URLs', async t => {
    const badUrls = [
        'http://localhost/feed.xml',
        'http://127.0.0.1/feed.xml',
        'http://0.0.0.0/feed.xml',
        'http://[::1]/feed.xml',
        'http://printer.local/feed.xml'
    ]

    for (const url of badUrls) {
        try {
            await validateFeedUrl(url)
            t.fail(`expected ${url} to be rejected`)
        } catch (_err) {
            const err = _err as Error
            t.equal(err.message, 'Feed URL host is not allowed')
        }
    }
})

test('validateFeedUrl rejects private and link-local IP ranges', async t => {
    const badUrls = [
        'http://10.0.0.1/feed.xml',
        'http://172.16.0.1/feed.xml',
        'http://172.31.255.255/feed.xml',
        'http://192.168.1.1/feed.xml',
        'http://169.254.1.1/feed.xml',
        'http://[fc00::1]/feed.xml',
        'http://[fdff::1]/feed.xml',
        'http://[fe80::1]/feed.xml',
        'http://[::]/feed.xml',
        'http://[::ffff:127.0.0.1]/feed.xml'
    ]

    for (const url of badUrls) {
        try {
            await validateFeedUrl(url)
            t.fail(`expected ${url} to be rejected`)
        } catch (_err) {
            const err = _err as Error
            t.equal(err.message, 'Feed URL host is not allowed')
        }
    }
})

test('validateFeedUrl rejects numeric loopback encodings', async t => {
    const badUrls = [
        'http://2130706433/',
        'http://0177.0.0.1/',
        'http://0x7f.0.0.1/'
    ]

    for (const url of badUrls) {
        try {
            await validateFeedUrl(url)
            t.fail(`expected ${url} to be rejected`)
        } catch (_err) {
            const err = _err as Error
            t.equal(err.message, 'Feed URL host is not allowed')
        }
    }
})

test('fetchFeedText rejects hostnames resolving to private IPs', async t => {
    try {
        await fetchFeedText('https://example.com/feed.xml', {
            fetchFn: async () => responseFromChunks(['never']),
            resolveHostname: async () => ['10.0.0.1']
        })
        t.fail('expected private resolved IP to be rejected')
    } catch (_err) {
        const err = _err as Error
        t.equal(err.message, 'Feed URL host is not allowed')
    }
})

test('fetchFeedText manually validates redirects', async t => {
    const fetched:string[] = []
    const redirects:RequestRedirect[] = []

    try {
        await fetchFeedText('https://example.com/feed.xml', {
            fetchFn: async (url, init) => {
                fetched.push(url.toString())
                redirects.push(init?.redirect || 'follow')

                return new Response(null, {
                    status: 302,
                    headers: {
                        location: 'http://10.0.0.1/feed.xml'
                    }
                })
            },
            resolveHostname: async () => ['93.184.216.34']
        })
        t.fail('expected private redirect location to be rejected')
    } catch (_err) {
        const err = _err as Error
        t.equal(err.message, 'Feed URL host is not allowed')
        t.deepEqual(fetched, ['https://example.com/feed.xml'])
        t.deepEqual(redirects, ['manual'])
    }
})

test('fetchFeedText rejects bodies larger than the byte limit', async t => {
    const response = responseFromChunks(['12345', '67890', 'x'])

    try {
        await fetchFeedText('https://example.com/feed.xml', {
            fetchFn: async () => response,
            maxBytes: 10
        })
        t.fail('expected oversized body to be rejected')
    } catch (_err) {
        const err = _err as Error
        t.equal(err.message, 'Feed response exceeds 10 bytes')
    }
})

test('fetchFeedText rejects responses without a stream', async t => {
    const response = {
        ok: true,
        status: 200,
        body: null,
        async text () {
            t.fail('response.text should not be called')
            return ''
        }
    } as unknown as Response

    try {
        await fetchFeedText('https://example.com/feed.xml', {
            fetchFn: async () => response
        })
        t.fail('expected missing stream to be rejected')
    } catch (_err) {
        const err = _err as Error
        t.equal(err.message, 'Feed response has no readable body')
    }
})
