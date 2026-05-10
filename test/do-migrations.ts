import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'
import {
    INDEXES_SQL,
    TABLES_SQL,
    USER_STATE_SQL
} from '../src/shared/schema.js'

interface QueryResult {
    toArray:() => unknown[]
    one:() => unknown | null
}

function result (rows:unknown[] = []):QueryResult {
    return {
        toArray () {
            return rows
        },
        one () {
            return rows[0] || null
        }
    }
}

function createConstructorContext (storedVersion:number | null) {
    const statements:string[] = []
    const writes:unknown[] = []
    let barrier:Promise<void> = Promise.resolve()

    const ctx = {
        storage: {
            sql: {
                exec (query:string) {
                    statements.push(query)
                    if (query.includes('PRAGMA table_info(feeds)')) {
                        return result([
                            { name: 'updated_at' },
                            { name: 'last_error' },
                            { name: 'last_status' },
                            { name: 'last_pulled_at' }
                        ])
                    }
                    if (query.includes('PRAGMA table_info(items)')) {
                        return result([
                            { name: 'updated_at' },
                            { name: 'thumbnail_url' },
                            { name: 'full_content' },
                            { name: 'full_content_fetched_at' },
                            { name: 'full_content_status' }
                        ])
                    }
                    return result()
                }
            },
            get: async () => {
                if (storedVersion === null) return null
                return { migration_v: storedVersion }
            },
            put: async (_key:string, value:unknown) => {
                writes.push(value)
            },
            getAlarm: async () => Date.now(),
            setAlarm: async () => {}
        },
        blockConcurrencyWhile: (fn:() => Promise<void>) => {
            barrier = fn()
        }
    } as unknown as DurableObjectState

    return {
        ctx,
        statements,
        writes,
        ready: () => barrier
    }
}

test('UserDO skips migration introspection when version is current',
    async t => {
        const currentMigrationVersion = 6
        const setup = createConstructorContext(currentMigrationVersion)

        const userDo = new UserDO(setup.ctx, {} as never)
        await setup.ready()

        const introspectionQueries = setup.statements.filter(query => {
            return query.includes('PRAGMA table_info')
        })
        const alterQueries = setup.statements.filter(query => {
            return query.includes('ALTER TABLE')
        })

        t.ok(userDo, 'Durable Object constructed successfully')
        t.equal(
            introspectionQueries.length,
            0,
            'current migration version skips PRAGMA column checks'
        )
        t.equal(
            alterQueries.length,
            0,
            'current migration version skips ALTER TABLE migrations'
        )
    })

test('UserDO reruns migrations when stored version is stale', async t => {
    const previousMigrationVersion = 1
    const setup = createConstructorContext(previousMigrationVersion)

    const userDo = new UserDO(setup.ctx, {} as never)
    await setup.ready()

    const introspectionQueries = setup.statements.filter(query => {
        return query.includes('PRAGMA table_info')
    })

    t.ok(userDo, 'Durable Object constructed successfully')
    t.equal(
        introspectionQueries.length,
        7,
        'stale migration version runs all column checks'
    )
    t.deepEqual(
        setup.writes,
        [{ migration_v: 6 }],
        'current migration version is persisted'
    )
})

test('UserDO migrates missing item thumbnail column', async t => {
    const setup = createConstructorContext(2)
    const originalExec = setup.ctx.storage.sql.exec.bind(
        setup.ctx.storage.sql
    )

    setup.ctx.storage.sql.exec = ((query:string) => {
        if (query.includes('PRAGMA table_info(items)')) {
            return result([{ name: 'updated_at' }])
        }

        return originalExec(query)
    }) as typeof setup.ctx.storage.sql.exec

    const userDo = new UserDO(setup.ctx, {} as never)
    await setup.ready()

    t.ok(userDo, 'Durable Object constructed successfully')
    t.ok(
        setup.statements.some(query => {
            return query.includes(
                'ALTER TABLE items ADD COLUMN thumbnail_url TEXT'
            )
        }),
        'missing thumbnail_url column is added'
    )
})

test('fresh item schema includes nullable image metadata columns', t => {
    const expectedColumns = [
        'og_image_url TEXT',
        'blurhash TEXT',
        'image_width INTEGER',
        'image_height INTEGER'
    ]

    for (const column of expectedColumns) {
        t.ok(
            TABLES_SQL.includes(column),
            `items table includes ${column}`
        )
    }
})

