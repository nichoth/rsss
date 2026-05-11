import { test } from '@substrate-system/tapzero'
import { html } from 'htm/preact'
import { render } from 'preact'
import { signal, computed } from '@preact/signals'
import sqlite3Module from '@sqlite.org/sqlite-wasm'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import { SCHEMA_SQL, DEAD_LETTER_OUTBOX_SQL } from '../src/shared/schema.js'
import { OUTBOX_SQL, SYNC_META_SQL } from '../src/client/db/local-schema.js'
import {
    bootstrapLocalDb,
    clearBootstrappedDb,
    disableLocalFirst,
    getAdapter,
    _resetAdapterCache,
    _resetSupportedCache,
    remoteAdapter
} from '../src/client/db/index.js'
import {
    getOpfsFilename,
    setSQLiteWorkerClientFactoryForTests,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    resetTabCoordinationForTests
} from '../src/client/db/tab-coordination.js'
import {
    saveLocalFirstSettings,
    setSyncSubscriptions,
    syncSubscriptions
} from '../src/client/local-first-settings.js'
import { billingStatus } from '../src/client/billing-status.js'
import { State, type AppState } from '../src/client/state.js'
import { FeedReader } from '../src/client/routes/feed-reader.js'
import type {
    SQLiteWorkerClient
} from '../src/client/db/sqlite-worker-client.js'
import type {
    SqliteWorkerBindValue,
    SqliteWorkerOpenOptions
} from '../src/client/db/sqlite-worker-protocol.js'

type SqliteModule = (
    opts:{ locateFile:() => string }
) => Promise<{
    oo1:{ DB:new (filename:string) => PersistentDb }
}>

type PersistentDbExecArg =
    string |
    {
        sql:string
        bind?:SqliteWorkerBindValue[]
        rowMode?:'object'
        resultRows?:Record<string, unknown>[]
    }

interface PersistentDb {
    exec:(arg:PersistentDbExecArg) => void
    close:() => void
}

const did = 'did:test:opfs-persistence'
const feedTitle = 'Persistent Feed'
const itemTitle = 'Persistent Item'

const syncPayload = {
    feeds: [{
        id: 1,
        url: 'https://example.com/persist.xml',
        title: feedTitle,
        description: null,
        site_url: null,
        last_fetched: null,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00'
    }],
    items: [{
        id: 1,
        feed_id: 1,
        guid: 'persist-item',
        title: itemTitle,
        link: 'https://example.com/articles/persistent-item',
        description: 'Readable after reload',
        content: '<p>Readable after reload</p>',
        author: null,
        pub_date: '2026-01-01 00:00:00',
        is_read: 0,
        is_starred: 0,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00'
    }],
    syncedAt: '2026-01-01 00:00:00',
    latestUpdatedAt: '2026-01-01 00:00:00',
    isFullSync: true
}

let sqlitePromise:ReturnType<SqliteModule>|null = null

function getSqlite ():ReturnType<SqliteModule> {
    if (!sqlitePromise) {
        const init = sqlite3Module as unknown as SqliteModule
        sqlitePromise = init({ locateFile: () => wasmUrl as string })
    }
    return sqlitePromise
}

async function createPersistentDb ():Promise<PersistentDb> {
    const sqlite = await getSqlite()
    const db = new sqlite.oo1.DB(':memory:')
    applySchema(db)
    return db
}

function applySchema (db:PersistentDb):void {
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(SCHEMA_SQL)
    db.exec(OUTBOX_SQL)
    db.exec(DEAD_LETTER_OUTBOX_SQL)
    db.exec(SYNC_META_SQL)
}

class PersistentSQLiteClient {
    db:PersistentDb|null = null
    filename:string|null = null
    private files:Map<string, PersistentDb>
    private counters:{ opens:number; probes:number }

    constructor (
        files:Map<string, PersistentDb>,
        counters:{ opens:number; probes:number }
    ) {
        this.files = files
        this.counters = counters
    }

