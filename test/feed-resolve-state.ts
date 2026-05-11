import { test } from '@substrate-system/tapzero'
import { signal } from '@preact/signals'
// @ts-expect-error -- no type declarations for .wasm imports
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm'
import type { SqlValue } from '@sqlite.org/sqlite-wasm'
import {
    openLocalDb,
    setTestMode
} from '../src/client/db/sqlite-init.js'
import { upsertFeedFromServer } from '../src/client/db/push-sync.js'
import {
    UserDO,
    RESOLVE_TIMEOUT_ERROR,
    RESOLVE_WINDOW_MS
} from '../src/server/durable-objects/index.js'
import {
    _resolveConvergenceForTest,
    CLIENT_GRACE_MS
} from '../src/client/state.js'
import type { Feed } from '../src/client/db/types.js'

setTestMode(true, wasmUrl as string)

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
    rowsWritten?:number
}

interface SqlExecCall {
    query:string
    params:unknown[]
}

interface FetchFeedDoType {
    sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
    broadcasts:Array<{ event:string; data:unknown }>
    ctx:{
        storage:{
            get:<T>(key:string) => Promise<T|undefined>
            put:(key:string, value:unknown) => Promise<void>
            delete:(key:string) => Promise<void>
        }
    }
    getFeedsWithUpdates:() => string[]
    getFeedUpdateCounts:() => Record<string, number>
    broadcast:(event:string, data:unknown) => void
    parseFeed:(text:string) => {
        title:string|null
        description:string|null
        link:string|null
        isTooLarge?:boolean
        items:unknown[]
    }
    doFetchFeedText:(
        url:string,
        validators?:{ etag?:string; lastModified?:string }
    ) => Promise<{
        text:string
        url:string
        notModified:boolean
        etag?:string
        lastModified?:string
    }>
    updateNewItemThumbnails:(items:unknown[]) => Promise<void>
    rowsWritten:(result:unknown) => number
    fetchFeed:(feed:{ id:number; url:string }) => Promise<void>
}

function createFetchHarness (opts:{
    notModified?:boolean
    parsedFeed?:{
        title:string|null
        description:string|null
        link:string|null
    }
}) {
    const sqlCalls:SqlExecCall[] = []
    const broadcasts:Array<{ event:string; data:unknown }> = []
    const harnessStorage = new Map<string, unknown>()

    const userDo = Object.create(UserDO.prototype) as FetchFeedDoType
    userDo.broadcasts = broadcasts

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            sqlCalls.push({ query, params })
            if (query.includes('SELECT id FROM items')) {
                return {
                    toArray: () => [],
                    one: () => null
                }
            }
            return {
                toArray: () => [],
                one: () => null,
                rowsWritten: 0
            }
        }
    }

    userDo.ctx = {
        storage: {
            async get<T> (key:string) {
                return harnessStorage.get(key) as T|undefined
            },
            async put (key:string, value:unknown) {
                harnessStorage.set(key, value)
            },
            async delete (key:string) {
                harnessStorage.delete(key)
            }
        }
    }

    userDo.broadcast = (event, data) => {
        broadcasts.push({ event, data })
    }
    userDo.getFeedsWithUpdates = () => []
    userDo.getFeedUpdateCounts = () => ({})
    userDo.updateNewItemThumbnails = async () => {}
    userDo.rowsWritten = () => 0

    userDo.doFetchFeedText = async (url) => {
        if (opts.notModified) {
            return {
                text: '',
                url,
                notModified: true
            }
        }
        return {
            text: '<rss/>',
            url,
            notModified: false
        }
    }

    userDo.parseFeed = () => ({
        title: opts.parsedFeed?.title ?? null,
        description: opts.parsedFeed?.description ?? null,
        link: opts.parsedFeed?.link ?? null,
        items: []
    })

    return { userDo, sqlCalls, broadcasts }
}

function findFeedTerminalUpdate (
    sqlCalls:SqlExecCall[]
):SqlExecCall|undefined {
    return sqlCalls.find((c) =>
        c.query.includes('UPDATE feeds') &&
        c.query.includes('last_fetched') &&
        c.query.includes('last_error') &&
        c.query.includes('last_status')
    )
}

