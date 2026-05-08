import { signal, batch } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import { State, type AppState } from '../src/client/state.js'

type EventListenerFn = (ev:MessageEvent|Event) => void

class StubEventSource {
    static instances:StubEventSource[] = []

    url:string
    readyState = 0
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
        StubEventSource.instances = []
    })
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type FetchHandler = (
    input:FetchInput,
    init?:FetchInit
) => Promise<Response>

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

interface PartialState {
    _routeHistory:string[]
}

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
        refreshInProgress: signal(false),
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

    ;(state as unknown as PartialState)._routeHistory = routes

    return state
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

async function settle (count = 4):Promise<void> {
    for (let i = 0; i < count; i++) {
        await nextTask()
    }
}

interface SafetyTimerStub {
    restore:() => void
    fire:() => void
    armedCount:() => number
}

function stubSafetyTimer ():SafetyTimerStub {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const armed:Map<number, () => void> = new Map()
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
            armed.set(id, () => {
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
            if (typeof id === 'number' && armed.delete(id)) return
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
        fire: () => {
            for (const cb of Array.from(armed.values())) cb()
            armed.clear()
        },
        armedCount: () => armed.size
    }
}

// US1 - T006: happy path
test('refreshInProgress stays true after POST ack and clears on ' +
    'SSE refresh-complete (FR-001/FR-005)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 4 }
    state.feedSyncStatus.value = 'updates'

    const originalRefreshAfterSync = State.refreshAfterSync
    let refreshAfterSyncCalls = 0
    State.refreshAfterSync = async (s:AppState) => {
        refreshAfterSyncCalls += 1
        batch(() => {
            s.feedUpdateCounts.value = {}
            s.feedSyncStatus.value = 'synced'
        })
    }

    let postCalls = 0
    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    postCalls += 1
                    return jsonResponse({ success: true, queued: 4 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]

                await State.refreshFeeds(state)

                t.equal(
                    state.refreshInProgress.value,
                    true,
                    'refreshInProgress is still true after POST resolves'
                )
                t.equal(
                    state.feedSyncStatus.value,
                    'syncing',
                    'feedSyncStatus stays syncing past POST ack'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    refreshAfterSyncCalls,
                    1,
                    'refresh-complete awaits refreshAfterSync once'
                )
                t.equal(
                    state.refreshInProgress.value,
                    false,
                    'settle batch clears refreshInProgress'
                )
                t.equal(
                    state.feedSyncStatus.value,
                    'synced',
                    'reconcile resolves to synced'
                )
                t.deepEqual(
                    state.feedUpdateCounts.value,
                    {},
                    'reconcile updated feedUpdateCounts'
                )
            })
        })
    } finally {
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }

    t.equal(postCalls, 1, 'exactly one POST /feeds/refresh dispatched')
})

// US1 - T007: rapid duplicate clicks (FR-008)
test('rapid duplicate refreshFeeds calls dispatch only one POST (FR-008)',
    async t => {
        const state = buildPartialState()

        let postCalls = 0
        await withStubbedFetch(async (input) => {
            const url = typeof input === 'string' ?
                input :
                input instanceof URL ?
                    input.toString() :
                    input.url
            if (url.endsWith('/api/feeds/refresh')) {
                postCalls += 1
                return new Promise<Response>(resolve => {
                    setTimeout(() => {
                        resolve(jsonResponse({ success: true, queued: 0 }))
                    }, 0)
                })
            }
            return jsonResponse({})
        }, async () => {
            const promises = [
                State.refreshFeeds(state),
                State.refreshFeeds(state),
                State.refreshFeeds(state),
                State.refreshFeeds(state)
            ]
            await Promise.all(promises)
        })

        t.equal(
            postCalls,
            1,
            'four rapid clicks dispatch exactly one POST'
        )
        t.equal(
            state.refreshInProgress.value,
            true,
            'refreshInProgress remains true after the single in-flight ' +
            'refresh resolves (settles via SSE)'
        )
    })

// US1 - T008: feed-updated does NOT clear refreshInProgress (FR-011)
test('SSE feed-updated does NOT clear refreshInProgress (FR-011)',
    async t => {
        const state = buildPartialState()
        state.refreshInProgress.value = true
        state.feedSyncStatus.value = 'syncing'

        await withStubbedEventSource(async () => {
            await withStubbedFetch(async () => {
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                source.fire('feed-updated')
                await settle()
            })
        })
        State.closeEventStream()

        t.equal(
            state.refreshInProgress.value,
            true,
            'feed-updated leaves refreshInProgress unchanged; only ' +
            'refresh-complete may clear it'
        )
    })

