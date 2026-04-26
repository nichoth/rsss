import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { runSyncCycle } from '../src/client/db/sync-cycle.js'

setTestMode(true, wasmUrl as string)

test('runSyncCycle pushes pending writes before pulling server state',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-order')
        const calls:string[] = []

        try {
            db.exec({
                sql: `INSERT INTO feeds
                    (id, url, title, created_at, updated_at)
                    VALUES (1, 'https://example.com/feed', 'Feed',
                        '2026-01-01 00:00:00',
                        '2026-01-01 00:00:00')`
            })
            db.exec({
                sql: `INSERT INTO items
                    (id, feed_id, guid, title, link, is_read, is_starred,
                     created_at, updated_at)
                    VALUES (10, 1, 'guid-10', 'Item',
                        'https://example.com/item-10', 1, 0,
                        '2026-01-01 00:00:00',
                        '2026-01-03 00:00:00')`
            })
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at)
                    VALUES ('update_item', 10, ?, 'op-cycle',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({ id: 10, is_read: true })]
            })

            await runSyncCycle(db, async (url, init) => {
                if (init?.method) {
                    calls.push('push')
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({})
                    } as Response
                }

                calls.push('pull')
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        feeds: [],
                        items: [],
                        syncedAt: '2026-01-04 00:00:00',
                        latestUpdatedAt: '2026-01-04 00:00:00',
                        isFullSync: false
                    })
                } as Response
            })

            t.equal(
                JSON.stringify(calls),
                JSON.stringify(['push', 'pull']),
                'push runs before pull'
            )
        } finally {
            db.close()
        }
    }
)
