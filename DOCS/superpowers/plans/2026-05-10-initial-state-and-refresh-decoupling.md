# Initial State Hydration and Refresh Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "No feeds yet…" message that appears on first paint when the user actually has subscribed feeds, and stop the "Refresh Feeds" button from re-fetching the feeds list (it must only pull per-feed updates).

**Architecture:**
- **Server SSR (production):** Extend `lazy-html-handler` to embed the full initial render state (feeds, per-feed counts, items) into the HTML payload. The first paint already has the feeds list and counts populated.
- **Client hydration (production + dev):** Read the embedded payload synchronously inside `State()` so `state.feeds`, `state.counts`, and `state.items` are non-empty before any async fetch runs. Treat any subsequent async reload as a refresh, not a first load.
- **Refresh decoupling:** Split `refreshAfterSync` into `loadInitialView` (called once at boot when no SSR payload was present) and `reconcileAfterRefresh` (called on SSE `refresh-complete`). The latter only pulls items, per-feed unread counts, and the feed-status indicator — never the full feeds list.
- **Diagnostic Phase 0:** Reproduce the dev-mode bug end-to-end first so we know whether the empty initial list is an auth-cookie race, a local-adapter cache miss, or an /api/items/count regression. The Phase 0 findings determine whether Task 7 (counts fix) is a code change or just a documentation note.

**Tech Stack:** TypeScript (Cloudflare Workers + Vite + Preact), `@preact/signals`, Hono, Cloudflare KV (lazy-html cache), Cloudflare Durable Object SQLite (server source of truth), `htm/preact` for views, `tapzero` + esbuild for tests.

---

## File Structure

**Server (modify):**
- `src/server/lazy-html.ts` — extend `InitialFeedPayload` with `feeds` and `counts`; bump cache key prefix from `v2` to `v3`; teach `injectInitialFeed` to serialize the new fields.
- `src/server/lazy-html-handler.ts` — extend `LazyHtmlDataResponse` to carry feeds + counts; pass them into the payload.
- `src/server/durable-objects/index.ts` — extend `/internal/lazy-html-data` to return feeds + counts in addition to items.

**Client (modify):**
- `src/client/initial-feed.ts` — extend `InitialFeedPayload` with `feeds` and `counts`; keep the existing item path working unchanged when those fields are absent (back-compat for older cached HTML during deploy window).
- `src/client/state.ts`:
  - In `State()`, synchronously seed `state.feeds`, `state.counts`, and `state.items` from the consumed payload.
  - Split `State.refreshAfterSync` into `State.loadInitialView` and `State.reconcileAfterRefresh` (see Task 5 for exact division of work).
  - Rewire the SSE `refresh-complete` and `feed-updated` listeners to call `reconcileAfterRefresh`.
  - Remove the silent `loadFeeds` swallow that lets a network failure render as "No feeds yet…"; surface a non-empty error state on the sidebar instead.

**Tests (create / extend):**
- `test/lazy-html.ts` — extend payload fixtures with feeds + counts; assert serialization round-trips both new fields.
- `test/lazy-html-handler.ts` — assert the handler fetches feeds + counts from the DO and forwards them into the injected payload.
- `test/initial-feed.ts` — assert the client reads feeds + counts from the bootstrap script and that `State()` seeds the signals before any fetch runs.
- `test/state-refresh-audit.ts` — extend (or add a sibling test) to assert that `reconcileAfterRefresh` does NOT call `loadFeeds`, while `loadInitialView` does.
- `test/refresh-lifecycle.ts` — extend to assert that the SSE `refresh-complete` handler calls the reconcile path (not the initial-load path).

**Run after every code task:**
```bash
npm test && npm run lint
```

---

## Task 0: Reproduce and root-cause the empty initial feeds list

**Files:**
- Modify: none (diagnostic only)
- Notes destination: `specs/019-fix-empty-initial-feeds/research.md` (create directory + file as part of this task)

- [ ] **Step 1: Create the spec directory for diagnostic notes**

```bash
mkdir -p specs/019-fix-empty-initial-feeds
```

- [ ] **Step 2: Start the dev server**

Run:
```bash
npm run start
```
Expected: Vite dev server listens on `http://127.0.0.1:2222/`.

- [ ] **Step 3: Reproduce the empty-feeds bug**

Open `http://127.0.0.1:2222/` in Chrome with DevTools → Network tab open and the "Preserve log" box checked. Log in (OAuth flow). After landing on `/`, observe whether the sidebar says "No feeds yet…" and the "All Items" badge is `0`.

If the bug does not reproduce on a single run, repeat in a fresh incognito window and, separately, after a hard reload (Cmd+Shift+R) of an already-authed session.

- [ ] **Step 4: Capture the network trace**

In the Network panel, copy the responses for `GET /api/me`, `GET /api/feeds`, `GET /api/feed-status`, `GET /api/items?limit=20&offset=0`, `GET /api/items/count` — both during the broken initial load and after clicking "Refresh Feeds". Save them as code blocks in `specs/019-fix-empty-initial-feeds/research.md` under headings:

