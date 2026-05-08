import { signal, batch } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import {
    SidebarFooter
} from '../src/client/components/sidebar-footer.js'
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

    ;(state as unknown as { _routeHistory:string[] })
        ._routeHistory = routes

    return state
}

function mount (state:AppState):HTMLDivElement {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(
        html`<${SidebarFooter} state=${state}/>`,
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

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

async function settle (count = 4):Promise<void> {
    for (let i = 0; i < count; i++) {
        await nextTask()
    }
}

// US1 - T005: a real click dispatches POST /api/feeds/refresh and the
// button enters its busy state (FR-001).
test('clicking the rendered "Refresh Feeds" button dispatches one ' +
    'POST and sets aria-busy="true" (FR-001)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 4 }
    state.feedSyncStatus.value = 'updates'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async () => {}

    let postCalls = 0
    let resolvePost:((r:Response) => void)|null = null
    const postGate = new Promise<Response>(resolve => {
        resolvePost = resolve
    })

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
                    postCalls += 1
                    return postGate
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)

                const btn = refreshButton(root)

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'pre-click aria-busy is false'
                )

                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))

                // Yield once so refreshFeeds enters its click-setup
                // batch (refreshInProgress -> true) and dispatches
                // the POST.
                await nextTask()

                t.equal(
                    postCalls,
                    1,
                    'click dispatches exactly one POST /api/feeds/refresh'
                )
                t.equal(
                    btn.getAttribute('aria-busy'),
                    'true',
                    'aria-busy is true while POST is in flight'
                )
                t.ok(
                    btn.disabled,
                    'button is disabled while POST is in flight'
                )

                // Resolve the POST so the test can finish cleanly. We
                // don't fire SSE refresh-complete here — that's T006.
                resolvePost!(jsonResponse({ success: true, queued: 4 }))
                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'true',
                    'aria-busy STAYS true after POST resolves; only ' +
                    'SSE refresh-complete may release it (FR-002)'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})

// US1 - T006: aria-busy stays true continuously through the refresh
// window and clears in the same paint as the resolution cue
// (FR-002 / FR-005).
test('aria-busy stays true past POST resolve until SSE ' +
    'refresh-complete; resolution cue lands in the same batch (FR-005)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 4 }
    state.feedSyncStatus.value = 'updates'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async (s:AppState) => {
        batch(() => {
            s.feedUpdateCounts.value = { 1: 7 }
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

                const btn = refreshButton(root)

                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))

                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'true',
                    'aria-busy true in the window between POST ack ' +
                    'and SSE refresh-complete (FR-002)'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'SSE refresh-complete clears aria-busy'
                )
                t.equal(
                    state.feedUpdateCounts.value[1],
                    7,
                    'feedUpdateCounts updated by refreshAfterSync ' +
                    'before the busy cue cleared (FR-005 single ' +
                    'paint)'
                )
                t.equal(
                    btn.disabled,
                    false,
                    'button is no longer disabled after settle'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})

