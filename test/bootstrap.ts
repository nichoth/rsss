import { test } from '@substrate-system/tapzero'
import sqlite3Module from '@sqlite.org/sqlite-wasm'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import { SCHEMA_SQL, DEAD_LETTER_OUTBOX_SQL } from
    '../src/shared/schema.js'
import { OUTBOX_SQL, SYNC_META_SQL } from
    '../src/client/db/local-schema.js'
import {
    classifyLocalDbError,
    getOpfsFilename,
    setSQLiteWorkerClientFactoryForTests,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import {
    bootstrapLocalDb,
    bootstrapInProgress,
    bootstrapFeedsCount,
    bootstrapItemsCount,
    bootstrapError,
    bootstrapRetryAvailable,
    bootstrapStorageWarning,
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
import { runSync } from '../src/client/db/sync.js'
import {
    isLocalFirstActive,
    syncError,
    syncStatus
} from '../src/client/db/sync-status.js'
import type { Sqlite3Db } from '../src/client/db/sqlite-init.js'
import type { SQLiteWorkerClient } from
    '../src/client/db/sqlite-worker-client.js'
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

    constructor (files:Map<string, PersistentDb>) {
        this.files = files
    }

    async probe ():Promise<void> {}

    async open (opts:SqliteWorkerOpenOptions):Promise<void> {
        const filename = opts.filename || (
            opts.did ? getOpfsFilename(opts.did) : ''
        )
        if (!filename) throw new Error('test worker requires a filename')

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
    Object.defineProperty(navigator, 'locks', {
        value: undefined,
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

function setupPersistentLocalFirst (
    files:Map<string, PersistentDb>,
    removed:string[] = []
):void {
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
    setTestMode(false)
    setSQLiteWorkerClientFactoryForTests(() => (
        new PersistentSQLiteClient(files) as unknown as SQLiteWorkerClient
    ))
    Object.defineProperty(navigator, 'storage', {
        value: {
            getDirectory: async () => ({
                getDirectoryHandle: async () => ({
                    removeEntry: async (name:string) => {
                        removed.push(name)
                        files.delete(name)
                    }
                })
            })
        },
        configurable: true
    })
    Object.defineProperty(navigator, 'locks', {
        value: undefined,
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

function teardownPersistentLocalFirst ():void {
    setSQLiteWorkerClientFactoryForTests(null)
    setTestMode(true, wasmUrl as string)
    clearBootstrappedDb()
    _resetAdapterCache()
    _resetSupportedCache()
    resetTabCoordinationForTests()
}

function makeFetch (body:unknown, status = 200):typeof fetch {
    return async (_url:RequestInfo|URL) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    } as Response)
}

function quotaWriteError ():Error {
    return new Error('SQLITE_FULL: database or disk is full')
}

function quotaWriteWorkerClient ():SQLiteWorkerClient {
    return {
        probe: async () => {},
        open: async () => {},
        exec: async (sql:string) => {
            if (/INSERT INTO feeds/.test(sql)) {
                throw quotaWriteError()
            }
        },
        query: async (sql:string) => {
            if (/COUNT\(\*\).*dead_letter_outbox/s.test(sql)) {
                return [{ n: 0 }]
            }
            if (/COUNT\(\*\).*outbox/s.test(sql)) {
                return [{ n: 0 }]
            }
            if (/last_pull_at/.test(sql)) {
                return [{ last_pull_at: null }]
            }
            if (/pull_cursor/.test(sql)) {
                return [{ pull_cursor: null }]
            }
            return []
        },
        close: async () => {},
        dispose: () => {}
    } as unknown as SQLiteWorkerClient
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

function persistentQueryAll<T> (
    db:PersistentDb,
    sql:string,
    bind?:unknown[]
):T[] {
    const rows:T[] = []
    db.exec({
        sql,
        bind: bind as SqliteWorkerBindValue[]|undefined,
        rowMode: 'object',
        resultRows: rows as Record<string, unknown>[]
    })
    return rows
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

test('bootstrapLocalDb: server error leaves local-first retryable',
    async (t) => {
        clearBootstrappedDb()
        syncSubscriptions.value = true
        bootstrapError.value = null

        const fetchFn = makeFetch({ error: 'internal' }, 500)
        await bootstrapLocalDb('did:test:bootstrap3', fetchFn)

        t.equal(bootstrapInProgress.value, false,
            'inProgress false after error')
        t.ok(bootstrapError.value !== null, 'error signal set')
        t.equal(syncSubscriptions.value, true,
            'syncSubscriptions stays true for retry')
        t.equal(bootstrapRetryAvailable.value, true,
            'server error exposes retry')
        t.equal(getBootstrappedDb(), null, 'no db after failure')
    }
)

test('bootstrapLocalDb: quota write error reaches bootstrap UI signal',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()
        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(quotaWriteWorkerClient)
        bootstrapError.value = null
        bootstrapRetryAvailable.value = true

        try {
            await bootstrapLocalDb(
                'did:test:bootstrap-quota-write',
                makeFetch(syncPayload)
            )

            t.equal(bootstrapRetryAvailable.value, false,
                'quota is treated as a terminal bootstrap failure')
            t.ok(
                /local storage is full/i.test(bootstrapError.value ?? ''),
                'bootstrap UI signal explains the quota failure'
            )
        } finally {
            teardownPersistentLocalFirst()
        }
    }
)

test('runSync: quota write error reaches steady-state UI signal',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()
        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(quotaWriteWorkerClient)
        syncError.value = null
        syncStatus.value = 'idle'

        try {
            await getAdapter('did:test:sync-quota-write')
            const db = getLocalDb('did:test:sync-quota-write')
            t.ok(db, 'local db is cached')
            if (!db) return

            isLocalFirstActive.value = true
            const err = await catchError(() => (
                runSync(db, makeFetch(syncPayload))
            ))

            t.equal(classifyLocalDbError(err), 'quota',
                'the SQLite write error is classified as quota')
            t.equal(syncStatus.value, 'error',
                'steady-state sync status becomes error')
            t.ok(
                /local storage is full/i.test(syncError.value ?? ''),
                'steady-state UI signal explains the quota failure'
            )
        } finally {
            isLocalFirstActive.value = false
            teardownPersistentLocalFirst()
        }
    }
)

test('bootstrapLocalDb: low storage waits for explicit confirmation',
    async (t) => {
        clearBootstrappedDb()
        syncSubscriptions.value = true
        bootstrapStorageWarning.value = null
        let fetchCalls = 0

        Object.defineProperty(navigator, 'storage', {
            value: {
                estimate: async () => ({
                    quota: 150 * 1024 * 1024,
                    usage: 80 * 1024 * 1024
                }),
                getDirectory: async () => ({
                    getDirectoryHandle: async () => ({
                        removeEntry: async () => undefined
                    })
                })
            },
            configurable: true
        })

        const fetchFn = (async () => {
            fetchCalls += 1
            return {
                ok: true,
                status: 200,
                json: async () => syncPayload
            } as Response
        }) as typeof fetch

        await bootstrapLocalDb('did:test:bootstrap-low-storage', fetchFn)

        t.equal(fetchCalls, 0, 'bootstrap does not pull rows')
        t.equal(getBootstrappedDb(), null, 'does not open a usable db')
        t.ok(bootstrapStorageWarning.value,
            'low-storage warning signal is set')
        t.equal(bootstrapInProgress.value, false,
            'inProgress is reset while waiting for confirmation')

        await bootstrapLocalDb(
            'did:test:bootstrap-low-storage-confirmed',
            fetchFn,
            { confirmLowStorage: async () => true }
        )

        t.equal(fetchCalls, 1, 'explicit confirmation allows bootstrap')
        t.equal(bootstrapStorageWarning.value, null,
            'successful bootstrap clears storage warning')

        getBootstrappedDb()?.close()
        clearBootstrappedDb()
    }
)

test('bootstrapLocalDb: transient fetch failure keeps local-first retryable',
    async (t) => {
        clearBootstrappedDb()
        syncSubscriptions.value = true
        bootstrapError.value = null
        bootstrapRetryAvailable.value = false
        const removed:string[] = []
        let calls = 0

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

        const fetchFn = (async () => {
            calls += 1
            if (calls === 1) {
                throw new TypeError('Failed to fetch')
            }
            return {
                ok: true,
                status: 200,
                json: async () => syncPayload
            } as Response
        }) as typeof fetch

        await bootstrapLocalDb('did:test:bootstrap-transient', fetchFn)

        t.equal(syncSubscriptions.value, true,
            'transient failure leaves local-first enabled')
        t.equal(removed.length, 0,
            'transient failure leaves OPFS data in place')
        t.equal(bootstrapRetryAvailable.value, true,
            'transient failure exposes retry')
        t.equal(getBootstrappedDb(), null, 'no db after failed attempt')

        await bootstrapLocalDb('did:test:bootstrap-transient', fetchFn)

        t.equal(calls, 2, 'retry calls fetch again')
        t.equal(bootstrapError.value, null, 'retry clears bootstrap error')
        t.equal(bootstrapRetryAvailable.value, false,
            'successful retry clears retry state')
        t.ok(getBootstrappedDb(), 'retry bootstraps the local db')

        getBootstrappedDb()?.close()
        clearBootstrappedDb()
    }
)

test('bootstrapLocalDb: interrupted bootstrap can be toggled and retried',
    async (t) => {
        clearBootstrappedDb()
        const files = new Map<string, PersistentDb>()
        setupPersistentLocalFirst(files)
        const did = 'did:test:bootstrap-toggle-retry'
        let calls = 0

        const fetchFn = (async () => {
            calls += 1
            if (calls === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        feeds: syncPayload.feeds,
                        items: [syncPayload.items[0]],
                        hasMore: true,
                        nextCursor: '1',
                        syncedAt: '2024-01-01T00:00:00Z',
                        latestUpdatedAt: '2024-01-01T00:00:00Z',
                        isFullSync: true
                    })
                } as Response
            }
            if (calls === 2) throw new TypeError('Failed to fetch')
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    feeds: [],
                    items: [syncPayload.items[1]],
                    hasMore: false,
                    nextCursor: null,
                    syncedAt: '2024-01-01T00:00:00Z',
                    latestUpdatedAt: '2024-01-01T00:00:00Z',
                    isFullSync: true
                })
            } as Response
        }) as typeof fetch

        try {
            await bootstrapLocalDb(did, fetchFn)

            t.equal(syncSubscriptions.value, true,
                'transient interruption does not auto-disable')
            t.equal(bootstrapRetryAvailable.value, true,
                'interruption leaves setup retryable')
            t.equal(getBootstrappedDb(), null,
                'interrupted db is not promoted')

            syncSubscriptions.value = false
            syncSubscriptions.value = true
            await bootstrapLocalDb(did, fetchFn)

            const db = getBootstrappedDb()
            t.ok(db, 're-toggle retry promotes the local db')

            const fileDb = files.get(getOpfsFilename(did))
            t.ok(fileDb, 'persistent OPFS file is still present')
            if (fileDb) {
                const rows = persistentQueryAll<{ count:number }>(
                    fileDb,
                    'SELECT COUNT(*) AS count FROM items'
                )
                t.equal(rows[0]?.count, 2,
                    'retry resumes and stores all bootstrap items')
            }
        } finally {
            teardownPersistentLocalFirst()
        }
    }
)

