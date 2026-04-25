export class OPFSUnavailableError extends Error {
    constructor () {
        super('OPFS is not available in this browser')
        this.name = 'OPFSUnavailableError'
    }
}

export async function initSqlite () {
    const sqlite3Module = await import('@sqlite.org/sqlite-wasm')
    const sqlite3 = await sqlite3Module.default()
    return sqlite3
}

export type Sqlite3 = Awaited<ReturnType<typeof initSqlite>>
export type Sqlite3Db = InstanceType<Sqlite3['oo1']['DB']>
