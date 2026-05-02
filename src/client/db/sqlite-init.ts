import {
    SCHEMA_SQL,
    DEAD_LETTER_OUTBOX_SQL
} from '../../shared/schema.js'
import { createSQLiteWorkerClient } from './sqlite-worker-factory.js'
import { WorkerBackedLocalDb } from './local-db.js'
import {
    OUTBOX_SQL,
    SYNC_META_SQL,
    FEED_CACHE_POLICY_SQL,
    CACHED_IMAGES_SQL
} from './local-schema.js'
import { LOCAL_TAB_LOCK_ERROR } from './tab-coordination.js'
import type { SQLiteWorkerClient } from './sqlite-worker-client.js'

export {
    SYNC_META_SQL,
    OUTBOX_SQL,
    FEED_CACHE_POLICY_SQL,
    CACHED_IMAGES_SQL
} from './local-schema.js'

export class OPFSUnavailableError extends Error {
    constructor (message = 'OPFS is not available in this browser') {
        super(message)
        this.name = 'OPFSUnavailableError'
    }
}

export type LocalDbErrorCategory =
    'unavailable' |
    'locked' |
    'quota' |
    'corruption' |
    'unknown'

export class LocalDbOpenError extends Error {
    category:LocalDbErrorCategory

    constructor (
        category:LocalDbErrorCategory,
        message:string,
        cause?:unknown
    ) {
        super(message, { cause })
        this.name = 'LocalDbOpenError'
        this.category = category
    }
}

let _testMode = false
let _testWasmUrl:string|undefined
let _workerClientFactory:(() => SQLiteWorkerClient) = createSQLiteWorkerClient
let _probedWorkerClient:SQLiteWorkerClient|null = null

/** Set to true in tests to use an in-memory DB instead of OPFS. */
export function setTestMode (v:boolean, wasmUrl?:string):void {
    _testMode = v
    _testWasmUrl = wasmUrl
    if (v) disposeProbedWorkerClient()
}

export function setSQLiteWorkerClientFactoryForTests (
    factory:(() => SQLiteWorkerClient)|null
):void {
    disposeProbedWorkerClient()
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
        navigator.storage != null &&
        typeof navigator.storage.getDirectory === 'function' &&
        (globalThis as { crossOriginIsolated?:boolean })
            .crossOriginIsolated === true
    )
}

export async function probeOpfsSupport ():Promise<boolean> {
    if (!isOpfsSupported()) {
        disposeProbedWorkerClient()
        return false
    }

    if (_probedWorkerClient) return true

    const client = _workerClientFactory()
    try {
        await client.probe({ directory: 'rsss-db' })
        _probedWorkerClient = client
        return true
    } catch {
        client.dispose()
        return false
    }
}

export function classifyLocalDbError (
    err:unknown
):LocalDbErrorCategory {
    if (err instanceof LocalDbOpenError) return err.category
    if (err instanceof OPFSUnavailableError) return 'unavailable'

    const record = err as { name?:unknown; message?:unknown }
    const name = typeof record?.name === 'string' ? record.name : ''
    const message = err instanceof Error ? err.message : String(err)
    const text = `${name} ${message}`.toLowerCase()

    if (isExclusiveLockError(err)) return 'locked'
    if (
        name === 'QuotaExceededError' ||
        /quota|sqlite_full|disk.*full|no space|not enough storage/.test(text)
    ) {
        return 'quota'
    }
    if (
        /corrupt|malformed|not a database/.test(text) ||
        /unsupported file format|incompatible/.test(text)
    ) {
        return 'corruption'
    }
    if (/opfs|storage directory|filesystem/.test(text)) {
        return 'unavailable'
    }

    return 'unknown'
}

export function describeLocalDbError (err:unknown):string {
    const category = classifyLocalDbError(err)
    if (category === 'unknown') {
        return err instanceof Error ? err.message : String(err)
    }
    return localDbOpenMessage(category, err)
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
        db.exec(FEED_CACHE_POLICY_SQL)
        db.exec(CACHED_IMAGES_SQL)
        return db as Sqlite3Db
    }

    if (!isOpfsSupported()) {
        throw new OPFSUnavailableError()
    }

    const client = takeProbedWorkerClient() ?? _workerClientFactory()
    try {
        await client.open({ did, directory: 'rsss-db' })
        return new WorkerBackedLocalDb(client) as unknown as Sqlite3Db
    } catch (err) {
        client.dispose()
        const category = isExclusiveLockError(err) ?
            'locked' :
            classifyLocalDbError(err)
        const message = category === 'locked' ?
            LOCAL_TAB_LOCK_ERROR :
            localDbOpenMessage(category, err)
        throw new LocalDbOpenError(category, message, err)
    }
}

function takeProbedWorkerClient ():SQLiteWorkerClient|null {
    const client = _probedWorkerClient
    _probedWorkerClient = null
    return client
}

function disposeProbedWorkerClient ():void {
    _probedWorkerClient?.dispose()
    _probedWorkerClient = null
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

function localDbOpenMessage (
    category:LocalDbErrorCategory,
    err:unknown
):string {
    if (category === 'quota') {
        return (
            'Local storage is full. Free up space or reset local data, ' +
            'then try again.'
        )
    }
    if (category === 'corruption') {
        return (
            'Local storage could not be read. Reset local data to rebuild ' +
            'the on-device database.'
        )
    }
    if (category === 'unavailable') {
        return 'Local storage is not available in this browser.'
    }
    if (category === 'locked') return LOCAL_TAB_LOCK_ERROR

    const detail = err instanceof Error ? `: ${err.message}` : ''
    return `Local storage could not be opened${detail}`
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
