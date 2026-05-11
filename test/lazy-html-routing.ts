/**
 * Runs in Node because browser fetch strips Cookie request headers.
 */
import { test } from '@substrate-system/tapzero'
import { createSessionCookie } from '../src/server/auth/oauth.js'
import app from '../src/server/index.js'

const TEST_DID = 'did:plc:reader'
const TEST_HANDLE = 'reader.example'
const SESSION_SECRET = 'test-secret'
const SHELL = (
    '<html><head><title>RSSS</title></head>' +
    '<body><div id="root"></div></body></html>'
)

class MemoryKv {
    data = new Map<string, string>()

    async get (key:string):Promise<string|null> {
        return this.data.get(key) ?? null
    }

    async put (key:string, value:string):Promise<void> {
        this.data.set(key, value)
    }

    async delete (key:string):Promise<void> {
        this.data.delete(key)
    }
}

class HtmlKvStub extends MemoryKv {
    gets:string[] = []
    puts:string[] = []

    async get (key:string):Promise<string|null> {
        this.gets.push(key)
        return super.get(key)
    }

    async put (key:string, value:string):Promise<void> {
        this.puts.push(key)
        await super.put(key, value)
    }
}

class AssetsStub {
    paths:string[] = []

    async fetch (input:RequestInfo | URL):Promise<Response> {
        const request = new Request(input)
        const pathname = new URL(request.url).pathname

        this.paths.push(pathname)

        if (pathname === '/index.html' || pathname === '/') {
            return new Response(SHELL, {
                headers: {
                    'content-type': 'text/html;charset=utf-8'
                }
            })
        }

        return new Response(`asset:${pathname}`, {
            headers: { 'content-type': 'text/plain;charset=utf-8' }
        })
    }
}

class UserDoStub {
    paths:string[] = []

    async fetch (input:RequestInfo | URL):Promise<Response> {
        const request = new Request(input)
        const pathname = new URL(request.url).pathname

        this.paths.push(pathname)

        if (pathname === '/internal/feed-version') {
            return Response.json({ version: 9 })
        }

        if (pathname === '/internal/lazy-html-data') {
            return Response.json({
                version: 9,
                items: [{
                    id: 1,
                    feed_id: 2,
                    guid: 'guid-1',
                    title: 'From DO',
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
                }],
                feeds: [{
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
                }],
                counts: {
                    unread: 1, starred: 0, total: 1, perFeed: { 2: 1 }
                }
            })
        }

        return new Response('not found', { status: 404 })
    }
}

async function makeEnv ():Promise<{
    env:Record<string, unknown>;
    htmlKv:HtmlKvStub;
    userDo:UserDoStub;
    cookie:string;
}> {
    const sessions = new MemoryKv()
    const htmlKv = new HtmlKvStub()
    const assets = new AssetsStub()
    const userDo = new UserDoStub()
    const cookie = await createSessionCookie(
        { did: TEST_DID, handle: TEST_HANDLE },
        SESSION_SECRET,
        sessions as unknown as KVNamespace
    )

    return {
        env: {
            SESSION_SECRET,
            SESSIONS: sessions as unknown as KVNamespace,
            HTML_KV: htmlKv as unknown as KVNamespace,
            ASSETS: assets as unknown as Fetcher,
            USER_DO: {
                idFromName: () => 'id',
                get: () => userDo
            },
            NODE_ENV: 'test'
        },
        htmlKv,
        userDo,
        cookie
    }
}

test('worker injects initial feed for authenticated HTML', async (t) => {
    const { env, htmlKv, userDo, cookie } = await makeEnv()
    const res = await app.request(
        'https://rsss.space/',
        {
            headers: {
                accept: 'text/html',
                cookie: `session=${cookie}`
            }
        },
        env
    )
    const body = await res.text()

    t.equal(res.status, 200)
    t.ok(
        body.includes('id="initial-feed"'),
        'authenticated HTML receives bootstrap script'
    )
    t.deepEqual(userDo.paths, [
        '/internal/feed-version',
        '/internal/lazy-html-data'
    ])
    t.deepEqual(htmlKv.gets, ['html:v3:did:plc:reader:9'])
    t.deepEqual(htmlKv.puts, ['html:v3:did:plc:reader:9'])
})

test('worker serves anonymous HTML shell without lazy DO calls', async (t) => {
    const { env, userDo } = await makeEnv()
    const res = await app.request(
        'https://rsss.space/',
        { headers: { accept: 'text/html' } },
        env
    )
    const body = await res.text()

    t.equal(res.status, 200)
    t.ok(!body.includes('id="initial-feed"'), 'shell is not bootstrapped')
    t.deepEqual(userDo.paths, [], 'does not call the user DO')
})

test('worker serves authenticated assets without lazy DO calls', async (t) => {
    const { env, userDo, cookie } = await makeEnv()
    const res = await app.request(
        'https://rsss.space/assets/app.js',
        {
            headers: {
                accept: 'application/javascript',
                cookie: `session=${cookie}`
            }
        },
        env
    )

    t.equal(await res.text(), 'asset:/assets/app.js')
    t.deepEqual(userDo.paths, [], 'does not call the user DO')
})
