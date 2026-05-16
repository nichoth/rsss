import { test } from '@substrate-system/tapzero'
import {
    type ReadonlySignal,
    signal,
    computed
} from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { FeedReader } from '../src/client/routes/feed-reader.js'
import { type AppState, State } from '../src/client/state.js'
import type {
    CountsResponse,
    Feed,
    Item
} from '../src/client/db/types.js'

const noopLoadItems = async () => {}
const originalLoadItems = State.loadItems
const originalRefreshFeeds = State.refreshFeeds
const originalRefreshFeed = State.refreshFeed

function makeFeed (overrides:Partial<Feed> = {}):Feed {
    return {
        id: 1,
        url: 'https://example.com/feed.rss',
        title: 'Example Feed',
        description: null,
        site_url: null,
        last_fetched: null,
        last_error: null,
        last_status: null,
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
        feedsError: signal<string|null>(null),
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

test('empty-state-pending-updates.AC3.1+AC3.3: Per-feed view with ' +
    'pending renders component and calls refreshFeed', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    let refreshFeedCalled = false
    let refreshFeedArgsLen:number = 0
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {
        refreshFeedCalled = true
        refreshFeedArgsLen = 2
    }) as typeof State.refreshFeed

    let refreshFeedsCalled = false
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {
        refreshFeedsCalled = true
    }) as typeof State.refreshFeeds

    const state = makeState()
    state.selectedFeedId.value = 1
    const feed = makeFeed({
        id: 1,
        url: 'https://example.com/feed.rss',
        title: 'Example Feed'
    })
    state.feeds.value = [feed]
    state.items.value = []
    state.feedUpdateCounts.value = {
        1: 50
    }

    const root = mount(state, ['example.com', 'feed.rss'])
    try {
        await nextTick()

        const component = root.querySelector('.pending-update-empty-state')
        t.ok(component, '.pending-update-empty-state is present')

        const button = component?.querySelector('button')
        t.ok(button, 'button exists inside .pending-update-empty-state')

        if (button) button.click()
        await nextTick()

        t.ok(refreshFeedCalled, 'State.refreshFeed was called')
        t.equal(
            refreshFeedArgsLen,
            2,
            'State.refreshFeed called with correct args'
        )
        t.equal(
            refreshFeedsCalled,
            false,
            'State.refreshFeeds was NOT called'
        )
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeed = originalRefreshFeed
        State.refreshFeeds = originalRefreshFeeds
    }
})

test('empty-state-pending-updates.AC3.2+AC3.4: All Items view with ' +
    'pending renders component and calls refreshFeeds', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    let refreshFeedsCalled = false
    let refreshFeedsArgsLen:number = 0
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {
        refreshFeedsCalled = true
        refreshFeedsArgsLen = 1
    }) as typeof State.refreshFeeds

    let refreshFeedCalled = false
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {
        refreshFeedCalled = true
    }) as typeof State.refreshFeed

    const state = makeState()
    const feed1 = makeFeed({
        id: 1,
        url: 'https://a.example.com/feed.rss',
        title: 'Feed A'
    })
    const feed2 = makeFeed({
        id: 2,
        url: 'https://b.example.com/feed.rss',
        title: 'Feed B'
    })
    state.feeds.value = [feed1, feed2]
    state.items.value = []
    state.feedUpdateCounts.value = {
        1: 30,
        2: 20
    }

    const root = mount(state, [])
    try {
        await nextTick()

        const component = root.querySelector(
            '.pending-update-empty-state'
        )
        t.ok(component, '.pending-update-empty-state is present')

        const button = component?.querySelector('button')
        t.ok(button, 'button exists inside .pending-update-empty-state')

        if (button) button.click()
        await nextTick()

        t.ok(refreshFeedsCalled, 'State.refreshFeeds was called')
        t.equal(
            refreshFeedsArgsLen,
            1,
            'State.refreshFeeds called with just state'
        )
        t.equal(
            refreshFeedCalled,
            false,
            'State.refreshFeed was NOT called'
        )
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeeds = originalRefreshFeeds
        State.refreshFeed = originalRefreshFeed
    }
})

