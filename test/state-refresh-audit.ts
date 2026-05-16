import { test } from '@substrate-system/tapzero'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { State, type AppState } from '../src/client/state.js'

const ALLOWED_CALLERS = new Set([
    'src/client/components/sidebar-footer.ts',
    'src/client/routes/feed-reader.ts',
    'src/client/routes/updates.ts'
])

const REFRESH_PATTERN = /State\.(refreshFeeds|refreshFeed)\s*\(/g

function collectClientFiles (dir:string):string[] {
    const files:string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            files.push(...collectClientFiles(full))
        } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
            files.push(full)
        }
    }
    return files
}

test('no unauthorized State.refreshFeeds / State.refreshFeed call sites',
    t => {
        const clientDir = 'src/client'
        const files = collectClientFiles(clientDir)

        const violations:string[] = []

        for (const file of files) {
            const rel = file.replace(/.*\/src\//, 'src/')
            if (ALLOWED_CALLERS.has(rel)) continue

            const src = readFileSync(file, 'utf8')
            const matches = src.match(REFRESH_PATTERN)
            if (matches) {
                violations.push(`${rel}: ${matches.join(', ')}`)
            }
        }

        t.equal(
            violations.length,
            0,
            'only sidebar-footer and updates.ts may call refreshFeeds/Feed' +
            (violations.length ? `\n  ${violations.join('\n  ')}` : '')
        )
    }
)

test(
    'reconcileAfterRefresh does not call loadFeeds',
    async t => {
        const calls:string[] = []
        const fakeState = {
            route: { value: '/' }
        } as unknown as AppState

        const original = {
            loadFeeds: State.loadFeeds,
            loadFeedStatus: State.loadFeedStatus,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts,
            loadItemByRoute: State.loadItemByRoute
        }
        State.loadFeeds = (async () => {
            calls.push('loadFeeds')
        }) as typeof State.loadFeeds
        State.loadFeedStatus = (async () => {
            calls.push('loadFeedStatus')
        }) as typeof State.loadFeedStatus
        State.loadItems = (async () => {
            calls.push('loadItems')
        }) as typeof State.loadItems
        State.loadCounts = (async () => {
            calls.push('loadCounts')
        }) as typeof State.loadCounts
        State.loadItemByRoute = (async () => null) as
            typeof State.loadItemByRoute

        try {
            await State.reconcileAfterRefresh(fakeState)
            t.equal(
                calls.includes('loadFeeds'),
                false,
                'reconcile does NOT reload the feeds list'
            )
            t.equal(
                calls.includes('loadFeedStatus'),
                true,
                'reconcile DOES reload the indicator'
            )
            t.equal(
                calls.includes('loadItems'),
                true,
                'reconcile DOES reload items'
            )
            t.equal(
                calls.includes('loadCounts'),
                true,
                'reconcile DOES reload per-feed counts'
            )
        } finally {
            Object.assign(State, original)
        }
    }
)

test(
    'loadInitialView calls loadFeeds',
    async t => {
        const calls:string[] = []
        const fakeState = {
            initialLoadComplete: { value: false },
            route: { value: '/' }
        } as unknown as AppState

        const original = {
            loadFeeds: State.loadFeeds,
            loadFeedStatus: State.loadFeedStatus,
            loadItems: State.loadItems,
            loadCounts: State.loadCounts
        }
        State.loadFeeds = (async () => {
            calls.push('loadFeeds')
        }) as typeof State.loadFeeds
        State.loadFeedStatus = (async () => {
            calls.push('loadFeedStatus')
        }) as typeof State.loadFeedStatus
        State.loadItems = (async () => {
            calls.push('loadItems')
        }) as typeof State.loadItems
        State.loadCounts = (async () => {
            calls.push('loadCounts')
        }) as typeof State.loadCounts

        try {
            await State.loadInitialView(fakeState)
            t.equal(
                calls.includes('loadFeeds'),
                true,
                'initial load fetches the feeds list'
            )
        } finally {
            Object.assign(State, original)
        }
    }
)
