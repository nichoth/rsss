import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import {
    consumeInitialFeed,
    readInitialFeedFromDom,
    _resetConsumedForTests,
    type InitialFeedPayload
} from '../src/client/initial-feed.js'
import { State, type AppState } from '../src/client/state.js'
import type { CountsResponse, Feed, Item } from '../src/client/db/types.js'

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

function countsFixture ():CountsResponse {
    return {
        unread: 1,
        starred: 0,
        total: 1,
        perFeed: { 2: 1 }
    }
}

function item (id = 1):Item {
    return {
        id,
        feed_id: 2,
        guid: `guid-${id}`,
        title: `Item ${id}`,
        link: `https://example.com/item-${id}`,
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

function payload (items = [item()]):InitialFeedPayload {
    return {
        version: 9,
        items,
        has_more: false,
        feeds: [feedFixture()],
        counts: countsFixture()
    }
}

function setBootstrapScript (
    value:string
):HTMLScriptElement {
    const script = document.createElement('script')
    script.id = 'initial-feed'
    script.type = 'application/json'
    script.textContent = value
    document.head.appendChild(script)
    return script
}

function resetBootstrap ():void {
    document.querySelector('#initial-feed')?.remove()
    delete window.__INITIAL_FEED__
    _resetConsumedForTests()
}

function stateForLoadItems ():AppState {
    return {
        items: signal<Item[]>([]),
        itemsTotal: signal(0),
        itemsLoading: signal(false),
        user: signal({ did: 'did:plc:test', handle: 'test' }),
        selectedFeedId: signal<number|null>(null),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(20),
        itemsOffset: signal(0)
    } as unknown as AppState
}

test('readInitialFeedFromDom parses the bootstrap payload', t => {
    resetBootstrap()
    const expected = payload()
    setBootstrapScript(JSON.stringify(expected))

    try {
        t.deepEqual(
            readInitialFeedFromDom(),
            expected,
            'returns the parsed payload'
        )
    } finally {
        resetBootstrap()
    }
})

test('readInitialFeedFromDom returns null when absent or invalid', t => {
    resetBootstrap()

    t.equal(
        readInitialFeedFromDom(),
        null,
        'missing script returns null'
    )

    const script = setBootstrapScript('{')
    try {
        t.equal(
            readInitialFeedFromDom(),
            null,
            'invalid JSON returns null'
        )
    } finally {
        script.remove()
        resetBootstrap()
    }
})

test('consumeInitialFeed reads and clears the global once', t => {
    resetBootstrap()
    const expected = payload()
    window.__INITIAL_FEED__ = expected

    try {
        t.deepEqual(
            consumeInitialFeed(),
            expected,
            'global payload is returned'
        )
        t.equal(
            window.__INITIAL_FEED__,
            undefined,
            'global payload is deleted'
        )
        t.equal(
            consumeInitialFeed(),
            null,
            'second consume returns null'
        )
    } finally {
        resetBootstrap()
    }
})

test('consumeInitialFeed falls through to DOM when global is missing',
    t => {
        resetBootstrap()
        const expected = payload()
        setBootstrapScript(JSON.stringify(expected))

        try {
            t.deepEqual(
                consumeInitialFeed(),
                expected,
                'DOM payload is returned'
            )
            t.equal(
                consumeInitialFeed(),
                null,
                'second consume returns null'
            )
        } finally {
            resetBootstrap()
        }
    })

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

test('isInitialFeedPayload accepts older payloads without feeds/counts',
    t => {
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
            state.cleanup()
        } finally {
            Object.defineProperty(globalThis, 'fetch', {
                value: originalFetch,
                configurable: true
            })
            resetBootstrap()
        }
    }
)

test('State.loadItems renders non-empty bootstrap without fetching',
    async t => {
        resetBootstrap()
        const expected = payload([item(1), item(2)])
        window.__INITIAL_FEED__ = expected
        const state = stateForLoadItems()
        const originalFetch = globalThis.fetch
        let fetchCount = 0

        Object.defineProperty(globalThis, 'fetch', {
            value: async () => {
                fetchCount += 1
                throw new Error('unexpected fetch')
            },
            configurable: true
        })

        try {
            await State.loadItems(state)

            t.deepEqual(
                state.items.value,
                expected.items,
                'items are populated from bootstrap'
            )
            t.equal(
                state.itemsTotal.value,
                expected.items.length,
                'total count matches bootstrap items'
            )
            t.equal(
                state.itemsLoading.value,
                false,
                'loading is cleared'
            )
            t.equal(fetchCount, 0, 'remote API is not called')
        } finally {
            Object.defineProperty(globalThis, 'fetch', {
                value: originalFetch,
                configurable: true
            })
            resetBootstrap()
        }
    })
