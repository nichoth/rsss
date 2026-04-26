import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { Header } from '../src/client/components/header.js'
import { type AppState } from '../src/client/state.js'
import {
    isLocalFirstActive,
    syncStatus,
    syncError,
    syncPending,
    syncDeadLetters,
    syncedAt
} from '../src/client/db/sync-status.js'
import { billingStatus } from '../src/client/billing-status.js'

function headerState ():AppState {
    return {
        route: signal('/'),
        user: signal(null)
    } as AppState
}

test('Header sponsor iframes limit embed capabilities', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    try {
        render(html`<${Header} state=${headerState()} />`, root)

        const frames = Array.from(root.querySelectorAll('iframe'))

        t.equal(frames.length, 2, 'renders both sponsor iframes')

        for (const frame of frames) {
            t.equal(
                frame.getAttribute('sandbox'),
                'allow-scripts allow-same-origin',
                'sets iframe sandbox'
            )
            t.equal(
                frame.getAttribute('loading'),
                'lazy',
                'lazy-loads iframe'
            )
            t.equal(
                frame.getAttribute('referrerpolicy'),
                'no-referrer',
                'removes iframe referrers'
            )
        }
    } finally {
        render(null, root)
        root.remove()
    }
})

test('Header sync status exposes accessible live status text', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    isLocalFirstActive.value = true
    syncStatus.value = 'error'
    syncError.value = 'pullSync: server returned 500'
    syncPending.value = 2
    syncDeadLetters.value = 0
    syncedAt.value = null
    billingStatus.value = {
        entitled: true,
        planId: 'sync',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }

    try {
        render(html`<${Header} state=${headerState()} />`, root)

        const status = root.querySelector('.sync-status') as HTMLElement

        t.ok(status, 'renders the sync status')
        t.equal(status.getAttribute('role'), 'status', 'uses status role')
        t.equal(
            status.getAttribute('aria-live'),
            'polite',
            'announces updates politely'
        )
        t.equal(
            status.getAttribute('aria-label'),
            'Sync error: pullSync: server returned 500',
            'includes tooltip detail in accessible text'
        )
    } finally {
        render(null, root)
        root.remove()
        isLocalFirstActive.value = false
        syncStatus.value = 'idle'
        syncError.value = null
        syncPending.value = 0
        syncDeadLetters.value = 0
        syncedAt.value = null
        billingStatus.value = null
    }
})
