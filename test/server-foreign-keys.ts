import { test } from '@substrate-system/tapzero'
// esbuild --loader:.wasm=dataurl inlines the binary as a base64 data URL
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import sqlite3Module from '@sqlite.org/sqlite-wasm'
import { UserDO, type Env } from '../src/server/durable-objects/index.js'

type Row = Record<string, unknown>
type SqliteExec = (opts:{
    sql:string
    bind:unknown[]
    rowMode:'object'
    resultRows:Row[]
}) => unknown
type MemorySqliteDb = {
    exec:(opts:Parameters<SqliteExec>[0]) => unknown
    close:() => void
}
type SqliteModule = (opts:{
    locateFile:() => string
}) => Promise<{
    oo1:{
        DB:new (filename:string) => MemorySqliteDb
    }
}>

function createFakeSqlResult (rows:Row[]) {
    return {
        toArray ():Row[] {
            return rows
        },

        one ():Row|null {
            return rows[0] ?? null
        }
    }
}

function createFakeSqlStorage (execSql:SqliteExec) {
    return {
        exec (sql:string, ...bind:unknown[]) {
            const rows:Row[] = []
            execSql({
                sql,
                bind,
                rowMode: 'object',
                resultRows: rows
            })
            return createFakeSqlResult(rows)
        }
    }
}

async function createDoWithMemorySql ():Promise<{
    userDo:UserDO
    sql:ReturnType<typeof createFakeSqlStorage>
    close:() => void
}> {
    const initSqlite = sqlite3Module as unknown as SqliteModule
    const sqlite3 = await initSqlite({
        locateFile: () => wasmUrl as string
    })
    const db = new sqlite3.oo1.DB(':memory:')
    const sql = createFakeSqlStorage((opts) => db.exec(opts))
    let barrier:Promise<void> = Promise.resolve()
    const ctx = {
        storage: {
            sql,
            get: async () => null,
            put: async () => {},
            getAlarm: async () => Date.now(),
            setAlarm: async () => {}
        },
        blockConcurrencyWhile: (fn:() => Promise<void>) => {
            barrier = fn()
        }
    } as unknown as DurableObjectState
    const userDo = new UserDO(ctx, {} as Env)
    await barrier

    return {
        userDo,
        sql,
        close: () => {
            db.close()
        }
    }
}

test('UserDO init enables foreign key cascades', async (t) => {
    const { userDo: _userDo, sql, close } = await createDoWithMemorySql()
    try {
        sql.exec("INSERT INTO feeds (url) VALUES ('https://example.com/rss')")
        sql.exec(
            'INSERT INTO items (feed_id, guid, title) VALUES (?, ?, ?)',
            1,
            'item-1',
            'Item 1'
        )

        sql.exec('DELETE FROM feeds WHERE id = ?', 1)

        const remaining = sql.exec(
            'SELECT COUNT(*) AS count FROM items'
        ).one()
        t.equal(remaining?.count, 0, 'item row was deleted by cascade')
        t.ok(_userDo, 'Durable Object constructed successfully')
    } finally {
        close()
    }
})