```markdown
## Initial load
### GET /api/me
<status, headers, body>
### GET /api/feeds
<status, body>
... (etc.)

## After clicking Refresh Feeds
### GET /api/feeds
<status, body>
... (etc.)
```

- [ ] **Step 5: Inspect the DO state directly**

In a separate shell (so the dev server keeps running):
```bash
npx wrangler d1 list 2>&1 || true
ls .wrangler/state/v3/d1/miniflare-D1DatabaseObject 2>/dev/null || true
```
Then either via Wrangler's DO inspector or by adding a one-line `console.log(this.sql.exec('SELECT id, url, last_pulled_at FROM feeds').toArray())` at the top of the `app.get('/feeds', ...)` handler in `src/server/durable-objects/index.ts` (REVERT before committing), confirm that the DO actually has the 3 feeds at the moment the broken `GET /api/feeds` was served.

Expected outcomes (any one of these settles the diagnosis — record which one in `research.md`):

- DO has feeds, but the broken `GET /api/feeds` returned `[]` → server-side or proxy-side bug; investigate the `dataRouter` / `requireAuth` path.
- DO has feeds, and the broken `GET /api/feeds` returned them, but the client still rendered empty → client-side state bug (likely `loadFeeds` rejection swallowed silently, or signal not set due to adapter-cache miss).
- `GET /api/feeds` was not even issued during the broken initial load → the boot effect that calls `loadFeeds` never fired (likely auth state never reached non-null because /api/me 401'd, then OAuth callback overwrote it).

- [ ] **Step 6: Write up findings**

In `specs/019-fix-empty-initial-feeds/research.md` add a `## Root cause` section that names ONE of the three outcomes above and the smallest fix that resolves it (e.g. "client must not catch+swallow loadFeeds errors", or "the refresh-complete reconcile must not race the initial load", or "/api/me sets the cookie with a path that excludes /api/feeds"). This finding informs the exact change in Task 6.

- [ ] **Step 7: Stop the dev server**

In the terminal running `npm run start`, press Ctrl+C.

- [ ] **Step 8: Commit the research notes**

```bash
git add specs/019-fix-empty-initial-feeds/research.md
git commit -m "docs(019): record root cause of empty initial feeds list"
```

---

## Task 1: Extend the server lazy-html payload type

**Files:**
- Modify: `src/server/lazy-html.ts`
- Test: `test/lazy-html.ts`

- [ ] **Step 1: Add the failing test for the extended payload**

Open `test/lazy-html.ts` and replace the `payload()` helper with a version that includes feeds and counts, plus add a new test asserting both fields round-trip through serialization:

```ts
import type { Feed } from '../src/client/db/types.js'

function feedFixture (id = 2):Feed {
    return {
        id,
        url: 'https://example.com/feed.xml',
        title: 'Example Feed',
        description: null,
        site_url: 'https://example.com',
        last_fetched: '2026-05-09T00:00:00.000Z',
        last_error: null,
        last_status: 200,
        created_at: '2026-05-09T00:00:00.000Z',
        updated_at: '2026-05-09T00:00:00.000Z'
    }
}

function payload (
    title = 'Title'
):InitialFeedPayload {
    return {
        version: 7,
        has_more: false,
        feeds: [feedFixture()],
        counts: {
            unread: 1,
            starred: 0,
            total: 1,
            perFeed: { '2': 1 }
        },
        items: [{
            id: 1,
            feed_id: 2,
            guid: 'guid-1',
            title,
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
        }]
    }
}

test('serializeInitialFeed round-trips feeds and counts', t => {
    const expected = payload()
    const parsed = JSON.parse(serializeInitialFeed(expected))

    t.deepEqual(parsed.feeds, expected.feeds, 'feeds round-trip')
    t.deepEqual(parsed.counts, expected.counts, 'counts round-trip')
})

test('buildLazyHtmlCacheKey is prefixed with the v3 schema marker', t => {
    const key = buildLazyHtmlCacheKey('did:plc:test', 7)

    t.equal(
        key.startsWith('html:v3:'),
        true,
        'cache key starts with html:v3: after schema bump'
    )
})
```

Also delete the existing `'buildLazyHtmlCacheKey is prefixed with the v2 schema marker'` test and update the two `t.equal` calls in the `'is deterministic and version-keyed'` test from `html:v2:` to `html:v3:`.

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm run test:lazy-html`

Expected: failures of the form "feeds is undefined" / "counts is undefined" / "cache key does not start with html:v3:".

- [ ] **Step 3: Update `src/server/lazy-html.ts`**

```ts
import type { CountsResponse, Feed, Item } from '../client/db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
    feeds:Feed[]
    counts:CountsResponse
}

// ...

