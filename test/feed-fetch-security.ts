import { test } from '@substrate-system/tapzero'
import {
    fetchOgImage,
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

function htmlResponse (html:string, init:ResponseInit = {}):Response {
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) {
        headers.set('content-type', 'text/html; charset=utf-8')
    }

    return new Response(html, {
        ...init,
        headers
    })
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

test('fetchOgImage extracts og:image from an article head', async t => {
    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async () => htmlResponse(
            '<html><head><meta property="og:image" ' +
            'content="/img/card.jpg"></head><body>ignored</body></html>'
        ),
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(image, 'https://example.com/img/card.jpg')
})

test('fetchOgImage falls back through secure_url and twitter image',
    async t => {
        const secure = await fetchOgImage('https://example.com/post', {
            fetchFn: async () => htmlResponse(
                '<head><meta property="og:image:secure_url" ' +
                'content="https://cdn.example.com/secure.jpg"></head>'
            ),
            resolveHostname: async () => ['93.184.216.34']
        })
        const twitter = await fetchOgImage('https://example.com/post', {
            fetchFn: async () => htmlResponse(
                '<head><meta name="twitter:image" ' +
                'content="https://cdn.example.com/twitter.jpg"></head>'
            ),
            resolveHostname: async () => ['93.184.216.34']
        })

        t.equal(secure, 'https://cdn.example.com/secure.jpg')
        t.equal(twitter, 'https://cdn.example.com/twitter.jpg')
    }
)

test('fetchOgImage returns null when no image metadata exists', async t => {
    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async () => htmlResponse('<head><title>Post</title></head>'),
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(image, null)
})

test('fetchOgImage follows safe redirects manually', async t => {
    const fetched:string[] = []

    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async (url, init) => {
            fetched.push(`${url} ${init?.redirect || 'follow'}`)

            if (url.toString() === 'https://example.com/post') {
                return new Response(null, {
                    status: 302,
                    headers: { location: '/canonical' }
                })
            }

            return htmlResponse(
                '<head><meta property="og:image" ' +
                'content="https://example.com/card.jpg"></head>'
            )
        },
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(image, 'https://example.com/card.jpg')
    t.deepEqual(fetched, [
        'https://example.com/post manual',
        'https://example.com/canonical manual'
    ])
})

test('fetchOgImage returns null after too many redirects', async t => {
    let calls = 0
    let caughtMessage:string|null = null

    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async () => {
            calls++
            return new Response(null, {
                status: 302,
                headers: { location: '/loop' }
            })
        },
        resolveHostname: async () => ['93.184.216.34'],
        onError: (err) => {
            caughtMessage = (err as Error).message
        }
    })

    t.equal(image, null)
    t.equal(calls, 6)
    t.equal(caughtMessage, 'Article redirected too many times')
})

test('fetchFeedText still caps at three redirects with feed wording',
    async t => {
        let calls = 0
        let caughtMessage:string|null = null

        try {
            await fetchFeedText('https://example.com/feed.xml', {
                fetchFn: async () => {
                    calls++
                    return new Response(null, {
                        status: 302,
                        headers: { location: '/loop' }
                    })
                },
                resolveHostname: async () => ['93.184.216.34']
            })
            t.fail('expected redirect cap to throw')
        } catch (_err) {
            caughtMessage = (_err as Error).message
        }

        t.equal(calls, 4)
        t.equal(caughtMessage, 'Feed redirected too many times')
    }
)

test('fetchFeedText follows 301 to trailing-slash canonical', async t => {
    const fetched:string[] = []

    const result = await fetchFeedText('https://example.com/rss', {
        fetchFn: async (url) => {
            const text = url.toString()
            fetched.push(text)
            if (text === 'https://example.com/rss') {
                return new Response(null, {
                    status: 301,
                    headers: { location: '/rss/' }
                })
            }
            return new Response('<rss></rss>', {
                status: 200,
                headers: { 'content-type': 'application/rss+xml' }
            })
        },
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(result.text, '<rss></rss>', 'returns response body')
    t.equal(
        result.url,
        'https://example.com/rss/',
        'returns final resolved URL'
    )
    t.deepEqual(
        fetched,
        ['https://example.com/rss', 'https://example.com/rss/'],
        'follows the redirect exactly once without stripping the slash'
    )
})

test('fetchOgImage returns null for blocked hosts', async t => {
    const image = await fetchOgImage('http://127.0.0.1/post', {
        fetchFn: async () => {
            t.fail('blocked host should not be fetched')
            return htmlResponse('')
        }
    })

    t.equal(image, null)
})

test('fetchOgImage returns null for non-html responses', async t => {
    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async () => new Response('{"image":"x"}', {
            headers: { 'content-type': 'application/json' }
        }),
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(image, null)
})

test('fetchOgImage drops http image results', async t => {
    const image = await fetchOgImage('https://example.com/post', {
        fetchFn: async () => htmlResponse(
            '<head><meta property="og:image" ' +
            'content="http://cdn.example.com/card.jpg"></head>'
        ),
        resolveHostname: async () => ['93.184.216.34']
    })

    t.equal(image, null)
})
