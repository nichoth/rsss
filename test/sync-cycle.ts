import { test } from '@substrate-system/tapzero'
import { effect } from '@preact/signals'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { runSync } from '../src/client/db/sync.js'
import {
    PullSyncAuthError,
    SyncBillingError
} from '../src/client/db/pull-sync.js'
import {
    isLocalFirstActive,
    syncDeadLetters,
    syncError,
    syncedAt,
    syncPending,
    syncStatus
} from '../src/client/db/sync-status.js'

setTestMode(true, wasmUrl as string)

interface SyncErrorWatch {
    count:() => number
    stop:() => void
}

function resetTrackedSyncStatus ():void {
    isLocalFirstActive.value = true
    syncStatus.value = 'idle'
    syncedAt.value = null
    syncPending.value = 0
    syncDeadLetters.value = 0
    syncError.value = null
}

function watchSyncErrorWrites ():SyncErrorWatch {
    let writes = 0
    const stop = effect(() => {
        if (syncError.value !== null) writes++
    })

    return {
        count: () => writes,
        stop
    }
}

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

test('runSync pulls new items after draining mark-all-read',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-mark-all-read')
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
                    VALUES (10, 1, 'guid-10', 'Old local item',
                        'https://example.com/item-10', 1, 0,
                        '2026-01-01 00:00:00',
                        '2026-01-03 00:00:00')`
            })
            db.exec({
                sql: `UPDATE sync_meta
                      SET last_pull_at = '2026-01-02 00:00:00'
                      WHERE id = 1`
            })
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at)
                    VALUES ('mark_all_read', 1, ?, 'op-mark-all',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({ feedId: 1 })]
            })

            await runSync(db, async (_url, init) => {
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
                        items: [{
                            id: 11,
                            feed_id: 1,
                            guid: 'guid-11',
                            title: 'New server item',
                            link: 'https://example.com/item-11',
                            description: null,
                            content: null,
                            author: null,
                            pub_date: null,
                            is_read: 0,
                            is_starred: 0,
                            created_at: '2026-01-04 00:00:00',
                            updated_at: '2026-01-04 00:00:00'
                        }],
                        syncedAt: '2026-01-04 00:00:00',
                        latestUpdatedAt: '2026-01-04 00:00:00',
                        isFullSync: false
                    })
                } as Response
            })

            const rows:{ title:string; is_read:number }[] = []
            db.exec({
                sql: `SELECT title, is_read
                      FROM items
                      ORDER BY id ASC`,
                rowMode: 'object',
                resultRows: rows
            })

            t.equal(
                JSON.stringify(calls),
                JSON.stringify(['push', 'pull']),
                'mark-all-read drains before pull reads pending refs'
            )
            t.equal(rows.length, 2, 'new server item is visible locally')
            t.equal(rows[1]?.title, 'New server item', 'pulled item stored')
            t.equal(rows[1]?.is_read, 0, 'new server item remains unread')
        } finally {
            db.close()
        }
    }
)

test('runSync coalesces concurrent callers before transactional push',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-concurrent')
        let pushCalls = 0
        let pullCalls = 0
        let releaseFirstPush:() => void = () => {}
        let firstPushStarted:() => void = () => {}
        const firstPush = new Promise<void>((resolve) => {
            firstPushStarted = resolve
        })
        const releasePush = new Promise<void>((resolve) => {
            releaseFirstPush = resolve
        })

        try {
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at)
                    VALUES ('add_feed', NULL, ?, 'op-concurrent',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({
                    url: 'https://example.com/feed'
                })]
            })

            const fetchFn:typeof fetch = async (_url, init) => {
                if (init?.method) {
                    pushCalls += 1
                    if (pushCalls === 1) {
                        firstPushStarted()
                        await releasePush
                    }
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            feed: {
                                id: 1,
                                url: 'https://example.com/feed',
                                title: 'Feed',
                                description: null,
                                site_url: null,
                                last_fetched: null,
                                created_at: '2026-01-01 00:00:00',
                                updated_at: '2026-01-03 00:00:00'
                            }
                        })
                    } as Response
                }

                pullCalls += 1
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
            }

            const first = runSync(db, fetchFn)
            const second = runSync(db, fetchFn)

            await firstPush
            await new Promise(resolve => setTimeout(resolve, 0))
            releaseFirstPush()

            const results = await Promise.allSettled([first, second])
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => String(result.reason))

            t.equal(errors.length, 0, 'concurrent callers do not reject')
            t.equal(
                errors.some((msg) => (
                    msg.includes('cannot start a transaction')
                )),
                false,
                'concurrent callers do not overlap SQLite transactions'
            )

            t.equal(pushCalls, 1, 'only one push request is sent')
            t.equal(pullCalls, 1, 'only one pull request is sent')
        } finally {
            db.close()
        }
    }
)

test('runSync surfaces pull network errors through one sync error update',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-pull-network')

        resetTrackedSyncStatus()
        const errorWrites = watchSyncErrorWrites()

        try {
            try {
                await runSync(db, async () => {
                    throw new Error('network unavailable')
                })
                t.fail('runSync rejects when pull network fetch fails')
            } catch (err) {
                t.ok(err instanceof Error, 'pull network failure rejects')
            }

            t.equal(syncStatus.value, 'error', 'sync status is error')
            t.equal(
                syncError.value,
                'network unavailable',
                'pull network failure reaches the UI error signal'
            )
            t.equal(errorWrites.count(), 1, 'sets one UI error')
        } finally {
            errorWrites.stop()
            isLocalFirstActive.value = false
            db.close()
        }
    }
)

test('runSync surfaces push non-auth errors through one sync error update',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-push-error')

        resetTrackedSyncStatus()
        const errorWrites = watchSyncErrorWrites()

        try {
            db.exec({
                sql: `INSERT INTO outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at)
                    VALUES ('add_feed', NULL, '{', 'op-bad-payload',
                        '2026-01-03 00:00:00')`
            })

            try {
                await runSync(db, async () => {
                    t.fail('invalid push payload fails before fetch')
                    return new Response(JSON.stringify({}))
                })
                t.fail('runSync rejects when pushSync throws')
            } catch (err) {
                t.ok(err instanceof SyntaxError, 'push failure rejects')
            }

            t.equal(syncStatus.value, 'error', 'sync status is error')
            t.ok(
                syncError.value?.includes('JSON'),
                'push failure reaches the UI error signal'
            )
            t.equal(errorWrites.count(), 1, 'sets one UI error')
        } finally {
            errorWrites.stop()
            isLocalFirstActive.value = false
            db.close()
        }
    }
)

test('runSync lets auth and billing errors escape without UI error',
    async (t) => {
        const authDb = await openLocalDb('did:test:sync-cycle-auth-error')
        const billingDb = await openLocalDb(
            'did:test:sync-cycle-billing-error'
        )

        resetTrackedSyncStatus()
        const errorWrites = watchSyncErrorWrites()

        try {
            try {
                await runSync(authDb, async () => new Response(null, {
                    status: 401
                }))
                t.fail('runSync rejects on auth failure')
            } catch (err) {
                t.ok(
                    err instanceof PullSyncAuthError,
                    'auth failure keeps its typed error'
                )
            }

            t.equal(syncError.value, null, 'auth failure sets no UI error')
            t.equal(errorWrites.count(), 0, 'auth failure is not surfaced')

            resetTrackedSyncStatus()

            try {
                await runSync(billingDb, async () => new Response(null, {
                    status: 402
                }))
                t.fail('runSync rejects on billing failure')
            } catch (err) {
                t.ok(
                    err instanceof SyncBillingError,
                    'billing failure keeps its typed error'
                )
            }

            t.equal(
                syncError.value,
                null,
                'billing failure sets no UI error'
            )
            t.equal(
                errorWrites.count(),
                0,
                'billing failure is not surfaced'
            )
        } finally {
            errorWrites.stop()
            isLocalFirstActive.value = false
            authDb.close()
            billingDb.close()
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

test('runSync includes dead-letter count in final sync status',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-dead-letters')

        isLocalFirstActive.value = true
        syncStatus.value = 'idle'
        syncedAt.value = null
        syncPending.value = 0
        syncDeadLetters.value = 0
        syncError.value = null

        try {
            db.exec({
                sql: `INSERT INTO dead_letter_outbox
                    (op, target_id, payload, client_op_id,
                     client_updated_at, attempts, last_error)
                    VALUES ('add_feed', NULL, ?, 'op-cycle-dead',
                        '2026-01-01 00:00:00', 10, 'HTTP 400')`,
                bind: [JSON.stringify({ url: 'https://example.com/dead' })]
            })

            await runSync(db, async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    feeds: [],
                    items: [],
                    syncedAt: '2026-01-04 00:00:00',
                    latestUpdatedAt: '2026-01-04 00:00:00',
                    isFullSync: false
                })
            } as Response))

            t.equal(syncStatus.value, 'warning', 'status shows warning')
            t.equal(syncDeadLetters.value, 1, 'dead-letter count is kept')
            t.equal(syncPending.value, 0, 'pending count is still zero')
            t.ok(syncedAt.value, 'syncedAt updates at the end')
        } finally {
            isLocalFirstActive.value = false
            db.close()
        }
    }
)

test('runSync refreshes pending count after push when pull fails',
    async (t) => {
        const db = await openLocalDb('did:test:sync-cycle-pull-error')

        isLocalFirstActive.value = true
        syncStatus.value = 'idle'
        syncedAt.value = null
        syncPending.value = 0
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
                    VALUES ('update_item', 10, ?, 'op-pending-error',
                        '2026-01-03 00:00:00')`,
                bind: [JSON.stringify({ id: 10, is_read: true })]
            })

            try {
                await runSync(db, async (_url, init) => {
                    if (init?.method) {
                        return {
                            ok: false,
                            status: 500,
                            json: async () => ({})
                        } as Response
                    }

                    return {
                        ok: false,
                        status: 500,
                        json: async () => ({})
                    } as Response
                })
                t.fail('runSync rejects when pull fails')
            } catch (err) {
                t.ok(err instanceof Error, 'pull failure rejects')
            }

            t.equal(syncStatus.value, 'error', 'sync status is error')
            t.equal(
                syncPending.value,
                1,
                'pending count reflects the failed push attempt'
            )
        } finally {
            isLocalFirstActive.value = false
            db.close()
        }
    }
)