// US1 - T009: SSE drop and reopen mid-refresh
test('SSE reopen with refreshInProgress runs refreshAfterSync and ' +
    'clears the busy state',
async t => {
    const state = buildPartialState()
    state.refreshInProgress.value = true
    state.feedSyncStatus.value = 'syncing'

    const originalRefreshAfterSync = State.refreshAfterSync
    let calls = 0
    State.refreshAfterSync = async () => {
        calls += 1
    }

    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async () => {
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]

                // First open is the initial connect; the handler's
                // hasOpenedBefore flag flips to true after this.
                source.fire('open')

                source.fire('error')
                source.fire('open')
                await settle()
            })
        })
    } finally {
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }

    t.equal(
        calls,
        1,
        'reopen with refreshInProgress=true runs the full ' +
        'refreshAfterSync once'
    )
    t.equal(
        state.refreshInProgress.value,
        false,
        'settle batch on reopen clears refreshInProgress'
    )
})

// US1 - T010: 60s safety timer fallback
test('safety timer clears refreshInProgress when refresh-complete is lost',
    async t => {
        const timer = stubSafetyTimer()
        const state = buildPartialState()

        try {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    return jsonResponse({ success: true, queued: 0 })
                }
                return jsonResponse({})
            }, async () => {
                await State.refreshFeeds(state)

                t.equal(
                    state.refreshInProgress.value,
                    true,
                    'refreshInProgress is true while waiting for SSE'
                )
                t.equal(
                    timer.armedCount(),
                    1,
                    'safety timer is armed while refresh is in flight'
                )

                timer.fire()

                t.equal(
                    state.refreshInProgress.value,
                    false,
                    'safety timer clears refreshInProgress'
                )
            })
        } finally {
            timer.restore()
        }
    })

// US1 - T011: zero-feed edge case
test('zero-feed refresh settles cleanly via refresh-complete with empty ' +
    'payload (FR-006)',
async t => {
    const state = buildPartialState()
    state.feeds.value = []
    state.feedSyncStatus.value = 'inactive'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async (s:AppState) => {
        // No feeds means an empty server reconcile.
        batch(() => {
            s.feedUpdateCounts.value = {}
            s.feedSyncStatus.value = 'synced'
        })
    }

    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    return jsonResponse({ success: true, queued: 0 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]

                await State.refreshFeeds(state)
                source.fire('refresh-complete')
                await settle()
            })
        })
    } finally {
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }

    t.equal(
        state.refreshInProgress.value,
        false,
        'zero-feed refresh resolves refreshInProgress to false'
    )
    t.equal(
        state.feedSyncStatus.value,
        'synced',
        'zero-feed refresh resolves to synced'
    )
    t.equal(
        state.feedSyncError.value,
        null,
        'zero-feed refresh produces no spurious error'
    )
})

// US2 - T020: failure restores priorCounts
test('refreshFeeds POST 5xx restores priorCounts and sets error (FR-007)',
    async t => {
        const state = buildPartialState()
        state.feedUpdateCounts.value = { 1: 7 }
        state.feedSyncStatus.value = 'updates'

        await withStubbedFetch(async () => {
            return new Response('boom', { status: 500 })
        }, async () => {
            await State.refreshFeeds(state).catch(() => undefined)
        })

        t.deepEqual(
            state.feedUpdateCounts.value,
            { 1: 7 },
            'feedUpdateCounts restored to pre-click snapshot'
        )
        t.equal(
            state.feedSyncStatus.value,
            'error',
            'feedSyncStatus is error after POST failure'
        )
        t.ok(
            state.feedSyncError.value,
            'feedSyncError carries a non-empty message'
        )
        t.equal(
            state.refreshInProgress.value,
            false,
            'refreshInProgress is cleared inside the failure batch'
        )
    })

// US2 - T021: 401 batch
test('refreshFeeds POST 401 nulls user, routes /login, and clears ' +
    'refreshInProgress in one batch',
async t => {
    const state = buildPartialState()
    state.feedSyncStatus.value = 'updates'

    await withStubbedFetch(async () => {
        return new Response('unauthenticated', { status: 401 })
    }, async () => {
        await State.refreshFeeds(state).catch(() => undefined)
    })

    t.equal(
        state.user.value,
        null,
        'user is nulled on 401'
    )
    t.ok(
        state.authError.value,
        'authError is populated on 401'
    )
    t.ok(
        (state as unknown as { _routeHistory:string[] })
            ._routeHistory.includes('/login'),
        'router is sent to /login on 401'
    )
    t.equal(
        state.refreshInProgress.value,
        false,
        'refreshInProgress is cleared inside the 401 batch'
    )
})
