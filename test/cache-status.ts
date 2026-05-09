import { test } from '@substrate-system/tapzero'
import { batch, computed, signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { type AppState } from '../src/client/state.js'
import { Header } from '../src/client/components/header.js'
import { billingStatus } from '../src/client/billing-status.js'
import { computeCacheStatus } from '../src/client/db/cache-status.js'
import {
    feedPolicies,
    _resetFeedPolicies
} from '../src/client/db/feed-cache-policy.js'
import {
    storeContent,
    syncSubscriptions,
    defaultCacheMode
} from '../src/client/local-first-settings.js'
import { recordCachedImage } from '../src/client/db/cached-images.js'
import {
    cacheStatus,
    resetCacheStatus,
    type CacheStatusSnapshot
} from '../src/client/cache-status-state.js'

setTestMode(true, wasmUrl as string)

const USER = {
    did: 'did:plc:test123',
    handle: 'alice.bsky.social'
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function headerState (
    route:string = '/'
):AppState {
    return {
        route: signal(route),
        user: signal(USER),
        feedSyncStatus: signal('inactive'),
        displayedFeedSyncStatus: computed(() => 'inactive'),
        feedUpdateCounts: signal({}),
        feedSyncError: signal(null),
        feedUpdateStatus: computed(() => 'synced')
    } as unknown as AppState
}

function resetHeaderCacheState ():void {
    resetCacheStatus()
    billingStatus.value = null
    syncSubscriptions.value = false
    storeContent.value = false
}

function setVisibleCacheState (snapshot:CacheStatusSnapshot):void {
    batch(() => {
        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
        syncSubscriptions.value = true
        storeContent.value = true
        cacheStatus.value = snapshot
    })
}

function seedFeed (db:Awaited<ReturnType<typeof openLocalDb>>):void {
    db.exec(`
        INSERT INTO feeds (id, url, title, created_at, updated_at)
        VALUES
            (1, 'https://a.example/feed', 'Feed A',
             '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
            (2, 'https://b.example/feed', 'Feed B',
             '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
    `)
}

function insertItem (
    db:Awaited<ReturnType<typeof openLocalDb>>,
    row:{
        id:number
        feedId:number
        guid?:string
        content?:string|null
        description?:string|null
    }
):void {
    db.exec({
        sql: `INSERT INTO items
            (id, feed_id, guid, title, content, description,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?,
                '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
        bind: [
            row.id,
            row.feedId,
            row.guid ?? `guid-${row.id}`,
            `Item ${row.id}`,
            row.content ?? null,
            row.description ?? null
        ]
    })
}

test(
    'cache status header hides when sync subscriptions are disabled',
    async t => {
        const root = document.createElement('div')
        document.body.appendChild(root)

        setVisibleCacheState({
            totalCount: 2,
            uncachedCount: 0,
            itemsToCache: []
        })

        try {
            render(html`<${Header} state=${headerState()} />`, root)
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
            resetHeaderCacheState()
        }
    }
)

test(
    'cache status header hides when article caching is disabled',
    async t => {
        const root = document.createElement('div')
        document.body.appendChild(root)

        setVisibleCacheState({
            totalCount: 2,
            uncachedCount: 1,
            itemsToCache: []
        })

        try {
            render(html`<${Header} state=${headerState()} />`, root)
            t.ok(
                root.querySelector('.cache-status'),
                'renders while article caching is enabled'
            )

            storeContent.value = false
            await nextTask()

            t.ok(
                !root.querySelector('.cache-status'),
                'hides after article caching is disabled'
            )
        } finally {
            render(null, root)
            root.remove()
            resetHeaderCacheState()
        }
    }
)

test(
    'cache status header shows neutral empty state for zero items',
    t => {
        const root = document.createElement('div')
        document.body.appendChild(root)

        setVisibleCacheState({
            totalCount: 0,
            uncachedCount: 0,
            itemsToCache: []
        })

        try {
            render(html`<${Header} state=${headerState()} />`, root)

            const status = root.querySelector(
                '.cache-status'
            ) as HTMLElement|null
            const dot = root.querySelector('.cache-status svg.dot')

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
            resetHeaderCacheState()
        }
    }
)

test(
    'cache status header renders on settings and about routes',
    t => {
        const root = document.createElement('div')
        document.body.appendChild(root)

        setVisibleCacheState({
            totalCount: 2,
            uncachedCount: 0,
            itemsToCache: []
        })

        try {
            for (const route of ['/settings', '/about']) {
                render(null, root)
                render(
                    html`<${Header} state=${headerState(route)} />`,
                    root
                )

                t.ok(
                    root.querySelector('.cache-status'),
                    `renders cache status on ${route}`
                )
            }
        } finally {
            render(null, root)
            root.remove()
            resetHeaderCacheState()
        }
    }
)

test(
    'cache status header preserves uncached and fully cached states',
    t => {
        const root = document.createElement('div')
        document.body.appendChild(root)

        const cases:Array<{
            name:string
            snapshot:CacheStatusSnapshot
            legend:string
            interactive:boolean
        }> = [
            {
                name: 'uncached',
                snapshot: {
                    totalCount: 3,
                    uncachedCount: 2,
                    itemsToCache: []
                },
                legend: '2 uncached',
                interactive: true
            },
            {
                name: 'fully cached',
                snapshot: {
                    totalCount: 3,
                    uncachedCount: 0,
                    itemsToCache: []
                },
                legend: '100% cached',
                interactive: false
            }
        ]

        try {
            for (const item of cases) {
                render(null, root)
                resetHeaderCacheState()
                setVisibleCacheState(item.snapshot)

                render(html`<${Header} state=${headerState()} />`, root)

                t.equal(
                    root.querySelector('.cache-status-legend')?.textContent,
                    item.legend,
                    `${item.name}: renders expected legend`
                )
                t.equal(
                    Boolean(root.querySelector('.cache-status-toggle')),
                    item.interactive,
                    `${item.name}: interaction state is preserved`
                )
            }
        } finally {
            render(null, root)
            root.remove()
            resetHeaderCacheState()
        }
    }
)

test('computeCacheStatus: empty DB returns zero counts', async (t) => {
    _resetFeedPolicies()
    storeContent.value = true
    defaultCacheMode.value = 'text'

    const db = await openLocalDb('did:test:cs-empty')
    try {
        const snap = await computeCacheStatus(db, { feedId: null })
        t.equal(snap.totalCount, 0, 'totalCount is 0')
        t.equal(snap.uncachedCount, 0, 'uncachedCount is 0')
        t.equal(snap.itemsToCache.length, 0, 'no items to cache')
    } finally {
        db.close()
    }
})

test(
    [
        'computeCacheStatus: text mode + storeContent=true:',
        'items with body are cached'
    ].join(' '),
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = true
        defaultCacheMode.value = 'text'

        const db = await openLocalDb('did:test:cs-text-cached')
        try {
            seedFeed(db)
            insertItem(db, {
                id: 10,
                feedId: 1,
                content: '<p>full body</p>'
            })
            insertItem(db, {
                id: 11,
                feedId: 1,
                description: 'just a summary'
            })

            const snap = await computeCacheStatus(db, { feedId: 1 })
            t.equal(snap.totalCount, 2, 'totalCount counts both items')
            t.equal(snap.uncachedCount, 0, 'all items considered cached')
        } finally {
            db.close()
        }
    }
)

test(
    [
        'computeCacheStatus: text mode + storeContent=true:',
        'items with no body are uncached'
    ].join(' '),
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = true
        defaultCacheMode.value = 'text'

        const db = await openLocalDb('did:test:cs-text-missing')
        try {
            seedFeed(db)
            insertItem(db, {
                id: 20,
                feedId: 1,
                content: null,
                description: null
            })
            insertItem(db, {
                id: 21,
                feedId: 1,
                content: '<p>has body</p>'
            })

            const snap = await computeCacheStatus(db, { feedId: 1 })
            t.equal(snap.totalCount, 2, 'totalCount counts both items')
            t.equal(snap.uncachedCount, 1, 'one item is uncached')
            t.equal(snap.itemsToCache[0].id, 20, 'uncached item id')
            t.equal(
                snap.itemsToCache[0].missingBody,
                true,
                'missingBody flag set'
            )
        } finally {
            db.close()
        }
    }
)

test(
    [
        'computeCacheStatus: storeContent=false:',
        'missing body does NOT count as uncached'
    ].join(' '),
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = false
        defaultCacheMode.value = 'text'

        const db = await openLocalDb('did:test:cs-no-store')
        try {
            seedFeed(db)
            insertItem(db, {
                id: 30,
                feedId: 1,
                content: null,
                description: null
            })

            const snap = await computeCacheStatus(db, { feedId: 1 })
            t.equal(snap.totalCount, 1, 'totalCount is 1')
            t.equal(
                snap.uncachedCount,
                0,
                'storeContent=false means body absence is fine'
            )
        } finally {
            db.close()
        }
    }
)

test(
    [
        'computeCacheStatus: text_images mode:',
        'items with uncached images are uncached'
    ].join(' '),
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = true
        defaultCacheMode.value = 'text_images'

        const db = await openLocalDb('did:test:cs-images')
        try {
            seedFeed(db)
            insertItem(db, {
                id: 40,
                feedId: 1,
                content: '<p>hi <img src="https://cdn.example/a.jpg" /></p>'
            })
            insertItem(db, {
                id: 41,
                feedId: 1,
                content: '<p>hi <img src="https://cdn.example/b.jpg" /></p>'
            })

            await recordCachedImage(db, {
                url: 'https://cdn.example/a.jpg',
                feedId: 1,
                itemId: 40,
                sizeBytes: 100
            })

            const snap = await computeCacheStatus(db, { feedId: 1 })
            t.equal(snap.totalCount, 2, 'totalCount is 2')
            t.equal(
                snap.uncachedCount,
                1,
                'item 41 uncached because b.jpg not cached'
            )
            t.equal(snap.itemsToCache[0].id, 41, 'uncached item id is 41')
            t.deepEqual(
                snap.itemsToCache[0].missingImageUrls,
                ['https://cdn.example/b.jpg'],
                'missing URL recorded'
            )
        } finally {
            db.close()
        }
    }
)

test(
    'computeCacheStatus: per-feed policy overrides default mode',
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = true
        defaultCacheMode.value = 'text_images'

        const db = await openLocalDb('did:test:cs-policy-override')
        try {
            seedFeed(db)
            insertItem(db, {
                id: 50,
                feedId: 1,
                content: '<img src="https://cdn.example/x.jpg" />'
            })

            // Override feed 1 to text-only: image absence should NOT
            // count as uncached.
            feedPolicies.value = {
                1: {
                    feed_id: 1,
                    cache_mode: 'text',
                    max_size_bytes: null,
                    max_age_seconds: null
                }
            }

            const snap = await computeCacheStatus(db, { feedId: 1 })
            t.equal(snap.totalCount, 1, 'totalCount is 1')
            t.equal(
                snap.uncachedCount,
                0,
                'text mode ignores image cache state'
            )
        } finally {
            db.close()
        }
    }
)

test(
    'computeCacheStatus: scope feedId=null counts items across all feeds',
    async (t) => {
        _resetFeedPolicies()
        storeContent.value = true
        defaultCacheMode.value = 'text'

        const db = await openLocalDb('did:test:cs-all-feeds')
        try {
            seedFeed(db)
            insertItem(db, { id: 60, feedId: 1, content: '<p>x</p>' })
            insertItem(db, { id: 61, feedId: 2, content: null })

            const snap = await computeCacheStatus(db, { feedId: null })
            t.equal(snap.totalCount, 2, 'counts items across feeds')
            t.equal(snap.uncachedCount, 1, 'one uncached')
        } finally {
            db.close()
        }
    }
)
