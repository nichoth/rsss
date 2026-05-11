import { signal } from '@preact/signals'
import { html } from 'htm/preact/index.js'
import { render } from 'preact'
import { test } from '@substrate-system/tapzero'
import { Sidebar } from '../src/client/components/sidebar.js'
import { type AppState, type Feed } from '../src/client/state.js'

interface StubOpts {
    feeds?:Feed[]
    unread?:number
    starred?:number
    total?:number
    perFeed?:Record<string, number>
    pendingCounts?:Record<string, number>
    showUnreadOnly?:boolean
    showStarredOnly?:boolean
    route?:string
}

function makeFeed (id:number, title:string, url:string):Feed {
    return {
        id,
        url,
        title,
        description: null,
        site_url: null,
        last_fetched: null,
        last_error: null,
        last_status: null,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z'
    }
}

function stubState (opts:StubOpts = {}):AppState {
    return {
        feeds: signal<Feed[]>(opts.feeds ?? []),
        feedsLoading: signal(false),
        feedsError: signal<string|null>(null),
        route: signal(opts.route ?? '/'),
        counts: signal({
            unread: opts.unread ?? 0,
            starred: opts.starred ?? 0,
            total: opts.total ?? 0,
            perFeed: opts.perFeed ?? {}
        }),
        showUnreadOnly: signal(opts.showUnreadOnly ?? false),
        showStarredOnly: signal(opts.showStarredOnly ?? false),
        feedSyncStatus: signal('inactive'),
        feedUpdateCounts: signal(opts.pendingCounts ?? {}),
        feedSyncError: signal(null),
        user: signal(null),
        _setRoute: () => {}
    } as unknown as AppState
}

function mount (state:AppState):HTMLDivElement {
    const body = document.querySelector('body') as HTMLElement
    const root = document.createElement('div')
    body.appendChild(root)
    render(html`<${Sidebar} state=${state} />`, root)
    return root
}

function feedRows (root:HTMLElement):HTMLElement[] {
    return Array.from(
        root.querySelectorAll('.feeds-list .feed-item')
    ) as HTMLElement[]
}

function rowBadgeText (row:HTMLElement):string {
    const badge = row.querySelector('.feed-unread-count') as HTMLElement
    return badge?.textContent?.trim() ?? ''
}

function rowAnchorText (row:HTMLElement):string {
    const anchor = row.querySelector('a.feed-select') as HTMLElement
    return anchor?.textContent?.trim() ?? ''
}