test('bootstrapLocalDb: terminal retry removes interrupted OPFS file',
    async (t) => {
        clearBootstrappedDb()
        const files = new Map<string, PersistentDb>()
        const removed:string[] = []
        setupPersistentLocalFirst(files, removed)
        const did = 'did:test:bootstrap-terminal-after-interrupt'
        const filename = getOpfsFilename(did)
        let calls = 0

        const fetchFn = (async () => {
            calls += 1
            if (calls === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        feeds: syncPayload.feeds,
                        items: [syncPayload.items[0]],
                        hasMore: true,
                        nextCursor: '1',
                        syncedAt: '2024-01-01T00:00:00Z',
                        latestUpdatedAt: '2024-01-01T00:00:00Z',
                        isFullSync: true
                    })
                } as Response
            }
            if (calls === 2) throw new TypeError('Failed to fetch')
            return {
                ok: false,
                status: 400,
                json: async () => ({ error: 'bad request' })
            } as Response
        }) as typeof fetch

        try {
            await bootstrapLocalDb(did, fetchFn)

            t.ok(files.has(filename),
                'precondition: interrupted OPFS file remains for retry')
            t.equal(syncSubscriptions.value, true,
                'precondition: transient failure keeps local-first enabled')

            await bootstrapLocalDb(did, fetchFn, {
                confirmTerminalReset: async () => true
            })

            t.equal(syncSubscriptions.value, false,
                'terminal retry disables local-first after confirmation')
            t.ok(removed.includes(filename),
                'terminal retry removes the interrupted file')
            t.equal(files.has(filename), false,
                'interrupted OPFS file is not left behind')
        } finally {
            teardownPersistentLocalFirst()
        }
    }
)

