import { test } from '@substrate-system/tapzero'
import type {
    CountsResponse,
    Feed,
    Item
} from '../src/client/db/types.js'
import {
    handleLazyHtmlRequest,
    type LazyHtmlInput
} from '../src/server/lazy-html-handler.js'

const DID = 'did:plc:abc'
const SHELL = (
    '<!doctype html><html><head><title>RSSS</title></head>' +
    '<body><div id="root"></div></body></html>'
)

interface RecordedKvPut {
    key:string
    value:string
    options?:KVNamespacePutOptions
}

class KvStub {
    gets:string[] = []
    puts:RecordedKvPut[] = []
    values:Map<string, string>

    constructor (
        values = new Map<string, string>()
    ) {
        this.values = values
    }

    async get (key:string):Promise<string | null> {
        this.gets.push(key)
        return this.values.get(key) ?? null
    }

    async put (
        key:string,
        value:string,
        options?:KVNamespacePutOptions
    ):Promise<void> {
        this.puts.push({ key, value, options })
        this.values.set(key, value)
    }
}

class DoStub {
    paths:string[] = []
    version:number
    items:Item[]
    feeds:Feed[]
    counts:CountsResponse

    constructor (
        version:number,
        items:Item[],
        feeds:Feed[] = [],
        counts:CountsResponse = {
            unread: 0, starred: 0, total: 0, perFeed: {}
        }
    ) {
        this.version = version
        this.items = items
        this.feeds = feeds
        this.counts = counts
    }

    async fetch (input:RequestInfo | URL):Promise<Response> {
        const request = new Request(input)
        const url = new URL(request.url)

        this.paths.push(url.pathname)

        if (url.pathname === '/internal/feed-version') {
            return Response.json({ version: this.version })
        }

        if (url.pathname === '/internal/lazy-html-data') {
            return Response.json({
                version: this.version,
                items: this.items,
                feeds: this.feeds,
                counts: this.counts
            })
        }

        return new Response('not found', { status: 404 })
    }
}

class AssetsStub {
    requests:Request[] = []
    shell:string

    constructor (
        shell = SHELL
    ) {
        this.shell = shell
    }

    async fetch (input:RequestInfo | URL):Promise<Response> {
        const request = new Request(input)

        this.requests.push(request)

        if (new URL(request.url).pathname === '/index.html') {
            return new Response(this.shell, {
                headers: { 'content-type': 'text/html;charset=utf-8' }
            })
        }

        return new Response('asset:' + request.url, {
            headers: { 'content-type': 'text/plain;charset=utf-8' }
        })
    }
}

function item (
    id = 1
):Item {
    return {
        id,
        feed_id: 2,
        guid: 'guid-' + id,
        title: 'Title ' + id,
        link: 'https://example.com/item-' + id,
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
    }
}

function input (
    options:{
        kv?:KvStub,
        doStub?:DoStub,
        assets?:AssetsStub,
        request?:Request
    } = {}
):LazyHtmlInput {
    return {
        did: DID,
        kv: options.kv as unknown as KVNamespace,
        doStub: options.doStub as unknown as DurableObjectStub,
        assets: options.assets as unknown as Fetcher,
        request: options.request ?? new Request('https://rsss.example/', {
            headers: { accept: 'text/html' }
        })
    }
}

function bootstrapPayload (html:string):unknown {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const script = doc.querySelector('#initial-feed')

    if (!script?.textContent) {
        throw new Error('missing initial-feed bootstrap')
    }

    return JSON.parse(script.textContent)
}