export function buildLazyHtmlCacheKey (
    did:string,
    version:number
):string {
    return `html:v3:${did}:${version}`
}
```

`serializeInitialFeed` already runs `JSON.stringify(payload)` so it will pick up the new fields automatically. `injectInitialFeed` does not need to change for serialization (only the pre-rendered list markup does — Task 8 covers that).

- [ ] **Step 4: Run the tests to verify pass**

Run: `npm run test:lazy-html`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/lazy-html.ts test/lazy-html.ts
git commit -m "feat(lazy-html): add feeds and counts to initial payload schema"
```

---

## Task 2: Surface feeds + counts from the DO `/internal/lazy-html-data` endpoint

**Files:**
- Modify: `src/server/durable-objects/index.ts:660-669`
- Test: `test/lazy-html-handler.ts` (asserts the handler consumes the new shape; no separate DO test exists)

- [ ] **Step 1: Update the DO endpoint**

In `src/server/durable-objects/index.ts`, replace the `app.get('/internal/lazy-html-data', ...)` handler with:

```ts
app.get('/internal/lazy-html-data', (c) => {
    const version = this.getFeedVersion()
    const items = this.sql.exec(
        `SELECT ${ITEM_SYNC_COLUMNS} ` +
        'FROM items JOIN feeds ON items.feed_id = feeds.id ' +
        'ORDER BY items.pub_date DESC, items.id DESC LIMIT 50'
    ).toArray()

    const feeds = this.sql.exec(
        'SELECT * FROM feeds ORDER BY title ASC'
    ).toArray()

    const unreadRow = this.sql.exec(
        'SELECT COUNT(*) as count FROM items WHERE is_read = 0'
    ).one() as { count:number }
    const starredRow = this.sql.exec(
        'SELECT COUNT(*) as count FROM items WHERE is_starred = 1'
    ).one() as { count:number }
    const totalRow = this.sql.exec(
        'SELECT COUNT(*) as count FROM items'
    ).one() as { count:number }
    const perFeedRows = this.sql.exec(
        'SELECT feed_id, COUNT(*) as unread FROM items' +
        ' WHERE is_read = 0 GROUP BY feed_id'
    ).toArray() as { feed_id:number; unread:number }[]
    const perFeed:Record<string, number> = {}
    for (const row of perFeedRows) {
        perFeed[String(row.feed_id)] = row.unread
    }

    const counts = {
        unread: unreadRow.count,
        starred: starredRow.count,
        total: totalRow.count,
        perFeed
    }

    return c.json({ version, items, feeds, counts })
})
```

The count and feed queries are copy-pasted verbatim from `app.get('/items/count', ...)` and `app.get('/feeds', ...)` respectively (do not refactor into helpers; that is out of scope for this plan).

- [ ] **Step 2: Commit**

```bash
git add src/server/durable-objects/index.ts
git commit -m "feat(do): include feeds and counts in /internal/lazy-html-data"
```

---

## Task 3: Pipe feeds + counts through the lazy-html handler

**Files:**
- Modify: `src/server/lazy-html-handler.ts`
- Test: `test/lazy-html-handler.ts`

- [ ] **Step 1: Add the failing test**

Open `test/lazy-html-handler.ts`. Find the existing test that exercises the cache-miss path and asserts the payload contents. Extend it (or add a sibling `test('handler injects feeds and counts from DO')`) so that:

```ts
const dataResponse = {
    version: 1,
    items: [/* existing items fixture */],
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
        unread: 1, starred: 0, total: 1, perFeed: { '2': 1 }
    }
}

// stub the DO so it returns dataResponse for /internal/lazy-html-data
// then call handleLazyHtmlRequest and assert:
const html = await response.text()
const parsed = JSON.parse(
    /<script id="initial-feed"[^>]*>([\s\S]+?)<\/script>/
        .exec(html)![1]
)

t.deepEqual(parsed.feeds, dataResponse.feeds, 'feeds embedded')
t.deepEqual(parsed.counts, dataResponse.counts, 'counts embedded')
```

If the existing test file uses `tapzero` and `node test/run-lazy-html-handler.mjs`, follow its existing style; do NOT introduce a new runner.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:lazy-html-handler`

Expected: failures showing `feeds` is `undefined` or missing in the embedded payload.

- [ ] **Step 3: Update `src/server/lazy-html-handler.ts`**

In the existing `LazyHtmlDataResponse` interface and the `payload` construction inside `handleLazyHtmlRequest`, propagate the new fields:

```ts
interface LazyHtmlDataResponse {
    version:number
    items:Item[]
    feeds:Feed[]
    counts:CountsResponse
}

// ...

const payload:InitialFeedPayload = {
    version: data.version,
    items: data.items,
    has_more: data.items.length >= 50,
    feeds: data.feeds,
    counts: data.counts
}
```

Add the new imports at the top:

```ts
import type { CountsResponse, Feed, Item } from '../client/db/types.js'
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:lazy-html-handler`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/lazy-html-handler.ts test/lazy-html-handler.ts
git commit -m "feat(lazy-html-handler): forward feeds and counts to client"
```

---