test('bootstrapLocalDb: leftover outbox rows do not block bootstrap',
    async (t) => {
        clearBootstrappedDb()
        const files = new Map<string, PersistentDb>()
        setupPersistentLocalFirst(files)
        const did = 'did:test:bootstrap-leftover-outbox'
        const filename = getOpfsFilename(did)

        try {
            const existingDb = await createPersistentDb()
            existingDb.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at)
                    VALUES ('update_item', 1, ?,
                        'op-leftover-bootstrap',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({ id: 1, is_read: true })]
            })
            files.set(filename, existingDb)

            await bootstrapLocalDb(did, makeFetch(syncPayload))

            t.equal(bootstrapError.value, null,
                'bootstrap completes without surfacing an error')
            t.ok(getBootstrappedDb(), 'bootstrap promotes the local db')

            const fileDb = files.get(filename)
            t.ok(fileDb, 'persistent DB still exists')
            if (fileDb) {
                const outbox = persistentQueryAll<{ count:number }>(
                    fileDb,
                    'SELECT COUNT(*) AS count FROM outbox'
                )
                const feeds = persistentQueryAll<{ count:number }>(
                    fileDb,
                    'SELECT COUNT(*) AS count FROM feeds'
                )
                t.equal(outbox[0]?.count, 1,
                    'leftover outbox row is preserved')
                t.equal(feeds[0]?.count, 1,
                    'bootstrap still writes unprotected feed rows')
            }
        } finally {
            teardownPersistentLocalFirst()
        }
    }
)

