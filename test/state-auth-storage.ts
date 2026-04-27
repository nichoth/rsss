import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    getAdapter,
    getLocalDb,
    _resetAdapterCache,
    _resetSupportedCache
} from '../src/client/db/index.js'
import * as pullSyncModule from '../src/client/db/pull-sync.js'
import { PushSyncAuthError } from '../src/client/db/push-sync.js'
import {
    setSQLiteWorkerClientFactoryForTests,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import type { SQLiteWorkerClient } from
    '../src/client/db/sqlite-worker-client.js'
import {
    releaseLocalTabLock,
    resetTabCoordinationForTests,
    setLocalTabBlocked
} from '../src/client/db/tab-coordination.js'
import { syncSubscriptions } from '../src/client/local-first-settings.js'
import { billingStatus } from '../src/client/billing-status.js'
import { State, type AppState } from '../src/client/state.js'
import { remoteAdapter } from '../src/client/db/remote-adapter.js'

type ErrorCtor = new () => Error
type StateWithSyncAuth = typeof State & {
    handleSyncAuthError?:(state:AppState, err:unknown) => boolean
}

class FakeBroadcastChannel {
    static channels:FakeBroadcastChannel[] = []

    name:string
    onmessage:((ev:{ data:unknown }) => void)|null = null
    closed = false

    constructor (name:string) {
        this.name = name
        FakeBroadcastChannel.channels.push(this)
    }

    postMessage (data:unknown):void {
        for (const channel of FakeBroadcastChannel.channels) {
            if (channel === this || channel.name !== this.name) continue
            if (channel.closed) continue
            channel.onmessage?.({ data })
        }
    }

    close ():void {
        this.closed = true
    }

    static reset ():void {
        FakeBroadcastChannel.channels = []
    }
}

setTestMode(true, wasmUrl as string)

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function emptySyncFetch ():typeof fetch {
    return async () => new Response(JSON.stringify({
        feeds: [],
        items: [],
        syncedAt: '2026-01-04 00:00:00',
        latestUpdatedAt: '2026-01-04 00:00:00',
        isFullSync: false
    }))
}

function setupLocalFirstForStateTest ():void {
    setTestMode(true, wasmUrl as string)
    _resetSupportedCache()
    _resetAdapterCache()
    resetTabCoordinationForTests()
    syncSubscriptions.value = true
    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    setSQLiteWorkerClientFactoryForTests(() => ({
        open: async () => undefined,
        exec: async () => undefined,
        query: async () => [],
        close: async () => undefined,
        probe: async () => undefined,
        dispose: () => undefined
    } as unknown as SQLiteWorkerClient))
    Object.defineProperty(navigator, 'storage', {
        value: {
            getDirectory: async () => ({})
        },
        configurable: true
    })
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
        value: true,
        configurable: true
    })
    Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true
    })
}

function setupBroadcastLockTest ():FakeBroadcastChannel {
    FakeBroadcastChannel.reset()
    Object.defineProperty(globalThis, 'BroadcastChannel', {
        value: FakeBroadcastChannel,
        configurable: true
    })
    Object.defineProperty(navigator, 'locks', {
        value: undefined,
        configurable: true
    })
    return new FakeBroadcastChannel('rsss-tab')
}

async function settleOnlineHandler ():Promise<void> {
    await nextTask()
    await nextTask()
    await nextTask()
}

function authState ():AppState {
    return ({
        authLoading: signal(false),
        authError: signal<string|null>(null),
        _setRoute: () => {},
        user: signal(null)
    } as unknown) as AppState
}

function itemByRouteResponse ():Response {
    return new Response(JSON.stringify({
        item: {
            id: 10,
            feed_id: 1,
            guid: 'guid-10',
            title: 'Local Item',
            link: 'https://example.com/item-10',
            description: 'remote description',
            content: '<p>remote content</p>',
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2026-01-01 00:00:00',
            updated_at: '2026-01-01 00:00:00',
            feed_title: 'Example Feed'
        }
    }))
}

test('checkAuth does not persist authenticated user to localStorage',
    async t => {
        const originalFetch = globalThis.fetch

        localStorage.removeItem('rsss_user')

        try {
            globalThis.fetch = async () => new Response(JSON.stringify({
                authenticated: true,
                did: 'did:plc:abc',
                handle: 'alice.test'
            }))

            const state = authState()

            await State.checkAuth(state)

            t.equal(
                state.user.value?.handle,
                'alice.test',
                'updates in-memory auth state'
            )
            t.equal(
                localStorage.getItem('rsss_user'),
                null,
                'leaves legacy user storage empty'
            )
        } finally {
            globalThis.fetch = originalFetch
            localStorage.removeItem('rsss_user')
        }
    })