test('cache miss writes key and injects bootstrap payload', async t => {
    const kv = new KvStub()
    const doStub = new DoStub(3, [item()])
    const assets = new AssetsStub()
    const response = await handleLazyHtmlRequest(input({
        kv,
        doStub,
        assets
    }))
    const html = await response.text()

    t.equal(response.status, 200, 'returns an HTML response')
    t.equal(kv.gets[0], 'html:v3:did:plc:abc:3', 'checks versioned key')
    t.equal(kv.puts.length, 1, 'stores rendered HTML on miss')
    t.equal(kv.puts[0].key, 'html:v3:did:plc:abc:3', 'writes miss key')
    t.equal(kv.puts[0].options?.expirationTtl, 2592000, 'uses 30 day ttl')
    t.deepEqual(doStub.paths, [
        '/internal/feed-version',
        '/internal/lazy-html-data'
    ], 'reads version then first-page data')
    t.deepEqual(bootstrapPayload(html), {
        version: 3,
        items: [item()],
        has_more: false,
        feeds: [],
        counts: { unread: 0, starred: 0, total: 0, perFeed: {} }
    }, 'injects parseable bootstrap')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const thumbnail = doc.querySelector(
        '#root blur-hash.item-thumbnail'
    )

    t.equal(
        thumbnail?.getAttribute('placeholder'),
        'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
        'pre-renders a first-page blurhash placeholder before JS loads'
    )
    t.equal(
        thumbnail?.getAttribute('src'),
        'https://example.com/image.jpg',
        'pre-rendered placeholder points at the OG image'
    )
})

test('cache hit returns body and skips data endpoint and put', async t => {
    const cached = (
        '<!doctype html><html><head></head>' +
        '<body>cached</body></html>'
    )
    const kv = new KvStub(new Map([['html:v3:did:plc:abc:5', cached]]))
    const doStub = new DoStub(5, [item()])
    const assets = new AssetsStub()
    const response = await handleLazyHtmlRequest(input({
        kv,
        doStub,
        assets
    }))

    t.equal(await response.text(), cached, 'returns cached shell verbatim')
    t.deepEqual(doStub.paths, [
        '/internal/feed-version'
    ], 'does not call data endpoint')
    t.equal(kv.puts.length, 0, 'does not write KV on hit')
    t.equal(assets.requests.length, 0, 'does not fetch shell on hit')
})

test('version bump invalidates cache by writing the new key', async t => {
    const kv = new KvStub(new Map([['html:v3:did:plc:abc:5', 'old']]))
    const doStub = new DoStub(6, [item(2)])
    const response = await handleLazyHtmlRequest(input({
        kv,
        doStub,
        assets: new AssetsStub()
    }))

    t.ok((await response.text()).includes('initial-feed'), 'returns injected')
    t.deepEqual(kv.gets, ['html:v3:did:plc:abc:6'], 'checks new key only')
    t.equal(kv.puts[0].key, 'html:v3:did:plc:abc:6', 'writes new key')
    t.deepEqual(doStub.paths, [
        '/internal/feed-version',
        '/internal/lazy-html-data'
    ], 'cache miss reads first-page data')
})

test('handler injects feeds and counts from DO', async t => {
    const feeds:Feed[] = [{
        id: 2,
        url: 'https://example.com/feed.xml',
        title: 'Example Feed',
        description: null,
        site_url: 'https://example.com',
        last_fetched: '2026-05-09T00:00:00.000Z',
        last_error: null,
        last_status: 200,
        created_at: '2026-05-09T00:00:00.000Z',
        updated_at: '2026-05-09T00:00:00.000Z'
    }]
    const counts:CountsResponse = {
        unread: 1, starred: 0, total: 1, perFeed: { 2: 1 }
    }
    const kv = new KvStub()
    const doStub = new DoStub(7, [item()], feeds, counts)
    const response = await handleLazyHtmlRequest(input({
        kv,
        doStub,
        assets: new AssetsStub()
    }))
    const html = await response.text()
    const parsed = bootstrapPayload(html) as {
        feeds:Feed[]
        counts:CountsResponse
    }

    t.deepEqual(parsed.feeds, feeds, 'feeds embedded in bootstrap')
    t.deepEqual(parsed.counts, counts, 'counts embedded in bootstrap')
})

test('non-html requests bypass lazy logic', async t => {
    const kv = new KvStub()
    const doStub = new DoStub(1, [item()])
    const assets = new AssetsStub()
    const request = new Request('https://rsss.example/assets/app.js', {
        headers: { accept: 'application/javascript' }
    })
    const response = await handleLazyHtmlRequest(input({
        kv,
        doStub,
        assets,
        request
    }))

    t.equal(
        await response.text(),
        'asset:https://rsss.example/assets/app.js',
        'returns asset fallback'
    )
    t.equal(kv.gets.length, 0, 'does not read KV')
    t.equal(kv.puts.length, 0, 'does not write KV')
    t.equal(doStub.paths.length, 0, 'does not call DO')
})