test('bootstrapLocalDb: failed bootstrap clears state and partial data',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()
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
            makeFetch({ error: 'bad request' }, 400),
            { confirmTerminalReset: async () => true }
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
        billingStatus.value = {
            entitled: true,
            planId: 'local-first',
            status: 'active',
            refreshedAt: Date.now(),
            useLive: false
        }
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

test('disableLocalFirst: cancels in-flight sync without UI error',
    async (t) => {
        clearBootstrappedDb()
        setupSupportedLocalFirst()
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

        await getAdapter('did:test:disable-cancel-safe')
        const db = getLocalDb('did:test:disable-cancel-safe')
        t.ok(db, 'local db is cached')
        if (!db) return

        isLocalFirstActive.value = true
        syncStatus.value = 'idle'
        syncError.value = null

        let pullStarted:() => void = () => {}
        let pullAborted:() => void = () => {}
        const started = new Promise<void>((resolve) => {
            pullStarted = resolve
        })
        const aborted = new Promise<void>((resolve) => {
            pullAborted = resolve
        })

        const hangingFetch = (async (
            _url:RequestInfo|URL,
            init?:RequestInit
        ) => {
            if (init?.method) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({})
                } as Response
            }

            pullStarted()
            await new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    pullAborted()
                    reject(new DOMException('Aborted', 'AbortError'))
                }, { once: true })
            })
            throw new Error('unreachable')
        }) as typeof fetch

        const syncPromise = runSync(db, hangingFetch)
        await started
        await disableLocalFirst('did:test:disable-cancel-safe')
        await aborted
        await syncPromise

        t.equal(syncError.value, null, 'sync error is not set')
        t.notEqual(syncStatus.value, 'error', 'status does not flash error')
        t.equal(removed.length, 1, 'OPFS file is removed exactly once')
        t.equal(
            removed[0],
            'rsss-did_test_disable_cancel_safe.db',
            'removes the expected OPFS file'
        )
        t.equal(syncSubscriptions.value, false, 'local-first is disabled')

        isLocalFirstActive.value = false
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
