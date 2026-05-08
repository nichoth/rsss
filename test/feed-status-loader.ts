import { signal, computed } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import { State, type AppState } from '../src/client/state.js'

type EventListenerFn = (ev:MessageEvent|Event) => void

class StubEventSource {
    static instances:StubEventSource[] = []
    static lastOptions:EventSourceInit|undefined

    url:string
    readyState = 0
    listeners:Record<string, EventListenerFn[]> = {}
    onopen:EventListenerFn|null = null
    onerror:EventListenerFn|null = null
    onmessage:EventListenerFn|null = null
    closed = false

    constructor (url:string, options?:EventSourceInit) {
        this.url = url
        StubEventSource.instances.push(this)
        StubEventSource.lastOptions = options
    }

    addEventListener (event:string, listener:EventListenerFn) {
        (this.listeners[event] ??= []).push(listener)
    }

    removeEventListener (event:string, listener:EventListenerFn) {
        const list = this.listeners[event]
        if (!list) return
        this.listeners[event] = list.filter(fn => fn !== listener)
    }

    close () {
        this.closed = true
    }

    fire (event:string, data?:unknown) {
        const ev = data === undefined ?
            new Event(event) :
            new MessageEvent(event, { data: JSON.stringify(data) })
        const list = this.listeners[event] ?? []
        for (const fn of list) fn(ev)
        if (event === 'open' && this.onopen) this.onopen(ev)
        if (event === 'error' && this.onerror) this.onerror(ev)
    }
}

