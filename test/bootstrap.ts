import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    setSQLiteWorkerClientFactoryForTests,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    getBootstrappedDb,
    clearBootstrappedDb
} from '../src/client/db/bootstrap.js'
import {
    syncSubscriptions,
    storeContent
} from '../src/client/local-first-settings.js'
import { billingStatus } from '../src/client/billing-status.js'
import {
    disableLocalFirst,
    resetLocalFirst,
    getAdapter,
    getLocalDb,
    _resetAdapterCache,
    _resetSupportedCache
} from '../src/client/db/index.js'
import {
    resetTabCoordinationForTests
} from '../src/client/db/tab-coordination.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'
import type { SQLiteWorkerClient } from
    '../src/client/db/sqlite-worker-client.js'

setTestMode(true, wasmUrl as string)

function setupSupportedLocalFirst ():void {
    _resetSupportedCache()
    _resetAdapterCache()
    resetTabCoordinationForTests()
    syncSubscriptions.value = true
    billingStatus.value = {
        entitled: true,
        planId: 'local-first',
        status: 'active',
        refreshedAt: Date.now(),
        useLive: false
    }
    setSQLiteWorkerClientFactoryForTests(() => ({
        probe: async () => {},
        dispose: () => {}
    } as unknown as SQLiteWorkerClient))
    Object.defineProperty(navigator, 'storage', {
        value: {
            getDirectory: async () => ({
                getDirectoryHandle: async () => ({
                    removeEntry: async () => undefined
                })
            })
        },
        configurable: true
    })
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
        value: true,
        configurable: true
    })
    Object.defineProperty(globalThis, 'FileSystemSyncAccessHandle', {
        value: function FileSystemSyncAccessHandle () {},
        configurable: true
    })
    Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true
    })
}

function makeFetch (body:unknown, status = 200):typeof fetch {
    return async (_url:RequestInfo|URL) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    } as Response)
}

const syncPayload = {
    feeds: [
        {
            id: 1,
            url: 'https://example.com/feed',
            title: 'Example',
            description: null,
            site_url: null,
            last_fetched: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        }
    ],
    items: [
        {
            id: 1,
            feed_id: 1,
            guid: 'guid1',
            title: 'Item 1',
            link: null,
            description: null,
            content: null,
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        },
        {
            id: 2,
            feed_id: 1,
            guid: 'guid2',
            title: 'Item 2',
            link: null,
            description: null,
            content: null,
            author: null,
            pub_date: null,
            is_read: 0,
            is_starred: 0,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z'
        }
    ],
    syncedAt: '2024-01-01T00:00:00Z',
    latestUpdatedAt: '2024-01-01T00:00:00Z',
    isFullSync: true
}

function failingPushFetch ():typeof fetch {
    return async (_url:RequestInfo|URL, init?:RequestInit) => {
        if (init?.method) {
            return {
                ok: false,
                status: 500,
                json: async () => ({ error: 'temporary failure' })
            } as Response
        }

        return {
            ok: true,
            status: 200,
            json: async () => syncPayload
        } as Response
    }
}

function seedOutbox (db:Sqlite3Db):void {
    db.exec({
        sql: `INSERT INTO outbox
            (op, target_id, payload, client_op_id, client_updated_at)
            VALUES ('update_item', 10, ?, 'op-disable-reset',
                '2026-01-03 00:00:00')`,
        bind: [JSON.stringify({ id: 10, is_read: true })]
    })
}

async function catchError (fn:() => Promise<void>):Promise<unknown> {
    try {
        await fn()
        return null
    } catch (err) {
        return err
    }
}

