import { test } from '@substrate-system/tapzero'
// esbuild --loader:.wasm=dataurl inlines the binary as a base64 data URL
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    probeOpfsSupport,
    setTestMode,
    setSQLiteWorkerClientFactoryForTests,
    OPFSUnavailableError,
    classifyLocalDbError
} from '../src/client/db/sqlite-init.js'
import type {
    SQLiteWorkerClient
} from '../src/client/db/sqlite-worker-client.js'

setTestMode(true, wasmUrl as string)

test('openLocalDb delegates production open and schema setup to worker',
    async (t) => {
        const openCalls:unknown[] = []
        const execSql:string[] = []
        const previousNavigator = globalThis.navigator
        const previousIsolated = (
            globalThis as { crossOriginIsolated?:boolean }
        ).crossOriginIsolated
        const previousAccessHandle = (
            globalThis as Record<string, unknown>
        ).FileSystemSyncAccessHandle

        const worker = {
            open: async (options:unknown) => {
                openCalls.push(options)
            },
            exec: async (sql:string) => {
                execSql.push(sql)
            },
            query: async () => [],
            close: async () => {}
        } as unknown as SQLiteWorkerClient

        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                storage: {
                    getDirectory: async () => ({})
                }
            }
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            configurable: true,
            value: true
        })
        ;(globalThis as Record<string, unknown>)
            .FileSystemSyncAccessHandle = function () {}

        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(() => worker)

        try {
            const db = await openLocalDb('did:plc:alice')

            t.deepEqual(openCalls, [{
                did: 'did:plc:alice',
                directory: 'rsss-db'
            }], 'opens the per-user OPFS database in the worker')
            await db.exec({ sql: 'SELECT 1', bind: [] })
            t.equal(execSql.at(-1), 'SELECT 1',
                'returned db delegates exec calls to the worker')
        } finally {
            setSQLiteWorkerClientFactoryForTests(null)
            setTestMode(true, wasmUrl as string)
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: previousNavigator
            })
            Object.defineProperty(globalThis, 'crossOriginIsolated', {
                configurable: true,
                value: previousIsolated
            })
            ;(globalThis as Record<string, unknown>)
                .FileSystemSyncAccessHandle = previousAccessHandle
        }
    })

test('probeOpfsSupport reuses one OPFS VFS install for the next open',
    async (t) => {
        const previousNavigator = globalThis.navigator
        const previousIsolated = (
            globalThis as { crossOriginIsolated?:boolean }
        ).crossOriginIsolated
        const previousAccessHandle = (
            globalThis as Record<string, unknown>
        ).FileSystemSyncAccessHandle
        let factoryCalls = 0
        let installCalls = 0
        let disposeCalls = 0
        let closeCalls = 0

        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                storage: {
                    getDirectory: async () => ({})
                }
            }
        })
        Object.defineProperty(globalThis, 'crossOriginIsolated', {
            configurable: true,
            value: true
        })
        ;(globalThis as Record<string, unknown>)
            .FileSystemSyncAccessHandle = function () {}

        setTestMode(false)
        setSQLiteWorkerClientFactoryForTests(() => {
            factoryCalls++
            let vfsReady = false

            return {
                probe: async () => {
                    if (!vfsReady) {
                        installCalls++
                        vfsReady = true
                    }
                },
                open: async () => {
                    if (!vfsReady) {
                        installCalls++
                        vfsReady = true
                    }
                },
                exec: async () => {},
                query: async () => [],
                close: async () => {
                    closeCalls++
                },
                dispose: () => {
                    disposeCalls++
                }
            } as unknown as SQLiteWorkerClient
        })

        try {
            const supported = await probeOpfsSupport()
            const db = await openLocalDb('did:plc:alice')

            t.equal(supported, true, 'probe succeeds')
            t.equal(factoryCalls, 1, 'reuses the successful probe worker')
            t.equal(installCalls, 1, 'installs OPFS-SAH-pool once')
            t.equal(disposeCalls, 0, 'keeps the probed worker for open')

            await db.close()
            t.equal(closeCalls, 1, 'open db still owns worker shutdown')
        } finally {
            setSQLiteWorkerClientFactoryForTests(null)
            setTestMode(true, wasmUrl as string)
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: previousNavigator
            })
            Object.defineProperty(globalThis, 'crossOriginIsolated', {
                configurable: true,
                value: previousIsolated
            })
            ;(globalThis as Record<string, unknown>)
                .FileSystemSyncAccessHandle = previousAccessHandle
        }
    })

test('openLocalDb creates feeds and items tables', async (t) => {
    const db = await openLocalDb('did:test:user1')
    try {
        const tables = db.selectValues(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ) as string[]
        t.ok(tables.includes('feeds'), 'feeds table exists')
        t.ok(tables.includes('items'), 'items table exists')
    } finally {
        db.close()
    }
})

test('openLocalDb creates expected indexes', async (t) => {
    const db = await openLocalDb('did:test:user2')
    try {
        const indexes = db.selectValues(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        ) as string[]
        t.ok(indexes.includes('idx_items_feed_id'), 'idx_items_feed_id exists')
        t.ok(indexes.includes('idx_items_is_read'), 'idx_items_is_read exists')
        t.ok(indexes.includes('idx_items_is_starred'),
            'idx_items_is_starred exists')
        t.ok(indexes.includes('idx_feeds_updated_at'),
            'idx_feeds_updated_at exists')
    } finally {
        db.close()
    }
})

test('openLocalDb enables foreign key enforcement', async (t) => {
    const db = await openLocalDb('did:test:foreign-keys')
    try {
        const enabled = db.selectValue('PRAGMA foreign_keys') as number
        t.equal(enabled, 1, 'foreign keys are enabled')
    } finally {
        db.close()
    }
})

test('openLocalDb schema is idempotent', async (t) => {
    const db = await openLocalDb('did:test:user3')
    const db2 = await openLocalDb('did:test:user3')
    try {
        const tables = db2.selectValues(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ) as string[]
        t.ok(tables.includes('feeds'), 'feeds still present after re-open')
        t.ok(tables.includes('items'), 'items still present after re-open')
    } finally {
        db.close()
        db2.close()
    }
})

test('OPFSUnavailableError is a typed Error subclass', (t) => {
    const err = new OPFSUnavailableError()
    t.ok(err instanceof Error, 'is an Error')
    t.equal(err.name, 'OPFSUnavailableError', 'has correct name')
})

test('classifyLocalDbError maps common browser and SQLite failures', (t) => {
    const quota = new DOMException(
        'The quota has been exceeded.',
        'QuotaExceededError'
    )
    const sqliteFull = new Error('SQLITE_FULL: database or disk is full')
    const corrupt = new Error('database disk image is malformed')
    const locked = new Error('database is locked')
    const unavailable = new OPFSUnavailableError()
    const unknown = new Error('something else')

    t.equal(
        classifyLocalDbError(quota),
        'quota',
        'classifies quota errors'
    )
    t.equal(
        classifyLocalDbError(sqliteFull),
        'quota',
        'classifies SQLite full-disk write errors'
    )
    t.equal(
        classifyLocalDbError(corrupt),
        'corruption',
        'classifies corrupt database errors'
    )
    t.equal(
        classifyLocalDbError(locked),
        'locked',
        'classifies lock errors'
    )
    t.equal(
        classifyLocalDbError(unavailable),
        'unavailable',
        'classifies unsupported OPFS errors'
    )
    t.equal(
        classifyLocalDbError(unknown),
        'unknown',
        'falls back to unknown'
    )
})