    async probe ():Promise<void> {
        this.counters.probes++
    }

    async open (opts:SqliteWorkerOpenOptions):Promise<void> {
        this.counters.opens++
        const filename = opts.filename || (
            opts.did ? getOpfsFilename(opts.did) : ''
        )
        if (!filename) {
            throw new Error('test worker requires a filename')
        }

        let db = this.files.get(filename)
        if (!db) {
            db = await createPersistentDb()
            this.files.set(filename, db)
        } else {
            applySchema(db)
        }

        this.filename = filename
        this.db = db
    }

    async exec (
        sql:string,
        bind?:SqliteWorkerBindValue[]
    ):Promise<void> {
        const db = this.getDb()
        if (!bind || bind.length === 0) {
            db.exec(sql)
            return
        }
        db.exec({ sql, bind })
    }

    async query<T extends Record<string, unknown>> (
        sql:string,
        bind?:SqliteWorkerBindValue[]
    ):Promise<T[]> {
        const rows:Record<string, unknown>[] = []
        this.getDb().exec({
            sql,
            bind: bind && bind.length > 0 ? bind : undefined,
            rowMode: 'object',
            resultRows: rows
        })
        return rows as T[]
    }

    async close ():Promise<void> {
        this.db = null
        this.filename = null
    }

    dispose ():void {
        this.db = null
        this.filename = null
    }

    private getDb ():PersistentDb {
        if (!this.db) throw new Error('persistent test DB is not open')
        return this.db
    }
}

interface FetchCounter {
    fetchFn:typeof fetch
    fullSyncs:() => number
}

function makeFetchCounter ():FetchCounter {
    let fullSyncs = 0

    const fetchFn = async (
        input:RequestInfo|URL
    ):Promise<Response> => {
        const url = String(input)
        if (url === '/api/sync') {
            fullSyncs++
        }

        return {
            ok: true,
            status: 200,
            json: async () => syncPayload
        } as Response
    }

    return { fetchFn, fullSyncs: () => fullSyncs }
}

function makeState ():AppState {
    const user = signal({ did, handle: 'example.test' })

    return {
        _setRoute: () => {},
        route: signal('/'),
        routeItem: signal(null),
        routeItemLoading: signal(false),
        user,
        authLoading: signal(false),
        authError: signal(null),
        feeds: signal([]),
        feedsLoading: signal(false),
        feedsError: signal<string|null>(null),
        feedSyncStatus: signal<
            'inactive'|'updates'|'syncing'|'error'|'synced'
        >('inactive'),
        feedSyncError: signal<string|null>(null),
        feedUpdateCounts: signal<Record<string, number>>({}),
        feedUpdateStatus: signal<'synced'|'updates'>('synced'),
        feedsWithUpdates: signal<string[]>([]),
        items: signal([]),
        itemsLoading: signal(false),
        itemsTotal: signal(0),
        itemsOffset: signal(0),
        counts: signal({ unread: 0, starred: 0, total: 0, perFeed: {} }),
        showUnreadOnly: signal(false),
        showStarredOnly: signal(false),
        pageSize: signal(20),
        selectedFeedId: signal(null),
        isAuthenticated: computed(() => user.value !== null),
        initialLoadComplete: signal(false),
        cleanup: () => {}
    } as unknown as AppState
}

async function loadLocalRows (state:AppState):Promise<void> {
    await State.loadFeeds(state)
    await State.loadItems(state)
    await State.loadCounts(state)
}

interface OpfsHarness {
    files:Map<string, PersistentDb>
    counters:{ opens:number; probes:number }
    cleanup:() => void
}