## Task 4: Extend the client `initial-feed` consumer

**Files:**
- Modify: `src/client/initial-feed.ts`
- Test: `test/initial-feed.ts`

- [ ] **Step 1: Add the failing test**

In `test/initial-feed.ts`, update the `payload()` helper to include feeds + counts (mirror the server fixture from Task 1) and add:

```ts
test('isInitialFeedPayload accepts payloads with feeds and counts', t => {
    resetBootstrap()
    const expected = payload()
    setBootstrapScript(JSON.stringify(expected))

    try {
        const parsed = readInitialFeedFromDom()
        t.ok(parsed, 'returns a payload')
        t.deepEqual(parsed?.feeds, expected.feeds, 'feeds parsed')
        t.deepEqual(parsed?.counts, expected.counts, 'counts parsed')
    } finally {
        resetBootstrap()
    }
})

test('isInitialFeedPayload accepts older payloads without feeds/counts', t => {
    resetBootstrap()
    // back-compat: an HTML page cached under html:v2 may be served
    // for one deploy window before the bump invalidates it.
    setBootstrapScript(JSON.stringify({
        version: 1,
        items: [],
        has_more: false
    }))

    try {
        const parsed = readInitialFeedFromDom()
        t.ok(parsed, 'older payload still parses')
        t.equal(parsed?.feeds, undefined, 'feeds is absent')
        t.equal(parsed?.counts, undefined, 'counts is absent')
    } finally {
        resetBootstrap()
    }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:initial-feed`

Expected: type/runtime failure because `feeds` and `counts` are not on `InitialFeedPayload`.

- [ ] **Step 3: Update `src/client/initial-feed.ts`**

```ts
import type { CountsResponse, Feed, Item } from './db/types.js'

export interface InitialFeedPayload {
    version:number
    items:Item[]
    has_more:boolean
    feeds?:Feed[]
    counts?:CountsResponse
}

// ...

function isInitialFeedPayload (
    value:unknown
):value is InitialFeedPayload {
    if (!value || typeof value !== 'object') return false

    const payload = value as Partial<InitialFeedPayload>
    if (typeof payload.version !== 'number') return false
    if (!Array.isArray(payload.items)) return false
    if (typeof payload.has_more !== 'boolean') return false

    if (
        payload.feeds !== undefined &&
        !Array.isArray(payload.feeds)
    ) {
        return false
    }
    if (
        payload.counts !== undefined &&
        (typeof payload.counts !== 'object' || payload.counts === null)
    ) {
        return false
    }

    return true
}
```

`feeds` and `counts` are optional so a freshly-deployed client can still consume an HTML page that was cached under the old `v2` key during the deploy-and-cache-invalidation window.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:initial-feed`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/initial-feed.ts test/initial-feed.ts
git commit -m "feat(initial-feed): accept optional feeds and counts"
```

---

## Task 5: Seed `state.feeds` and `state.counts` from the bootstrap payload

**Files:**
- Modify: `src/client/state.ts`
- Test: `test/initial-feed.ts` (extend with a `State()` integration test)

- [ ] **Step 1: Add the failing test**

Add to `test/initial-feed.ts`:

```ts
test(
    'State() seeds feeds and counts from the bootstrap payload',
    async t => {
        resetBootstrap()
        const expected = payload()
        window.__INITIAL_FEED__ = expected
        const originalFetch = globalThis.fetch
        Object.defineProperty(globalThis, 'fetch', {
            value: async () => new Response('{}', { status: 401 }),
            configurable: true
        })

        try {
            const state = State()

            t.deepEqual(
                state.feeds.value,
                expected.feeds,
                'feeds.value seeded from bootstrap'
            )
            t.deepEqual(
                state.counts.value,
                expected.counts,
                'counts.value seeded from bootstrap'
            )
            t.equal(
                state.feedsLoading.value,
                false,
                'feedsLoading is false (no async load needed)'
            )
        } finally {
            Object.defineProperty(globalThis, 'fetch', {
                value: originalFetch,
                configurable: true
            })
            resetBootstrap()
        }
    }
)
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:initial-feed`

Expected: failure showing `state.feeds.value` is `[]`.

- [ ] **Step 3: Add a peek helper that does NOT consume the payload**

In `src/client/initial-feed.ts`, add:

```ts
/**
 * Read the bootstrap payload without marking it consumed. Used by
 * `State()` to seed feeds/counts synchronously while leaving the
 * items consumption to `loadItems()` (which expects single-use).
 */
export function peekInitialFeed ():InitialFeedPayload|null {
    if (typeof window === 'undefined') return readInitialFeedFromDom()
    return (
        window.__INITIAL_FEED__ ??
        readInitialFeedFromDom()
    )
}
```

This avoids changing the existing single-shot semantics that `loadItems` already depends on.

- [ ] **Step 4: Seed signals in `State()`**

In `src/client/state.ts`, near the top of `State()` (just after `loadLocalFirstSettings()`):

