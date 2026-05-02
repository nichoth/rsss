import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'
import type {
    SqliteWorkerBindValue,
    SqliteWorkerOpenOptions,
    SqliteWorkerRequest,
    SqliteWorkerResponse,
    SqliteWorkerRow,
    SqliteWorkerSerializedError
} from './sqlite-worker-protocol.js'
import {
    SCHEMA_SQL,
    DEAD_LETTER_OUTBOX_SQL
} from '../../shared/schema.js'
import {
    OUTBOX_SQL,
    SYNC_META_SQL,
    FEED_CACHE_POLICY_SQL,
    CACHED_IMAGES_SQL
} from './local-schema.js'

type WorkerDbExecArg =
    string |
    {
        sql:string
        bind?:SqliteWorkerBindValue[]
        rowMode?:'object'
        resultRows?:SqliteWorkerRow[]
    }

interface WorkerDb {
    exec:(arg:WorkerDbExecArg) => void
    close:() => void
}

type WorkerDbConstructor = new (filename:string) => WorkerDb

interface SqliteWorkerNamespace {
    oo1:{
        DB:WorkerDbConstructor
    }
    installOpfsSAHPoolVfs:(opts:{ directory:string }) => Promise<{
        OpfsSAHPoolDb:WorkerDbConstructor
    }>
}

interface WorkerScope {
    onmessage:((event:MessageEvent<SqliteWorkerRequest>) => void)|null
    postMessage:(message:SqliteWorkerResponse) => void
}

type SqliteWorkerFactory = (options:{
    locateFile:(filename:string) => string
}) => Promise<SqliteWorkerNamespace>

interface SqliteWorkerModule {
    default:SqliteWorkerFactory
}

const workerScope = globalThis as unknown as WorkerScope
let sqlitePromise:Promise<SqliteWorkerNamespace>|null = null
let db:WorkerDb|null = null
let opfsPoolDirectory:string|null = null
let opfsPoolDb:WorkerDbConstructor|null = null

workerScope.onmessage = (event) => {
    dispatch(event.data).catch((err) => {
        send({
            id: event.data.id,
            ok: false,
            error: serializeError(err)
        })
    })
}

async function dispatch (request:SqliteWorkerRequest):Promise<void> {
    try {
        const result = await handleRequest(request)
        send({ id: request.id, ok: true, result })
    } catch (err) {
        send({
            id: request.id,
            ok: false,
            error: serializeError(err)
        })
    }
}

async function handleRequest (
    request:SqliteWorkerRequest
):Promise<SqliteWorkerRow[]|void> {
    switch (request.type) {
        case 'probe':
            await probeOpfs(request.directory)
            return
        case 'open':
            await openDb(request)
            return
        case 'exec':
            getOpenDb().exec(sqlExecArg(request.sql, request.bind))
            return
        case 'query':
            return query(request.sql, request.bind)
        case 'close':
            closeDb()
    }
}

async function probeOpfs (directory = 'rsss-db'):Promise<void> {
    const workerNavigator = (globalThis as unknown as {
        navigator?:{
            storage?:{
                getDirectory?:() => Promise<unknown>
            }
        }
    }).navigator
    const getDirectory = workerNavigator?.storage?.getDirectory

    if (typeof getDirectory !== 'function') {
        throw new Error('OPFS storage directory API is unavailable')
    }

    await getDirectory.call(workerNavigator!.storage)

    await getOpfsPoolDb(directory)
}

async function openDb (options:SqliteWorkerOpenOptions):Promise<void> {
    const sqlite = await initSqliteInWorker()
    closeDb()

    if (options.inMemory || options.filename === ':memory:') {
        db = new sqlite.oo1.DB(':memory:')
        applySchema(db)
        return
    }

    const filename = options.filename || (
        options.did ? getOpfsFilename(options.did) : ''
    )
    if (!filename) {
        throw new Error('SQLite worker open requires did or filename')
    }

    const PoolDb = await getOpfsPoolDb(options.directory || 'rsss-db')
    db = new PoolDb(filename)
    applySchema(db)
}

async function getOpfsPoolDb (
    directory:string
):Promise<WorkerDbConstructor> {
    if (opfsPoolDb && opfsPoolDirectory === directory) {
        return opfsPoolDb
    }

    const sqlite = await initSqliteInWorker()
    if (typeof sqlite.installOpfsSAHPoolVfs !== 'function') {
        throw new Error('SQLite OPFS-SAH-pool VFS is unavailable')
    }

    const pool = await sqlite.installOpfsSAHPoolVfs({ directory })
    if (typeof pool.OpfsSAHPoolDb !== 'function') {
        throw new Error('SQLite OPFS-SAH-pool database is unavailable')
    }

    opfsPoolDirectory = directory
    opfsPoolDb = pool.OpfsSAHPoolDb
    return opfsPoolDb
}

function applySchema (targetDb:WorkerDb):void {
    targetDb.exec('PRAGMA foreign_keys = ON;')
    targetDb.exec(SCHEMA_SQL)
    targetDb.exec(OUTBOX_SQL)
    targetDb.exec(DEAD_LETTER_OUTBOX_SQL)
    targetDb.exec(SYNC_META_SQL)
    targetDb.exec(FEED_CACHE_POLICY_SQL)
    targetDb.exec(CACHED_IMAGES_SQL)
}

async function initSqliteInWorker ():Promise<SqliteWorkerNamespace> {
    if (!sqlitePromise) {
        sqlitePromise = import('@sqlite.org/sqlite-wasm')
            .then((sqlite3Module) => {
                const module = sqlite3Module as unknown as SqliteWorkerModule
                return module.default({
                    locateFile: () => sqliteWasmUrl
                })
            })
            .then((sqlite) => sqlite as unknown as SqliteWorkerNamespace)
    }

    return sqlitePromise
}

function query (
    sql:string,
    bind?:SqliteWorkerBindValue[]
):SqliteWorkerRow[] {
    const rows:SqliteWorkerRow[] = []
    getOpenDb().exec({
        sql,
        bind: bind && bind.length > 0 ? bind : undefined,
        rowMode: 'object',
        resultRows: rows
    })
    return rows
}

function sqlExecArg (
    sql:string,
    bind?:SqliteWorkerBindValue[]
):WorkerDbExecArg {
    if (!bind || bind.length === 0) return sql
    return { sql, bind }
}

function getOpenDb ():WorkerDb {
    if (!db) throw new Error('SQLite worker database is not open')
    return db
}

function closeDb ():void {
    if (!db) return
    db.close()
    db = null
}

function send (response:SqliteWorkerResponse):void {
    workerScope.postMessage(response)
}

function serializeError (err:unknown):SqliteWorkerSerializedError {
    if (err instanceof Error) {
        return {
            name: err.name || 'Error',
            message: err.message,
            stack: err.stack
        }
    }

    return {
        name: 'Error',
        message: String(err)
    }
}

function getOpfsFilename (did:string):string {
    return `rsss-${did.replace(/[^a-z0-9]/gi, '_')}.db`
}
