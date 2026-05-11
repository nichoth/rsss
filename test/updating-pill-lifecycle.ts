import { signal, batch, computed } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import {
    SidebarFooter
} from '../src/client/components/sidebar-footer.js'
import { FeedStatus } from '../src/client/components/feed-status.js'
import { State, type AppState } from '../src/client/state.js'

type EventListenerFn = (ev:MessageEvent|Event) => void

class StubEventSource {
    static instances:StubEventSource[] = []

    url:string
    readyState = 0
    listeners:Record<string, EventListenerFn[]> = {}
    onopen:EventListenerFn|null = null
    onerror:EventListenerFn|null = null
    onmessage:EventListenerFn|null = null
    closed = false

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

    close ():void {
        this.closed = true
    }

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
        feeds: signal([{ id: 1, url: 'a' }]),
        feedsLoading: signal(false),
        feedsError: signal<string|null>(null),
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
        initialLoadComplete: signal<boolean>(false),
        cleanup: () => {}
    } as unknown as AppState

    ;(state as unknown as { _routeHistory:string[] })
        ._routeHistory = routes

    return state
}

function mount (state:AppState):HTMLDivElement {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(
        html`<div>
            <${SidebarFooter} state=${state}/>
            <${FeedStatus} state=${state}/>
        </div>`,
        root
    )
    return root
}

function unmount (root:HTMLDivElement):void {
    render(null, root)
    root.remove()
}

function refreshButton (root:HTMLElement):HTMLButtonElement {
    const buttons = root.querySelectorAll('button')
    for (const btn of Array.from(buttons)) {
        const text = (btn.textContent || '').trim()
        if (text.includes('Refresh Feeds')) {
            return btn as HTMLButtonElement
        }
    }
    throw new Error('Refresh Feeds button not found in mounted output')
}

function pillWrapper (root:HTMLElement):HTMLElement {
    const pill = root.querySelector('.feed-status') as HTMLElement|null
    if (!pill) {
        throw new Error('FeedStatus pill not found in mounted output')
    }
    return pill
}

function pillDotColor (root:HTMLElement):string {
    const dot = root.querySelector('.feed-status svg.dot')
    if (!dot) {
        throw new Error('FeedStatus dot SVG not found in mounted output')
    }
    const colors = ['gray', 'green', 'blue', 'yellow', 'red']
    for (const color of colors) {
        if (dot.classList.contains(color)) return color
    }
    throw new Error('FeedStatus dot has no recognized color class')
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

async function settle (count = 4):Promise<void> {
    for (let i = 0; i < count; i++) {
        await nextTask()
    }
}

// 012-T014 / FR-012 (a) (c) success-with-items.
// The pill is yellow + 'updating' from the click frame onward, then
// transitions to blue 'n updates' inside the same paint as the
// refresh button returns to idle.
test('012-FR-012: success-with-items lifecycle: yellow updating -> ' +
    'blue n updates in one paint',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = {}
    state.feedSyncStatus.value = 'synced'

    const originalReconcileAfterRefresh = State.reconcileAfterRefresh
    State.reconcileAfterRefresh = async (s:AppState) => {
        batch(() => {
            s.feedUpdateCounts.value = { 1: 4 }
            s.feedSyncStatus.value = 'updates'
        })
    }

    const root = mount(state)
    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    return jsonResponse({ success: true, queued: 4 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]

                t.equal(
                    pillDotColor(root),
                    'green',
                    'pre-click pill is green (synced)'
                )

                const btn = refreshButton(root)
                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                t.equal(
                    pillDotColor(root),
                    'yellow',
                    'in-flight pill is yellow (FR-012a)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes('updating'),
                    'in-flight pill text reads "updating" (FR-012a)'
                )
                t.equal(
                    pillWrapper(root).getAttribute('aria-label'),
                    'Feed sync status: updating',
                    'in-flight aria-label is "Feed sync status: ' +
                    'updating" (FR-012a / FR-008)'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'true',
                    'button is busy in-flight'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    pillDotColor(root),
                    'blue',
                    'post-resolution pill is blue (n updates) ' +
                    '(FR-012c)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes('4 updates'),
                    'post-resolution pill text reads "4 updates"'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'button busy clears in the same settle (FR-012c)'
                )
            })
        })
    } finally {
        unmount(root)
        State.reconcileAfterRefresh = originalReconcileAfterRefresh
        State.closeEventStream()
    }
})

// 012-T014 / FR-012 (c) success-no-items.
// Pill yellow updating -> green up to date in one paint.
test('012-FR-012: success-no-items lifecycle: yellow updating -> ' +
    'green up to date in one paint',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = {}
    state.feedSyncStatus.value = 'synced'

    const originalReconcileAfterRefresh = State.reconcileAfterRefresh
    State.reconcileAfterRefresh = async (s:AppState) => {
        batch(() => {
            s.feedUpdateCounts.value = {}
            s.feedSyncStatus.value = 'synced'
        })
    }

    const root = mount(state)
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

                const btn = refreshButton(root)
                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                t.equal(
                    pillDotColor(root),
                    'yellow',
                    'in-flight pill is yellow (FR-012a)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes('updating'),
                    'in-flight pill text reads "updating"'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    pillDotColor(root),
                    'green',
                    'post-resolution pill is green (up to date) ' +
                    '(FR-012c)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes(
                        'up to date'
                    ),
                    'post-resolution pill text reads "up to date"'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'button busy clears in the same settle'
                )
            })
        })
    } finally {
        unmount(root)
        State.reconcileAfterRefresh = originalReconcileAfterRefresh
        State.closeEventStream()
    }
})