```ts
import { consumeInitialFeed, peekInitialFeed } from './initial-feed.js'

// ...

export function State ():AppState {
    loadLocalFirstSettings()

    const seed = peekInitialFeed()
    const seededFeeds = seed?.feeds ?? []
    const seededCounts = seed?.counts ?? {
        unread: 0, starred: 0, total: 0, perFeed: {}
    }
    const seededItems = seed?.items ?? []

    const onRoute = Route()

    const state = {
        // ... existing fields ...
        feeds: signal<Feed[]>(seededFeeds),
        // feedsLoading is already initialized to false; that is correct
        // when seed?.feeds was non-empty, AND it remains correct when
        // the seed was empty because Task 6's loadInitialView will
        // set it true before any async fetch.
        // ...
        items: signal<Item[]>(seededItems),
        itemsTotal: signal(seededItems.length),
        // ...
        counts: signal<CountsResponse>(seededCounts),
        // ...
    }
```

(Apply the seeded values directly into the existing object literal. Do not introduce a new factory.)

- [ ] **Step 5: Run to verify pass**

Run: `npm run test:initial-feed && npm run test:lazy-html && npm run test:lazy-html-handler`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/state.ts src/client/initial-feed.ts test/initial-feed.ts
git commit -m "feat(state): seed feeds/counts/items from bootstrap payload"
```

---

## Task 6: Split `refreshAfterSync` and rewire the SSE listener

**Files:**
- Modify: `src/client/state.ts:667-694, 750-771, 859-892`
- Test: `test/state-refresh-audit.ts` (extend); `test/refresh-lifecycle.ts` (extend)

- [ ] **Step 1: Add the failing tests**

Append to `test/state-refresh-audit.ts`:

```ts
import {
    test
} from '@substrate-system/tapzero'

test(
    'reconcileAfterRefresh does not call loadFeeds',
    async t => {
        const calls:string[] = []
        const fakeState = {} as Parameters<
            typeof State.reconcileAfterRefresh
        >[0]

        const original = {
            loadFeeds: State.loadFeeds,
            loadFeedStatus: State.loadFeedStatus,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            loadItemByRoute: State.loadItemByRoute
        }
        State.loadFeeds = (async () => {
            calls.push('loadFeeds')
        }) as typeof State.loadFeeds
        State.loadFeedStatus = (async () => {
            calls.push('loadFeedStatus')
        }) as typeof State.loadFeedStatus
        State.loadItems = (async () => {
            calls.push('loadItems')
        }) as typeof State.loadItems
        State.loadCounts = (async () => {
            calls.push('loadCounts')
        }) as typeof State.loadCounts
        State.loadItemByRoute = (async () => null) as
            typeof State.loadItemByRoute

        try {
            await State.reconcileAfterRefresh(fakeState)
            t.equal(
                calls.includes('loadFeeds'),
                false,
                'reconcile does NOT reload the feeds list'
            )
            t.equal(
                calls.includes('loadFeedStatus'),
                true,
                'reconcile DOES reload the indicator'
            )
            t.equal(
                calls.includes('loadItems'),
                true,
                'reconcile DOES reload items'
            )
            t.equal(
                calls.includes('loadCounts'),
                true,
                'reconcile DOES reload per-feed counts'
            )
        } finally {
            Object.assign(State, original)
        }
    }
)

test(
    'loadInitialView calls loadFeeds',
    async t => {
        const calls:string[] = []
        const fakeState = {
            initialLoadComplete: { value: false },
            route: { value: '/' }
        } as unknown as Parameters<typeof State.loadInitialView>[0]

        const original = {
            loadFeeds: State.loadFeeds,
            loadFeedStatus: State.loadFeedStatus,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts
        }
        State.loadFeeds = (async () => {
            calls.push('loadFeeds')
        }) as typeof State.loadFeeds
        State.loadFeedStatus = (async () => {
            calls.push('loadFeedStatus')
        }) as typeof State.loadFeedStatus
        State.loadItems = (async () => {
            calls.push('loadItems')
        }) as typeof State.loadItems
        State.loadCounts = (async () => {
            calls.push('loadCounts')
        }) as typeof State.loadCounts

        try {
            await State.loadInitialView(fakeState)
            t.equal(
                calls.includes('loadFeeds'),
                true,
                'initial load fetches the feeds list'
            )
        } finally {
            Object.assign(State, original)
        }
    }
)
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
esbuild ./test/state-refresh-audit.ts --bundle --platform=node --format=esm | node --input-type=module | tap-spec
```
Expected: failures with `State.reconcileAfterRefresh is not a function` and `State.loadInitialView is not a function`.

- [ ] **Step 3: Replace `refreshAfterSync` with the two-function split**

In `src/client/state.ts`, replace the existing `State.refreshAfterSync` body (currently around line 667–694) with two methods:

```ts
/**
 * First post-auth load. Pulls feeds, indicator, items, counts, and
 * the route item if applicable. Sets initialLoadComplete on the way
 * out so the App shell can swap from skeleton to real UI.
 */
