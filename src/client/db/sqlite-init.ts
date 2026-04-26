import {
    SCHEMA_SQL,
    DEAD_LETTER_OUTBOX_SQL
} from '../../shared/schema.js'
import { createSQLiteWorkerClient } from './sqlite-worker-factory.js'
import { WorkerBackedLocalDb } from './local-db.js'
import { OUTBOX_SQL, SYNC_META_SQL } from './local-schema.js'
import { LOCAL_TAB_LOCK_ERROR } from './tab-coordination.js'
import type { SQLiteWorkerClient } from './sqlite-worker-client.js'

export { SYNC_META_SQL, OUTBOX_SQL } from './local-schema.js'

export class OPFSUnavailableError extends Error {
    constructor (message = 'OPFS is not available in this browser') {
        super(message)
        this.name = 'OPFSUnavailableError'
    }
}

let _testMode = false
let _testWasmUrl:string|undefined
let _workerClientFactory:(() => SQLiteWorkerClient) = createSQLiteWorkerClient

/** Set to true in tests to use an in-memory DB instead of OPFS. */
export function setTestMode (v:boolean, wasmUrl?:string):void {
    _testMode = v
    _testWasmUrl = wasmUrl
}

export function setSQLiteWorkerClientFactoryForTests (
    factory:(() => SQLiteWorkerClient)|null
):void {
    _workerClientFactory = factory ?? createSQLiteWorkerClient
}

export async function initSqlite () {
    const sqlite3Module = await import('@sqlite.org/sqlite-wasm')
    const opts = _testWasmUrl
        ? { locateFile: () => _testWasmUrl! }
        : {}
    const init = sqlite3Module.default as (
        opts?:{ locateFile?:() => string }
    ) => ReturnType<typeof sqlite3Module.default>
    const sqlite3 = await init(opts)
    return sqlite3
}

export type Sqlite3 = Awaited<ReturnType<typeof initSqlite>>
export type Sqlite3Db = InstanceType<Sqlite3['oo1']['DB']>

function isOpfsSupported ():boolean {
    return (
        typeof navigator !== 'undefined' &&
        'storage' in navigator &&
        typeof (globalThis as Record<string, unknown>)
            .FileSystemSyncAccessHandle !== 'undefined' &&
        (globalThis as { crossOriginIsolated?:boolean })
            .crossOriginIsolated === true
    )
}

/**
 * Open (or create) a SQLite database for `did`.
 *
 * In test mode, opens an in-memory database.
 * In production, uses the OPFS-SAH-pool VFS.
 * Throws OPFSUnavailableError if OPFS is not supported.
 */
export async function openLocalDb (did:string):Promise<Sqlite3Db> {
    if (_testMode) {
        const sqlite3 = await initSqlite()
        const db = new sqlite3.oo1.DB(':memory:')
        db.exec('PRAGMA foreign_keys = ON;')
        db.exec(SCHEMA_SQL)
        db.exec(OUTBOX_SQL)
        db.exec(DEAD_LETTER_OUTBOX_SQL)
        db.exec(SYNC_META_SQL)
        return db as Sqlite3Db
    }

    if (!isOpfsSupported()) {
        throw new OPFSUnavailableError()
    }

    try {
        const client = _workerClientFactory()
        await client.open({ did, directory: 'rsss-db' })
        return new WorkerBackedLocalDb(client) as unknown as Sqlite3Db
    } catch (err) {
        if (isExclusiveLockError(err)) {
            throw new OPFSUnavailableError(LOCAL_TAB_LOCK_ERROR)
        }
        throw err
    }
}

function isExclusiveLockError (err:unknown):boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return (
        /lock/i.test(msg) ||
        /busy/i.test(msg) ||
        /already.*open/i.test(msg) ||
        /no available.*access handle/i.test(msg)
    )
}

export function getOpfsFilename (did:string):string {
    return `rsss-${did.replace(/[^a-z0-9]/gi, '_')}.db`
}

/**
 * Remove the OPFS SQLite file for `did`.
 * Best-effort — resolves even if the file does not exist.
 */
export async function removeOpfsDb (did:string):Promise<void> {
    try {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('rsss-db', {
            create: false
        })
        await dir.removeEntry(getOpfsFilename(did))
    } catch {
        // file may not exist; ignore
    }
}