// US2 - T012: new-items resolution; pill / items / button transition
// in one paint (FR-003a / FR-005).
test('new-items resolution: aria-busy clears with feedUpdateCounts ' +
    'and feedSyncStatus updated together (FR-003a)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = {}
    state.feedSyncStatus.value = 'synced'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async (s:AppState) => {
        batch(() => {
            s.feedUpdateCounts.value = { 1: 1, 2: 1, 3: 1 }
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
                    return jsonResponse({ success: true, queued: 3 })
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

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'aria-busy cleared after refresh-complete'
                )
                t.deepEqual(
                    state.feedUpdateCounts.value,
                    { 1: 1, 2: 1, 3: 1 },
                    'three new items surface in feedUpdateCounts'
                )
                t.equal(
                    state.feedSyncStatus.value,
                    'updates',
                    'feedSyncStatus reflects new updates'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})

// US2 - T013: no-new-items resolution; pill goes to synced
// (FR-003b).
test('no-new-items resolution: pill transitions cleanly to ' +
    '"up to date"; never to a fourth silent state (FR-003b)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = {}
    state.feedSyncStatus.value = 'synced'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async (s:AppState) => {
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
                    state.feedSyncStatus.value,
                    'syncing',
                    'pill transitions through syncing during the run'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'aria-busy cleared after refresh-complete'
                )
                t.equal(
                    state.feedSyncStatus.value,
                    'synced',
                    'pill resolves to synced (up to date) on no-new'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})

// US2 - T014: failure resolution; aria-busy clears, prior counts
// restored, error legend surfaces (FR-003c / FR-006 / FR-007).
test('failure resolution: aria-busy clears, prior counts restored, ' +
    'error legend surfaces (FR-003c / FR-006 / FR-007)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 4, 2: 2 }
    state.feedSyncStatus.value = 'updates'
    const priorCounts = state.feedUpdateCounts.value

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
                    btn.getAttribute('aria-busy'),
                    'false',
                    'aria-busy cleared inside the failure batch'
                )
                t.equal(
                    state.feedSyncStatus.value,
                    'error',
                    'feedSyncStatus is error'
                )
                t.deepEqual(
                    state.feedUpdateCounts.value,
                    priorCounts,
                    'feedUpdateCounts is restored to its pre-click ' +
                    'value (NOT zeroed — FR-006)'
                )
                t.ok(
                    state.feedSyncError.value,
                    'feedSyncError carries a non-null message'
                )
            })
        })
    } finally {
        unmount(root)
        State.closeEventStream()
    }
})

// US3 - T015: successive resolved clicks; each goes through the full
// chain (FR-008).
test('three successive resolved clicks each dispatch a POST and ' +
    'each cycle through the full visible chain (FR-008)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 1 }
    state.feedSyncStatus.value = 'updates'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async () => {}

    let postCalls = 0
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
                    postCalls += 1
                    return jsonResponse({ success: true, queued: 1 })
                }
                return jsonResponse({})
            }, async () => {
                State.openEventStream(state)
                const source = StubEventSource.instances[0]
                const btn = refreshButton(root)

                for (let i = 1; i <= 3; i++) {
                    btn.dispatchEvent(new MouseEvent('click', {
                        bubbles: true
                    }))
                    await settle()

                    t.equal(
                        btn.getAttribute('aria-busy'),
                        'true',
                        `click ${i} sets aria-busy true`
                    )

                    source.fire('refresh-complete')
                    await settle()

                    t.equal(
                        btn.getAttribute('aria-busy'),
                        'false',
                        `click ${i} resolves aria-busy back to false`
                    )
                }

                t.equal(
                    postCalls,
                    3,
                    'three clicks dispatch exactly three POSTs'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})

// US3 - T016: click-while-busy guard; second click is swallowed by
// the disabled DOM attribute (FR-007).
test('a second click while the button is disabled does not dispatch ' +
    'a second POST (FR-007)',
async t => {
    const state = buildPartialState()
    state.feedUpdateCounts.value = { 1: 1 }
    state.feedSyncStatus.value = 'updates'

    const originalRefreshAfterSync = State.refreshAfterSync
    State.refreshAfterSync = async () => {}

    let postCalls = 0
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
                    postCalls += 1
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

                t.ok(
                    btn.disabled,
                    'button is disabled while in flight'
                )

                btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true
                }))
                await settle()

                t.equal(
                    postCalls,
                    1,
                    'second click while disabled does NOT dispatch ' +
                    'a second POST'
                )

                source.fire('refresh-complete')
                await settle()

                t.equal(
                    btn.getAttribute('aria-busy'),
                    'false',
                    'in-flight run resolves cleanly after the second ' +
                    'click is swallowed'
                )
            })
        })
    } finally {
        unmount(root)
        State.refreshAfterSync = originalRefreshAfterSync
        State.closeEventStream()
    }
})
