import { test } from '@substrate-system/tapzero'
import {
    type ReadonlySignal,
    signal,
    computed
} from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import '@substrate-system/details-summary'
import { FeedReader } from '../src/client/routes/feed-reader.js'
import { type AppState, State } from '../src/client/state.js'
import {
    feedPolicies,
    _resetFeedPolicies
} from '../src/client/db/feed-cache-policy.js'
import {
    defaultCacheMode,
    defaultMaxSizeBytes,
    defaultMaxAgeSeconds
} from '../src/client/local-first-settings.js'
import type {
    CountsResponse,
    Feed,
    Item
} from '../src/client/db/types.js'

const noopLoadItems = async () => {}
const originalLoadItems = State.loadItems
const originalMarkAllRead = State.markAllRead

function makeFeed (overrides:Partial<Feed> = {}):Feed {
    return {
        id: 1,
        url: 'https://example.com/feed.rss',
        title: 'Example Feed',
        description: null,
        site_url: null,
        last_fetched: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        ...overrides
    }
}

function makeState ():AppState {
    const state = {
        _setRoute: (_r:string) => {},
        route: signal('/'),
        routeItem: signal<Item|null>(null),
        routeItemLoading: signal(false),
        user: signal(null),
        authLoading: signal(false),
        authError: signal<string|null>(null),
        feeds: signal<Feed[]>([]),
        feedsLoading: signal(false),
        feedSyncStatus: signal<
            'inactive'|'updates'|'syncing'|'error'|'synced'
        >('inactive'),
        feedSyncError: signal<string|null>(null),
        feedUpdateCounts: signal<Record<string, number>>({}),
        items: signal<Item[]>([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        counts: signal<CountsResponse>(
            { unread: 0, starred: 0, total: 0, perFeed: {} }
        ),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(20),
        selectedFeedId: signal<number|null>(null),
        initialLoadComplete: signal<boolean>(false),
        cleanup: () => {}
    } as unknown as AppState
    ;(state as unknown as {
        feedUpdateStatus:ReadonlySignal<'synced'|'updates'>
    }).feedUpdateStatus = computed(() => 'synced')
    ;(state as unknown as {
        feedsWithUpdates:ReadonlySignal<string[]>
    }).feedsWithUpdates = computed(() => [])
    ;(state as unknown as {
        isAuthenticated:ReadonlySignal<boolean>
    }).isAuthenticated = computed(() => false)
    return state
}

function mount (
    state:AppState,
    splats:string[]
):HTMLElement {
    const root = document.createElement('div')
    document.body.appendChild(root)
    render(
        html`<${FeedReader} state=${state} splats=${splats} />`,
        root
    )
    return root
}

function unmount (root:HTMLElement):void {
    render(null, root)
    root.remove()
}

function nextTick ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

test('feed-reader cache disclosure: <details-summary> wrapper shape',
    async (t) => {
        State.loadItems = noopLoadItems as typeof State.loadItems
        State.markAllRead = (async () => {}) as typeof State.markAllRead
        _resetFeedPolicies()
        defaultCacheMode.value = 'text_images'
        defaultMaxSizeBytes.value = 50_000_000
        defaultMaxAgeSeconds.value = 30 * 86400

        const state = makeState()
        const feed = makeFeed({
            id: 1,
            url: 'https://example.com/feed.rss',
            title: 'Example'
        })
        state.feeds.value = [feed]
        const splats = ['example.com', 'feed.rss']

        const root = mount(state, splats)
        try {
            await nextTick()
            const wrapper = root.querySelector(
                '.feed-cache-controls'
            )
            t.ok(wrapper, '.feed-cache-controls element exists')
            t.equal(
                wrapper?.tagName.toLowerCase(),
                'details-summary',
                'host element is <details-summary>'
            )

            const innerDetails = wrapper?.querySelectorAll(':scope > details')
            t.equal(
                innerDetails?.length,
                1,
                'exactly one direct-child <details>'
            )

            const details = innerDetails?.[0] as HTMLDetailsElement|undefined
            const summaries = details?.querySelectorAll(':scope > summary')
            t.equal(
                summaries?.length,
                1,
                'exactly one direct-child <summary> inside <details>'
            )
            const summary = summaries?.[0] as HTMLElement|undefined
            t.ok(
                summary?.textContent?.trim().startsWith('Cache:'),
                'summary text starts with "Cache:"'
            )

            const contents = details?.querySelectorAll(
                ':scope > .details-content'
            )
            t.equal(
                contents?.length,
                1,
                'exactly one direct-child .details-content inside <details>'
            )
        } finally {
            unmount(root)
            _resetFeedPolicies()
            State.loadItems = originalLoadItems
            State.markAllRead = originalMarkAllRead
        }
    }
)

test('feed-reader cache disclosure: inner controls present',
    async (t) => {
        State.loadItems = noopLoadItems as typeof State.loadItems
        State.markAllRead = (async () => {}) as typeof State.markAllRead
        _resetFeedPolicies()
        defaultCacheMode.value = 'text_images'
        defaultMaxSizeBytes.value = 50_000_000
        defaultMaxAgeSeconds.value = 30 * 86400

        const state = makeState()
        const feed = makeFeed({
            id: 42,
            url: 'https://controls.example.com/feed.rss',
            title: 'Controls'
        })
        state.feeds.value = [feed]

        const root = mount(state, ['controls.example.com', 'feed.rss'])
        try {
            await nextTick()
            const content = root.querySelector(
                '.feed-cache-controls .details-content'
            )
            t.ok(content, '.details-content present')

            const selects = content?.querySelectorAll(
                'select[name^="feed-cache-mode-"]'
            )
            t.equal(
                selects?.length,
                1,
                'one cache-mode <select> in .details-content'
            )

            const sizes = content?.querySelectorAll(
                'input[type="number"][name^="feed-max-size-"]'
            )
            t.equal(
                sizes?.length,
                1,
                'one max-size <input type="number"> in .details-content'
            )

            const ages = content?.querySelectorAll(
                'input[type="number"][name^="feed-max-age-"]'
            )
            t.equal(
                ages?.length,
                1,
                'one max-age <input type="number"> in .details-content'
            )

            const clears = content?.querySelectorAll(
                'button.btn-clear-cache'
            )
            t.equal(
                clears?.length,
                1,
                'one .btn-clear-cache button in .details-content'
            )
        } finally {
            unmount(root)
            _resetFeedPolicies()
            State.loadItems = originalLoadItems
            State.markAllRead = originalMarkAllRead
        }
    }
)

test('feed-reader cache disclosure: (default) suffix tracks effective mode',
    async (t) => {
        State.loadItems = noopLoadItems as typeof State.loadItems
        State.markAllRead = (async () => {}) as typeof State.markAllRead
        _resetFeedPolicies()
        defaultCacheMode.value = 'text_images'

        const state = makeState()
        const feed = makeFeed({
            id: 99,
            url: 'https://default.example.com/feed.rss',
            title: 'Default'
        })
        state.feeds.value = [feed]

        const root = mount(state, ['default.example.com', 'feed.rss'])
        try {
            await nextTick()
            const summary = root.querySelector(
                '.feed-cache-controls summary'
            )
            t.ok(
                summary?.textContent?.includes('(default)'),
                'shows (default) when no override'
            )

            feedPolicies.value = {
                99: {
                    feed_id: 99,
                    cache_mode: 'text',
                    max_size_bytes: null,
                    max_age_seconds: null
                }
            }
            await nextTick()
            const summary2 = root.querySelector(
                '.feed-cache-controls summary'
            )
            t.ok(
                !summary2?.textContent?.includes('(default)'),
                'no (default) suffix when cache_mode is overridden'
            )
            t.ok(
                summary2?.textContent?.includes('Text only'),
                'shows "Text only" when override is text'
            )
        } finally {
            unmount(root)
            _resetFeedPolicies()
            State.loadItems = originalLoadItems
            State.markAllRead = originalMarkAllRead
        }
    }
)

test('feed-reader cache disclosure: no carry-over on feed switch',
    async (t) => {
        State.loadItems = noopLoadItems as typeof State.loadItems
        State.markAllRead = (async () => {}) as typeof State.markAllRead
        _resetFeedPolicies()

        const state = makeState()
        const feedA = makeFeed({
            id: 10,
            url: 'https://a.example.com/feed.rss',
            title: 'A'
        })
        const feedB = makeFeed({
            id: 20,
            url: 'https://b.example.com/feed.rss',
            title: 'B'
        })
        state.feeds.value = [feedA, feedB]

        const rootA = mount(state, ['a.example.com', 'feed.rss'])
        try {
            await nextTick()
            const detailsA = rootA.querySelector(
                '.feed-cache-controls details'
            ) as HTMLDetailsElement|null
            t.ok(detailsA, 'feed A renders a <details>')
            if (detailsA) detailsA.open = true
            unmount(rootA)

            const rootB = mount(state, ['b.example.com', 'feed.rss'])
            try {
                await nextTick()
                const detailsB = rootB.querySelector(
                    '.feed-cache-controls details'
                ) as HTMLDetailsElement|null
                t.ok(detailsB, 'feed B renders a <details>')
                t.equal(
                    detailsB?.hasAttribute('open'),
                    false,
                    'feed B <details> has no open attribute'
                )
            } finally {
                unmount(rootB)
            }
        } finally {
            _resetFeedPolicies()
            State.loadItems = originalLoadItems
            State.markAllRead = originalMarkAllRead
        }
    }
)
