import { computed, signal } from '@preact/signals'
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

type FeedSyncStatus = 'inactive'|'updates'|'syncing'|'error'|'synced'

function headerState (
    user:{ did:string; handle:string; avatar?:string }|null = null,
    options:{
        feedSyncStatus?:FeedSyncStatus,
        feedUpdateCounts?:Record<string, number>,
        feedSyncError?:string|null
    } = {}
):AppState {
    const feedSyncStatus = signal<FeedSyncStatus>(
        options.feedSyncStatus ?? 'inactive'
    )
    const feedUpdateCounts = signal<Record<string, number>>(
        options.feedUpdateCounts ?? {}
    )

    return {
        route: signal('/'),
        user: signal(user),
        feedSyncStatus,
        feedUpdateCounts,
        feedSyncError: signal<string|null>(
            options.feedSyncError ?? null
        ),
        feedUpdateStatus: computed<'synced'|'updates'>(() => (
            feedSyncStatus.value === 'updates' ?
                'updates' :
                'synced'
        ))
    } as unknown as AppState
}

test('Header sponsor iframes limit embed capabilities', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    try {
        render(html`<${Header} state=${headerState()} />`, root)

        const frames = Array.from(root.querySelectorAll('iframe'))

        t.ok(frames.length > 0, 'renders sponsor iframe')

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

test(
    'Header user icon shows empty circle linking to /login when logged out',
    t => {
        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        try {
            render(html`<${Header} state=${headerState(null)} />`, root)

            const icons = Array.from(
                root.querySelectorAll('a.user-icon')
            )
            t.ok(icons.length > 0, 'renders at least one user icon')

            for (const icon of icons) {
                t.equal(
                    icon.getAttribute('href'),
                    '/login',
                    'links to /login when logged out'
                )
                t.equal(
                    icon.getAttribute('aria-label'),
                    'Sign in',
                    'has Sign in accessible label'
                )
                t.ok(
                    icon.querySelector('.user-icon-placeholder'),
                    'shows the empty circle placeholder'
                )
                t.ok(
                    !icon.querySelector('img'),
                    'does not render an avatar image'
                )
            }
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'Header user icon shows avatar linking to /settings when logged in',
    t => {
        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        const user = {
            did: 'did:plc:test123',
            handle: 'alice.bsky.social',
            avatar: 'https://example.test/alice.jpg'
        }

        try {
            render(html`<${Header} state=${headerState(user)} />`, root)

            const icons = Array.from(
                root.querySelectorAll('a.user-icon')
            )
            t.ok(icons.length > 0, 'renders at least one user icon')

            for (const icon of icons) {
                t.equal(
                    icon.getAttribute('href'),
                    '/settings',
                    'links to /settings when logged in'
                )
                t.equal(
                    icon.getAttribute('aria-label'),
                    'Account settings for @alice.bsky.social',
                    'accessible label includes the handle'
                )
                const img = icon.querySelector('img') as HTMLImageElement
                t.ok(img, 'renders an avatar image')
                t.equal(
                    img.getAttribute('src'),
                    'https://example.test/alice.jpg',
                    'image points at the avatar URL'
                )
                t.ok(
                    !icon.querySelector('.user-icon-placeholder'),
                    'does not show the placeholder'
                )
            }
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

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
        planId: 'local-first',
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

test('Header feed status renders one dot for all sync states', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    const user = {
        did: 'did:plc:test123',
        handle: 'alice.bsky.social'
    }
    const cases:Array<{
        status:FeedSyncStatus,
        color:string,
        text:string,
        title:string|null
    }> = [
        {
            status: 'inactive',
            color: 'gray',
            text: '',
            title: null
        },
        {
            status: 'updates',
            color: 'blue',
            text: '3',
            title: null
        },
        {
            status: 'syncing',
            color: 'yellow',
            text: '',
            title: null
        },
        {
            status: 'error',
            color: 'red',
            text: 'sync failed',
            title: 'Refresh failed: upstream timed out'
        },
        {
            status: 'synced',
            color: 'green',
            text: '',
            title: null
        }
    ]

    try {
        for (const item of cases) {
            render(null, root)
            const state = headerState(user, {
                feedSyncStatus: item.status,
                feedUpdateCounts: { one: 1, two: 2 },
                feedSyncError: item.title
            })

            render(html`<${Header} state=${state} />`, root)

            const status = root.querySelector(
                '.feed-status'
            ) as HTMLElement
            const dots = root.querySelectorAll(
                '.feed-status .dot'
            )

            t.ok(status, `renders feed status for ${item.status}`)
            t.equal(dots.length, 1, 'renders one header feed dot')
            t.ok(
                dots[0].classList.contains(item.color),
                `uses ${item.color} dot for ${item.status}`
            )
            t.equal(
                status.getAttribute('role'),
                'status',
                'uses status role'
            )
            t.equal(
                status.getAttribute('aria-live'),
                'polite',
                'announces feed status politely'
            )
            t.equal(
                status.textContent?.trim() ?? '',
                item.text,
                `renders expected text for ${item.status}`
            )
            t.equal(
                status.getAttribute('title'),
                item.title,
                `sets expected title for ${item.status}`
            )
        }
    } finally {
        render(null, root)
        root.remove()
    }
})

test('Header feed status is hidden for anonymous users', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    try {
        render(html`<${Header} state=${headerState(null, {
            feedSyncStatus: 'updates',
            feedUpdateCounts: { one: 3 }
        })} />`, root)

        t.equal(
            root.querySelectorAll('.feed-status .dot').length,
            0,
            'does not render a feed dot when signed out'
        )
    } finally {
        render(null, root)
        root.remove()
    }
})
