import { SCHEMA_SQL } from '../../shared/schema.js'

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

    const filename = `rsss-${did.replace(/[^a-z0-9]/gi, '_')}.db`
    const db = new poolUtil.OpfsSAHPoolDb(filename)
    db.exec(SCHEMA_SQL)
    return db
}