function withStubbedEventSource<T> (
    fn:() => Promise<T>
):Promise<T> {
    const original = (globalThis as { EventSource?:typeof EventSource })
        .EventSource
    StubEventSource.instances = []
    ;(globalThis as { EventSource:unknown })
        .EventSource = StubEventSource as unknown as typeof EventSource
    return fn().finally(() => {
        ;(globalThis as { EventSource?:typeof EventSource })
            .EventSource = original
    })
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type FetchHandler = (
    input:FetchInput,
    init?:FetchInit
) => Promise<Response>

function buildPartialState ():AppState {
    const route = signal('/')
    const routes:string[] = []
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
    const state = {
        _setRoute: (next:string) => {
            routes.push(next)
            route.value = next
        },
        route,
        routeItem: signal(null),
        routeItemLoading: signal(false),
        user: signal({
            did: 'did:plc:test',
            handle: 'test.bsky.social'
        }),
        authLoading: signal(false),
        authError: signal<string|null>(null),
        feeds: signal([]),
        feedsLoading: signal(false),
        refreshInProgress,
        feedSyncStatus,
        displayedFeedSyncStatus,
        feedSyncError: signal<string|null>(null),
        feedUpdateCounts: signal<Record<string, number>>({}),
        feedUpdateStatus: signal('synced'),
        feedsWithUpdates: signal([]),
        items: signal([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        counts: signal({ unread: 0, starred: 0, total: 0, perFeed: {} }),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(20),
        selectedFeedId: signal<number|null>(null),
        isAuthenticated: signal(true),
        cleanup: () => {}
    } as unknown as AppState

    // Expose route history for assertions
    ;(state as unknown as { _routeHistory:string[] })._routeHistory = routes

    return state
}

function withStubbedFetch<T> (
    handler:FetchHandler,
    fn:() => Promise<T>
):Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = handler as typeof fetch
    return fn().finally(() => {
        globalThis.fetch = original
    })
}

function jsonResponse (body:unknown, status = 200):Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

test(
    'loadFeedStatus: success populates counts and switches to updates',
    async t => {
        const state = buildPartialState()
        let calls = 0

        await withStubbedFetch(async (input) => {
            calls += 1
            const url = typeof input === 'string' ?
                input :
                input instanceof URL ?
                    input.toString() :
                    input.url
            t.ok(
                url.endsWith('/api/feed-status'),
                'calls /api/feed-status'
            )
            return jsonResponse({
                feedUpdateCounts: { 1: 2, 5: 3 },
                totalPending: 5
            })
        }, async () => {
            await State.loadFeedStatus(state)
        })

        t.equal(calls, 1, 'issues exactly one request per call')
        t.deepEqual(
            state.feedUpdateCounts.value,
            { 1: 2, 5: 3 },
            'feedUpdateCounts is overwritten with server payload'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'feedSyncStatus is updates when totalPending > 0'
        )
        t.equal(
            state.feedSyncError.value,
            null,
            'feedSyncError is cleared on success'
        )
    }
)

test(
    'loadFeedStatus: success with zero totalPending sets synced',
    async t => {
        const state = buildPartialState()

        await withStubbedFetch(async () => {
            return jsonResponse({
                feedUpdateCounts: { 1: 0 },
                totalPending: 0
            })
        }, async () => {
            await State.loadFeedStatus(state)
        })

        t.equal(
            state.feedSyncStatus.value,
            'synced',
            'feedSyncStatus is synced when totalPending === 0'
        )
    }
)

test(
    '012-T012 (US3): loadFeedStatus during a manual refresh updates the ' +
    'underlying signals but does NOT exit the displayed yellow state',
    async t => {
        const state = buildPartialState()
        // Pre-click resting state.
        state.feedSyncStatus.value = 'updates'
        state.feedUpdateCounts.value = { 1: 2 }
        // Simulate that a manual refresh is in flight.
        state.refreshInProgress.value = true

        t.equal(
            state.displayedFeedSyncStatus.value,
            'syncing',
            'pre-loader: pill is yellow (updating) because ' +
            'refreshInProgress is true'
        )

        await withStubbedFetch(async () => {
            return jsonResponse({
                feedUpdateCounts: { 1: 5, 7: 2 },
                totalPending: 7
            })
        }, async () => {
            await State.loadFeedStatus(state)
        })

        // FR-011: underlying signals MUST keep moving so the post-refresh
        // resting state can fold the loader's payload in.
        t.deepEqual(
            state.feedUpdateCounts.value,
            { 1: 5, 7: 2 },
            'underlying feedUpdateCounts is updated by the loader'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'underlying feedSyncStatus is updated by the loader'
        )
        // FR-007: the displayed pill MUST stay yellow throughout the
        // manual-refresh window, even when the loader writes underneath.
        t.equal(
            state.displayedFeedSyncStatus.value,
            'syncing',
            'displayedFeedSyncStatus stays syncing while ' +
            'refreshInProgress is true (FR-007)'
        )

        // Simulate the settle batch clearing refreshInProgress.
        state.refreshInProgress.value = false

        t.equal(
            state.displayedFeedSyncStatus.value,
            'updates',
            'displayedFeedSyncStatus surfaces the loader payload as ' +
            'soon as refreshInProgress clears (FR-011)'
        )
    }
)

test(
    'loadFeedStatus: HTTP 5xx sets feedSyncStatus to error and never lies green',
    async t => {
        const state = buildPartialState()
        // Pre-populate as if a previous call had succeeded.
        state.feedUpdateCounts.value = { 1: 4 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedFetch(async () => {
            return new Response('boom', { status: 500 })
        }, async () => {
            await State.loadFeedStatus(state)
        })

        t.equal(
            state.feedSyncStatus.value,
            'error',
            'feedSyncStatus reflects the failure'
        )
        t.notEqual(
            state.feedSyncStatus.value,
            'synced',
            'feedSyncStatus does NOT silently default to synced'
        )
        t.ok(
            state.feedSyncError.value,
            'feedSyncError carries a non-empty message'
        )
    }
)

test(
    'loadFeedStatus: HTTP 401 clears the user and routes to /login',
    async t => {
        const state = buildPartialState()
        const history =
            (state as unknown as { _routeHistory:string[] })._routeHistory

        await withStubbedFetch(async () => {
            return jsonResponse(
                { error: 'unauthorized' },
                401
            )
        }, async () => {
            await State.loadFeedStatus(state)
        })

        t.equal(state.user.value, null, 'user is cleared on 401')
        t.equal(
            state.feedSyncStatus.value,
            'error',
            'feedSyncStatus is error on 401'
        )
        t.ok(
            history.includes('/login'),
            'router is sent to /login'
        )
    }
)

test(
    'feed-updates-available: overwrites feedUpdateCounts with payload counts',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [
            { id: 1, url: 'a' },
            { id: 7, url: 'b' }
        ] as never
        state.feedUpdateCounts.value = { 1: 1, 7: 4 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            const source = StubEventSource.instances[0]
            source.fire('feed-updates-available', {
                feedUpdateCounts: { 7: 9 }
            })
        })
        State.closeEventStream()

        t.equal(
            state.feedUpdateCounts.value[7],
            9,
            'pending count for the touched feed is overwritten, not incremented'
        )
        t.equal(
            state.feedUpdateCounts.value[1],
            1,
            'untouched feeds keep their existing count'
        )
    }
)

test(
    'feed-updates-available: a 0 count entry removes that feed from the map',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [{ id: 1, url: 'a' }] as never
        state.feedUpdateCounts.value = { 1: 5 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            const source = StubEventSource.instances[0]
            source.fire('feed-updates-available', {
                feedUpdateCounts: { 1: 0 }
            })
        })
        State.closeEventStream()

        t.equal(
            Object.prototype.hasOwnProperty.call(
                state.feedUpdateCounts.value,
                '1'
            ),
            false,
            'entry with value 0 is removed from feedUpdateCounts'
        )
        t.equal(
            state.feedSyncStatus.value,
            'synced',
            'status flips to synced when the resulting total is 0'
        )
    }
)

