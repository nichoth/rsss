import { test } from '@substrate-system/tapzero'
import {
    createSessionCookie,
    verifySessionCookie,
    type OAuthSession
} from '../src/server/auth/oauth.js'

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

function base64UrlDecode (value:string):string {
    const padded = value + '='.repeat((4 - value.length % 4) % 4)
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
    return atob(base64)
}

test('session cookie stores a URL-safe base64 payload', async t => {
    const kv = new MemoryKv()
    const session:OAuthSession = {
        did: 'did:plc:reader',
        handle: 'reader.example'
    }

    const cookie = await createSessionCookie(
        session,
        'secret',
        kv as unknown as KVNamespace
    )
    const [payloadB64, signatureB64] = cookie.split('.')

    t.ok(payloadB64, 'has payload segment')
    t.ok(signatureB64, 'has signature segment')
    t.equal(cookie.includes('+'), false, 'has no plus characters')
    t.equal(cookie.includes('/'), false, 'has no slash characters')
    t.equal(cookie.includes('='), false, 'has no padding characters')

    let payload:{ sid?:unknown } = {}
    try {
        payload = JSON.parse(base64UrlDecode(payloadB64))
    } catch (err) {
        t.fail(`payload should decode as JSON: ${(err as Error).message}`)
    }

    t.equal(typeof payload.sid, 'string', 'payload carries the session id')
    t.ok(kv.data.has(`session:${payload.sid}`), 'session id maps to KV')
})

test('session cookie verifies round trip and rejects tampering', async t => {
    const kv = new MemoryKv()
    const session:OAuthSession = {
        did: 'did:plc:reader',
        handle: 'reader.example'
    }
    const cookie = await createSessionCookie(
        session,
        'secret',
        kv as unknown as KVNamespace
    )

    const verified = await verifySessionCookie(
        cookie,
        'secret',
        kv as unknown as KVNamespace
    )
    const tampered = `${cookie.slice(0, -1)}x`
    const rejected = await verifySessionCookie(
        tampered,
        'secret',
        kv as unknown as KVNamespace
    )

    t.deepEqual(verified, session, 'loads session from a valid cookie')
    t.equal(rejected, null, 'rejects a tampered signature')
})
