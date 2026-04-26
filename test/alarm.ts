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
    setAlarm = async (_time:number) => {}
) {
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        ctx:{ storage:{ setAlarm:(time:number) => Promise<void> } }
        fetchFeed:(feed:FeedRow) => Promise<void>
        alarm:() => Promise<void>
    }

    userDo.sql = {
        exec (query:string) {
            if (query.includes('SELECT * FROM feeds')) {
                return result(feeds)
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }
    userDo.ctx = { storage: { setAlarm } }
    userDo.fetchFeed = fetchFeed

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

test('alarm tests done', () => {
    if (window) {
        // @ts-expect-error tests
        window.testsFinished = true
    }
})