test('image metadata columns do not have dedicated indexes', t => {
    const metadataColumns = [
        'og_image_url',
        'blurhash',
        'image_width',
        'image_height'
    ]

    for (const column of metadataColumns) {
        t.equal(
            INDEXES_SQL.includes(column),
            false,
            `${column} is not indexed`
        )
    }
})

test('user state schema creates the feed version counter row', t => {
    t.ok(
        USER_STATE_SQL.includes('CREATE TABLE IF NOT EXISTS user_state'),
        'user_state table is created idempotently'
    )
    t.ok(
        USER_STATE_SQL.includes(
            'id INTEGER PRIMARY KEY CHECK (id = 1)'
        ),
        'user_state table is constrained to one row'
    )
    t.ok(
        USER_STATE_SQL.includes(
            'feed_version INTEGER NOT NULL DEFAULT 0'
        ),
        'feed_version defaults to zero'
    )
    t.ok(
        USER_STATE_SQL.includes(
            'INSERT OR IGNORE INTO user_state (id, feed_version)'
        ),
        'initial user_state row is inserted idempotently'
    )
})

test('UserDO applies user state schema after dead letter outbox', async t => {
    const setup = createConstructorContext(6)

    const userDo = new UserDO(setup.ctx, {} as never)
    await setup.ready()

    const deadLetterIndex = setup.statements.findIndex(query => {
        return query.includes('CREATE TABLE IF NOT EXISTS dead_letter_outbox')
    })
    const userStateIndex = setup.statements.findIndex(query => {
        return query.includes('CREATE TABLE IF NOT EXISTS user_state')
    })

    t.ok(userDo, 'Durable Object constructed successfully')
    t.ok(deadLetterIndex >= 0, 'dead letter outbox schema is applied')
    t.ok(userStateIndex >= 0, 'user state schema is applied')
    t.ok(
        userStateIndex > deadLetterIndex,
        'user state schema runs after the dead letter outbox'
    )
})

test('UserDO reads and bumps feed version through user_state', t => {
    const statements:{ query:string, params:unknown[] }[] = []
    const userDo = Object.create(UserDO.prototype) as {
        sql:{
            exec:(query:string, ...params:unknown[]) => QueryResult
        }
        getFeedVersion:() => number
        bumpFeedVersion:() => number
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]):QueryResult {
            statements.push({ query, params })

            if (query.includes('SELECT feed_version FROM user_state')) {
                return result([{ feed_version: 4 }])
            }

            if (query.includes('UPDATE user_state SET')) {
                return result([{ feed_version: 5 }])
            }

            return result()
        }
    }

    t.equal(
        userDo.getFeedVersion(),
        4,
        'getFeedVersion returns the stored counter'
    )
    t.equal(
        userDo.bumpFeedVersion(),
        5,
        'bumpFeedVersion returns the incremented counter'
    )
    t.ok(
        statements[1].query.includes('RETURNING feed_version'),
        'bumpFeedVersion reads the new value atomically'
    )
})

test('UserDO migrates missing item image metadata columns', async t => {
    const setup = createConstructorContext(5)
    const originalExec = setup.ctx.storage.sql.exec.bind(
        setup.ctx.storage.sql
    )

    setup.ctx.storage.sql.exec = ((query:string) => {
        if (query.includes('PRAGMA table_info(items)')) {
            return result([
                { name: 'updated_at' },
                { name: 'thumbnail_url' },
                { name: 'full_content' },
                { name: 'full_content_fetched_at' },
                { name: 'full_content_status' }
            ])
        }

        return originalExec(query)
    }) as typeof setup.ctx.storage.sql.exec

    const userDo = new UserDO(setup.ctx, {} as never)
    await setup.ready()

    const expectedMigrations = [
        'ALTER TABLE items ADD COLUMN og_image_url TEXT',
        'ALTER TABLE items ADD COLUMN blurhash TEXT',
        'ALTER TABLE items ADD COLUMN image_width INTEGER',
        'ALTER TABLE items ADD COLUMN image_height INTEGER'
    ]

    t.ok(userDo, 'Durable Object constructed successfully')
    for (const migration of expectedMigrations) {
        t.ok(
            setup.statements.some(query => query.includes(migration)),
            `${migration} is run for existing item tables`
        )
    }
})
