import {
    SQLiteWorkerClient
} from './sqlite-worker-client.js'

export function createSQLiteWorkerClient ():SQLiteWorkerClient {
    return new SQLiteWorkerClient(new Worker(
        new URL('./sqlite-worker.ts', import.meta.url),
        { type: 'module', name: 'rsss-sqlite-worker' }
    ))
}
