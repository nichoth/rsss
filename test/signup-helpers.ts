/**
 * Shared helpers for the signup test suite.
 *
 * Pure data-shaping and runtime stubs only -- no imports from
 * browser-only client modules so this file can be bundled for either
 * Node (server tests) or Chromium (UI tests).
 */
import {
    createSessionCookie,
    type OAuthSession
} from '../src/server/auth/oauth.js'
import { didToCustomerId } from '../src/server/autumn-billing.js'

// ---------------------------------------------------------------
// In-memory KV stub
// ---------------------------------------------------------------

interface KvOpts { expirationTtl?:number }

export function makeKv () {
    const store = new Map<string, string>()
    const expires = new Map<string, number>()
    return {
        store,
        async get (key:string):Promise<string|null> {
            const exp = expires.get(key)
            if (exp && exp < Date.now()) {
                store.delete(key)
                expires.delete(key)
                return null
            }
            return store.get(key) ?? null
        },
        async put (
            key:string,
            value:string,
            opts?:KvOpts
        ):Promise<void> {
            store.set(key, value)
            if (opts?.expirationTtl) {
                expires.set(
                    key,
                    Date.now() + opts.expirationTtl * 1000
                )
            }
        },
        async delete (key:string):Promise<void> {
            store.delete(key)
            expires.delete(key)
        },
        async list (
            options?:{ prefix?:string }
        ):Promise<{ keys:Array<{ name:string }> }> {
            const prefix = options?.prefix
            const names = Array.from(store.keys())
                .filter(k => !prefix || k.startsWith(prefix))
                .map(name => ({ name }))
            return { keys: names }
        }
    }
}

export type Kv = ReturnType<typeof makeKv>

// ---------------------------------------------------------------
// Test env factory
// ---------------------------------------------------------------

export const SESSION_SECRET = 'test-secret-key-32-chars-long!!!'
export const TEST_CSRF_TOKEN = 'test-csrf'

export interface TestEnv {
    SESSIONS:Kv;
    SESSION_SECRET:string;
    USER_DO:unknown;
    ASSETS:unknown;
    AUTUMN_SECRET_KEY?:string;
    AUTUMN_DISABLED?:string;
    RESEND_API_KEY?:string;
    RESEND_DISABLED?:string;
    NODE_ENV:string;
    APP_ORIGIN?:string;
}

export function makeEnv (overrides:Partial<TestEnv> = {}):TestEnv {
    return {
        SESSIONS: makeKv(),
        SESSION_SECRET,
        USER_DO: {},
        ASSETS: {},
        NODE_ENV: 'test',
        ...overrides
    }
}

/**
 * Stub Cloudflare ExecutionContext. The billing handlers read
 * `c.executionCtx` (whose getter throws when missing) to schedule
 * background email retries via `waitUntil`.
 */
export const executionCtx = {
    waitUntil (p:Promise<unknown>):void {
        // Surface async errors to the console rather than swallowing.
        p.catch(err => {
            console.error('waitUntil rejection:', err)
        })
    },
    passThroughOnException ():void {}
} as unknown as ExecutionContext

export async function makeSession (
    env:TestEnv,
    session:OAuthSession = {
        did: 'did:plc:alice',
        handle: 'alice.bsky.social'
    }
):Promise<{ session:OAuthSession; cookieHeader:string }> {
    const cookie = await createSessionCookie(
        session,
        env.SESSION_SECRET,
        env.SESSIONS as unknown as KVNamespace
    )
    return {
        session,
        cookieHeader: `session=${cookie}; csrf_token=${TEST_CSRF_TOKEN}`
    }
}

// ---------------------------------------------------------------
// Fetch interceptor for Autumn / Resend
// ---------------------------------------------------------------

export interface RecordedCall {
    url:string;
    method:string;
    body:unknown;
    headers:Record<string, string>;
}

export interface FetchHandler {
    (call:RecordedCall):Response|Promise<Response>;
}

function collectHeaders (
    h:HeadersInit|undefined
):Record<string, string> {
    const out:Record<string, string> = {}
    if (!h) return out
    if (h instanceof Headers) {
        h.forEach((v, k) => { out[k.toLowerCase()] = v })
    } else if (Array.isArray(h)) {
        for (const [k, v] of h) out[k.toLowerCase()] = v
    } else {
        for (const k of Object.keys(h)) {
            out[k.toLowerCase()] = (h as Record<string, string>)[k]
        }
    }
    return out
}

export function withFetch<T> (
    handler:FetchHandler,
    fn:(calls:RecordedCall[]) => Promise<T>
):Promise<T> {
    const original = globalThis.fetch
    const calls:RecordedCall[] = []
    globalThis.fetch = (async (
        input:RequestInfo|URL,
        init?:RequestInit
    ) => {
        let url:string
        let method:string
        let headers:Record<string, string>
        let bodyText:string|null = null

        if (input instanceof Request) {
            url = input.url
            method = init?.method ?? input.method
            const initHeaders = init?.headers ?
                collectHeaders(init.headers) :
                {}
            const reqHeaders = collectHeaders(input.headers)
            headers = { ...reqHeaders, ...initHeaders }
            if (typeof init?.body === 'string') {
                bodyText = init.body
            } else if (init?.body) {
                bodyText = String(init.body)
            } else {
                try {
                    bodyText = await input.clone().text()
                    if (!bodyText) bodyText = null
                } catch {
                    bodyText = null
                }
            }
        } else {
            url = typeof input === 'string' ?
                input :
                input.toString()
            method = init?.method ?? 'GET'
            headers = collectHeaders(init?.headers)
            if (typeof init?.body === 'string') {
                bodyText = init.body
            }
        }

        let body:unknown = bodyText
        if (bodyText) {
            try {
                body = JSON.parse(bodyText)
            } catch {
                body = bodyText
            }
        }

        const call:RecordedCall = { url, method, body, headers }
        calls.push(call)
        return await handler(call)
    }) as typeof fetch
    return fn(calls).finally(() => {
        globalThis.fetch = original
    })
}

export function jsonResponse (body:unknown, status = 200):Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

// ---------------------------------------------------------------
// Autumn payload builders
// ---------------------------------------------------------------

export function customerBody (
    did:string,
    email:string|null = 'alice@example.com',
    subscriptions:unknown[] = []
) {
    return {
        id: didToCustomerId(did),
        name: 'alice.bsky.social',
        email,
        created_at: 1700000000000,
        fingerprint: null,
        stripe_id: null,
        env: 'live',
        metadata: {},
        send_email_receipts: true,
        billing_controls: {},
        subscriptions,
        purchases: [],
        balances: {},
        flags: {}
    }
}

export function activeSubscription () {
    return {
        id: 'sub_active',
        plan_id: 'local-first',
        auto_enable: false,
        add_on: false,
        status: 'active',
        past_due: false,
        canceled_at: null,
        expires_at: null,
        trial_ends_at: null,
        started_at: 1700000000000,
        current_period_start: null,
        current_period_end: null,
        quantity: 1
    }
}
