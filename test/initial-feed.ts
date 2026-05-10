import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import {
    consumeInitialFeed,
    readInitialFeedFromDom,
    _resetConsumedForTests,
    type InitialFeedPayload
} from '../src/client/initial-feed.js'
import { State, type AppState } from '../src/client/state.js'
import type { Item } from '../src/client/db/types.js'

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
        has_more: false
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
