# Lazy Per-User Blurhash HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate per-user `index.html` lazily on first request with the user's first-page items (and their blurhash strings) embedded as a JSON bootstrap, cache it in KV keyed by a DO-tracked feed-version, and invalidate via version bumps when ingest writes new items or new blurhash data.

**Architecture:** Each user's DO gains a `user_state.feed_version` counter, bumped whenever a new item lands or a blurhash is written. A new `HTML_KV` namespace caches `html:{did}:{version}`. A worker route intercepts SPA HTML GETs for authenticated users: it reads the version from the DO, looks up KV; on miss it pulls the first page of items from the DO, injects `<script>window.__INITIAL_FEED__ = {...}</script>` into the static `index.html`, stores in KV, and returns. Anonymous requests bypass and hit `ASSETS` directly. The Preact client consumes `window.__INITIAL_FEED__` on its first `loadItems` to skip the initial `/api/items` round-trip.

**Tech Stack:** Cloudflare Workers + Hono + Workers KV + Durable Object SQLite, Preact + `@preact/signals`, tapzero/tapout/esbuild for tests.

---

## Context

The README (lines 248–272) specifies that blurhash strings should be embedded in the static HTML served to each client so that blurhash placeholders can render before the JS bundle (or its API call) finishes. The current build of the repo already has all blurhash *production* infrastructure:

- `items.blurhash`, `og_image_url`, `image_width`, `image_height` columns in the per-user DO SQLite (`src/shared/schema.ts:52-77`)
- A queue consumer (`src/server/blurhash-consumer.ts`) that decodes images via `@cf-wasm/photon` and calls `encode()` from `blurhash`
- A KV cache `BLURHASH_KV` keyed by SHA-256 of the image URL (`src/server/blurhash.ts:21`)
- An ingest path that fills `og_image_url` and either reads from `BLURHASH_KV` or enqueues a job (`durable-objects/index.ts:1791`)
- A frontend `<blur-hash>` web component consumed by `src/client/components/item-row.ts`

What is *not* built is the per-user HTML embedding pipeline. The app today is a pure SPA: `index.html` is a bare shell served by `c.env.ASSETS.fetch(c.req.raw)` (`src/server/index.ts:1465-1472`); items load via `/api/items` *after* JS boots (`src/client/state.ts:1491-1515`). That means the user sees a skeleton loader, not the blurhash placeholders, on cold paint.

This plan adds the lazy embedding + caching pipeline and the cache-invalidation hooks described in the README.

---

## File Structure

**Created:**
- `src/server/lazy-html.ts` — pure HTML generator and KV key helpers
- `src/server/lazy-html-handler.ts` — Hono handler that ties together session lookup, DO fetch, KV cache, and ASSETS fallback
- `src/client/initial-feed.ts` — read-and-clear helper for `window.__INITIAL_FEED__`
- `src/client/initial-feed.d.ts` — `Window` augmentation
- `test/lazy-html.ts` — unit tests for the generator
- `test/lazy-html-handler.ts` — handler tests with KV/DO/ASSETS fakes
- `test/initial-feed.ts` — bootstrap helper tests

**Modified:**
- `src/shared/schema.ts` — export new `USER_STATE_SQL` block
- `src/server/durable-objects/index.ts` — apply `USER_STATE_SQL` on init, expose `GET /internal/lazy-html-data` and `GET /internal/feed-version`, bump `feed_version` at the three write sites
- `src/server/index.ts` — register `lazy-html-handler` before `app.all('*')`, register the `HTML_KV` binding type
- `src/client/state.ts` — read `window.__INITIAL_FEED__` on the first `loadItems` call
- `wrangler.jsonc` — add `HTML_KV` namespace binding
- `worker-configuration.d.ts` — regenerated (or hand-edit) to add `HTML_KV: KVNamespace` to `Env`
- `package.json` — add `test:lazy-html`, `test:initial-feed` scripts
- `test/run-all-tests.mjs` — register the new test scripts

---

## Task 1 — DO schema: `user_state.feed_version`

**Files:**
- Modify: `src/shared/schema.ts` (append after `DEAD_LETTER_OUTBOX_SQL`)
- Modify: `src/server/durable-objects/index.ts:6-9` (import) and `:386-426` (init block)

- [ ] **Step 1: Add USER_STATE_SQL export**

Append to `src/shared/schema.ts`:

