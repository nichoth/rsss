import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'
import { INDEXES_SQL, TABLES_SQL } from '../src/shared/schema.js'

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