// 012-T014 / FR-012 (d) failure path.
// Pill yellow updating -> red sync failed (NEVER green).
test('012-FR-012: failure lifecycle: yellow updating -> red sync ' +
    'failed (never green)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 6 }
    state.feedSyncStatus.value = 'updates'
    const priorCounts = { ...state.feedUpdateCounts.value }

    const root = mount(state)
    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    return new Response('boom', { status: 500 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)

                const btn = refreshButton(root)
                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                t.equal(
                    pillDotColor(root),
                    'red',
                    'failure exits yellow into red (FR-012d) — never ' +
                    'green or stuck on yellow'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes(
                        'sync failed'
                    ),
                    'pill text reads "sync failed" after failure batch'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'button busy cleared inside the failure batch'
                )
                t.deepEqual(
                    state.feedUpdateCounts.value,
                    priorCounts,
                    'priorCounts restored on failure (010/011 ' +
                    'contract preserved)'
                )
            })
        })
    } finally {
        unmount(root)
        State.closeEventStream()
    }
})

// 012-T014 / FR-012 (b) background-poll-during-refresh.
// A background SSE feed-updates-available arrives while the manual
// refresh is in flight. The pill stays yellow throughout and the
// background tick's count is folded into the post-refresh resting
// state.
test('012-FR-012: background feed-updates-available during refresh ' +
    'leaves the pill yellow until settle (FR-012b / FR-007 / FR-011)',
async t => {
    const state = buildPartialState()
    state.feeds.value = [
        { id: 1, url: 'a' },
        { id: 7, url: 'b' }
    ] as never
    state.feedUpdateCounts.value = { 1: 1 }
    state.feedSyncStatus.value = 'updates'

    const originalReconcileAfterRefresh = State.reconcileAfterRefresh
    // Settle simulates the post-refresh authoritative reconcile that
    // sees the SSE-bumped count.
    State.reconcileAfterRefresh = async (s:AppState) => {
        batch(() => {
            s.feedSyncStatus.value = 'updates'
        })
    }

    const root = mount(state)
    try {
        await withStubbedEventSource(async () => {
            await withStubbedFetch(async (input) => {
                const url = typeof input === 'string' ?
                    input :
                    input instanceof URL ?
                        input.toString() :
                        input.url
                if (url.endsWith('/api/feeds/refresh')) {
                    return jsonResponse({ success: true, queued: 1 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]

                const btn = refreshButton(root)
                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                t.equal(
                    pillDotColor(root),
                    'yellow',
                    'in-flight pill is yellow before SSE event'
                )

                // Background SSE event mid-flight (e.g. background
                // poller bumping count for feed 7).
                source.fire('feed-updates-available', {
                    feedUpdateCounts: { 7: 4 }
                })
                await settle()

                t.equal(
                    pillDotColor(root),
                    'yellow',
                    'pill STAYS yellow when SSE feed-updates-available ' +
                    'arrives mid-refresh (FR-012b / FR-007)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes('updating'),
                    'pill text still reads "updating" mid-refresh'
                )
                t.equal(
                    state.feedUpdateCounts.value[7],
                    4,
                    'SSE-bumped count is captured underneath the ' +
                    'masked yellow display (FR-011)'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    pillDotColor(root),
                    'blue',
                    'post-resolution pill is blue (n updates) with ' +
                    'the SSE-bumped count folded in (FR-012c / FR-011)'
                )
                t.equal(
                    state.feedUpdateCounts.value[7],
                    4,
                    'SSE-bumped count survives into the post-refresh ' +
                    'resting state'
                )
            })
        })
    } finally {
        unmount(root)
        State.reconcileAfterRefresh = originalReconcileAfterRefresh
        State.closeEventStream()
    }
})

// 012-T014 / FR-012 (e) zero-feeds-subscribed edge case.
// Even with no feeds, the click MUST produce at least one paint of
// yellow before settling green.
test('012-FR-012: zero-feeds-subscribed click flashes yellow for at ' +
    'least one paint before settling green (FR-012e)',
async t => {
    const state = buildPartialState()
    state.feeds.value = []
    state.feedUpdateCounts.value = {}
    state.feedSyncStatus.value = 'synced'

    const originalReconcileAfterRefresh = State.reconcileAfterRefresh
    State.reconcileAfterRefresh = async (s:AppState) => {
        batch(() => {
            s.feedUpdateCounts.value = {}
            s.feedSyncStatus.value = 'synced'
        })
    }

    const root = mount(state)
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

                const btn = refreshButton(root)
                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                // The click MUST produce a perceptible yellow paint
                // even on zero-feeds accounts.
                t.equal(
                    pillDotColor(root),
                    'yellow',
                    'zero-feeds click flashes yellow for at least ' +
                    'one paint (FR-012e)'
                )
                t.ok(
                    pillWrapper(root).textContent?.includes('updating'),
                    'zero-feeds click pill text reads "updating"'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    pillDotColor(root),
                    'green',
                    'zero-feeds settle returns pill to green ' +
                    '(up to date)'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'button busy cleared on zero-feeds settle'
                )
            })
        })
    } finally {
        unmount(root)
        State.reconcileAfterRefresh = originalReconcileAfterRefresh
        State.closeEventStream()
    }
})