```ts
/**
 * Server-only table tracking per-user counters used by the lazy
 * per-user HTML cache. Single-row table (id = 1). Bumped whenever
 * the feed item set or its blurhash data changes.
 */
export const USER_STATE_SQL = `
    CREATE TABLE IF NOT EXISTS user_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        feed_version INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO user_state (id, feed_version) VALUES (1, 0);
`
```

- [ ] **Step 2: Apply it in DO init**

In `src/server/durable-objects/index.ts`, add `USER_STATE_SQL` to the import from `'../shared/schema.js'` (line 6-9 area), then after the existing `this.sql.exec(DEAD_LETTER_OUTBOX_SQL)` at line 426 add:

```ts
this.sql.exec(USER_STATE_SQL)
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/schema.ts src/server/durable-objects/index.ts
git commit -m "feat(do): add user_state.feed_version counter for lazy html cache"
```

---

## Task 2 — DO method: `bumpFeedVersion` + `getFeedVersion`

**Files:**
- Modify: `src/server/durable-objects/index.ts` (add private helpers near the top of `UserDO` class — adjacent to other private helpers like `rowsWritten`)

- [ ] **Step 1: Write the failing test**

Create a new file `test/lazy-html-do-bump.ts` only if a DO unit-test harness exists for similar patterns. **If not** (most DO logic in this repo is exercised via integration), skip the explicit test here and rely on the handler-level tests in Task 7. Search:

```bash
grep -l "new UserDO\|UserDO.prototype" test/
```

If no harness, add `// covered by lazy-html-handler tests` comment in the handler test file later and proceed.

- [ ] **Step 2: Implement `bumpFeedVersion` and `getFeedVersion`**

Add to the `UserDO` class:

```ts
private bumpFeedVersion ():number {
    const row = this.sql.exec(
        `UPDATE user_state SET feed_version = feed_version + 1
         WHERE id = 1
         RETURNING feed_version`
    ).one() as { feed_version:number } | null
    return row?.feed_version ?? 0
}

private getFeedVersion ():number {
    const row = this.sql.exec(
        'SELECT feed_version FROM user_state WHERE id = 1'
    ).one() as { feed_version:number } | null
    return row?.feed_version ?? 0
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/durable-objects/index.ts
git commit -m "feat(do): add bumpFeedVersion / getFeedVersion helpers"
```

---

## Task 3 — Bump `feed_version` at the three write sites

**Files:**
- Modify: `src/server/durable-objects/index.ts:1602-1617` (new-items insert loop)
- Modify: `src/server/durable-objects/index.ts:1791-1823` (`updateBlurhashFromCacheOrQueue`)
- Modify: `src/server/durable-objects/index.ts:617-649` (`POST /internal/blurhash/items/:id`)

- [ ] **Step 1: Bump after new-items insert**

Find the `for (const item of parsedFeed.items)` loop near line 1580. After the loop closes and before the next block, bump once if `newItems.length > 0`. Insert immediately after the loop body finishes (before any post-loop code that uses `newItems`):

```ts
if (newItems.length > 0) {
    this.bumpFeedVersion()
}
```

- [ ] **Step 2: Bump in `updateBlurhashFromCacheOrQueue`**

Inside `updateBlurhashFromCacheOrQueue`, immediately after the `UPDATE items SET blurhash = COALESCE(...)` exec (around line 1814) and before the `return`:

```ts
this.bumpFeedVersion()
return
```

(replace the bare `return`).

- [ ] **Step 3: Bump in `POST /internal/blurhash/items/:id`**

In the `app.post('/internal/blurhash/items/:id', ...)` handler at line 617, immediately after the `UPDATE items SET blurhash = ?, ...` exec (around line 646) and before `return new Response(null, { status: 204 })`:

```ts
this.bumpFeedVersion()
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/durable-objects/index.ts
git commit -m "feat(do): bump feed_version on item insert and blurhash apply"
```

---

## Task 4 — DO endpoints: `GET /internal/feed-version`, `GET /internal/lazy-html-data`

**Files:**
- Modify: `src/server/durable-objects/index.ts` — add two routes inside the existing Hono app (next to the `/internal/blurhash/items/:id` POST at line 617)

- [ ] **Step 1: Add `/internal/feed-version`**

Insert near line 615 (next to other `/internal` routes):

```ts
app.get('/internal/feed-version', (c) => {
    return c.json({ version: this.getFeedVersion() })
})
```