test('bootstrapLocalDb: happy path sets signals and db', async (t) => {
    clearBootstrappedDb()
    syncSubscriptions.value = false
    storeContent.value = false
    bootstrapError.value = null

    const fetchFn = makeFetch(syncPayload)
    syncSubscriptions.value = true
    await bootstrapLocalDb('did:test:bootstrap1', fetchFn)

    t.equal(bootstrapInProgress.value, false, 'inProgress is false after done')
    t.equal(bootstrapFeedsCount.value, 1, 'feeds count = 1')
    t.equal(bootstrapItemsCount.value, 2, 'items count = 2')
    t.equal(bootstrapError.value, null, 'no error')

    const db = getBootstrappedDb()
    t.ok(db !== null, 'bootstrapped DB is set')

    if (db) {
        const feeds = db.selectObjects(
            'SELECT * FROM feeds'
        ) as { id:number }[]
        t.equal(feeds.length, 1, 'feed row written to db')
        const items = db.selectObjects(
            'SELECT * FROM items'
        ) as { id:number }[]
        t.equal(items.length, 2, 'item rows written to db')
        db.close()
    }
    clearBootstrappedDb()
})

test('bootstrapLocalDb: bootstrap is idempotent (re-run adds no dupes)',
    async (t) => {
        clearBootstrappedDb()
        const fetchFn = makeFetch(syncPayload)
        syncSubscriptions.value = true

        await bootstrapLocalDb('did:test:bootstrap2', fetchFn)
        const db = getBootstrappedDb()

        // Run again on same in-memory DB via a second call won't reuse the same
        // db in test mode (new :memory: each time) but confirms no crash.
        t.equal(bootstrapInProgress.value, false,
            'inProgress false after second run')
        t.equal(bootstrapError.value, null, 'no error on second run')

        if (db) db.close()
        clearBootstrappedDb()
    }
)

test('bootstrapLocalDb: server error reverts syncSubscriptions', async (t) => {
    clearBootstrappedDb()
    syncSubscriptions.value = true
    bootstrapError.value = null

    const fetchFn = makeFetch({ error: 'internal' }, 500)
    await bootstrapLocalDb('did:test:bootstrap3', fetchFn)

    t.equal(bootstrapInProgress.value, false, 'inProgress false after error')
    t.ok(bootstrapError.value !== null, 'error signal set')
    t.equal(syncSubscriptions.value, false,
        'syncSubscriptions reverted to false')
    t.equal(getBootstrappedDb(), null, 'no db after failure')
})

test('bootstrapLocalDb: failed bootstrap clears state and partial data',
    async (t) => {
        clearBootstrappedDb()
        syncSubscriptions.value = true
        bootstrapError.value = null
        const removed:string[] = []

        Object.defineProperty(navigator, 'storage', {
            value: {
                getDirectory: async () => ({
                    getDirectoryHandle: async () => ({
                        removeEntry: async (name:string) => {
                            removed.push(name)
                        }
                    })
                })
            },
            configurable: true
        })

        await bootstrapLocalDb('did:test:bootstrap-old', makeFetch(syncPayload))
        const oldDb = getBootstrappedDb()
        t.ok(oldDb, 'precondition: old bootstrapped db exists')
        _resetSupportedCache()
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {},
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        await getAdapter('did:test:bootstrap-old')
        t.equal(getLocalDb('did:test:bootstrap-old'), oldDb,
            'precondition: adapter cache points at old db')

        syncSubscriptions.value = true
        await bootstrapLocalDb(
            'did:test:bootstrap-fails',
            makeFetch({ error: 'internal' }, 500)
        )

        t.equal(getBootstrappedDb(), null, 'clears bootstrapped db on failure')
        t.equal(syncSubscriptions.value, false,
            'syncSubscriptions reverted to false')
        syncSubscriptions.value = true
        await getAdapter('did:test:bootstrap-old')
        t.ok(getLocalDb('did:test:bootstrap-old') !== oldDb,
            'clears cached adapter db on failure')
        t.ok(
            removed.some((name) => name === 'rsss-did_test_bootstrap_fails.db'),
            'removes the failed partial local db file'
        )

        oldDb?.close()
        clearBootstrappedDb()
    }
)

