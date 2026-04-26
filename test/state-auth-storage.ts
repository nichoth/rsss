import { signal } from '@preact/signals'
import { test } from '@substrate-system/tapzero'
import { State, type AppState } from '../src/client/state.js'

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
