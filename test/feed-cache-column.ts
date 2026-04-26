import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'
import { TABLES_SQL } from '../src/shared/schema.js'

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

function createPatchRouteDo () {
    const feed = {
        id: 1,
        url: 'https://example.com/feed.xml',
        title: null,
        description: null,
        site_url: null,
        last_fetched: null,
        created_at: '2026-04-26 00:00:00',
        updated_at: '2026-04-26 00:00:00'
    }
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        createRouter:() => { request:(path:string, init:RequestInit) =>
            Promise<Response> }
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (query.includes('SELECT id FROM feeds WHERE id = ?')) {
                return result(params[0] === 1 ? [{ id: 1 }] : [])
            }

            if (query.includes('SELECT * FROM feeds WHERE id = ?')) {
                return result(params[0] === 1 ? [feed] : [])
            }

            if (query.includes('UPDATE feeds SET is_locally_cached')) {
                return result([])
            }

            throw new Error(`Unexpected SQL: ${query}`)
        }
    }

    return userDo.createRouter()
}

test('shared feed schema does not include is_locally_cached', t => {
    t.equal(
        TABLES_SQL.includes('is_locally_cached'),
        false,
        'feed cache column is not part of new databases'
    )
})

test('PATCH /feeds/:id is not exposed for feed cache toggles', async t => {
    const app = createPatchRouteDo()
    const response = await app.request('/feeds/1', {
        method: 'PATCH',
        body: JSON.stringify({ is_locally_cached: false })
    })

    t.equal(response.status, 404, 'feed cache toggle endpoint is removed')
})