- [ ] **Step 2: Add `/internal/lazy-html-data`**

This must return the version AND the first-page items in one round-trip so the worker doesn't see a torn read. Use `ITEM_COLUMNS` (already defined at line 120). Insert directly after `/internal/feed-version`:

```ts
app.get('/internal/lazy-html-data', (c) => {
    const version = this.getFeedVersion()
    const rows = this.sql.exec(
        `SELECT ${ITEM_COLUMNS}
         FROM items
         LEFT JOIN feeds ON feeds.id = items.feed_id
         ORDER BY items.pub_date DESC, items.id DESC
         LIMIT 50`
    ).toArray()
    return c.json({ version, items: rows })
})
```

(Adjust `LEFT JOIN feeds` to match what `/items` already does — copy that pattern from the existing `/items` handler at line 955 area; the join is included to allow `feed_title` aliasing if other endpoints rely on it. Use whatever shape the existing `/items` endpoint returns to keep client/server shape consistent.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/durable-objects/index.ts
git commit -m "feat(do): add internal endpoints for lazy-html data"
```

---

## Task 5 — Pure HTML generator: `src/server/lazy-html.ts`

**Files:**
- Create: `src/server/lazy-html.ts`
- Test: `test/lazy-html.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/lazy-html.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    buildLazyHtmlCacheKey,
    injectInitialFeed,
    serializeInitialFeed
} from '../src/server/lazy-html.js'

const SHELL = '<!doctype html><html><head>' +
    '<title>x</title></head><body><div id="root"></div>' +
    '</body></html>'

test('buildLazyHtmlCacheKey is deterministic and version-keyed', t => {
    t.equal(
        buildLazyHtmlCacheKey('did:plc:abc', 7),
        'html:did:plc:abc:7'
    )
    t.notEqual(
        buildLazyHtmlCacheKey('did:plc:abc', 7),
        buildLazyHtmlCacheKey('did:plc:abc', 8)
    )
})

test('serializeInitialFeed produces JSON parseable to the original payload', t => {
    const payload = {
        version: 4,
        items: [{ id: 1, blurhash: 'L9R{', og_image_url: 'https://x/y' }],
        has_more: false
    }
    const serialized = serializeInitialFeed(payload)
    const parsed = JSON.parse(serialized)
    t.deepEqual(parsed, payload)
})

test('serializeInitialFeed escapes < to prevent script-tag breakout', t => {
    const payload = {
        version: 1,
        items: [{ id: 1, title: '</script><script>alert(1)</script>' }],
        has_more: false
    }
    const serialized = serializeInitialFeed(payload)
    t.ok(
        !serialized.includes('</script>'),
        'no literal </script> in serialized output'
    )
    const parsed = JSON.parse(serialized)
    t.equal(parsed.items[0].title,
        '</script><script>alert(1)</script>')
})

test('injectInitialFeed inserts a parseable bootstrap before </head>', t => {
    const payload = {
        version: 2,
        items: [{ id: 42, blurhash: 'LE' }],
        has_more: true
    }
    const out = injectInitialFeed(SHELL, payload)
    const headEnd = out.indexOf('</head>')
    const scriptOpen = out.indexOf('<script id="initial-feed"')
    t.ok(scriptOpen > 0, 'script tag is present')
    t.ok(scriptOpen < headEnd, 'script appears before </head>')
    const match = out.match(
        /<script id="initial-feed"[^>]*>([\s\S]*?)<\/script>/
    )
    t.ok(match, 'script tag matched')
    const json = JSON.parse(match![1])
    t.deepEqual(json, payload)
})

