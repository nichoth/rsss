import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

interface FeedRow {
    id:number
    url:string
    title:string|null
    description:string|null
    site_url:string|null
    last_fetched:string|null
    created_at:string
    updated_at:string
}

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

interface AlarmStorage {
    get:<T>(key:string) => Promise<T | undefined>
    put:(key:string, value:unknown) => Promise<void>
    delete:(key:string) => Promise<void>
    setAlarm:(time:number) => Promise<void>
}

function result (rows:unknown[]):QueryResult {
    return {
        toArray () {
            return rows
        },
        one () {
            return rows[0] || null
        }
    }
}

function createFeed (id:number, url = `https://example.com/${id}.xml`) {
    return {
        id,
        url,
        title: null,
        description: null,
        site_url: null,
        last_fetched: null,
        created_at: '2026-04-26 00:00:00',
        updated_at: '2026-04-26 00:00:00'
    }
}

function nextTask ():Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function deferred () {
    let release = () => {}
    const promise = new Promise<void>((resolve) => {
        release = resolve
    })

    return { promise, resolve: release }
}

function createAlarmDo (
    feeds:FeedRow[],
    fetchFeed:(feed:FeedRow) => Promise<void>,
    setAlarm = async (_time:number) => {},
    storage:Partial<AlarmStorage> = {}
) {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        ctx:{ storage:AlarmStorage }
        fetchFeed:(feed:FeedRow) => Promise<void>
        alarm:() => Promise<void>
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('SELECT * FROM feeds')) {
                const hasCursor = query.includes('WHERE id > ?')
                const cursor = hasCursor ? Number(params[0]) : 0
                const parsedLimit = Number(params[params.length - 1])
                const limit = Number.isFinite(parsedLimit)
                    ? parsedLimit
                    : feeds.length
                const batch = feeds
                    .filter(feed => feed.id > cursor)
                    .slice(0, limit)

                return result(batch)
            }

            // sweepStuckResolvingFeeds (added in 018) runs an UPDATE
            // against still-resolving feeds and then a SELECT for the
            // just-marked rows. The alarm harness only models the
            // happy-path refresh queue, so both are no-ops here.
            if (query.includes('UPDATE feeds SET')) {
                return result([])
            }
            if (query.includes('SELECT id FROM feeds') &&
                query.includes('last_status = 504')) {
                return result([])
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }
    userDo.ctx = {
        storage: {
            get: storage.get || (async () => undefined),
            put: storage.put || (async () => {}),
            delete: storage.delete || (async () => {}),
            setAlarm: storage.setAlarm || setAlarm
        }
    }
    userDo.fetchFeed = fetchFeed

    return userDo
}

function createResumeAlarmDo (
    feeds:FeedRow[],
    fetchFeed:(feed:FeedRow) => Promise<void>,
    storage:AlarmStorage,
    failOnQuery:number
) {
    let queryCount = 0
    const userDo = createAlarmDo(feeds, fetchFeed, storage.setAlarm, storage)

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            // sweepStuckResolvingFeeds (018) probes/updates rows
            // outside this test's queue model; no-op for both.
            if (query.includes('UPDATE feeds SET')) {
                return result([])
            }
            if (query.includes('SELECT id FROM feeds') &&
                query.includes('last_status = 504')) {
                return result([])
            }
            if (!query.includes('SELECT * FROM feeds')) {
                throw new Error(`Unexpected SQL: ${query}`)
            }

            queryCount++
            if (queryCount === failOnQuery) {
                throw new Error('CPU budget exhausted')
            }

            const hasCursor = query.includes('WHERE id > ?')
            const cursor = hasCursor ? Number(params[0]) : 0
            const parsedLimit = Number(params[params.length - 1])
            const limit = Number.isFinite(parsedLimit)
                ? parsedLimit
                : feeds.length
            const batch = feeds
                .filter(feed => feed.id > cursor)
                .slice(0, limit)

            return result(batch)
        }
    }

    return userDo
}