function setupOpfsHarness ():OpfsHarness {
    const files = new Map<string, PersistentDb>()
    const counters = { opens: 0, probes: 0 }
    const originalStorage = navigator.storage
    const originalOnline = navigator.onLine
    const originalIsolated = (
        globalThis as { crossOriginIsolated?:boolean }
    ).crossOriginIsolated

    Object.defineProperty(navigator, 'storage', {
        value: {
            getDirectory: async () => ({
                getDirectoryHandle: async () => ({
                    removeEntry: async (filename:string) => {
                        files.get(filename)?.close()
                        files.delete(filename)
                    }
                })
            })
        },
        configurable: true
    })
    Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true
    })
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
        value: true,
        configurable: true
    })
    setSQLiteWorkerClientFactoryForTests(() => {
        return new PersistentSQLiteClient(
            files,
            counters
        ) as unknown as SQLiteWorkerClient
    })

    return {
        files,
        counters,
        cleanup: () => {
            for (const db of files.values()) db.close()
            files.clear()
            setSQLiteWorkerClientFactoryForTests(null)
            Object.defineProperty(navigator, 'storage', {
                value: originalStorage,
                configurable: true
            })
            Object.defineProperty(navigator, 'onLine', {
                value: originalOnline,
                configurable: true
            })
            Object.defineProperty(globalThis, 'crossOriginIsolated', {
                value: originalIsolated,
                configurable: true
            })
        }
    }
}

function resetLocalFirstState ():void {
    setTestMode(false, wasmUrl as string)
    clearBootstrappedDb()
    _resetAdapterCache()
    _resetSupportedCache()
    resetTabCoordinationForTests()
    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    setSyncSubscriptions(false)
    saveLocalFirstSettings()
}

test(
    'persists local-first feed and item rows across a simulated reload',
    async (t) => {
        resetLocalFirstState()
        const harness = setupOpfsHarness()
        const sync = makeFetchCounter()
        const root = document.createElement('div')
        document.body.appendChild(root)

        try {
            setSyncSubscriptions(true)
            saveLocalFirstSettings()
            await bootstrapLocalDb(did, sync.fetchFn)

            const state = makeState()
            await loadLocalRows(state)
            render(html`<${FeedReader} state=${state} splats=${[]} />`, root)

            t.equal(state.feeds.value[0]?.title, feedTitle,
                'feed loads from local SQLite')
            t.equal(state.items.value[0]?.title, itemTitle,
                'item loads from local SQLite')
            t.ok(root.textContent?.includes(feedTitle),
                'feed appears in the rendered UI')
            t.ok(root.textContent?.includes(itemTitle),
                'item appears in the rendered UI')

            const fullSyncsAfterBootstrap = sync.fullSyncs()
            clearBootstrappedDb()
            _resetAdapterCache()
            resetTabCoordinationForTests()
            render(null, root)

            const reloaded = makeState()
            await loadLocalRows(reloaded)
            render(
                html`<${FeedReader} state=${reloaded} splats=${[]} />`,
                root
            )

            t.equal(sync.fullSyncs(), fullSyncsAfterBootstrap,
                'reload does not run a second full bootstrap')
            t.equal(reloaded.feeds.value[0]?.title, feedTitle,
                'feed persists after reload')
            t.equal(reloaded.items.value[0]?.title, itemTitle,
                'item persists after reload')
            t.ok(root.textContent?.includes(itemTitle),
                'reloaded UI renders the persisted item')

            await disableLocalFirst(did, sync.fetchFn)
            const filename = getOpfsFilename(did)
            const opensAfterDisable = harness.counters.opens
            const adapter = await getAdapter(did)

            t.equal(syncSubscriptions.value, false,
                'local-first is disabled')
            t.equal(harness.files.has(filename), false,
                'local OPFS database is removed')
            t.equal(adapter, remoteAdapter,
                'adapter falls back to remote after disable')
            t.equal(harness.counters.opens, opensAfterDisable,
                'disabled local-first does not reopen SQLite')
        } finally {
            render(null, root)
            root.remove()
            harness.cleanup()
            resetLocalFirstState()
        }
    }
)