test(
    'fetchFeed parsed-but-no-metadata path UPDATEs last_fetched and clears ' +
    'last_error/last_status (FR-004, research Decision 7)',
    async (t) => {
        const { userDo, sqlCalls } = createFetchHarness({
            parsedFeed: { title: null, description: null, link: null }
        })

        await userDo.fetchFeed({
            id: 42,
            url: 'https://example.com/feed'
        })

        const update = findFeedTerminalUpdate(sqlCalls)
        t.ok(
            update,
            'fetchFeed runs the terminal-state UPDATE even when ' +
            'title/description/link are all null'
        )
        t.ok(
            update!.query.includes('last_error = NULL'),
            'last_error is cleared'
        )
        t.ok(
            update!.query.includes('last_status = NULL'),
            'last_status is cleared'
        )
    }
)

test(
    'fetchFeed 304 Not Modified branch UPDATEs last_fetched and clears ' +
    'last_error/last_status on first fetch (FR-005, research Decision 6)',
    async (t) => {
        const { userDo, sqlCalls } = createFetchHarness({
            notModified: true
        })

        await userDo.fetchFeed({
            id: 7,
            url: 'https://example.com/feed'
        })

        const update = findFeedTerminalUpdate(sqlCalls)
        t.ok(
            update,
            '304 branch issues the terminal-state UPDATE so the row reaches ' +
            'RESOLVED instead of staying perpetually resolving'
        )
        t.ok(
            update!.query.includes('last_fetched = datetime'),
            'last_fetched is set to the current time'
        )
        t.equal(
            update!.params[update!.params.length - 1],
            7,
            'UPDATE targets the correct feed id'
        )
    }
)

test(
    'sweepStuckResolvingFeeds marks rows older than RESOLVE_WINDOW_MS as ' +
    'failed with last_status = 504 and broadcasts feed-updated ' +
    '(FR-001, FR-003, research Decision 3)',
    (t) => {
        const sqlCalls:SqlExecCall[] = []
        const broadcasts:Array<{ event:string; data:unknown }> = []

        const userDo = Object.create(UserDO.prototype) as {
            sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
            broadcast:(event:string, data:unknown) => void
            sweepStuckResolvingFeeds:() => void
        }

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                sqlCalls.push({ query, params })
                if (
                    query.includes('SELECT id FROM feeds') &&
                    query.includes('last_status = 504')
                ) {
                    return {
                        toArray: () => [{ id: 11 }, { id: 12 }],
                        one: () => null
                    }
                }
                return { toArray: () => [], one: () => null }
            }
        }
        userDo.broadcast = (event, data) => {
            broadcasts.push({ event, data })
        }

        userDo.sweepStuckResolvingFeeds()

        const updateCall = sqlCalls.find((c) =>
            c.query.includes('UPDATE feeds') &&
            c.query.includes('last_status = 504')
        )
        t.ok(updateCall, 'sweep issues the UPDATE')
        t.equal(
            updateCall!.params[0],
            RESOLVE_TIMEOUT_ERROR,
            'first bind is the timeout-error sentinel'
        )
        const cutoffSeconds = Math.ceil(RESOLVE_WINDOW_MS / 1000)
        t.equal(
            updateCall!.params[1],
            `-${cutoffSeconds} seconds`,
            'second bind is the negative-window modifier matching ' +
            'RESOLVE_WINDOW_MS'
        )

        t.equal(
            broadcasts.length,
            2,
            'broadcasts feed-updated for each row swept'
        )
        t.deepEqual(
            broadcasts.map((b) => b.event),
            ['feed-updated', 'feed-updated'],
            'every broadcast is a feed-updated event'
        )
        t.deepEqual(
            broadcasts.map((b) => (b.data as { feedId:number }).feedId),
            [11, 12],
            'broadcasts carry the swept feed ids'
        )
    }
)

