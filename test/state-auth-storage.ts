import { signal, batch, computed } from '@preact/signals'
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
import { isLocalFirstActive } from '../src/client/db/sync-status.js'
import { syncSubscriptions } from '../src/client/local-first-settings.js'
import { billingStatus } from '../src/client/billing-status.js'
import { State, type AppState } from '../src/client/state.js'
import { remoteAdapter } from '../src/client/db/remote-adapter.js'
import { mockFeeds } from './mock.js'

type ErrorCtor = new () => Error
type StateWithSyncAuth = typeof State & {
    handleSyncAuthError?:(state:AppState, err:unknown) => boolean
}
type QueuedRefreshTimer = () => void

interface QueuedRefreshSafetyTimerStub {
    restore:() => void
    runSafetyTimers:() => void
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

function stubRefreshSafetyTimer ():() => void {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout

    Object.defineProperty(globalThis, 'setTimeout', {
        value: (
            handler:TimerHandler,
            timeout?:number,
            ...args:unknown[]
        ) => {
            if (timeout === 60_000) return 1
            return originalSetTimeout(handler, timeout, ...args)
        },
        configurable: true
    })
    Object.defineProperty(globalThis, 'clearTimeout', {
        value: () => undefined,
        configurable: true
    })

    return () => {
        Object.defineProperty(globalThis, 'setTimeout', {
            value: originalSetTimeout,
            configurable: true
        })
        Object.defineProperty(globalThis, 'clearTimeout', {
            value: originalClearTimeout,
            configurable: true
        })
    }
}

function stubQueuedRefreshSafetyTimer ():QueuedRefreshSafetyTimerStub {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const timers = new Map<number, QueuedRefreshTimer>()
    let nextId = 1

    Object.defineProperty(globalThis, 'setTimeout', {
        value: (
            handler:TimerHandler,
            timeout?:number,
            ...args:unknown[]
        ) => {
            if (timeout !== 60_000) {
                return originalSetTimeout(handler, timeout, ...args)
            }

            const id = nextId++
            timers.set(id, () => {
                if (typeof handler === 'function') {
                    handler(...args)
                }
            })
            return id
        },
        configurable: true
    })
    Object.defineProperty(globalThis, 'clearTimeout', {
        value: (id?:number) => {
            if (typeof id === 'number' && timers.delete(id)) return
            originalClearTimeout(id)
        },
        configurable: true
    })

    return {
        restore: () => {
            Object.defineProperty(globalThis, 'setTimeout', {
                value: originalSetTimeout,
                configurable: true
            })
            Object.defineProperty(globalThis, 'clearTimeout', {
                value: originalClearTimeout,
                configurable: true
            })
        },
        runSafetyTimers: () => {
            for (const timer of Array.from(timers.values())) {
                timer()
            }
        }
    }
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

function makeEmptySyncResponse ():Response {
    return new Response(JSON.stringify({
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

function feedState ():AppState {
    const refreshInProgress = signal(false)
    const feedSyncStatus = signal<
        'inactive'|'updates'|'syncing'|'error'|'synced'
    >('inactive')
    const displayedFeedSyncStatus = computed<
        'inactive'|'updates'|'syncing'|'error'|'synced'
    >(() => (
        refreshInProgress.value ?
            'syncing' :
            feedSyncStatus.value
    ))
    return ({
        user: signal(null),
        feeds: signal([]),
        feedsLoading: signal(false),
        refreshInProgress,
        feedSyncStatus,
        displayedFeedSyncStatus,
        feedSyncError: signal<string|null>(null),
        feedUpdateCounts: signal<Record<string, number>>({})
    } as unknown) as AppState
}

type EventListenerFn = (ev:MessageEvent|Event) => void

class StubEventSource {
    static instances:StubEventSource[] = []

    url:string
    listeners:Record<string, EventListenerFn[]> = {}

    constructor (url:string) {
        this.url = url
        StubEventSource.instances.push(this)
    }

    addEventListener (event:string, listener:EventListenerFn):void {
        (this.listeners[event] ??= []).push(listener)
    }

    removeEventListener (event:string, listener:EventListenerFn):void {
        const list = this.listeners[event]
        if (!list) return
        this.listeners[event] = list.filter(fn => fn !== listener)
    }

    close ():void {}

    fire (event:string, data?:unknown):void {
        const ev = data === undefined ?
            new Event(event) :
            new MessageEvent(event, { data: JSON.stringify(data) })
        const list = this.listeners[event] ?? []
        for (const fn of list) fn(ev)
    }
}

function stubEventSource ():() => void {
    const original = (globalThis as { EventSource?:typeof EventSource })
        .EventSource
    StubEventSource.instances = []
    ;(globalThis as { EventSource:unknown })
        .EventSource = StubEventSource as unknown as typeof EventSource
    return () => {
        ;(globalThis as { EventSource?:typeof EventSource })
            .EventSource = original
        StubEventSource.instances = []
    }
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

test('loadFeeds does not write indicator state (owned by loadFeedStatus)',
    async t => {
        const originalFetch = globalThis.fetch

        syncSubscriptions.value = false
        _resetAdapterCache()

        try {
            // The server may still return legacy `feedUpdateCounts`
            // for one deploy window; loadFeeds must ignore it.
            globalThis.fetch = async () => new Response(JSON.stringify({
                feeds: mockFeeds,
                feedUpdateCounts: { 1: 2 }
            }))

            const state = feedState()
            const originalStatus = state.feedSyncStatus.value
            const originalCounts = state.feedUpdateCounts.value

            await State.loadFeeds(state)

            t.equal(
                state.feedSyncStatus.value,
                originalStatus,
                'loadFeeds does NOT touch feedSyncStatus'
            )
            t.deepEqual(
                state.feedUpdateCounts.value,
                originalCounts,
                'loadFeeds does NOT touch feedUpdateCounts'
            )
            t.equal(
                state.feeds.value.length,
                mockFeeds.length,
                'loadFeeds still loads the feeds list'
            )
            t.equal(
                state.feedsLoading.value,
                false,
                'clears loading after bootstrap hydration'
            )
        } finally {
            globalThis.fetch = originalFetch
            _resetAdapterCache()
        }
    })

test('loadFeeds keeps inactive status after bootstrap failure',
    async t => {
        const originalFetch = globalThis.fetch

        syncSubscriptions.value = false
        _resetAdapterCache()

        try {
            globalThis.fetch = async () => {
                throw new Error('bootstrap failed')
            }

            const state = feedState()

            await State.loadFeeds(state)

            t.equal(
                state.feedSyncStatus.value,
                'inactive',
                'failed bootstrap leaves feed sync status inactive'
            )
            t.deepEqual(
                state.feedUpdateCounts.value,
                {},
                'failed bootstrap leaves update counts unchanged'
            )
            t.equal(
                state.feedsLoading.value,
                false,
                'clears loading after bootstrap failure'
            )
        } finally {
            globalThis.fetch = originalFetch
            _resetAdapterCache()
        }
    })

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

test('State exposes feed sync status as the single source of truth',
    t => {
        const state = State()

        t.equal(
            state.feedSyncStatus.value,
            'inactive',
            'feed sync status defaults to inactive'
        )
        t.deepEqual(
            state.feedUpdateCounts.value,
            {},
            'feed update counts default to an empty object'
        )
        t.equal(
            state.feedUpdateStatus.value,
            'synced',
            'legacy status derives an empty-count state as synced'
        )
        t.deepEqual(
            state.feedsWithUpdates.value,
            [],
            'legacy update feed list derives from empty counts'
        )

        state.feedUpdateCounts.value = { 1: 2, 3: 1 }
        state.feedSyncStatus.value = 'updates'

        t.equal(
            state.feedUpdateStatus.value,
            'updates',
            'legacy status derives updates from feedSyncStatus'
        )
        t.deepEqual(
            state.feedsWithUpdates.value,
            ['1', '3'],
            'legacy feed list derives from feedUpdateCounts keys'
        )

        state.cleanup()
    })

test('refreshFeeds marks feed sync as syncing while request is in flight',
    async t => {
        const originalFetch = globalThis.fetch
        const restoreTimeout = stubRefreshSafetyTimer()
        let resolveRefresh:(response:Response) => void = () => {}

        try {
            globalThis.fetch = async () => new Promise<Response>(resolve => {
                resolveRefresh = resolve
            })

            const state = feedState()
            state.feedUpdateCounts.value = { 1: 2 }
            state.feedSyncStatus.value = 'updates'

            const refresh = State.refreshFeeds(state)
            await nextTask()

            t.equal(
                state.refreshInProgress.value,
                true,
                'refresh button spinner stays active during sync'
            )
            t.equal(
                state.displayedFeedSyncStatus.value,
                'syncing',
                'displayed pill switches to syncing immediately ' +
                '(yellow during refresh via computed; FR-002)'
            )
            t.equal(
                state.feedSyncError.value,
                null,
                'clears stale feed sync errors before retrying'
            )

            resolveRefresh(new Response(JSON.stringify({
                success: true
            })))
            await refresh
        } finally {
            globalThis.fetch = originalFetch
            restoreTimeout()
        }
    })

test('refreshFeeds clears update counts and marks feed sync as synced',
    async t => {
        const originalFetch = globalThis.fetch
        const restoreTimeout = stubRefreshSafetyTimer()
        const restoreEventSource = stubEventSource()
        const originalRefreshAfterSync = State.refreshAfterSync

        try {
            globalThis.fetch = async () => new Response(JSON.stringify({
                success: true
            }))

            // Stub refreshAfterSync to mimic loadFeedStatus's
            // post-refresh reconcile (counts cleared, status synced)
            // without exercising the full reload pipeline here. The
            // full pipeline is tested in test/refresh-lifecycle.ts.
            State.refreshAfterSync = async (state:AppState) => {
                batch(() => {
                    state.feedUpdateCounts.value = {}
                    state.feedSyncStatus.value = 'synced'
                })
            }

            const state = feedState()
            state.feedUpdateCounts.value = { 1: 2, 2: 1 }
            state.feedSyncStatus.value = 'updates'

            State.openEventStream(state)
            const source = StubEventSource.instances[0]

            await State.refreshFeeds(state)

            t.equal(
                state.refreshInProgress.value,
                true,
                'POST resolve does NOT clear refreshInProgress; ' +
                'completion is bound to SSE refresh-complete (FR-001)'
            )
            t.deepEqual(
                state.feedUpdateCounts.value,
                { 1: 2, 2: 1 },
                'POST resolve does NOT zero feedUpdateCounts'
            )

            source.fire('refresh-complete')
            await nextTask()
            await nextTask()

            t.deepEqual(
                state.feedUpdateCounts.value,
                {},
                'refreshAfterSync after refresh-complete clears counts'
            )
            t.equal(
                state.feedSyncStatus.value,
                'synced',
                'refreshAfterSync settles status to synced'
            )
            t.equal(
                state.refreshInProgress.value,
                false,
                'SSE refresh-complete clears the busy state (FR-005)'
            )
        } finally {
            State.refreshAfterSync = originalRefreshAfterSync
            State.closeEventStream()
            globalThis.fetch = originalFetch
            restoreTimeout()
            restoreEventSource()
        }
    })

test('refreshFeeds safety timer clears the busy state without ' +
    'overwriting pill state',
async t => {
    const originalFetch = globalThis.fetch
    const timerStub = stubQueuedRefreshSafetyTimer()

    try {
        globalThis.fetch = async () => new Response(JSON.stringify({
            success: true
        }))

        const state = feedState()
        state.feedUpdateCounts.value = { 1: 2 }
        state.feedSyncStatus.value = 'updates'

        await State.refreshFeeds(state)

        // POST resolved but completion is now bound to SSE
        // refresh-complete; refreshInProgress stays true until
        // either the event arrives or the safety timer fires.
        t.equal(
            state.refreshInProgress.value,
            true,
            'POST resolve does not clear refreshInProgress'
        )

        timerStub.runSafetyTimers()

        t.equal(
            state.refreshInProgress.value,
            false,
            'safety timer clears the busy state on stuck refreshes'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'safety timer does not touch feedSyncStatus; the ' +
            'underlying value retains the pre-click resting state ' +
            '(no click-time write since 012; the next ' +
            'loadFeedStatus reconcile owns the next transition)'
        )
        t.equal(
            state.displayedFeedSyncStatus.value,
            'updates',
            'displayed pill exits yellow back to the pre-click ' +
            'resting state after safety timer fires (FR-006 ' +
            'degraded path)'
        )
    } finally {
        globalThis.fetch = originalFetch
        timerStub.restore()
    }
})

test('refreshFeeds stores latest error message on failure',
    async t => {
        const originalFetch = globalThis.fetch
        const restoreTimeout = stubRefreshSafetyTimer()

        try {
            globalThis.fetch = async () => {
                throw new Error('upstream timed out')
            }

            const state = feedState()
            state.feedSyncStatus.value = 'updates'
            state.feedSyncError.value = 'older error'

            await State.refreshFeeds(state).catch(() => undefined)

            t.equal(
                state.feedSyncStatus.value,
                'error',
                'failed refresh marks feed sync as error'
            )
            t.equal(
                state.feedSyncError.value,
                'upstream timed out',
                'stores the latest refresh error message'
            )
            t.equal(
                state.feedsLoading.value,
                false,
                'failed refresh clears the button spinner'
            )
        } finally {
            globalThis.fetch = originalFetch
            restoreTimeout()
        }
    })

test('refreshFeeds retries from error state and recovers via SSE',
    async t => {
        const originalFetch = globalThis.fetch
        const restoreTimeout = stubRefreshSafetyTimer()
        const restoreEventSource = stubEventSource()
        const originalRefreshAfterSync = State.refreshAfterSync
        let resolveRefresh:(response:Response) => void = () => {}

        try {
            globalThis.fetch = async () => new Promise<Response>(resolve => {
                resolveRefresh = resolve
            })

            State.refreshAfterSync = async (state:AppState) => {
                batch(() => {
                    state.feedUpdateCounts.value = {}
                    state.feedSyncStatus.value = 'synced'
                })
            }

            const state = feedState()
            state.feedSyncStatus.value = 'error'
            state.feedSyncError.value = 'first outage'

            State.openEventStream(state)
            const source = StubEventSource.instances[0]

            const refresh = State.refreshFeeds(state)
            await nextTask()

            t.equal(
                state.displayedFeedSyncStatus.value,
                'syncing',
                'displayed pill switches an error state to syncing ' +
                'immediately (yellow during retry via computed)'
            )
            t.equal(
                state.feedSyncError.value,
                null,
                'retry clears the old error while the request is active'
            )

            resolveRefresh(new Response(JSON.stringify({
                success: true
            })))
            await refresh

            // POST resolved; completion bound to SSE refresh-complete.
            t.equal(
                state.refreshInProgress.value,
                true,
                'POST resolve does NOT clear the busy state'
            )

            source.fire('refresh-complete')
            await nextTask()
            await nextTask()

            t.equal(
                state.feedSyncStatus.value,
                'synced',
                'SSE refresh-complete + reconcile marks feed sync synced'
            )
            t.equal(
                state.feedSyncError.value,
                null,
                'successful retry does not restore the old error'
            )
            t.equal(
                state.refreshInProgress.value,
                false,
                'SSE refresh-complete clears the busy state'
            )
        } finally {
            State.refreshAfterSync = originalRefreshAfterSync
            State.closeEventStream()
            globalThis.fetch = originalFetch
            restoreTimeout()
            restoreEventSource()
        }
    })

test('refreshFeeds retries from error and replaces a second failure',
    async t => {
        const originalFetch = globalThis.fetch
        const restoreTimeout = stubRefreshSafetyTimer()
        let rejectRefresh:(err:Error) => void = () => {}

        try {
            globalThis.fetch = async () => new Promise<Response>(
                (_resolve, reject) => {
                    rejectRefresh = reject
                }
            )

            const state = feedState()
            state.feedSyncStatus.value = 'error'
            state.feedSyncError.value = 'first outage'

            const refresh = State.refreshFeeds(state)
            await nextTask()

            t.equal(
                state.displayedFeedSyncStatus.value,
                'syncing',
                'displayed pill enters syncing before the second ' +
                'failure (yellow during retry via computed)'
            )
            t.equal(
                state.feedSyncError.value,
                null,
                'retry removes stale error text before failing again'
            )

            rejectRefresh(new Error('second outage'))
            await refresh.catch(() => undefined)

            t.equal(
                state.feedSyncStatus.value,
                'error',
                'second failed retry returns to error state'
            )
            t.equal(
                state.feedSyncError.value,
                'second outage',
                'latest retry error replaces the previous message'
            )
        } finally {
            globalThis.fetch = originalFetch
            restoreTimeout()
        }
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

test('online event skips sync when local-first is inactive',
    async t => {
        const originals = {
            checkAuth: State.checkAuth,
            loadBillingStatus: State.loadBillingStatus,
            loadFeeds: State.loadFeeds,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            fetch: globalThis.fetch
        }
        const did = 'did:plc:online-inactive'
        let syncCalls = 0

        setupLocalFirstForStateTest()
        await getAdapter(did)
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

        try {
            const state = State()
            state.user.value = {
                did,
                handle: 'online-inactive.test'
            }
            await settleOnlineHandler()
            syncCalls = 0
            isLocalFirstActive.value = false

            window.dispatchEvent(new Event('online'))
            await settleOnlineHandler()

            t.equal(
                syncCalls,
                0,
                'inactive local-first skips online sync'
            )

            state.cleanup()
        } finally {
            State.checkAuth = originals.checkAuth
            State.loadBillingStatus = originals.loadBillingStatus
            State.loadFeeds = originals.loadFeeds
            State.loadItems = originals.loadItems
            State.loadCounts = originals.loadCounts
            globalThis.fetch = originals.fetch
            isLocalFirstActive.value = false
            setSQLiteWorkerClientFactoryForTests(null)
            _resetAdapterCache()
            _resetSupportedCache()
            syncSubscriptions.value = false
            resetTabCoordinationForTests()
        }
    })

test('online event coalesces while sync is already in flight',
    async t => {
        const originals = {
            checkAuth: State.checkAuth,
            loadBillingStatus: State.loadBillingStatus,
            loadFeeds: State.loadFeeds,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            fetch: globalThis.fetch
        }
        const did = 'did:plc:online-coalesce'
        let syncCalls = 0
        let resolveSync:(response:Response) => void = () => {}

        setupLocalFirstForStateTest()
        await getAdapter(did)
        globalThis.fetch = emptySyncFetch()

        State.checkAuth = async () => {}
        State.loadBillingStatus = async () => null
        State.loadFeeds = async () => {}
        State.loadItems = async () => {}
        State.loadCounts = async () => {}

        try {
            const state = State()
            state.user.value = {
                did,
                handle: 'online-coalesce.test'
            }
            await settleOnlineHandler()

            const syncStarted = new Promise<void>(resolve => {
                globalThis.fetch = async (input, init) => {
                    const url = input instanceof Request ?
                        input.url :
                        input.toString()
                    if (!init?.method && url.includes('/api/sync')) {
                        syncCalls++
                        resolve()
                        return new Promise<Response>(resolve => {
                            resolveSync = resolve
                        })
                    }
                    return originals.fetch.call(globalThis, input, init)
                }
            })
            syncCalls = 0

            window.dispatchEvent(new Event('online'))
            await syncStarted
            window.dispatchEvent(new Event('online'))
            await settleOnlineHandler()

            t.equal(
                syncCalls,
                1,
                'second online event reuses the in-flight sync'
            )

            resolveSync(makeEmptySyncResponse())
            await settleOnlineHandler()

            state.cleanup()
        } finally {
            State.checkAuth = originals.checkAuth
            State.loadBillingStatus = originals.loadBillingStatus
            State.loadFeeds = originals.loadFeeds
            State.loadItems = originals.loadItems
            State.loadCounts = originals.loadCounts
            globalThis.fetch = originals.fetch
            isLocalFirstActive.value = false
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
