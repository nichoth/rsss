import { SCHEMA_SQL } from '../../shared/schema.js'

export const SYNC_META_SQL = `
    CREATE TABLE IF NOT EXISTS sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_pull_at TEXT
    );
    INSERT OR IGNORE INTO sync_meta (id, last_pull_at) VALUES (1, NULL);
`

const OUTBOX_SQL = `
    CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        op TEXT NOT NULL,
        target_id INTEGER,
        payload TEXT NOT NULL,
        client_op_id TEXT NOT NULL UNIQUE,
        client_updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    );
`

export class OPFSUnavailableError extends Error {
    constructor () {
        super('OPFS is not available in this browser')
        this.name = 'OPFSUnavailableError'
    }
}

let _testMode = false
let _testWasmUrl:string|undefined

/** Set to true in tests to use an in-memory DB instead of OPFS. */
export function setTestMode (v:boolean, wasmUrl?:string):void {
    _testMode = v
    _testWasmUrl = wasmUrl
}

export async function initSqlite () {
    const sqlite3Module = await import('@sqlite.org/sqlite-wasm')
    const opts = _testWasmUrl
        ? { locateFile: () => _testWasmUrl! }
        : {}
    const sqlite3 = await sqlite3Module.default(opts)
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
    const sqlite3 = await initSqlite()

    if (_testMode) {
        const db = new sqlite3.oo1.DB(':memory:')
        db.exec(SCHEMA_SQL)
        db.exec(OUTBOX_SQL)
        db.exec(SYNC_META_SQL)
        return db as Sqlite3Db
    }

    if (!isOpfsSupported()) {
        throw new OPFSUnavailableError()
    }

    const poolUtil = await (
        sqlite3 as unknown as {
            installOpfsSAHPoolVfs:(opts:{
                directory:string
            }) => Promise<{
                OpfsSAHPoolDb:new (filename:string) => Sqlite3Db
            }>
        }
    ).installOpfsSAHPoolVfs({ directory: 'rsss-db' })

    const filename = getOpfsFilename(did)
    const db = new poolUtil.OpfsSAHPoolDb(filename)
    db.exec(SCHEMA_SQL)
    db.exec(OUTBOX_SQL)
    db.exec(SYNC_META_SQL)
    return db
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
