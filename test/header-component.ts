import { batch, computed, signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { Header } from '../src/client/components/header.js'
import { type AppState } from '../src/client/state.js'
import { State } from '../src/client/state.js'
import { SettingsRoute } from '../src/client/routes/settings.js'
import {
    isLocalFirstActive,
    syncStatus,
    syncError,
    syncPending,
    syncDeadLetters,
    syncedAt
} from '../src/client/db/sync-status.js'
import { billingStatus } from '../src/client/billing-status.js'
import {
    cacheStatus,
    resetCacheStatus
} from '../src/client/cache-status-state.js'
import {
    storeContent,
    syncSubscriptions
} from '../src/client/local-first-settings.js'
import { localFirstSupported } from '../src/client/db/index.js'
import {
    _resetStorageUsage,
    totalStorageBytes
} from '../src/client/db/storage-usage.js'

type FeedSyncStatus = 'inactive'|'updates'|'syncing'|'error'|'synced'

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function headerState (
    user:{ did:string; handle:string; avatar?:string }|null = null,
    options:{
        route?:string,
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
        route: signal(options.route ?? '/'),
        user: signal(user),
        feedSyncStatus,
        displayedFeedSyncStatus: computed<FeedSyncStatus>(() => (
            feedSyncStatus.value
        )),
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

function persistLocalFirstSettings (
    sync:boolean,
    store:boolean
):void {
    localStorage.setItem('rsss.localFirst', JSON.stringify({
        syncSubscriptions: sync,
        storeContent: store,
        defaultCacheMode: 'text_images',
        defaultMaxSizeBytes: 50_000_000,
        defaultMaxAgeSeconds: 30 * 86400,
        defaultAccountMaxSizeBytes: 500_000_000
    }))
}

test('Header cache status renders on authenticated app routes', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    const user = {
        did: 'did:plc:test123',
        handle: 'alice.bsky.social'
    }

    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    cacheStatus.value = {
        uncachedCount: 0,
        totalCount: 2,
        itemsToCache: []
    }
    syncSubscriptions.value = true
    storeContent.value = true

    try {
        for (const route of ['/', '/starred', '/feed/1', '/settings',
            '/about', '/add-feed']) {
            render(null, root)
            render(html`<${Header} state=${headerState(user, {
                route
            })} />`, root)

            const status = root.querySelector(
                '.cache-status'
            ) as HTMLElement|null

            t.ok(status, `renders cache status on ${route}`)
        }
    } finally {
        render(null, root)
        root.remove()
        resetCacheStatus()
        billingStatus.value = null
        syncSubscriptions.value = false
        storeContent.value = false
    }
})

test(
    'Header cache status hides when sync subscriptions are disabled',
    async t => {
        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        const user = {
            did: 'did:plc:test123',
            handle: 'alice.bsky.social'
        }

        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        cacheStatus.value = {
            uncachedCount: 0,
            totalCount: 2,
            itemsToCache: []
        }
        syncSubscriptions.value = true
        storeContent.value = true

        try {
            render(html`<${Header} state=${headerState(user)} />`, root)

            t.ok(
                root.querySelector('.cache-status'),
                'renders while sync subscriptions are enabled'
            )

            syncSubscriptions.value = false
            await nextTask()

            t.ok(
                !root.querySelector('.cache-status'),
                'hides after sync subscriptions are disabled'
            )
        } finally {
            render(null, root)
            root.remove()
            resetCacheStatus()
            billingStatus.value = null
            syncSubscriptions.value = false
            storeContent.value = false
        }
    }
)

test(
    'Header cache status hides when article content caching is disabled',
    async t => {
        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        const user = {
            did: 'did:plc:test123',
            handle: 'alice.bsky.social'
        }

        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        cacheStatus.value = {
            uncachedCount: 1,
            totalCount: 2,
            itemsToCache: []
        }
        syncSubscriptions.value = true
        storeContent.value = true

        try {
            render(html`<${Header} state=${headerState(user)} />`, root)

            t.ok(
                root.querySelector('.cache-status'),
                'renders while article content caching is enabled'
            )

            storeContent.value = false
            await nextTask()

            t.ok(
                !root.querySelector('.cache-status'),
                'hides after article content caching is disabled'
            )
        } finally {
            render(null, root)
            root.remove()
            resetCacheStatus()
            billingStatus.value = null
            syncSubscriptions.value = false
            storeContent.value = false
        }
    }
)

test('Header cache status shows neutral state when there are no items', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    const user = {
        did: 'did:plc:test123',
        handle: 'alice.bsky.social'
    }

    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    cacheStatus.value = {
        uncachedCount: 0,
        totalCount: 0,
        itemsToCache: []
    }
    syncSubscriptions.value = true
    storeContent.value = true

    try {
        render(html`<${Header} state=${headerState(user)} />`, root)

        const status = root.querySelector(
            '.cache-status'
        ) as HTMLElement|null
        const dot = root.querySelector('.cache-status svg.dot')

        t.ok(status, 'renders cache status')
        t.equal(
            status?.getAttribute('aria-label'),
            'Cache status: no items yet',
            'uses neutral accessible label'
        )
        t.equal(
            root.querySelector('.cache-status-legend')?.textContent,
            'No items yet',
            'renders neutral legend'
        )
        t.ok(dot?.classList.contains('gray'), 'uses gray dot')
        t.ok(
            !root.querySelector('.cache-status-toggle'),
            'neutral state is not interactive'
        )
    } finally {
        render(null, root)
        root.remove()
        resetCacheStatus()
        billingStatus.value = null
        syncSubscriptions.value = false
        storeContent.value = false
    }
})

test(
    'Header cache status agrees with settings cache state',
    async t => {
        const originalLoadBillingStatus = State.loadBillingStatus
        State.loadBillingStatus = async () => billingStatus.value

        const body = document.querySelector('body') as HTMLElement
        const root = document.createElement('div')
        body.appendChild(root)

        const user = {
            did: 'did:plc:test123',
            handle: 'alice.bsky.social'
        }
        const state = {
            ...headerState(user, { route: '/settings' }),
            isAuthenticated: signal(true),
            feeds: signal([])
        } as unknown as AppState

        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        localFirstSupported.value = true

        const cases = [
            {
                name: 'off',
                sync: false,
                store: false,
                totalBytes: 0,
                snapshot: {
                    totalCount: 0,
                    uncachedCount: 0,
                    itemsToCache: []
                },
                legend: null
            },
            {
                name: 'empty',
                sync: true,
                store: true,
                totalBytes: 0,
                snapshot: {
                    totalCount: 0,
                    uncachedCount: 0,
                    itemsToCache: []
                },
                legend: 'No items yet'
            },
            {
                name: 'partial',
                sync: true,
                store: true,
                totalBytes: 2_000,
                snapshot: {
                    totalCount: 3,
                    uncachedCount: 1,
                    itemsToCache: []
                },
                legend: '1 uncached'
            },
            {
                name: 'full',
                sync: true,
                store: true,
                totalBytes: 2_000,
                snapshot: {
                    totalCount: 3,
                    uncachedCount: 0,
                    itemsToCache: []
                },
                legend: '100% cached'
            }
        ]

        try {
            for (const item of cases) {
                render(null, root)
                persistLocalFirstSettings(item.sync, item.store)
                batch(() => {
                    syncSubscriptions.value = item.sync
                    storeContent.value = item.store
                    totalStorageBytes.value = item.totalBytes
                    cacheStatus.value = item.snapshot
                })

                render(html`
                    <${Header} state=${state} />
                    <${SettingsRoute} state=${state} />
                `, root)
                await nextTask()

                const total = root.querySelector(
                    '.cache-total'
                ) as HTMLElement|null
                const syncBox = root.querySelector(
                    'check-box[name="sync-subscriptions"]'
                ) as (HTMLElement & { checked:boolean })|null
                const storeBox = root.querySelector(
                    'check-box[name="store-content"]'
                ) as (HTMLElement & { checked:boolean })|null

                t.equal(
                    total?.textContent?.trim(),
                    item.totalBytes === 0 ?
                        'Total storage used: 0 B' :
                        'Total storage used: 2.0 KB',
                    `${item.name}: settings shows cache storage`
                )
                t.equal(
                    Boolean(syncBox?.checked),
                    item.sync,
                    `${item.name}: settings sync toggle matches`
                )
                t.equal(
                    Boolean(storeBox?.checked),
                    item.store,
                    `${item.name}: settings content toggle matches`
                )

                const legend = root.querySelector(
                    '.cache-status-legend'
                )?.textContent ?? null
                t.equal(
                    legend,
                    item.legend,
                    `${item.name}: header cache indicator matches`
                )
            }
        } finally {
            State.loadBillingStatus = originalLoadBillingStatus
            render(null, root)
            root.remove()
            localStorage.removeItem('rsss.localFirst')
            resetCacheStatus()
            _resetStorageUsage()
            billingStatus.value = null
            localFirstSupported.value = false
            syncSubscriptions.value = false
            storeContent.value = false
        }
    }
)

test('Header does not render third-party sponsor iframes', t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    try {
        render(html`<${Header} state=${headerState()} />`, root)

        t.equal(
            root.querySelectorAll('iframe').length,
            0,
            'does not render external sponsor iframes'
        )
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
            text: '3 updates',
            title: null
        },
        {
            status: 'syncing',
            color: 'yellow',
            text: 'updating',
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
            text: 'up to date',
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

test('Header feed status exposes only the latest retry error', async t => {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)

    const user = {
        did: 'did:plc:test123',
        handle: 'alice.bsky.social'
    }
    const state = headerState(user, {
        feedSyncStatus: 'error',
        feedSyncError: 'first outage'
    })

    try {
        render(html`<${Header} state=${state} />`, root)

        let status = root.querySelector('.feed-status') as HTMLElement
        t.equal(
            status.getAttribute('title'),
            'first outage',
            'initial error title exposes the first failure'
        )
        t.equal(
            status.getAttribute('aria-label'),
            'Feed sync error: first outage',
            'initial error label exposes the first failure'
        )

        state.feedSyncStatus.value = 'syncing'
        state.feedSyncError.value = null
        await nextTask()

        status = root.querySelector('.feed-status') as HTMLElement
        t.equal(
            status.getAttribute('title'),
            null,
            'retry syncing state removes the old error title'
        )
        t.equal(
            status.getAttribute('aria-label'),
            'Feed sync status: updating',
            'retry syncing state replaces the old error label'
        )

        state.feedSyncStatus.value = 'error'
        state.feedSyncError.value = 'second outage'
        await nextTask()

        status = root.querySelector('.feed-status') as HTMLElement
        t.equal(
            status.getAttribute('title'),
            'second outage',
            'retry failure title exposes only the latest error'
        )
        t.equal(
            status.getAttribute('aria-label'),
            'Feed sync error: second outage',
            'retry failure label exposes only the latest error'
        )
        t.ok(
            !(status.getAttribute('title') ?? '').includes('first'),
            'old error is not stacked into the title'
        )
        t.ok(
            !(status.getAttribute('aria-label') ?? '').includes('first'),
            'old error is not stacked into the label'
        )
    } finally {
        render(null, root)
        root.remove()
    }
})
