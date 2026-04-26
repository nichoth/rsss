import { test } from '@substrate-system/tapzero'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { runSync } from '../src/client/db/sync.js'
import {
    isLocalFirstActive,
    syncDeadLetters,
    syncError,
    syncedAt,
    syncPending,
    syncStatus
} from '../src/client/db/sync-status.js'

setTestMode(true, wasmUrl as string)

test('runSync pushes pending writes before pulling server state',
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

            await runSync(db, async (url, init) => {
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

test('runSync marks sync done once after push and pull finish',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-status')
        const observedDuringPull:{
            status:string
            syncedAt:Date|null
            pending:number
        }[] = []

        isLocalFirstActive.value = true
        syncStatus.value = 'idle'
        syncedAt.value = null
        syncPending.value = 1
        syncDeadLetters.value = 0
        syncError.value = null

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
                    VALUES ('update_item', 10, ?, 'op-status',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({ id: 10, is_read: true })]
            })

            await runSync(db, async (_url, init) => {
                if (init?.method) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({})
                    } as Response
                }

                observedDuringPull.push({
                    status: syncStatus.value,
                    syncedAt: syncedAt.value,
                    pending: syncPending.value
                })

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
                observedDuringPull[0]?.status,
                'syncing',
                'status stays syncing during pull'
            )
            t.equal(
                observedDuringPull[0]?.syncedAt,
                null,
                'sync is not marked done between push and pull'
            )
            t.equal(
                observedDuringPull[0]?.pending,
                1,
                'pending count does not flicker to zero before pull'
            )
            t.equal(syncStatus.value, 'idle', 'status is idle after cycle')
            t.equal(syncPending.value, 0, 'pending count updates at the end')
            t.ok(syncedAt.value, 'syncedAt updates at the end')
        } finally {
            isLocalFirstActive.value = false
            db.close()
        }
    }
)