test(
    'POST /feeds/:id/refresh returns the post-fetch row instead of ' +
    '{ success: true } (contracts/refresh-response.md, FR-007)',
    async (t) => {
        const sqlCalls:SqlExecCall[] = []
        const harnessStorage = new Map<string, unknown>()
        const feedRow = {
            id: 5,
            url: 'https://example.com/feed',
            title: 'Example',
            description: null,
            site_url: null,
            last_fetched: '2026-05-10 12:00:00',
            last_pulled_at: null,
            last_error: null,
            last_status: null,
            created_at: '2026-05-10 11:59:00',
            updated_at: '2026-05-10 12:00:00'
        }

        const userDo = Object.create(UserDO.prototype) as {
            sql:{ exec:(q:string, ...p:unknown[]) => QueryResult }
            ctx:{
                storage:{
                    get:<T>(key:string) => Promise<T|undefined>
                    put:(key:string, value:unknown) => Promise<void>
                    delete:(key:string) => Promise<void>
                }
                waitUntil:(p:Promise<unknown>) => void
            }
            fetchFeed:(feed:unknown) => Promise<void>
            advanceFeedCursor:(id:number) => void
            claimManualFeedRefresh:(
                id:number
            ) => Promise<null | { retryAfterSeconds:number }>
            createRouter:() => {
                request:(path:string, init?:RequestInit) => Promise<Response>
            }
        }

        userDo.sql = {
            exec (query:string, ...params:unknown[]) {
                sqlCalls.push({ query, params })
                if (
                    query.includes('SELECT * FROM feeds WHERE id = ?')
                ) {
                    return {
                        toArray: () => [feedRow],
                        one: () => feedRow
                    }
                }
                if (
                    query.includes('SELECT') &&
                    query.includes('FROM feeds WHERE id = ?')
                ) {
                    // FEED_SYNC_COLUMNS projection
                    return {
                        toArray: () => [feedRow],
                        one: () => feedRow
                    }
                }
                return { toArray: () => [], one: () => null }
            }
        }
        userDo.ctx = {
            storage: {
                async get<T> (key:string) {
                    return harnessStorage.get(key) as T|undefined
                },
                async put (key:string, value:unknown) {
                    harnessStorage.set(key, value)
                },
                async delete (key:string) {
                    harnessStorage.delete(key)
                }
            },
            waitUntil () {}
        }
        userDo.fetchFeed = async () => {}
        userDo.advanceFeedCursor = () => {}
        userDo.claimManualFeedRefresh = async () => null

        const app = userDo.createRouter()
        const res = await app.request(
            '/feeds/5/refresh',
            { method: 'POST' }
        )
        t.equal(res.status, 200, 'refresh returns 200')
        const body = await res.json() as { feed?:Record<string, unknown> }
        t.ok(body.feed, 'response body wraps the row under .feed')
        t.equal(
            (body.feed as { id:number }).id,
            5,
            'response carries the right row'
        )
        t.equal(
            (body.feed as { last_fetched:string }).last_fetched,
            '2026-05-10 12:00:00',
            'last_fetched reflects post-fetch state'
        )
    }
)