test('alarm refreshes feeds with concurrency limited to 8', async t => {
    const feeds = Array.from({ length: 20 }, (_value, index) => {
        return createFeed(index + 1)
    })
    let active = 0
    let maxActive = 0
    const userDo = createAlarmDo(feeds, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await nextTask()
        active--
    })

    await userDo.alarm()

    t.equal(maxActive, 8, 'at most 8 feed fetches run at once')
})

test('alarm waits for the rescheduled alarm to persist', async t => {
    const releaseAlarm = deferred()
    let alarmSettled = false
    const userDo = createAlarmDo(
        [createFeed(1)],
        async () => {},
        async () => releaseAlarm.promise
    )

    const alarmPromise = userDo.alarm().then(() => {
        alarmSettled = true
    })

    await nextTask()

    t.equal(
        alarmSettled,
        false,
        'alarm promise remains pending until setAlarm resolves'
    )

    releaseAlarm.resolve()
    await alarmPromise

    t.equal(alarmSettled, true, 'alarm resolves after setAlarm resolves')
})

test('alarm resumes refresh after a mid-run kill', async t => {
    const feeds = Array.from({ length: 10 }, (_value, index) => {
        return createFeed(index + 1)
    })
    const stored = new Map<string, unknown>()
    const alarmTimes:number[] = []
    const fetched:number[] = []
    const storage:AlarmStorage = {
        async get <T> (key:string) {
            return stored.get(key) as T | undefined
        },
        async put (key:string, value:unknown) {
            stored.set(key, value)
        },
        async delete (key:string) {
            stored.delete(key)
        },
        async setAlarm (time:number) {
            alarmTimes.push(time)
        }
    }
    const firstRun = createResumeAlarmDo(
        feeds,
        async (feed) => {
            fetched.push(feed.id)
        },
        storage,
        2
    )

    let killed = false
    try {
        await firstRun.alarm()
    } catch {
        killed = true
    }

    t.equal(killed, true, 'first alarm stops mid-refresh')
    t.deepEqual(
        fetched,
        [1, 2, 3, 4, 5, 6, 7, 8],
        'first alarm completes the first refresh batch'
    )
    t.equal(alarmTimes.length, 1, 'next alarm is scheduled before kill')

    const secondRun = createResumeAlarmDo(
        feeds,
        async (feed) => {
            fetched.push(feed.id)
        },
        storage,
        0
    )

    await secondRun.alarm()

    t.deepEqual(
        fetched,
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        'second alarm resumes with the remaining feeds'
    )
    t.equal(alarmTimes.length, 2, 'the resumed run schedules another alarm')
    t.equal(stored.size, 0, 'completed refresh clears the resume cursor')
})

test('fetchFeed stores last_error and last_status on failure', async t => {
    let failureUpdate:null | {
        error:unknown
        status:unknown
        id:unknown
    } = null
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        fetchFeed:(feed:FeedRow) => Promise<void>
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('last_error') &&
                query.includes('last_status')) {
                failureUpdate = {
                    error: params[0],
                    status: params[1],
                    id: params[2]
                }
                return result([])
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    const consoleError = console.error
    console.error = () => {}
    try {
        await userDo.fetchFeed(createFeed(7, 'http://localhost/feed.xml'))
    } finally {
        console.error = consoleError
    }

    t.deepEqual(
        failureUpdate,
        {
            error: 'Feed URL host is not allowed',
            status: 400,
            id: 7
        },
        'feed failure metadata is stored on the feed row'
    )
})

