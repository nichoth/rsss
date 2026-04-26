import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import * as pullSyncModule from '../src/client/db/pull-sync.js'
import { PushSyncAuthError } from '../src/client/db/push-sync.js'
import { State, type AppState } from '../src/client/state.js'

type ErrorCtor = new () => Error
type StateWithSyncAuth = typeof State & {
    handleSyncAuthError?:(state:AppState, err:unknown) => boolean
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function authState ():AppState {
    return ({
        authLoading: signal(false),
        authError: signal<string|null>(null),
        _setRoute: () => {},
        user: signal(null)
    } as unknown) as AppState
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
        State.loadBillingStatus = async (state:AppState) => {
            loadDids.push(state.user.value?.did ?? 'none')
            return null
        }
        State.loadFeeds = async () => {}
        State.loadItems = async () => {}
        State.loadCounts = async () => {}

        try {
            State()
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