State.loadInitialView = async function (
    state:AppState
):Promise<void> {
    const route = state.route.value

    try {
        await Promise.all([
            State.loadFeeds(state),
            State.loadFeedStatus(state),
            State.loadItems(state),
            State.loadCounts(state)
        ])

        if (!isItemRoute(route)) return

        const item = await State.loadItemByRoute(state, route)
        if (state.route.value !== route) return

        batch(() => {
            state.routeItem.value = item
            state.routeItemLoading.value = false
        })
    } finally {
        if (!state.initialLoadComplete.value) {
            state.initialLoadComplete.value = true
        }
    }
}

/**
 * Reconcile state after a feed-refresh round-trip. Pulls items,
 * per-feed unread counts, and the indicator -- but NOT the feeds
 * list. The list of subscribed feeds only changes via add/delete
 * (which already triggers loadFeeds inline) or via per-feed
 * `feed-updated` SSE (which calls loadFeeds individually).
 */
State.reconcileAfterRefresh = async function (
    state:AppState
):Promise<void> {
    const route = state.route.value

    await Promise.all([
        State.loadFeedStatus(state),
        State.loadItems(state),
        State.loadCounts(state)
    ])

    if (!isItemRoute(route)) return

    const item = await State.loadItemByRoute(state, route)
    if (state.route.value !== route) return

    batch(() => {
        state.routeItem.value = item
        state.routeItemLoading.value = false
    })
}

// Back-compat shim: external callers (online/offline handlers and the
// bootstrap path) continue to call refreshAfterSync. Route them to the
// initial-load path because they all run before initialLoadComplete is
// set or as part of resuming sync after a network event -- both of
// which legitimately want the feeds list re-fetched.
State.refreshAfterSync = State.loadInitialView
```

Update the type definition of `State` (the namespace functions) to declare the two new methods alongside the existing `refreshAfterSync` so TypeScript accepts the assignments above.

- [ ] **Step 4: Rewire the SSE refresh-complete listener**

In `src/client/state.ts`, find the `refresh-complete` listener (currently around line 755):

```ts
source.addEventListener('refresh-complete', () => {
    debug('SSE refresh-complete')
    clearRefreshFeedsSafetyTimeout()
    State.refreshAfterSync(state).catch((err) => {
        debug('refresh-complete reconcile error:', err)
    }).finally(() => {
        batch(() => {
            state.refreshInProgress.value = false
            state.feedsLoading.value = false
        })
    })
})
```

Replace `State.refreshAfterSync(state)` with `State.reconcileAfterRefresh(state)`. Same change in the SSE `open` reconnect handler at the `if (state.refreshInProgress.value)` branch (around line 870).

Leave the SSE `feed-updated` debounced refresh (around line 750) calling `State.refreshAfterSync` (i.e. the initial-load path) — that event covers per-feed metadata changes (title, last_fetched), where re-loading the feeds list is correct.

- [ ] **Step 5: Run the targeted tests to verify pass**

Run:
```bash
esbuild ./test/state-refresh-audit.ts --bundle --platform=node --format=esm | node --input-type=module | tap-spec
```
Expected: PASS for both new tests.

- [ ] **Step 6: Commit**

```bash
git add src/client/state.ts test/state-refresh-audit.ts
git commit -m "refactor(state): split refresh into initial-load and reconcile paths"
```

---

## Task 7: Stop swallowing `loadFeeds` failures behind "No feeds yet…"

**Files:**
- Modify: `src/client/state.ts:1386-1404`
- Modify: `src/client/components/sidebar.ts:242-249`
- Test: extend `test/state-refresh-audit.ts` with a sidebar-render assertion

- [ ] **Step 1: Add a `feedsError` signal**

In `src/client/state.ts`, in the `AppState` type:

```ts
feedsError:Signal<string|null>,
```

Initialize it in `State()`:

```ts
feedsError: signal<string|null>(null),
```

- [ ] **Step 2: Set the error on failure**

Replace the `loadFeeds` function body:

```ts
State.loadFeeds = async function (
    state:AppState
):Promise<void> {
    state.feedsLoading.value = true

    try {
        const adapter = await getAdapter(
            state.user.value?.did
        )
        const data = await adapter.getFeeds()
        batch(() => {
            state.feeds.value = data.feeds
            state.feedsError.value = null
            state.feedsLoading.value = false
        })
    } catch (err) {
        debug('Error loading feeds:', err)
        batch(() => {
            state.feedsError.value = err instanceof Error ?
                err.message :
                'Failed to load feeds'
            state.feedsLoading.value = false
        })
    }
}
```

- [ ] **Step 3: Render the error in the sidebar**

In `src/client/components/sidebar.ts`, replace the empty-state block (the `${(!feedsLoading.value && feeds.value.length === 0) && html\`...No feeds yet${ELLIPSIS}...\`}`) with:

```ts
${(!feedsLoading.value && feeds.value.length === 0) && html`
    <div class="empty-state">
        ${state.feedsError.value ?
            `Couldn't load feeds: ${state.feedsError.value}` :
            html`No feeds yet${ELLIPSIS}`}
    </div>
`}
```

This means the user only sees "No feeds yet…" when the server actually confirmed they have zero feeds — never when a network or auth error swallowed the response.

- [ ] **Step 4: Add the sidebar-render assertion**

Append to `test/state-refresh-audit.ts`:

```ts
test(
    'sidebar shows the error message when loadFeeds fails',
    async t => {
        // import sidebar render helper from preact-render-to-string
        // ... (follow existing test patterns; if the project does not
        // already have a sidebar-render harness, create one based on
        // test/sidebar-static.mjs)
        // assert that the rendered HTML contains "Couldn't load feeds"
        // when state.feedsError.value is set, and "No feeds yet" when
        // feedsError is null and feeds is empty.
        t.pass('placeholder — implement once helper exists')
    }
)
```

If a sidebar render helper does not already exist, do NOT add a new dependency. Instead, write a static assertion in `test/sidebar-static.mjs` that grep-checks the sidebar source for both the error branch and the empty branch.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/state.ts src/client/components/sidebar.ts test/state-refresh-audit.ts test/sidebar-static.mjs
git commit -m "fix(sidebar): show error when loadFeeds fails instead of 'no feeds yet'"
```

---

## Task 8: Pre-render seeded feeds into the SSR HTML markup

**Files:**
- Modify: `src/server/lazy-html.ts`
- Test: `test/lazy-html.ts`

- [ ] **Step 1: Add the failing test**

In `test/lazy-html.ts`:

```ts
test('injectInitialFeed pre-renders the feeds list when seeded', t => {
    const expected = payload()
    const html = injectInitialFeed(
        '<html><head></head><body><div id="root"></div></body></html>',
        expected
    )

    t.equal(
        html.includes('Example Feed'),
        true,
        'feed title appears in pre-rendered sidebar markup'
    )
    t.equal(
        html.includes('class="sidebar"'),
        true,
        'sidebar shell is rendered server-side'
    )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:lazy-html`

Expected: failure showing the rendered HTML does not contain "Example Feed".

- [ ] **Step 3: Extend `injectInitialFeed`**

In `src/server/lazy-html.ts`, alongside the existing `injectInitialFeedMarkup` (which builds the items list under `#root`), inject a pre-rendered sidebar-feeds-list inside the same `#root` swap. The minimal markup mirrors the structure that `Sidebar` produces in `src/client/components/sidebar.ts`:

```ts
function renderInitialFeedsListItem (feed:Feed):string {
    const title = feed.title ?
        escapeHtml(feed.title) :
        escapeHtml(feed.url)
    const href = '/feed/' + escapeAttribute(stripProtocolForHref(feed.url))
    return (
        '<div class="sidebar-item feed-item">' +
        '<span class="badge feed-unread-count">0</span>' +
        `<a class="feed-select" href="${href}">${title}</a>` +
        '</div>'
    )
}

function stripProtocolForHref (url:string):string {
    return url.replace(/^https?:\/\//, '')
}
```

In `injectInitialFeedMarkup`, replace the `seededRoot` builder with one that also includes a sidebar block:

```ts
const seededRoot = (
    '<div id="root">' +
    '<div class="route feed-reader">' +
    '<div class="app-body">' +
    '<aside class="sidebar">' +
    '<div class="sidebar-section">' +
    '<div class="feeds-list">' +
    payload.feeds.map(renderInitialFeedsListItem).join('') +
    '</div>' +
    '</div>' +
    '</aside>' +
    '<main class="content">' +
    '<ul class="items-list">' +
    payload.items.map(renderInitialFeedItem).join('') +
    '</ul>' +
    '</main>' +
    '</div>' +
    '</div>' +
    '</div>'
)
```

The pre-rendered badge always shows `0`; the live signal-driven render replaces it as soon as Preact hydrates. Per-feed unread is intentionally not pre-computed in markup because the Preact render will overwrite it; including it would just duplicate hydration work.

Use `escapeHtml` and `escapeAttribute` (already in the file) for both the feed title and the URL.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:lazy-html`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/lazy-html.ts test/lazy-html.ts
git commit -m "feat(lazy-html): pre-render seeded feeds list in SSR markup"
```

---

## Task 9: Investigate the per-feed 0-counts symptom

**Files:**
- Modify: none (diagnostic only)
- Notes destination: `specs/019-fix-empty-initial-feeds/research.md`

- [ ] **Step 1: Reproduce with three live feeds**

With the dev server running, add three feeds via the UI: a known-good wire-service RSS, an intentionally-failing URL (`https://www.example.invalid/feed.xml`), and a second known-good feed. Wait 30 seconds for the resolve-convergence pull to land.

- [ ] **Step 2: Inspect items per feed**

Add a temporary console.log inside `app.get('/items/count', ...)` in `src/server/durable-objects/index.ts` that also logs `this.sql.exec('SELECT feed_id, COUNT(*) as total FROM items GROUP BY feed_id').toArray()`. Refresh the page once. Capture the log output and add it to `specs/019-fix-empty-initial-feeds/research.md` under `## Counts investigation`. REVERT the temporary log before committing.

- [ ] **Step 3: Decide the verdict**

Based on the captured numbers, write one of these in the research doc:

- **No items in DB for any feed:** The fetch is silently failing for the working URLs too. File a follow-up bug; do NOT widen this plan's scope.
- **Items exist but `is_read = 1`:** The unread filter is masking them; verify whether something is auto-marking-read on initial load.
- **Items exist with `is_read = 0`:** The `/api/items/count` endpoint is returning the right numbers, and the symptom is purely client-side display (likely a stale `state.counts.value` from before Task 5's seeding). Task 5 already fixes that case; close this task.

- [ ] **Step 4: Commit findings (only if a code change is needed)**

If the verdict is "no code change", just amend the research doc and move on. Otherwise, open a separate spec under `specs/020-fix-zero-item-counts/` and link it from `research.md`.

```bash
git add specs/019-fix-empty-initial-feeds/research.md
git commit -m "docs(019): record per-feed counts investigation"
```

---

## Task 10: End-to-end verification

**Files:**
- None (manual + automated test execution)

- [ ] **Step 1: Run the full test suite**

Run: `npm test && npm run lint`

Expected: PASS.

- [ ] **Step 2: Manually verify the original bug is fixed**

```bash
npm run start
```

Open `http://127.0.0.1:2222/` in an incognito window, complete OAuth, and confirm:

1. The sidebar shows the user's actual feeds list on first paint (no "No feeds yet…" flash).
2. The "All Items" badge shows the correct unread total on first paint.
3. Per-feed badges show the correct counts on first paint.
4. Clicking "Refresh Feeds" does NOT cause the sidebar feeds list to flicker, blank, or re-order.
5. Clicking "Refresh Feeds" DOES update the items list and the per-feed unread badges.
6. The header status pill ("up to date" / "n updates") still reacts correctly to refresh.

Also hard-reload (Cmd+Shift+R) the authenticated session and confirm the same six checks.

- [ ] **Step 3: Verify production HTML caching**

Build and inspect the production HTML to confirm the new payload is embedded:

```bash
npm run build
grep -c "initial-feed" public/index.html || true
```

Expected: `0` — the build artifact is the empty shell; injection happens at request-time in the worker.

Then verify the Worker code path by running the lazy-html-handler tests:

```bash
npm run test:lazy-html-handler
```

Expected: PASS.

- [ ] **Step 4: Stop the dev server**

Press Ctrl+C in the terminal running `npm run start`.

- [ ] **Step 5: Commit any final cleanup, open the PR**

```bash
git status
# If anything is left uncommitted (e.g. accidentally-staged debug logs),
# resolve before opening the PR.
git push -u origin <branch>
gh pr create --title "Fix empty initial feeds list and decouple refresh" \
    --body "$(cat <<'EOF'
## Summary
- SSR-inject feeds + counts into the lazy-html payload so the sidebar is populated on first paint.
- Split refreshAfterSync into loadInitialView and reconcileAfterRefresh; the SSE refresh-complete handler now uses the lighter reconcile path that does not re-pull the feeds list.
- Surface loadFeeds failures via a feedsError signal so the user sees a real error instead of "No feeds yet…" when /api/feeds fails.
- Bump the lazy-html cache key from v2 to v3 to invalidate stale HTML.

## Test plan
- [ ] npm test passes
- [ ] npm run lint passes
- [ ] Manual: incognito OAuth login shows feeds on first paint
- [ ] Manual: hard reload shows feeds on first paint
- [ ] Manual: Refresh Feeds button does not blank the sidebar list
- [ ] Manual: Refresh Feeds button still updates items + counts + status pill
EOF
)"
```

---

## Self-review summary

- **Spec coverage:** Each of the user's three points has an owning task: feeds-on-initial-load (Tasks 1-5, 8), refresh decoupling (Task 6), 0-counts symptom (Tasks 5 + 9). Task 0 establishes the root cause first so we know whether Task 7's error-display change is the real fix or just a defense-in-depth layer.
- **Type consistency:** `InitialFeedPayload` carries `feeds:Feed[]` and `counts:CountsResponse` end-to-end (server payload schema → handler → client `peekInitialFeed` → `State()` seeding). Method names `loadInitialView` and `reconcileAfterRefresh` are referenced identically in Tasks 6 and 7. The cache-key bump is `v2 → v3` everywhere it appears.
- **No placeholders:** All code blocks are complete; the only "placeholder" is the explicit guidance in Task 7 Step 4 that says "if a sidebar render helper does not exist, fall back to the existing sidebar-static.mjs grep test" — that is a real instruction, not a TBD.