test(
    'sweep filters out feeds whose nextDueAt is in the future',
    async t => {
        const feeds = [createFeed(1), createFeed(2), createFeed(3)]
        const fetched:number[] = []
        const stored = new Map<string, unknown>()
        const future = Date.now() + 10 * 60 * 1000
        // Feed 2 has a future nextDueAt; feed 1 is overdue;
        // feed 3 has no record (treated as due).
        stored.set('poll:feed:1', {
            consecutiveFailures: 0,
            nextDueAt: 0
        })
        stored.set('poll:feed:2', {
            consecutiveFailures: 0,
            nextDueAt: future
        })

        const userDo = createAlarmDo(
            feeds,
            async (feed) => {
                fetched.push(feed.id)
            },
            async () => {},
            {
                async get<T> (key:string) {
                    return stored.get(key) as T|undefined
                },
                async put (key:string, value:unknown) {
                    stored.set(key, value)
                },
                async delete (key:string) {
                    stored.delete(key)
                }
            }
        )

        await userDo.alarm()

        t.deepEqual(
            fetched.sort(),
            [1, 3],
            'only overdue feeds (1, 3) are polled; feed 2 is skipped'
        )
    }
)

test(
    'sweep skips feeds claimed by an in-flight manual refresh',
    async t => {
        const feeds = [createFeed(1), createFeed(2)]
        const fetched:number[] = []
        const stored = new Map<string, unknown>()
        const userDo = createAlarmDo(
            feeds,
            async (feed) => {
                fetched.push(feed.id)
            },
            async () => {},
            {
                async get<T> (key:string) {
                    return stored.get(key) as T|undefined
                },
                async put (key:string, value:unknown) {
                    stored.set(key, value)
                },
                async delete (key:string) {
                    stored.delete(key)
                }
            }
        )
        // Seed an active manual refresh claim for feed 1.
        ;(userDo as unknown as {
            manualRefreshClaims:Map<number, number>
        }).manualRefreshClaims = new Map([[1, Date.now()]])

        await userDo.alarm()

        t.deepEqual(
            fetched,
            [2],
            'feed 1 is skipped this sweep; manual refresh wins'
        )
    }
)

test(
    'alarm short-circuits when account is inactive past threshold',
    async t => {
        const feeds = [createFeed(1), createFeed(2), createFeed(3)]
        const fetched:number[] = []
        const stored = new Map<string, unknown>()
        const alarmTimes:number[] = []
        // Seed last_active_at to 31 days ago.
        const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
        stored.set('poll:account:last_active_at', {
            lastActiveAt: thirtyOneDaysAgo
        })

        const userDo = createAlarmDo(
            feeds,
            async (feed) => {
                fetched.push(feed.id)
            },
            async (time) => {
                alarmTimes.push(time)
            },
            {
                async get<T> (key:string) {
                    return stored.get(key) as T|undefined
                },
                async put (key:string, value:unknown) {
                    stored.set(key, value)
                },
                async delete (key:string) {
                    stored.delete(key)
                }
            }
        )

        await userDo.alarm()

        t.equal(
            fetched.length,
            0,
            'inactive account: zero feed fetches during alarm tick (SC-005)'
        )
        t.equal(
            alarmTimes.length,
            1,
            'alarm re-arms normally for the next cadence'
        )
    }
)

test(
    'alarm resumes polling once last_active_at advances to now',
    async t => {
        const feeds = [createFeed(1), createFeed(2)]
        const fetched:number[] = []
        const stored = new Map<string, unknown>()
        // Active recently — alarm should poll normally.
        stored.set('poll:account:last_active_at', {
            lastActiveAt: Date.now() - 5_000
        })

        const userDo = createAlarmDo(
            feeds,
            async (feed) => {
                fetched.push(feed.id)
            },
            async () => {},
            {
                async get<T> (key:string) {
                    return stored.get(key) as T|undefined
                },
                async put (key:string, value:unknown) {
                    stored.set(key, value)
                },
                async delete (key:string) {
                    stored.delete(key)
                }
            }
        )

        await userDo.alarm()

        t.deepEqual(
            fetched.sort(),
            [1, 2],
            'recently-active account: alarm polls feeds normally'
        )
    }
)

test('alarm tests done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
