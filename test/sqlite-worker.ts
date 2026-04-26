import { test } from '@substrate-system/tapzero'
import {
    SQLiteWorkerClient
} from '../src/client/db/sqlite-worker-client.js'
import type {
    SqliteWorkerRequest,
    SqliteWorkerResponse
} from '../src/client/db/sqlite-worker-protocol.js'

class MockWorker {
    onmessage:((event:MessageEvent<SqliteWorkerResponse>) => void)|null = null
    onerror:((event:ErrorEvent) => void)|null = null
    sent:SqliteWorkerRequest[] = []
    terminated = false

    postMessage (message:SqliteWorkerRequest):void {
        this.sent.push(message)
    }

    respond (response:SqliteWorkerResponse):void {
        const event = { data: response } as MessageEvent<SqliteWorkerResponse>
        this.onmessage?.(event)
    }

    fail (message:string):void {
        const event = { message } as ErrorEvent
        this.onerror?.(event)
    }

    terminate ():void {
        this.terminated = true
    }
}

test('SQLiteWorkerClient resolves successful worker responses', async (t) => {
    const worker = new MockWorker()
    const client = new SQLiteWorkerClient(worker)

    const probe = client.probe({ directory: 'rsss-db' })
    t.equal(worker.sent[0].type, 'probe', 'sends probe request')
    t.equal(worker.sent[0].id, 1, 'first request has id 1')
    worker.respond({ id: 1, ok: true })
    await probe

    const open = client.open({ did: 'did:plc:alice' })
    t.equal(worker.sent[1].type, 'open', 'sends open request')
    t.equal(worker.sent[1].id, 2, 'second request has id 2')
    worker.respond({ id: 2, ok: true })
    await open

    const exec = client.exec('PRAGMA foreign_keys = ON;')
    t.equal(worker.sent[2].type, 'exec', 'sends exec request')
    t.equal(worker.sent[2].id, 3, 'third request has id 3')
    worker.respond({ id: 3, ok: true })
    await exec

    const query = client.query<{ id:number }>(
        'SELECT id FROM feeds WHERE id = ?',
        [1]
    )
    t.equal(worker.sent[3].type, 'query', 'sends query request')
    worker.respond({
        id: 4,
        ok: true,
        result: [{ id: 1 }]
    })

    t.deepEqual(await query, [{ id: 1 }], 'returns query rows')

    const close = client.close()
    t.equal(worker.sent[4].type, 'close', 'sends close request')
    worker.respond({ id: 5, ok: true })
    await close
    t.equal(worker.terminated, true, 'terminates worker on close')
})

test('SQLiteWorkerClient rejects failed worker responses', async (t) => {
    const worker = new MockWorker()
    const client = new SQLiteWorkerClient(worker)
    const exec = client.exec('BAD SQL')

    worker.respond({
        id: 1,
        ok: false,
        error: {
            name: 'Error',
            message: 'near "BAD": syntax error'
        }
    })

    try {
        await exec
        t.fail('expected exec to reject')
    } catch (err) {
        t.ok(err instanceof Error, 'rejects with an Error')
        t.equal(
            (err as Error).message,
            'near "BAD": syntax error',
            'preserves worker error message'
        )
    }
})

test('SQLiteWorkerClient rejects pending work on worker errors', async (t) => {
    const worker = new MockWorker()
    const client = new SQLiteWorkerClient(worker)
    const query = client.query('SELECT 1')

    worker.fail('worker crashed')

    try {
        await query
        t.fail('expected query to reject')
    } catch (err) {
        t.ok(err instanceof Error, 'rejects with an Error')
        t.equal(
            (err as Error).message,
            'worker crashed',
            'uses the worker error message'
        )
    }
})
