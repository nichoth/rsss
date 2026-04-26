import type {
    SqliteWorkerBindValue,
    SqliteWorkerOpenOptions,
    SqliteWorkerProbeOptions,
    SqliteWorkerRequest,
    SqliteWorkerRequestBody,
    SqliteWorkerResponse
} from './sqlite-worker-protocol.js'

export interface SQLiteWorkerLike {
    onmessage:((event:MessageEvent<SqliteWorkerResponse>) => void)|null
    onerror:((event:ErrorEvent) => void)|null
    postMessage:(message:SqliteWorkerRequest) => void
    terminate?:() => void
}

interface PendingRequest<T = unknown> {
    resolve:(value:T) => void
    reject:(err:Error) => void
}

export class SQLiteWorkerClient {
    private nextId = 1
    private closed = false
    private pending = new Map<number, PendingRequest>()

    constructor (private worker:SQLiteWorkerLike) {
        this.worker.onmessage = (event) => this.handleMessage(event.data)
        this.worker.onerror = (event) => {
            const message = event.message || 'SQLite worker failed'
            this.rejectAll(new Error(message))
        }
    }

    probe (options:SqliteWorkerProbeOptions = {}):Promise<void> {
        return this.send<void>({ type: 'probe', ...options })
    }

    open (options:SqliteWorkerOpenOptions):Promise<void> {
        return this.send<void>({ type: 'open', ...options })
    }

    exec (
        sql:string,
        bind?:SqliteWorkerBindValue[]
    ):Promise<void> {
        return this.send<void>({ type: 'exec', sql, bind })
    }

    query<T extends Record<string, unknown>> (
        sql:string,
        bind?:SqliteWorkerBindValue[]
    ):Promise<T[]> {
        return this.send<T[]>({ type: 'query', sql, bind })
    }

    async close ():Promise<void> {
        if (this.closed) return
        try {
            await this.send<void>({ type: 'close' })
        } finally {
            this.closed = true
            this.worker.terminate?.()
        }
    }

    dispose ():void {
        if (this.closed) return
        this.closed = true
        this.rejectAll(new Error('SQLite worker client disposed'))
        this.worker.terminate?.()
    }

    private send<T> (body:SqliteWorkerRequestBody):Promise<T> {
        if (this.closed) {
            return Promise.reject(new Error('SQLite worker client is closed'))
        }

        const id = this.nextId++
        const message = { id, ...body } as SqliteWorkerRequest

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value:unknown) => resolve(value as T),
                reject
            })

            try {
                this.worker.postMessage(message)
            } catch (err) {
                this.pending.delete(id)
                reject(toError(err))
            }
        })
    }

    private handleMessage (response:SqliteWorkerResponse):void {
        const pending = this.pending.get(response.id)
        if (!pending) return

        this.pending.delete(response.id)

        if (response.ok) {
            pending.resolve(response.result)
            return
        }

        const err = new Error(response.error.message)
        err.name = response.error.name || 'Error'
        pending.reject(err)
    }

    private rejectAll (err:Error):void {
        for (const pending of this.pending.values()) {
            pending.reject(err)
        }
        this.pending.clear()
    }
}

function toError (err:unknown):Error {
    return err instanceof Error ? err : new Error(String(err))
}
