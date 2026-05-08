import { signal, computed } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { FeedStatus, legendFor } from '../src/client/components/feed-status.js'
import { type AppState } from '../src/client/state.js'

type FeedSyncStatus = 'inactive'|'updates'|'syncing'|'error'|'synced'

function feedStatusState (options:{
    feedSyncStatus?:FeedSyncStatus
    feedUpdateCounts?:Record<string, number>
    feedSyncError?:string|null
    refreshInProgress?:boolean
} = {}):AppState {
    const feedSyncStatus = signal<FeedSyncStatus>(
        options.feedSyncStatus ?? 'inactive'
    )
    const refreshInProgress = signal<boolean>(
        options.refreshInProgress ?? false
    )
    const displayedFeedSyncStatus = computed<FeedSyncStatus>(() => (
        refreshInProgress.value ?
            'syncing' :
            feedSyncStatus.value
    ))
    return {
        user: signal({ did: 'did:plc:test', handle: 'test.bsky.social' }),
        feedSyncStatus,
        refreshInProgress,
        displayedFeedSyncStatus,
        feedUpdateCounts: signal<Record<string, number>>(
            options.feedUpdateCounts ?? {}
        ),
        feedSyncError: signal<string|null>(
            options.feedSyncError ?? null
        )
    } as unknown as AppState
}

function renderFeedStatus (state:AppState):{
    root:HTMLElement
    cleanup:() => void
} {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(html`<${FeedStatus} state=${state} />`, root)
    return {
        root,
        cleanup () {
            render(null, root)
            root.remove()
        }
    }
}

test('legendFor: synced returns "up to date" for both surfaces', t => {
    const result = legendFor('synced', 0)
    t.equal(result.label, 'up to date', 'visible label for synced')
    t.equal(
        result.ariaLabel,
        'Feed sync status: up to date',
        'aria-label for synced'
    )
})

test('legendFor: updates with count === 1 uses singular', t => {
    const result = legendFor('updates', 1)
    t.equal(result.label, '1 update', 'singular visible label')
    t.equal(
        result.ariaLabel,
        'Feed sync status: 1 update',
        'singular aria-label'
    )
})

test('legendFor: updates with count > 1 uses plural', t => {
    const result = legendFor('updates', 3)
    t.equal(result.label, '3 updates', 'plural visible label')
    t.equal(
        result.ariaLabel,
        'Feed sync status: 3 updates',
        'plural aria-label'
    )
})

test('legendFor: syncing returns "updating"', t => {
    const result = legendFor('syncing', 0)
    t.equal(result.label, 'updating', 'visible label for syncing')
    t.equal(
        result.ariaLabel,
        'Feed sync status: updating',
        'aria-label for syncing'
    )
})

test('legendFor: inactive preserves existing presentation', t => {
    const result = legendFor('inactive', 0)
    t.equal(result.label, '', 'no new visible label for inactive')
    t.equal(
        result.ariaLabel,
        'Feed sync status: inactive',
        'aria-label preserves existing inactive wording'
    )
})

test('legendFor: error preserves existing "sync failed" text', t => {
    const result = legendFor('error', 0)
    t.equal(
        result.label,
        'sync failed',
        'preserves existing error visible text'
    )
})

test(
    'FeedStatus renders red sync-failed pill when feedSyncStatus = error',
    t => {
        const { root, cleanup } = renderFeedStatus(feedStatusState({
            feedSyncStatus: 'error',
            feedSyncError: 'fetch failed'
        }))

        try {
            const dot = root.querySelector('svg.dot')
            t.ok(dot, 'renders the dot indicator')
            t.ok(
                dot?.classList.contains('red'),
                'dot is red on error (page-load failure path FR-012)'
            )

            const wrapper = root.querySelector('.feed-status')
            t.ok(wrapper, 'renders the feed-status wrapper')
            t.equal(
                wrapper?.textContent?.includes('sync failed'),
                true,
                'shows the "sync failed" label so the pill is never silently green'
            )
            t.equal(
                wrapper?.getAttribute('title'),
                'fetch failed',
                'tooltip carries the error message'
            )
        } finally {
            cleanup()
        }
    }
)

test(
    'FeedStatus renders green "up to date" pill when synced and zero pending',
    t => {
        const { root, cleanup } = renderFeedStatus(feedStatusState({
            feedSyncStatus: 'synced',
            feedUpdateCounts: {}
        }))

        try {
            const dot = root.querySelector('svg.dot')
            t.ok(
                dot?.classList.contains('green'),
                'dot is green when synced'
            )
            t.equal(
                root.textContent?.trim(),
                'up to date',
                'pill reads "up to date" after refresh sequence (US3)'
            )
        } finally {
            cleanup()
        }
    }
)

test(
    'FeedStatus renders blue "n updates" pill when totalPending > 0',
    t => {
        const { root, cleanup } = renderFeedStatus(feedStatusState({
            feedSyncStatus: 'updates',
            feedUpdateCounts: { 1: 2, 2: 3 }
        }))

        try {
            const dot = root.querySelector('svg.dot')
            t.ok(
                dot?.classList.contains('blue'),
                'dot is blue when updates are pending'
            )
            t.ok(
                root.textContent?.includes('5 updates'),
                'pill reads "5 updates" using the summed counts'
            )
        } finally {
            cleanup()
        }
    }
)

test(
    'FeedStatus renders yellow "updating" pill when refreshInProgress=true ' +
    'regardless of underlying feedSyncStatus (FR-002 / FR-003)',
    t => {
        // Underlying status is 'updates' with a non-zero count; the
        // displayed pill must still be yellow + 'updating' because
        // refreshInProgress is true.
        const { root, cleanup } = renderFeedStatus(feedStatusState({
            feedSyncStatus: 'updates',
            feedUpdateCounts: { 1: 4 },
            refreshInProgress: true
        }))

        try {
            const dot = root.querySelector('svg.dot')
            t.ok(
                dot?.classList.contains('yellow'),
                'dot is yellow during manual refresh'
            )
            const wrapper = root.querySelector('.feed-status')
            t.equal(
                wrapper?.getAttribute('aria-label'),
                'Feed sync status: updating',
                'aria-label reads "updating" during manual refresh'
            )
            t.ok(
                root.textContent?.includes('updating'),
                'pill text reads "updating" during manual refresh'
            )
            t.equal(
                root.textContent?.includes('4 updates'),
                false,
                'pill does NOT show the underlying "n updates" text ' +
                'while refreshInProgress is true'
            )
        } finally {
            cleanup()
        }
    }
)

test(
    'FeedStatus renders yellow "updating" pill when refreshInProgress=true ' +
    'over a synced underlying status',
    t => {
        const { root, cleanup } = renderFeedStatus(feedStatusState({
            feedSyncStatus: 'synced',
            refreshInProgress: true
        }))

        try {
            const dot = root.querySelector('svg.dot')
            t.ok(
                dot?.classList.contains('yellow'),
                'dot is yellow during manual refresh over synced'
            )
            t.ok(
                root.textContent?.includes('updating'),
                'pill text reads "updating" during manual refresh ' +
                'over synced'
            )
            t.equal(
                root.textContent?.includes('up to date'),
                false,
                'pill does NOT show "up to date" while ' +
                'refreshInProgress is true'
            )
        } finally {
            cleanup()
        }
    }
)
