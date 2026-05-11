import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import type { SQLiteWorkerClient } from './sqlite-worker-client.js'
import type { Sqlite3Db } from './sqlite-init.js'

export type LocalDbBindValue = SqlValue

export type LocalDbExecArg =
    string |
    {
        sql:string
        bind?:LocalDbBindValue[]
        rowMode?:'object'
        resultRows?:Record<string, SqlValue>[]
    }

export class WorkerBackedLocalDb {
    readonly isWorkerBackedLocalDb = true
    private client:SQLiteWorkerClient

    constructor (client:SQLiteWorkerClient) {
        this.client = client
    }

    exec (arg:LocalDbExecArg):Promise<void> {
        if (typeof arg === 'string') {
            return this.client.exec(arg)
        }

        if (arg.rowMode === 'object' && arg.resultRows) {
            return this.client
                .query<Record<string, SqlValue>>(arg.sql, arg.bind)
                .then((rows) => {
                    arg.resultRows!.push(...rows)
                })
        }

        return this.client.exec(arg.sql, arg.bind)
    }

    query<T> (
        sql:string,
        bind?:LocalDbBindValue[]
    ):Promise<T[]> {
        return this.client.query<Record<string, unknown>>(sql, bind)
            .then((rows) => rows as T[])
    }

    close ():Promise<void> {
        return this.client.close()
    }

    selectValue ():unknown {
        throw new Error('selectValue is unavailable on worker DB')
    }

    selectValues ():unknown[] {
        throw new Error('selectValues is unavailable on worker DB')
    }
}

export function isWorkerBackedLocalDb (
    db:Sqlite3Db
):db is Sqlite3Db & WorkerBackedLocalDb {
    return Boolean(
        (db as unknown as { isWorkerBackedLocalDb?:boolean })
            .isWorkerBackedLocalDb
    )
}

export async function execDb (
    db:Sqlite3Db,
    arg:LocalDbExecArg
):Promise<void> {
    await (db as unknown as {
        exec:(arg:LocalDbExecArg) => void|Promise<void>
    }).exec(arg)
}

export async function queryDb<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:LocalDbBindValue[]
):Promise<T[]> {
    if (isWorkerBackedLocalDb(db)) {
        return db.query<T>(sql, bind)
    }

    const rows:T[] = []
    await execDb(db, {
        sql,
        bind: bind && bind.length ? bind : undefined,
        rowMode: 'object',
        resultRows: rows as Record<string, SqlValue>[]
    })
    return rows
}

export async function queryOneDb<T> (
    db:Sqlite3Db,
    sql:string,
    bind?:LocalDbBindValue[]
):Promise<T|undefined> {
    const rows = await queryDb<T>(db, sql, bind)
    return rows[0]
}

const feedTerminalStateColumnsReady = new WeakSet<Sqlite3Db>()

export async function ensureFeedTerminalStateColumns (
    db:Sqlite3Db
):Promise<void> {
    if (feedTerminalStateColumnsReady.has(db)) return

    const cols = await queryDb<{ name:string }>(
        db,
        'PRAGMA table_info(feeds)'
    )
    const has = (name:string) => cols.some((col) => col.name === name)
    if (!has('last_error')) {
        await execDb(db, 'ALTER TABLE feeds ADD COLUMN last_error TEXT')
    }
    if (!has('last_status')) {
        await execDb(db, 'ALTER TABLE feeds ADD COLUMN last_status INTEGER')
    }
    feedTerminalStateColumnsReady.add(db)
}

export async function closeDb (db:Sqlite3Db|null|undefined):Promise<void> {
    if (!db) return

    const close = (db as unknown as { close?:() => void|Promise<void> })
        .close
    if (typeof close !== 'function') return

    await close.call(db)
}
