import type {
    SqliteWorkerBindValue,
    SqliteWorkerOpenOptions,
    SqliteWorkerRequest,
    SqliteWorkerResponse,
    SqliteWorkerRow,
    SqliteWorkerSerializedError
} from './sqlite-worker-protocol.js'

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

const workerScope = globalThis as unknown as WorkerScope
let sqlitePromise:Promise<SqliteWorkerNamespace>|null = null
let db:WorkerDb|null = null

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

async function openDb (options:SqliteWorkerOpenOptions):Promise<void> {
    const sqlite = await initSqliteInWorker()
    closeDb()

    if (options.inMemory || options.filename === ':memory:') {
        db = new sqlite.oo1.DB(':memory:')
        db.exec('PRAGMA foreign_keys = ON;')
        return
    }

    const filename = options.filename || (
        options.did ? getOpfsFilename(options.did) : ''
    )
    if (!filename) {
        throw new Error('SQLite worker open requires did or filename')
    }

    const pool = await sqlite.installOpfsSAHPoolVfs({
        directory: options.directory || 'rsss-db'
    })
    db = new pool.OpfsSAHPoolDb(filename)
    db.exec('PRAGMA foreign_keys = ON;')
}

async function initSqliteInWorker ():Promise<SqliteWorkerNamespace> {
    if (!sqlitePromise) {
        sqlitePromise = import('@sqlite.org/sqlite-wasm')
            .then((sqlite3Module) => sqlite3Module.default())
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