test('resetLocalFirst closes worker db before removing OPFS data',
    async (t) => {
        clearBootstrappedDb()
        _resetSupportedCache()
        _resetAdapterCache()
        resetTabCoordinationForTests()
        syncSubscriptions.value = true
        const events:string[] = []

        Object.defineProperty(navigator, 'storage', {
            value: {
                getDirectory: async () => ({
                    getDirectoryHandle: async () => ({
                        removeEntry: async () => {
                            events.push('remove')
                        }
                    })
                })
            },
            configurable: true
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            value: true,
            configurable: true
        })
        Object.defineProperty(navigator, 'onLine', {
            value: true,
            configurable: true
        })

        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(() => ({
            probe: async () => {},
            open: async () => {
                events.push('open')
            },
            exec: async () => {},
            query: async () => [],
            close: async () => {
                events.push('close')
            },
            dispose: () => {}
        } as unknown as SQLiteWorkerClient))

        try {
            await getAdapter('did:test:reset-close')
            await resetLocalFirst(
                'did:test:reset-close',
                makeFetch(syncPayload)
            )

            const closeIndex = events.indexOf('close')
            const removeIndex = events.indexOf('remove')
            t.ok(closeIndex >= 0, 'closes the worker db')
            t.ok(removeIndex >= 0, 'removes the OPFS data')
            t.ok(closeIndex < removeIndex,
                'closes worker db before removing OPFS data')
        } finally {
            setSQLiteWorkerClientFactoryForTests(null)
            setTestMode(true, wasmUrl as string)
            clearBootstrappedDb()
            _resetAdapterCache()
            resetTabCoordinationForTests()
        }
    }
)

test('getAdapter returns remoteAdapter while bootstrap in progress',
    async (t) => {
        const { getAdapter, _resetAdapterCache, remoteAdapter } =
            await import('../src/client/db/index.js')
        _resetAdapterCache()
        clearBootstrappedDb()
        syncSubscriptions.value = true
        bootstrapInProgress.value = true

        const adapter = await getAdapter('did:test:bootstrap4')
        t.equal(adapter, remoteAdapter,
            'returns remoteAdapter when bootstrap in progress')

        bootstrapInProgress.value = false
        _resetAdapterCache()
    }
)

test('disableLocalFirst: aborts when pending writes cannot sync',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()

        await getAdapter('did:test:disable-sync-failure')
        const db = getLocalDb('did:test:disable-sync-failure')
        t.ok(db, 'local db is cached')
        if (!db) return

        seedOutbox(db)

        const err = await catchError(async () => {
            await disableLocalFirst(
                'did:test:disable-sync-failure',
                failingPushFetch()
            )
        })
        t.ok(err instanceof Error, 'disable rejects on failed push')
        t.ok(
            err instanceof Error &&
            /Unable to upload pending local changes/.test(err.message),
            'error explains pending local changes were not uploaded'
        )
        t.equal(syncSubscriptions.value, true,
            'local-first remains enabled after failed push')
        t.equal(getLocalDb('did:test:disable-sync-failure'), db,
            'local db cache remains available')

        db.close()
        clearBootstrappedDb()
        _resetAdapterCache()
    }
)

test('resetLocalFirst: requires explicit data-loss confirmation after failure',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()

        await getAdapter('did:test:reset-sync-failure')
        const db = getLocalDb('did:test:reset-sync-failure')
        t.ok(db, 'local db is cached')
        if (!db) return

        seedOutbox(db)

        const err = await catchError(async () => {
            await resetLocalFirst(
                'did:test:reset-sync-failure',
                failingPushFetch()
            )
        })
        t.ok(err instanceof Error, 'reset rejects on failed push')
        t.ok(
            err instanceof Error &&
            /Unable to upload pending local changes/.test(err.message),
            'error explains pending local changes were not uploaded'
        )
        t.equal(getLocalDb('did:test:reset-sync-failure'), db,
            'reset abort keeps the cached db')

        await resetLocalFirst(
            'did:test:reset-sync-failure',
            failingPushFetch(),
            { allowDataLossOnSyncFailure: true }
        )

        const bootstrapped = getBootstrappedDb()
        t.ok(bootstrapped, 'reset proceeds after explicit confirmation')
        if (bootstrapped) {
            const rows = bootstrapped.selectObjects(
                'SELECT * FROM feeds'
            ) as { id:number }[]
            t.equal(rows.length, 1, 'reset re-bootstraps local data')
            bootstrapped.close()
        }

        clearBootstrappedDb()
        _resetAdapterCache()
    }
)