test('injectInitialFeed is idempotent when no </head> exists', t => {
    const out = injectInitialFeed(
        '<html><body></body></html>',
        { version: 1, items: [], has_more: false }
    )
    t.equal(out, '<html><body></body></html>')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Add a `test:lazy-html` script to `package.json` `scripts`:

```json
"test:lazy-html": "esbuild ./test/lazy-html.ts --bundle | tapout",
```

Run: `npm run test:lazy-html`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/lazy-html.ts`**

```ts
/**
 * Pure helpers for the per-user lazy HTML cache.
 *
 * The HTML shell is read from the static ASSETS binding once,
 * then a JSON bootstrap is injected before </head>. The cache
 * key includes a per-user version stamp tracked in the DO so
 * that ingest can invalidate by bumping the version.
 */

import type { Item } from '../client/db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
}

/**
 * Cache key used by both the worker (read) and the version bump
 * pipeline (effectively a TTL-only invalidation; old keys age
 * out instead of being explicitly deleted).
 */
export function buildLazyHtmlCacheKey (
    did:string,
    version:number
):string {
    return `html:${did}:${version}`
}

/**
 * Serialize a payload safely for embedding inside <script>...
 * The only character that can break out of a script element is
 * `<`. JSON.stringify already escapes quotes and backslashes;
 * we additionally escape `<` so that "</script>" inside any
 * string field cannot terminate the script element.
 */
export function serializeInitialFeed (
    payload:InitialFeedPayload
):string {
    return JSON.stringify(payload).replace(/</g, '\\u003c')
}

const HEAD_END = '</head>'

export function injectInitialFeed (
    html:string,
    payload:InitialFeedPayload
):string {
    const idx = html.indexOf(HEAD_END)
    if (idx < 0) return html
    const tag = '<script id="initial-feed" type="application/json">' +
        serializeInitialFeed(payload) +
        '</script>'
    return html.slice(0, idx) + tag + html.slice(idx)
}
```

(`type="application/json"` ensures the browser does not execute the contents; the client then reads it via `document.getElementById('initial-feed').textContent` and `JSON.parse`. This avoids the `window.__INITIAL_FEED__` global executing as JS — but we still expose it as a global from `initial-feed.ts` for ergonomic client access. See Task 9.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:lazy-html`
Expected: PASS for all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/lazy-html.ts test/lazy-html.ts package.json
git commit -m "feat(server): add lazy-html generator with safe JSON bootstrap"
```

---

## Task 6 — Wrangler binding: `HTML_KV`

**Files:**
- Modify: `wrangler.jsonc` (kv_namespaces array, around lines 41-53)
- Modify: `worker-configuration.d.ts` (regenerated)

- [ ] **Step 1: Add the namespace declaration**

In `wrangler.jsonc`, in the `kv_namespaces` array (next to `BLURHASH_KV`), add:

```jsonc
{
    "binding": "HTML_KV",
    "id": "REPLACE_WITH_NAMESPACE_ID",
    "preview_id": "REPLACE_WITH_PREVIEW_ID"
}
```

Then provision the namespaces:

```bash
npx wrangler kv namespace create HTML_KV
npx wrangler kv namespace create HTML_KV --preview
```

Paste the returned IDs into the `id` and `preview_id` fields.

- [ ] **Step 2: Regenerate types**

Run: `npx wrangler types`
Expected: `worker-configuration.d.ts` now includes `HTML_KV: KVNamespace`. (If the project uses a hand-maintained `Env` interface instead, edit it manually.)

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "feat(infra): provision HTML_KV namespace for per-user html cache"
```

---

## Task 7 — Lazy-HTML handler with cache lookup

**Files:**
- Create: `src/server/lazy-html-handler.ts`
- Test: `test/lazy-html-handler.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/lazy-html-handler.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import { handleLazyHtmlRequest } from '../src/server/lazy-html-handler.js'

const SHELL = '<!doctype html><html><head><title>x</title>' +
    '</head><body><div id="root"></div></body></html>'

interface KVStub {
    store:Map<string, string>
    getCalls:string[]
    putCalls:Array<{ key:string; value:string }>
    get(key:string):Promise<string|null>
    put(key:string, value:string):Promise<void>
}

function makeKv ():KVStub {
    const store = new Map<string, string>()
    const getCalls:string[] = []
    const putCalls:Array<{ key:string; value:string }> = []
    return {
        store,
        getCalls,
        putCalls,
        async get (key) {
            getCalls.push(key)
            return store.get(key) ?? null
        },
        async put (key, value) {
            putCalls.push({ key, value })
            store.set(key, value)
        }
    }
}

interface DoStub {
    fetchCalls:string[]
    version:number
    items:unknown[]
    fetch(url:string):Promise<Response>
}

function makeDo (
    items:unknown[],
    version:number
):DoStub {
    const calls:string[] = []
    return {
        fetchCalls: calls,
        version,
        items,
        async fetch (url:string) {
            calls.push(url)
            const u = new URL(url)
            if (u.pathname === '/internal/feed-version') {
                return new Response(JSON.stringify({ version }), {
                    headers: { 'content-type': 'application/json' }
                })
            }
            if (u.pathname === '/internal/lazy-html-data') {
                return new Response(
                    JSON.stringify({ version, items }),
                    {
                        headers: {
                            'content-type': 'application/json'
                        }
                    }
                )
            }
            return new Response('not found', { status: 404 })
        }
    }
}

const ASSETS_OK = {
    async fetch () {
        return new Response(SHELL, {
            headers: { 'content-type': 'text/html' }
        })
    }
}

test('cache miss: fetches DO data, embeds, stores in KV', async t => {
    const kv = makeKv()
    const items = [{ id: 1, blurhash: 'LE', og_image_url: 'x' }]
    const doStub = makeDo(items, 3)

    const res = await handleLazyHtmlRequest({
        did: 'did:plc:abc',
        kv: kv as any,
        doStub: doStub as any,
        assets: ASSETS_OK as any,
        request: new Request('https://r/')
    })

    t.equal(res.status, 200)
    const body = await res.text()
    const m = body.match(
        /<script id="initial-feed"[^>]*>([\s\S]*?)<\/script>/
    )
    t.ok(m, 'bootstrap tag injected')
    const data = JSON.parse(m![1])
    t.equal(data.version, 3)
    t.equal(data.items.length, 1)
    t.equal(kv.putCalls.length, 1)
    t.equal(kv.putCalls[0].key, 'html:did:plc:abc:3')
})

test('cache hit: returns KV body without calling DO data endpoint',
async t => {
    const kv = makeKv()
    const cached = '<html><head><script id="initial-feed" ' +
        'type="application/json">{"version":5,"items":[],' +
        '"has_more":false}</script></head></html>'
    kv.store.set('html:did:plc:abc:5', cached)
    const doStub = makeDo([], 5)

    const res = await handleLazyHtmlRequest({
        did: 'did:plc:abc',
        kv: kv as any,
        doStub: doStub as any,
        assets: ASSETS_OK as any,
        request: new Request('https://r/')
    })

    t.equal(res.status, 200)
    const body = await res.text()
    t.equal(body, cached, 'served the cached body verbatim')
    t.equal(
        doStub.fetchCalls.filter(
            u => u.endsWith('/internal/lazy-html-data')
        ).length,
        0,
        'data endpoint NOT called on cache hit'
    )
    t.equal(kv.putCalls.length, 0, 'no put on cache hit')
})

test('version bump invalidates: same did, new version → miss',
async t => {
    const kv = makeKv()
    kv.store.set('html:did:plc:abc:5', '<old/>')
    const doStub = makeDo([{ id: 9 }], 6)

    const res = await handleLazyHtmlRequest({
        did: 'did:plc:abc',
        kv: kv as any,
        doStub: doStub as any,
        assets: ASSETS_OK as any,
        request: new Request('https://r/')
    })

    const body = await res.text()
    t.notEqual(body, '<old/>')
    t.equal(kv.putCalls[0].key, 'html:did:plc:abc:6')
    t.ok(
        doStub.fetchCalls.some(
            u => u.endsWith('/internal/lazy-html-data')
        ),
        'data endpoint called for new version'
    )
})

test('non-html accept header bypasses lazy logic', async t => {
    const kv = makeKv()
    const doStub = makeDo([], 1)
    const req = new Request('https://r/feed.json', {
        headers: { accept: 'application/json' }
    })
    const res = await handleLazyHtmlRequest({
        did: 'did:plc:abc',
        kv: kv as any,
        doStub: doStub as any,
        assets: ASSETS_OK as any,
        request: req
    })
    t.equal(kv.getCalls.length, 0)
    t.equal(doStub.fetchCalls.length, 0)
    t.equal(res.status, 200)
})
```

- [ ] **Step 2: Wire the test script and run to verify failure**

Add to `package.json`:

```json
"test:lazy-html-handler": "esbuild ./test/lazy-html-handler.ts --bundle --alias:cloudflare:workers=./test/cloudflare-workers-stub.ts | tapout",
```

Run: `npm run test:lazy-html-handler`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/lazy-html-handler.ts`**

```ts
import {
    buildLazyHtmlCacheKey,
    injectInitialFeed,
    type InitialFeedPayload
} from './lazy-html.js'

interface AssetFetcher {
    fetch(req:Request):Promise<Response>
}

interface KvLike {
    get(key:string):Promise<string|null>
    put(
        key:string,
        value:string,
        opts?:{ expirationTtl?:number }
    ):Promise<void>
}

interface DoLike {
    fetch(url:string):Promise<Response>
}

export interface LazyHtmlInput {
    did:string
    kv:KvLike
    doStub:DoLike
    assets:AssetFetcher
    request:Request
}

const HTML_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30  // 30 days

function wantsHtml (req:Request):boolean {
    if (req.method !== 'GET') return false
    const accept = req.headers.get('accept') || ''
    return accept.includes('text/html')
}

export async function handleLazyHtmlRequest (
    input:LazyHtmlInput
):Promise<Response> {
    const { did, kv, doStub, assets, request } = input

    if (!wantsHtml(request)) {
        return assets.fetch(request)
    }

    const versionRes = await doStub.fetch(
        'http://do/internal/feed-version'
    )
    if (!versionRes.ok) return assets.fetch(request)
    const { version } = await versionRes.json<{ version:number }>()

    const key = buildLazyHtmlCacheKey(did, version)
    const cached = await kv.get(key)
    if (cached !== null) {
        return new Response(cached, {
            headers: { 'content-type': 'text/html;charset=utf-8' }
        })
    }

    const dataRes = await doStub.fetch(
        'http://do/internal/lazy-html-data'
    )
    if (!dataRes.ok) return assets.fetch(request)
    const data = await dataRes.json<{
        version:number
        items:unknown[]
    }>()

    const shellRes = await assets.fetch(
        new Request(new URL('/index.html', request.url).toString())
    )
    if (!shellRes.ok) return shellRes
    const shell = await shellRes.text()

    const payload:InitialFeedPayload = {
        version: data.version,
        items: data.items as InitialFeedPayload['items'],
        has_more: data.items.length >= 50
    }
    const html = injectInitialFeed(shell, payload)

    await kv.put(
        buildLazyHtmlCacheKey(did, data.version),
        html,
        { expirationTtl: HTML_CACHE_TTL_SECONDS }
    )

    return new Response(html, {
        headers: { 'content-type': 'text/html;charset=utf-8' }
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:lazy-html-handler`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/lazy-html-handler.ts test/lazy-html-handler.ts package.json
git commit -m "feat(server): add lazy-html handler with KV+DO cache lookup"
```

---

## Task 8 — Wire handler into worker route table

**Files:**
- Modify: `src/server/index.ts:1465-1472`

- [ ] **Step 1: Replace the catch-all to consult the lazy handler**

At the top of `src/server/index.ts`, add the import:

```ts
import { handleLazyHtmlRequest } from './lazy-html-handler.js'
```

Replace lines 1465-1472:

```ts
app.all('*', async (c) => {
    if (!c.env?.ASSETS) {
        return c.notFound()
    }

    const session = c.get('session') as
        | { did:string } | undefined
    const did = session?.did

    if (did && c.env.HTML_KV && c.env.USER_DO) {
        const stub = getUserDO(c.env, did)
        return handleLazyHtmlRequest({
            did,
            kv: c.env.HTML_KV,
            doStub: stub,
            assets: c.env.ASSETS,
            request: c.req.raw
        })
    }

    return c.env.ASSETS.fetch(c.req.raw)
})
```

(`getUserDO` is already used elsewhere in this file; reuse the existing helper signature — confirm the exact name/import. The handler's `wantsHtml` guard means non-HTML asset requests still hit `ASSETS.fetch` from inside the handler, so this change is safe for `.js`, `.css`, `.png` etc.)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Smoke test in dev**

Run: `npm run start` (in another terminal)
Then: `curl -s -H 'cookie: session=<valid>' -H 'accept: text/html' http://localhost:5173/ | grep initial-feed`
Expected: A line containing `<script id="initial-feed" type="application/json">{...}</script>` with feed JSON.

For an unauthenticated request: `curl -s -H 'accept: text/html' http://localhost:5173/` should still return the shell without the script tag.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): route html GETs through lazy-html cache for signed-in users"
```

---

## Task 9 — Client bootstrap: read `__INITIAL_FEED__`

**Files:**
- Create: `src/client/initial-feed.ts`
- Create: `src/client/initial-feed.d.ts`
- Test: `test/initial-feed.ts`
- Modify: `src/client/state.ts:1491-1515` (`State.loadItems`)

- [ ] **Step 1: Write the failing tests**

Create `test/initial-feed.ts`:

```ts
import { test } from '@substrate-system/tapzero'
import {
    consumeInitialFeed,
    readInitialFeedFromDom
} from '../src/client/initial-feed.js'

test('readInitialFeedFromDom parses #initial-feed JSON', t => {
    const script = document.createElement('script')
    script.id = 'initial-feed'
    script.type = 'application/json'
    script.textContent = JSON.stringify({
        version: 7,
        items: [{ id: 1 }],
        has_more: false
    })
    document.head.appendChild(script)

    const out = readInitialFeedFromDom()
    t.ok(out, 'returns payload')
    t.equal(out!.version, 7)
    t.equal(out!.items.length, 1)

    script.remove()
})

test('readInitialFeedFromDom returns null when absent', t => {
    const out = readInitialFeedFromDom()
    t.equal(out, null)
})

test('consumeInitialFeed returns then clears the global', t => {
    const w = window as unknown as {
        __INITIAL_FEED__?:{ version:number; items:unknown[];
            has_more:boolean }
    }
    w.__INITIAL_FEED__ = {
        version: 1,
        items: [{ id: 9 }],
        has_more: false
    }
    const first = consumeInitialFeed()
    t.ok(first)
    t.equal(first!.version, 1)
    const second = consumeInitialFeed()
    t.equal(second, null, 'cleared after first read')
})

test('consumeInitialFeed falls through to DOM if global missing', t => {
    const script = document.createElement('script')
    script.id = 'initial-feed'
    script.type = 'application/json'
    script.textContent = JSON.stringify({
        version: 11,
        items: [],
        has_more: true
    })
    document.head.appendChild(script)

    const out = consumeInitialFeed()
    t.ok(out)
    t.equal(out!.version, 11)
    script.remove()
})
```

- [ ] **Step 2: Wire the test script and run to verify failure**

Add to `package.json`:

```json
"test:initial-feed": "esbuild ./test/initial-feed.ts --bundle | tapout",
```

Run: `npm run test:initial-feed`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/client/initial-feed.ts`**

```ts
import type { Item } from './db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
}

declare global {
    interface Window {
        __INITIAL_FEED__?:InitialFeedPayload
    }
}

export function readInitialFeedFromDom ():InitialFeedPayload|null {
    if (typeof document === 'undefined') return null
    const el = document.getElementById('initial-feed')
    if (!el) return null
    try {
        return JSON.parse(el.textContent || '') as InitialFeedPayload
    } catch {
        return null
    }
}

let consumed = false

/**
 * Returns the embedded initial feed payload (from window or DOM)
 * exactly once. Subsequent calls return null so that the client
 * falls back to its normal API fetch path on later refreshes.
 */
export function consumeInitialFeed ():InitialFeedPayload|null {
    if (consumed) return null
    consumed = true
    const w = window as Window
    if (w.__INITIAL_FEED__) {
        const v = w.__INITIAL_FEED__
        delete w.__INITIAL_FEED__
        return v
    }
    return readInitialFeedFromDom()
}

/** Test-only reset. */
export function _resetConsumedForTests ():void {
    consumed = false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Note: The `consumeInitialFeed` tests need the module-level `consumed` flag reset between test cases. Add an explicit `_resetConsumedForTests()` call at the start of each `consumeInitialFeed` test. Update the test file accordingly:

```ts
import { _resetConsumedForTests } from '../src/client/initial-feed.js'
// at the start of each consumeInitialFeed test:
_resetConsumedForTests()
```

Run: `npm run test:initial-feed`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Use it in `State.loadItems`**

In `src/client/state.ts`, add at the imports (top of file):

```ts
import { consumeInitialFeed } from './initial-feed.js'
```

Replace `State.loadItems` (lines 1491-1515) with:

```ts
State.loadItems = async function (
    state:AppState
):Promise<void> {
    const initial = consumeInitialFeed()
    if (initial && initial.items.length > 0) {
        batch(() => {
            state.items.value = initial.items as Item[]
            state.itemsTotal.value = initial.items.length
            state.itemsLoading.value = false
        })
        recomputeCacheStatus(state).catch(() => {})
        return
    }

    state.itemsLoading.value = true

    let data:ItemsResponse|null = null
    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        data = await adapter.getItems(buildItemOptions(state))
    } catch (err) {
        debug('Error loading items:', err)
    }

    batch(() => {
        if (data) {
            state.items.value = data.items as Item[]
            state.itemsTotal.value = data.total
        }
        state.itemsLoading.value = false
    })

    recomputeCacheStatus(state).catch(() => {})
}
```

- [ ] **Step 6: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/client/initial-feed.ts test/initial-feed.ts \
    src/client/state.ts package.json
git commit -m "feat(client): consume window.__INITIAL_FEED__ on first paint"
```

---

## Task 10 — Register new test scripts in the all-tests runner

**Files:**
- Modify: `test/run-all-tests.mjs`

- [ ] **Step 1: Inspect the current runner**

Run: `head -40 test/run-all-tests.mjs`
Look at how existing scripts are listed (e.g. as an array of npm-script names). Add the new entries `test:lazy-html`, `test:lazy-html-handler`, `test:initial-feed` in the same place, in the same style — match what's already there.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: All tests pass, including the three new ones.

- [ ] **Step 3: Commit**

```bash
git add test/run-all-tests.mjs
git commit -m "test: include lazy-html and initial-feed suites in npm test"
```

---

## Task 11 — End-to-end sanity in dev

**Files:** none

- [ ] **Step 1: Reset local state**

Run: `npm run db:reset`

- [ ] **Step 2: Start dev**

Run: `npm run start`

- [ ] **Step 3: Sign in, add a feed with og images**

In a browser, visit `http://localhost:5173/`. Sign in with a test ATProto account. Add a feed known to expose `og:image` (e.g. a typical blog).

- [ ] **Step 4: Wait for the blurhash queue to land**

Watch wrangler logs for `blurhash-jobs` queue activity. Wait until at least one item has a blurhash (DevTools → Storage → IndexedDB or `/api/items` response).

- [ ] **Step 5: Hard reload and inspect first paint**

Open DevTools → Network. Hard-reload `/`. Look at the response body for `/`:
- Confirm there is a `<script id="initial-feed" type="application/json">` element in the response.
- Parse its contents and confirm at least one item has a non-empty `blurhash`.

- [ ] **Step 6: Confirm second hit is cache**

Hard-reload again. The DO `lazy-html-data` endpoint should NOT be hit a second time at the same `feed_version`. Verify via wrangler logs (no `/internal/lazy-html-data` log line on the second request).

- [ ] **Step 7: Confirm invalidation**

Add a new feed with og images. After ingest completes (logs show new items), reload. Observe a new KV key `html:{did}:{newVersion}` being written (wrangler `kv list` against `HTML_KV` shows the new key).

- [ ] **Step 8: Confirm anonymous fallthrough**

Sign out. Reload `/`. Body should contain the bare shell (no `id="initial-feed"` script). The handler must not have called the DO (no log line).

- [ ] **Step 9: Confirm the `<blur-hash>` placeholder paints early**

Throttle network to "Slow 3G" in DevTools. Reload `/`. The blurhash placeholders for the first-page items should be visible before the JS bundle finishes loading (because the items list and their `blurhash` strings were embedded in the response, so `ItemRow` + `<blur-hash>` render on the very first synchronous Preact pass after the bundle parses).

---

## Verification Summary

End-to-end signals that this is shipping correctly:

- `npm test` passes, including `test:lazy-html`, `test:lazy-html-handler`, `test:initial-feed`.
- `npm run typecheck && npm run lint` pass.
- A `curl -H 'accept: text/html' -H 'cookie: session=...' /` response body contains a `<script id="initial-feed" type="application/json">` whose JSON has a non-empty `items` array.
- A repeat curl at the same `feed_version` does not hit `/internal/lazy-html-data` on the DO.
- After ingesting a new item with `og_image_url`, `feed_version` is incremented in the DO's `user_state` and a new `HTML_KV` key is written on the next request.
- Anonymous requests still receive the static shell.

---

## Notes on test brittleness (per project guidance)

The tests above deliberately avoid asserting on raw HTML *text* shapes. They:

- Parse JSON out of the bootstrap script tag and assert on its parsed structure.
- Assert on observable side effects (KV `put` call count, DO `fetch` call list).
- Assert on cache key shape (a contract the handler has to honour) rather than on the rendered HTML body.

The single exception is the cache-hit test, which asserts that the cached body is returned verbatim — that's the contract of "cache hit", not a content-equality check on rendered HTML.

No tests exist for the README/docs.