test('handleSyncAuthError sends auth failures to login', async t => {
    const PullSyncAuthError = (
        pullSyncModule as typeof pullSyncModule & {
            PullSyncAuthError?:ErrorCtor
        }
    ).PullSyncAuthError
    const handleSyncAuthError = (State as StateWithSyncAuth)
        .handleSyncAuthError
    const routes:string[] = []
    const state = {
        ...authState(),
        _setRoute: (route:string) => {
            routes.push(route)
        }
    }

    t.ok(PullSyncAuthError, 'exports pull auth error')
    t.ok(handleSyncAuthError, 'exports sync auth handler')

    if (!PullSyncAuthError || !handleSyncAuthError) return

    handleSyncAuthError(state, new PullSyncAuthError())

    t.equal(
        state.authError.value,
        'Your session expired. Please log in again.',
        'sets re-auth copy for pull auth failure'
    )
    t.equal(routes.pop(), '/login', 'routes pull auth failure to login')

    handleSyncAuthError(state, new PushSyncAuthError())

    t.equal(routes.pop(), '/login', 'routes push auth failure to login')
})

test('State auth effect loads once for the final rapid auth value',
    async t => {
        const originals = {
            checkAuth: State.checkAuth,
            loadBillingStatus: State.loadBillingStatus,
            loadFeeds: State.loadFeeds,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts
        }
        const loadDids:string[] = []
        let currentState:AppState|null = null

        State.checkAuth = async (state:AppState) => {
            state.user.value = {
                did: 'did:plc:stale',
                handle: 'stale.test'
            }
            state.user.value = null
            state.user.value = {
                did: 'did:plc:final',
                handle: 'final.test'
            }
        }
        State.loadBillingStatus = async () => {
            loadDids.push(
                currentState?.user.value?.did ?? 'none'
            )
            return null
        }
        State.loadFeeds = async () => {}
        State.loadItems = async () => {}
        State.loadCounts = async () => {}

        try {
            currentState = State()
            await nextTask()
            await nextTask()

            t.deepEqual(
                loadDids,
                ['did:plc:final'],
                'only the final authenticated user bootstraps'
            )
        } finally {
            State.checkAuth = originals.checkAuth
            State.loadBillingStatus = originals.loadBillingStatus
            State.loadFeeds = originals.loadFeeds
            State.loadItems = originals.loadItems
            State.loadCounts = originals.loadCounts
        }
    })

test('State cleanup removes online and offline listeners', async t => {
    const originals = {
        checkAuth: State.checkAuth,
        addEventListener: window.addEventListener,
        removeEventListener: window.removeEventListener
    }
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    const removed = new Map<string, EventListenerOrEventListenerObject>()

    State.checkAuth = async () => {}
    window.addEventListener = (
        type:string,
        listener:EventListenerOrEventListenerObject
    ) => {
        listeners.set(type, listener)
    }
    window.removeEventListener = (
        type:string,
        listener:EventListenerOrEventListenerObject
    ) => {
        removed.set(type, listener)
    }

    try {
        const state = State()

        state.cleanup()

        t.equal(
            removed.get('online'),
            listeners.get('online'),
            'removes the registered online listener'
        )
        t.equal(
            removed.get('offline'),
            listeners.get('offline'),
            'removes the registered offline listener'
        )
    } finally {
        State.checkAuth = originals.checkAuth
        window.addEventListener = originals.addEventListener
        window.removeEventListener = originals.removeEventListener
    }
})

test('online sync refreshes lists, counts, and the route item',
    async t => {
        const originals = {
            checkAuth: State.checkAuth,
            loadBillingStatus: State.loadBillingStatus,
            loadFeeds: State.loadFeeds,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            loadItemByRoute: State.loadItemByRoute,
            fetch: globalThis.fetch
        }
        const did = 'did:plc:online-refresh'
        const calls:string[] = []

        setupLocalFirstForStateTest()
        await getAdapter(did)
        globalThis.fetch = emptySyncFetch()

        State.checkAuth = async () => {}
        State.loadBillingStatus = async () => null
        State.loadFeeds = async () => {
            calls.push('feeds')
        }
        State.loadItems = async () => {
            calls.push('items')
        }
        State.loadCounts = async () => {
            calls.push('counts')
        }
        State.loadItemByRoute = async () => {
            calls.push('route-item')
            return null
        }

        try {
            const state = State()
            state.user.value = {
                did,
                handle: 'online.test'
            }
            await settleOnlineHandler()
            state.route.value = '/post/example'
            await settleOnlineHandler()
            calls.length = 0

            window.dispatchEvent(new Event('online'))
            await settleOnlineHandler()

            t.deepEqual(
                calls,
                ['feeds', 'items', 'counts', 'route-item'],
                'online sync reloads visible data after the cycle'
            )

            state.cleanup()
        } finally {
            State.checkAuth = originals.checkAuth
            State.loadBillingStatus = originals.loadBillingStatus
            State.loadFeeds = originals.loadFeeds
            State.loadItems = originals.loadItems
            State.loadCounts = originals.loadCounts
            State.loadItemByRoute = originals.loadItemByRoute
            globalThis.fetch = originals.fetch
            setSQLiteWorkerClientFactoryForTests(null)
            _resetAdapterCache()
            _resetSupportedCache()
            syncSubscriptions.value = false
            resetTabCoordinationForTests()
        }
    })

