import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import { State, type AppState } from '../src/client/state.js'

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function authState ():AppState {
    return {
        authLoading: signal(false),
        authError: signal<string|null>(null),
        user: signal(null)
    } as AppState
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