test(
    'every feed-item has a feed-unread-count before the feed name',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            unread: 7,
            perFeed: { 1: 5, 2: 2 }
        })
        const root = mount(state)
        try {
            const rows = feedRows(root)
            t.equal(
                rows.length,
                3,
                '3 feed-item rows: All Feeds + 2 feeds'
            )
            for (const row of rows) {
                const badge = row.querySelector(
                    '.feed-unread-count'
                ) as HTMLElement|null
                t.ok(badge, 'row has a .feed-unread-count element')
                const link = row.querySelector(
                    '.feed-select'
                ) as HTMLElement|null
                t.ok(link, 'row has a .feed-select link')
                if (badge && link) {
                    t.ok(
                        badge.compareDocumentPosition(link) &
                            Node.DOCUMENT_POSITION_FOLLOWING,
                        'badge appears before feed-select in DOM order'
                    )
                }
            }
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'per-feed badge text equals counts.perFeed[String(feed.id)]',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            unread: 8,
            perFeed: { 1: 5, 2: 3 }
        })
        const root = mount(state)
        try {
            const rows = feedRows(root)
            // rows[0] is the All Feeds row
            t.equal(
                rowBadgeText(rows[0]),
                '8',
                'All Feeds row badge equals counts.unread'
            )
            t.equal(
                rowBadgeText(rows[1]),
                '5',
                'feed 1 row badge equals perFeed[1]'
            )
            t.equal(
                rowBadgeText(rows[2]),
                '3',
                'feed 2 row badge equals perFeed[2]'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'feed missing from perFeed renders the literal text 0',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            unread: 5,
            // f2 deliberately missing — producer omits zeros
            perFeed: { 1: 5 }
        })
        const root = mount(state)
        try {
            const rows = feedRows(root)
            t.equal(
                rowBadgeText(rows[2]),
                '0',
                'feed missing from perFeed renders 0, not blank'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'toggling showUnreadOnly does not change badge text',
    async t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const state = stubState({
            feeds: [f1],
            unread: 4,
            perFeed: { 1: 4 },
            showUnreadOnly: false
        })
        const root = mount(state)
        try {
            const before = feedRows(root).map(rowBadgeText)
            t.deepEqual(
                before,
                ['4', '4'],
                'initial: All Feeds=4, feed1=4'
            )

            state.showUnreadOnly.value = true
            await new Promise(resolve => setTimeout(resolve, 0))

            const after = feedRows(root).map(rowBadgeText)
            t.deepEqual(
                after,
                before,
                'badge text unchanged after showUnreadOnly toggle'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'feed with N>0 pending shows `(N) ` prefix before name',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            pendingCounts: { 1: 3 }
        })
        const root = mount(state)
        try {
            const rows = feedRows(root)
            // rows[0] = All Feeds, rows[1] = feed1, rows[2] = feed2
            const text1 = rowAnchorText(rows[1])
            t.ok(
                text1.startsWith('(3) '),
                'feed 1 anchor text starts with "(3) "'
            )
            t.ok(
                text1.endsWith('Feed One'),
                'feed 1 anchor text ends with the feed title'
            )
            t.equal(
                rowAnchorText(rows[2]).indexOf('('),
                -1,
                'feed 2 has no parenthesized prefix'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'feed with zero/undefined pending shows no prefix',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            // f1 explicit zero, f2 absent — both must hide the prefix
            pendingCounts: { 1: 0 }
        })
        const root = mount(state)
        try {
            const rows = feedRows(root)
            t.equal(
                rowAnchorText(rows[1]).indexOf('('),
                -1,
                'feed 1 (zero) anchor has no "(" — no (0) placeholder'
            )
            t.equal(
                rowAnchorText(rows[2]).indexOf('('),
                -1,
                'feed 2 (absent key) anchor has no "(" — no empty ()'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'clearing feedUpdateCounts removes the prefix in the same paint',
    async t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const state = stubState({
            feeds: [f1],
            pendingCounts: { 1: 4 }
        })
        const root = mount(state)
        try {
            t.ok(
                rowAnchorText(feedRows(root)[1]).startsWith('(4) '),
                'initial: feed 1 anchor starts with "(4) "'
            )

            state.feedUpdateCounts.value = {}
            await new Promise(resolve => setTimeout(resolve, 0))

            t.equal(
                rowAnchorText(feedRows(root)[1]).indexOf('('),
                -1,
                'after clear: anchor no longer contains "("'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'signal change re-renders the prefix without reload',
    async t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const state = stubState({
            feeds: [f1],
            pendingCounts: {}
        })
        const root = mount(state)
        try {
            t.equal(
                rowAnchorText(feedRows(root)[1]).indexOf('('),
                -1,
                'initial: no prefix'
            )

            state.feedUpdateCounts.value = { 1: 7 }
            await new Promise(resolve => setTimeout(resolve, 0))

            t.ok(
                rowAnchorText(feedRows(root)[1]).startsWith('(7) '),
                'after signal write: anchor starts with "(7) "'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'multi-digit count renders fully (e.g. 153)',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const state = stubState({
            feeds: [f1],
            pendingCounts: { 1: 153 }
        })
        const root = mount(state)
        try {
            t.ok(
                rowAnchorText(feedRows(root)[1]).startsWith('(153) '),
                'multi-digit count "(153) " renders fully'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'deleting one feed does not change another\'s prefix',
    async t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            pendingCounts: { 1: 2, 2: 5 }
        })
        const root = mount(state)
        try {
            const before = feedRows(root)
            t.ok(
                rowAnchorText(before[1]).startsWith('(2) '),
                'feed 1 starts with "(2) "'
            )
            t.ok(
                rowAnchorText(before[2]).startsWith('(5) '),
                'feed 2 starts with "(5) "'
            )

            state.feeds.value = [f2]
            await new Promise(resolve => setTimeout(resolve, 0))

            const after = feedRows(root)
            t.equal(
                after.length,
                2,
                'after delete: All Feeds row + feed 2 row only'
            )
            t.ok(
                rowAnchorText(after[1]).startsWith('(5) '),
                'feed 2 prefix unchanged after feed 1 deleted'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'feed with no title gets the prefix before its URL',
    t => {
        const f1 = makeFeed(
            1,
            '' as unknown as string,
            'https://a.example.com/feed'
        )
        const state = stubState({
            feeds: [f1],
            pendingCounts: { 1: 9 }
        })
        const root = mount(state)
        try {
            t.equal(
                rowAnchorText(feedRows(root)[1]),
                '(9) https://a.example.com/feed',
                'anchor reads "(9) <url>" with single ASCII space'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)

test(
    'the All Feeds pseudo-row never receives a prefix',
    t => {
        const f1 = makeFeed(1, 'Feed One', 'https://a.example.com/feed')
        const f2 = makeFeed(2, 'Feed Two', 'https://b.example.com/feed')
        const state = stubState({
            feeds: [f1, f2],
            pendingCounts: { 1: 4, 2: 6 }
        })
        const root = mount(state)
        try {
            // The All Feeds row is the first .feed-item in .feeds-list.
            const allFeedsRow = feedRows(root)[0]
            const text = allFeedsRow.textContent ?? ''
            t.equal(
                text.indexOf('('),
                -1,
                'All Feeds row text contains no "("'
            )
        } finally {
            render(null, root)
            root.remove()
        }
    }
)