test(
    'upsertFeedFromServer persists last_error and last_status into the ' +
    'local DB (research Decision 9 item 4)',
    async (t) => {
        const db = await openLocalDb('did:test:feed-resolve-upsert')
        try {
            await upsertFeedFromServer(db, {
                id: 99,
                url: 'https://example.com/feed-99',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: 'HTTP 404',
                last_status: 404,
                created_at: '2026-05-10 12:00:00',
                updated_at: '2026-05-10 12:00:01'
            })

            const rows:Array<Record<string, SqlValue>> = []
            db.exec({
                sql: `SELECT last_error, last_status
                      FROM feeds WHERE id = ?`,
                bind: [99],
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(rows.length, 1, 'row exists')
            t.equal(
                rows[0].last_error,
                'HTTP 404',
                'last_error round-trips through upsertFeedFromServer'
            )
            t.equal(
                rows[0].last_status,
                404,
                'last_status round-trips through upsertFeedFromServer'
            )
        } finally {
            (db as unknown as { close:() => void }).close()
        }
    }
)

function makeFakeStateWithFeed (feed:Partial<Feed> & { id:number; url:string }) {
    return {
        feeds: signal<Feed[]>([feed as Feed]),
        user: signal<{ did:string }|null>(null)
    } as unknown as Parameters<
        typeof _resolveConvergenceForTest.schedule
    >[0]
}

test(
    'addFeed schedules a one-shot convergence timer for a row that is ' +
    'still resolving, and skips when the row is already terminal (FR-006)',
    async (t) => {
        const realSetTimeout = globalThis.setTimeout
        const realClearTimeout = globalThis.clearTimeout
        const scheduled:Array<{
            delay:number
            cb:() => void
            id:number
        }> = []
        let nextTimerId = 1

        globalThis.setTimeout = ((cb:() => void, delay:number) => {
            const id = nextTimerId++
            scheduled.push({ delay, cb, id })
            return id as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout

        globalThis.clearTimeout = ((id:number) => {
            const idx = scheduled.findIndex((s) => s.id === id)
            if (idx >= 0) scheduled.splice(idx, 1)
        }) as typeof clearTimeout

        try {
            _resolveConvergenceForTest.clearAll()

            // Case 1: row is still resolving -- timer scheduled.
            const resolvingState = makeFakeStateWithFeed({
                id: 51,
                url: 'https://example.com/resolving',
                last_fetched: null,
                last_error: null
            })
            _resolveConvergenceForTest.schedule(
                resolvingState,
                'https://example.com/resolving'
            )
            t.equal(
                scheduled.length,
                1,
                'one-shot timer scheduled for resolving row'
            )
            t.equal(
                scheduled[0].delay,
                RESOLVE_WINDOW_MS + CLIENT_GRACE_MS,
                'timer delay is RESOLVE_WINDOW_MS + CLIENT_GRACE_MS'
            )
            t.equal(
                _resolveConvergenceForTest.pendingTimerCount(),
                1,
                'helper tracks the pending timer'
            )

            // Case 2: row already resolved -- no timer scheduled.
            scheduled.length = 0
            const resolvedState = makeFakeStateWithFeed({
                id: 52,
                url: 'https://example.com/resolved',
                last_fetched: '2026-05-10 12:00:00',
                last_error: null
            })
            _resolveConvergenceForTest.schedule(
                resolvedState,
                'https://example.com/resolved'
            )
            t.equal(
                scheduled.length,
                0,
                'no timer scheduled for already-resolved row'
            )

            // Case 3: row failed -- no timer scheduled.
            scheduled.length = 0
            const failedState = makeFakeStateWithFeed({
                id: 53,
                url: 'https://example.com/failed',
                last_fetched: null,
                last_error: 'HTTP 404'
            })
            _resolveConvergenceForTest.schedule(
                failedState,
                'https://example.com/failed'
            )
            t.equal(
                scheduled.length,
                0,
                'no timer scheduled for failed row'
            )

            _resolveConvergenceForTest.clearAll()
        } finally {
            globalThis.setTimeout = realSetTimeout
            globalThis.clearTimeout = realClearTimeout
        }
    }
)

test(
    'upsertFeedFromServer overwrites stale last_error when server payload ' +
    'reports cleared state (terminal RESOLVED after retry)',
    async (t) => {
        const db = await openLocalDb('did:test:feed-resolve-clear')
        try {
            await upsertFeedFromServer(db, {
                id: 100,
                url: 'https://example.com/feed-100',
                title: null,
                description: null,
                site_url: null,
                last_fetched: null,
                last_error: 'HTTP 504',
                last_status: 504,
                created_at: '2026-05-10 12:00:00',
                updated_at: '2026-05-10 12:00:01'
            })
            await upsertFeedFromServer(db, {
                id: 100,
                url: 'https://example.com/feed-100',
                title: 'Recovered',
                description: null,
                site_url: null,
                last_fetched: '2026-05-10 12:00:30',
                last_error: null,
                last_status: null,
                created_at: '2026-05-10 12:00:00',
                updated_at: '2026-05-10 12:00:30'
            })

            const rows:Array<Record<string, SqlValue>> = []
            db.exec({
                sql: `SELECT last_fetched, last_error, last_status
                      FROM feeds WHERE id = ?`,
                bind: [100],
                rowMode: 'object',
                resultRows: rows
            })
            t.equal(
                rows[0].last_fetched,
                '2026-05-10 12:00:30',
                'last_fetched advances on second upsert'
            )
            t.equal(
                rows[0].last_error,
                null,
                'last_error cleared when server reports null'
            )
            t.equal(
                rows[0].last_status,
                null,
                'last_status cleared when server reports null'
            )
        } finally {
            (db as unknown as { close:() => void }).close()
        }
    }
)