test('released tab lock reacquires local adapter and starts sync',
    async t => {
        const originals = {
            checkAuth: State.checkAuth,
            loadBillingStatus: State.loadBillingStatus,
            loadFeeds: State.loadFeeds,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            loadItemByRoute: State.loadItemByRoute,
            fetch: globalThis.fetch
        }
        const did = 'did:plc:lock-release'
        let syncCalls = 0

        setupLocalFirstForStateTest()
        const primary = setupBroadcastLockTest()
        await getAdapter(did)
        await releaseLocalTabLock()
        setLocalTabBlocked()
        globalThis.fetch = async (input, init) => {
            const url = input instanceof Request ?
                input.url :
                input.toString()
            if (!init?.method && url.includes('/api/sync')) {
                syncCalls++
                return emptySyncFetch()(input, init)
            }
            return originals.fetch.call(globalThis, input, init)
        }

        State.checkAuth = async () => {}
        State.loadBillingStatus = async () => null
        State.loadFeeds = async () => {}
        State.loadItems = async () => {}
        State.loadCounts = async () => {}
        State.loadItemByRoute = async () => null

        try {
            const state = State()
            state.user.value = {
                did,
                handle: 'lock-release.test'
            }
            await settleOnlineHandler()

            t.equal(
                await getAdapter(did),
                remoteAdapter,
                'blocked tab stays on remote adapter before release'
            )

            primary.postMessage({ type: 'released' })
            await settleOnlineHandler()

            t.equal(syncCalls, 1, 'release starts a sync cycle')
            t.notEqual(
                await getAdapter(did),
                remoteAdapter,
                'next adapter lookup returns local adapter'
            )
            await settleOnlineHandler()

            state.cleanup()
        } finally {
            State.checkAuth = originals.checkAuth
            State.loadBillingStatus = originals.loadBillingStatus
            State.loadFeeds = originals.loadFeeds
            State.loadItems = originals.loadItems
            State.loadCounts = originals.loadCounts
            State.loadItemByRoute = originals.loadItemByRoute
            globalThis.fetch = originals.fetch
            primary.close()
            setSQLiteWorkerClientFactoryForTests(null)
            _resetAdapterCache()
            _resetSupportedCache()
            syncSubscriptions.value = false
            resetTabCoordinationForTests()
            FakeBroadcastChannel.reset()
        }
    })

test('loadItemByRoute fetches server body for local item missing content',
    async t => {
        const originals = {
            fetch: globalThis.fetch
        }
        const did = 'did:plc:missing-content'

        setupLocalFirstForStateTest()
        await getAdapter(did)
        const db = getLocalDb(did)
        if (!db) {
            t.fail('local DB is opened')
            return
        }

        db.exec({
            sql: `INSERT INTO feeds
                (id, url, title, created_at, updated_at)
                VALUES (1, 'https://example.com/feed', 'Example Feed',
                    '2026-01-01 00:00:00',
                    '2026-01-01 00:00:00')`
        })
        db.exec({
            sql: `INSERT INTO items
                (id, feed_id, guid, title, link, description, content,
                 is_read, is_starred, created_at, updated_at)
                VALUES (10, 1, 'guid-10', 'Local Item',
                    'https://example.com/item-10', NULL, NULL, 1, 1,
                    '2026-01-01 00:00:00',
                    '2026-01-01 00:00:00')`
        })

        globalThis.fetch = async (input) => {
            const url = input instanceof Request ?
                input.url :
                input.toString()
            if (url.includes('/api/items/by-route')) {
                return itemByRouteResponse()
            }
            return new Response('{}', { status: 404 })
        }

        try {
            const state = authState()
            state.user.value = {
                did,
                handle: 'missing-content.test'
            }
            const item = await State.loadItemByRoute(
                state,
                '/post/example.com/item-10'
            )

            t.equal(
                item?.content,
                '<p>remote content</p>',
                'uses server content for display'
            )
            t.equal(
                item?.description,
                'remote description',
                'uses server description for display'
            )
            t.equal(item?.is_read, 1, 'preserves local read state')
            t.equal(item?.is_starred, 1, 'preserves local starred state')
        } finally {
            globalThis.fetch = originals.fetch
            setSQLiteWorkerClientFactoryForTests(null)
            _resetAdapterCache()
            _resetSupportedCache()
            syncSubscriptions.value = false
            resetTabCoordinationForTests()
        }
    })

test('checkAuth does not remove legacy user localStorage entry',
    async t => {
        const originalFetch = globalThis.fetch

        localStorage.setItem('rsss_user', 'legacy')

        try {
            globalThis.fetch = async () => new Response(JSON.stringify({
                authenticated: false
            }))

            const state = authState()

            await State.checkAuth(state)

            t.equal(
                state.user.value,
                null,
                'clears in-memory auth state'
            )
            t.equal(
                localStorage.getItem('rsss_user'),
                'legacy',
                'does not write legacy user storage on sign-out state'
            )
        } finally {
            globalThis.fetch = originalFetch
            localStorage.removeItem('rsss_user')
        }
    })