test(
    'feed-updates-available: ignores events for feedIds not in state.feeds',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [{ id: 1, url: 'a' }] as never
        state.feedUpdateCounts.value = {}
        state.feedSyncStatus.value = 'synced'

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            const source = StubEventSource.instances[0]
            source.fire('feed-updates-available', {
                feedUpdateCounts: { 999: 4 }
            })
        })
        State.closeEventStream()

        t.equal(
            Object.keys(state.feedUpdateCounts.value).length,
            0,
            'unknown feedId entries are ignored (multi-tab unsubscribe edge)'
        )
        t.equal(
            state.feedSyncStatus.value,
            'synced',
            'status stays synced when the unknown event would have flipped it'
        )
    }
)

test(
    'EventSource reconnect: open after error triggers loadFeedStatus reconcile',
    async t => {
        const state = buildPartialState()
        let fetchCalls = 0

        await withStubbedEventSource(async () => {
            await withStubbedFetch(async () => {
                fetchCalls += 1
                return jsonResponse({
                    feedUpdateCounts: {},
                    totalPending: 0
                })
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                source.fire('open')
                await new Promise(resolve => setTimeout(resolve, 0))
                t.equal(
                    fetchCalls,
                    0,
                    'first open does not refetch (boot path already loaded)'
                )

                source.fire('error')
                source.fire('open')
                await new Promise(resolve => setTimeout(resolve, 0))
                t.equal(
                    fetchCalls,
                    1,
                    'second open (after error) re-runs loadFeedStatus (FR-007)'
                )
            })
        })
        State.closeEventStream()
    }
)

test(
    'refresh-complete: awaits refreshAfterSync to reconcile authoritative ' +
        'state',
    async t => {
        const state = buildPartialState()
        state.feedUpdateCounts.value = { 1: 4 }
        state.feedSyncStatus.value = 'updates'
        let feedStatusCalls = 0

        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feed-status')) {
                    feedStatusCalls += 1
                    return jsonResponse({
                        feedUpdateCounts: { 1: 2 },
                        totalPending: 2
                    })
                }
                if (url.includes('/api/feeds')) {
                    return jsonResponse({ feeds: [] })
                }
                if (url.includes('/api/items/count')) {
                    return jsonResponse({
                        unread: 0,
                        starred: 0,
                        total: 0,
                        perFeed: {}
                    })
                }
                if (url.includes('/api/items')) {
                    return jsonResponse({ items: [], total: 0 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                source.fire('refresh-complete', {})
                // refreshAfterSync awaits Promise.all of four loaders;
                // yield enough microtasks for all to resolve and the
                // settle batch to land.
                for (let i = 0; i < 6; i++) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
            })
        })
        State.closeEventStream()

        t.equal(
            feedStatusCalls,
            1,
            'refresh-complete reconciles via loadFeedStatus once'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'reconcile resolves to the residual count after refresh ended'
        )
        t.equal(
            state.feedUpdateCounts.value[1],
            2,
            'feedUpdateCounts reflects items that arrived during refresh'
        )
    }
)

test(
    'refreshFeeds failure leaves feedSyncStatus = error (Acceptance 3.3)',
    async t => {
        const state = buildPartialState()
        state.feedSyncStatus.value = 'updates'
        state.feedUpdateCounts.value = { 1: 3 }

        await withStubbedFetch(async () => {
            return new Response('boom', { status: 500 })
        }, async () => {
            try {
                await State.refreshFeeds(state)
            } catch {
                // refreshFeeds rethrows on failure; that's expected.
            }
        })

        t.equal(
            state.feedSyncStatus.value,
            'error',
            'partial-failure refresh ends in the error state, not synced'
        )
        t.ok(
            state.feedSyncError.value,
            'feedSyncError carries the failure detail'
        )
        t.equal(
            state.refreshInProgress.value,
            false,
            'refreshInProgress is cleared inside the failure batch (FR-007)'
        )
        t.deepEqual(
            state.feedUpdateCounts.value,
            { 1: 3 },
            'pre-click feedUpdateCounts are restored on failure (FR-007)'
        )
    }
)

