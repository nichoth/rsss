import type { SqlValue } from '@sqlite.org/sqlite-wasm'

export type SqliteWorkerBindValue = SqlValue
export type SqliteWorkerRow = Record<string, SqlValue>

export interface SqliteWorkerOpenOptions {
    did?:string
    filename?:string
    directory?:string
    inMemory?:boolean
}

export interface SqliteWorkerProbeOptions {
    directory?:string
}

export interface SqliteWorkerProbeRequest extends SqliteWorkerProbeOptions {
    id:number
    type:'probe'
}

export interface SqliteWorkerOpenRequest extends SqliteWorkerOpenOptions {
    id:number
    type:'open'
}

export interface SqliteWorkerExecRequest {
    id:number
    type:'exec'
    sql:string
    bind?:SqliteWorkerBindValue[]
}

export interface SqliteWorkerQueryRequest {
    id:number
    type:'query'
    sql:string
    bind?:SqliteWorkerBindValue[]
}

export interface SqliteWorkerCloseRequest {
    id:number
    type:'close'
}

export type SqliteWorkerRequest =
    SqliteWorkerProbeRequest |
    SqliteWorkerOpenRequest |
    SqliteWorkerExecRequest |
    SqliteWorkerQueryRequest |
    SqliteWorkerCloseRequest

export type SqliteWorkerRequestBody =
    Omit<SqliteWorkerProbeRequest, 'id'> |
    Omit<SqliteWorkerOpenRequest, 'id'> |
    Omit<SqliteWorkerExecRequest, 'id'> |
    Omit<SqliteWorkerQueryRequest, 'id'> |
    Omit<SqliteWorkerCloseRequest, 'id'>

export interface SqliteWorkerSerializedError {
    name:string
    message:string
    stack?:string
}

export type SqliteWorkerResponse =
    { id:number; ok:true; result?:unknown } |
    { id:number; ok:false; error:SqliteWorkerSerializedError }