test('empty-state-pending-updates.AC4.1: No feeds at all renders ' +
    'existing copy not component', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {}) as typeof State.refreshFeeds
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {}) as typeof State.refreshFeed

    const state = makeState()
    state.feeds.value = []
    state.items.value = []
    state.feedUpdateCounts.value = {
        1: 5
    }

    const root = mount(state, [])
    try {
        await nextTick()

        const component = root.querySelector(
            '.pending-update-empty-state'
        )
        t.equal(
            component,
            null,
            '.pending-update-empty-state is NOT present'
        )

        const emptyState = root.querySelector('.empty-state')
        t.ok(emptyState,
            '.empty-state is present (existing copy)')
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeeds = originalRefreshFeeds
        State.refreshFeed = originalRefreshFeed
    }
})

test('empty-state-pending-updates.AC4.2: Per-feed view with pending=0 ' +
    'renders existing copy not component', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {}) as typeof State.refreshFeeds
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {}) as typeof State.refreshFeed

    const state = makeState()
    state.selectedFeedId.value = null
    const feed = makeFeed({
        id: 1,
        url: 'https://example.com/feed.rss',
        title: 'Example Feed'
    })
    state.feeds.value = [feed]
    state.items.value = []
    state.feedUpdateCounts.value = {
        1: 0
    }

    const root = mount(state, ['example.com', 'feed.rss'])
    try {
        await nextTick()

        const component = root.querySelector(
            '.pending-update-empty-state'
        )
        t.equal(
            component,
            null,
            '.pending-update-empty-state is NOT present'
        )

        const emptyState = root.querySelector('.empty-state')
        t.ok(emptyState,
            '.empty-state is present (existing copy)')
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeeds = originalRefreshFeeds
        State.refreshFeed = originalRefreshFeed
    }
})

test('empty-state-pending-updates.AC4.3: All Items view with ' +
    'pending sum=0 renders existing copy not component', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {}) as typeof State.refreshFeeds
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {}) as typeof State.refreshFeed

    const state = makeState()
    const feed1 = makeFeed({
        id: 1,
        url: 'https://a.example.com/feed.rss',
        title: 'Feed A'
    })
    const feed2 = makeFeed({
        id: 2,
        url: 'https://b.example.com/feed.rss',
        title: 'Feed B'
    })
    state.feeds.value = [feed1, feed2]
    state.items.value = []
    state.feedUpdateCounts.value = {}

    const root = mount(state, [])
    try {
        await nextTick()

        const component = root.querySelector(
            '.pending-update-empty-state'
        )
        t.equal(
            component,
            null,
            '.pending-update-empty-state is NOT present'
        )

        const emptyState = root.querySelector('.empty-state')
        t.ok(emptyState,
            '.empty-state is present (existing copy)')
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeeds = originalRefreshFeeds
        State.refreshFeed = originalRefreshFeed
    }
})

test('empty-state-pending-updates.AC4.4: itemsLoading=true renders ' +
    'neither component nor copy, loading indicator is present', async (t) => {
    State.loadItems = noopLoadItems as typeof State.loadItems
    State.refreshFeeds = (async (
        _state:AppState
    ):Promise<void> => {}) as typeof State.refreshFeeds
    State.refreshFeed = (async (
        _state:AppState,
        _feedId:string
    ):Promise<void> => {}) as typeof State.refreshFeed

    const state = makeState()
    const feed = makeFeed({
        id: 1,
        url: 'https://example.com/feed.rss',
        title: 'Example Feed'
    })
    state.feeds.value = [feed]
    state.items.value = []
    state.feedUpdateCounts.value = {
        1: 50
    }
    state.itemsLoading.value = true

    const root = mount(state, ['example.com', 'feed.rss'])
    try {
        await nextTick()

        const component = root.querySelector(
            '.pending-update-empty-state'
        )
        t.equal(
            component,
            null,
            '.pending-update-empty-state is NOT present'
        )

        const emptyState = root.querySelector('.empty-state')
        t.equal(
            emptyState,
            null,
            '.empty-state is NOT present'
        )

        const loadingIndicator = root.querySelector('.loading-text')
        t.ok(loadingIndicator,
            '.loading-text indicator is present')
    } finally {
        unmount(root)
        State.loadItems = originalLoadItems
        State.refreshFeeds = originalRefreshFeeds
        State.refreshFeed = originalRefreshFeed
    }
})
