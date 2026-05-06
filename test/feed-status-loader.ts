import { signal } from '@preact/signals'
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
        feedSyncStatus: signal<
            'inactive'|'updates'|'syncing'|'error'|'synced'
        >('inactive'),
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
    'refresh-complete: triggers a defensive loadFeedStatus reconcile',
    async t => {
        const state = buildPartialState()
        state.feedUpdateCounts.value = { 1: 4 }
        state.feedSyncStatus.value = 'updates'
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
                    'reconcile call hits /api/feed-status'
                )
                return jsonResponse({
                    feedUpdateCounts: { 1: 2 },
                    totalPending: 2
                })
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                source.fire('refresh-complete', {})
                // The handler synchronously clears counts; the
                // reconcile is async. Yield so the fetch resolves.
                await new Promise(resolve => setTimeout(resolve, 0))
                await new Promise(resolve => setTimeout(resolve, 0))
            })
        })
        State.closeEventStream()

        t.equal(
            fetchCalls,
            1,
            'refresh-complete defensively reconciles via loadFeedStatus ' +
                '(Acceptance 3.2)'
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
    }
)