test(
    'feed-updates-cleared: removes the listed feedIds from feedUpdateCounts',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [
            { id: 1, url: 'a' },
            { id: 2, url: 'b' },
            { id: 3, url: 'c' }
        ] as never
        state.feedUpdateCounts.value = { 1: 2, 2: 5, 3: 1 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            const source = StubEventSource.instances[0]
            source.fire('feed-updates-cleared', {
                feedIds: ['1', '3']
            })
        })
        State.closeEventStream()

        t.deepEqual(
            state.feedUpdateCounts.value,
            { 2: 5 },
            'only the listed feed entries are removed; others survive'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'status stays updates while pending counts remain'
        )
    }
)

test(
    'feed-updates-cleared: flips feedSyncStatus to synced when map empties',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [{ id: 1, url: 'a' }] as never
        state.feedUpdateCounts.value = { 1: 4 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            const source = StubEventSource.instances[0]
            source.fire('feed-updates-cleared', {
                feedIds: ['1']
            })
        })
        State.closeEventStream()

        t.equal(
            Object.keys(state.feedUpdateCounts.value).length,
            0,
            'feedUpdateCounts is empty after clearing the only entry'
        )
        t.equal(
            state.feedSyncStatus.value,
            'synced',
            'status flips to synced when nothing pending remains'
        )
    }
)

test(
    'openEventStream: connects to /api/events with credentials and is idempotent',
    async t => {
        const state = buildPartialState()

        await withStubbedEventSource(async () => {
            State.openEventStream(state)
            State.openEventStream(state)

            t.equal(
                StubEventSource.instances.length,
                1,
                'second openEventStream call is a no-op (no second connection)'
            )
            t.equal(
                StubEventSource.instances[0].url,
                '/api/events',
                'EventSource is opened against the SSE endpoint'
            )
            t.equal(
                StubEventSource.lastOptions?.withCredentials,
                true,
                'EventSource is opened with credentials so the session ' +
                    'cookie is sent'
            )
        })
        State.closeEventStream()
    }
)

test(
    'feed-updated: rapid bursts debounce to a single refreshAfterSync',
    async t => {
        const state = buildPartialState()
        const original = State.refreshAfterSync
        let calls = 0
        State.refreshAfterSync = async () => {
            calls += 1
        }

        try {
            await withStubbedEventSource(async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                source.fire('feed-updated')
                source.fire('feed-updated')
                source.fire('feed-updated')
                source.fire('feed-updated')
                // SSE_REFRESH_DEBOUNCE_MS is 250ms; wait past the
                // window so the coalesced timer fires inside the test.
                await new Promise(resolve => setTimeout(resolve, 320))
            })
            State.closeEventStream()

            t.equal(
                calls,
                1,
                'four feed-updated events within the debounce window ' +
                    'collapse to a single refreshAfterSync call'
            )
        } finally {
            State.refreshAfterSync = original
        }
    }
)

test(
    'feed-updates-available: legacy feedIds payload reconciles via loadFeedStatus',
    async t => {
        const state = buildPartialState()
        state.feeds.value = [{ id: 1, url: 'a' }] as never
        let fetchCalls = 0

        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                fetchCalls += 1
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                t.ok(
                    url.endsWith('/api/feed-status'),
                    'legacy fallback hits the canonical status endpoint'
                )
                return jsonResponse({
                    feedUpdateCounts: { 1: 7 },
                    totalPending: 7
                })
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                // Older server bundles emit { feedIds: [...] } without
                // canonical counts; client should defer to the status
                // endpoint rather than guessing.
                source.fire('feed-updates-available', {
                    feedIds: ['1']
                })
                await new Promise(resolve => setTimeout(resolve, 0))
                await new Promise(resolve => setTimeout(resolve, 0))
            })
        })
        State.closeEventStream()

        t.equal(
            fetchCalls,
            1,
            'legacy feedIds payload triggers exactly one status reconcile'
        )
        t.equal(
            state.feedUpdateCounts.value[1],
            7,
            'reconcile populates counts from the authoritative response'
        )
        t.equal(
            state.feedSyncStatus.value,
            'updates',
            'status reflects the server-reported pending total'
        )
    }
)
