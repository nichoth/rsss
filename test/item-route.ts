import { test } from '@substrate-system/tapzero'
import { UserDO } from '../src/server/durable-objects/index.js'

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

function createItemRouteDo () {
    const exactItem = {
        id: 1,
        feed_id: 1,
        guid: 'exact',
        title: 'Exact Item',
        link: 'https://example.com/posts/item',
        description: null,
        content: null,
        author: null,
        pub_date: '2024-01-01 00:00:00',
        is_read: 0,
        is_starred: 0,
        created_at: '2024-01-01 00:00:00',
        updated_at: '2024-01-01 00:00:00',
        feed_title: 'Feed'
    }
    const links = [
        exactItem.link,
        'https://example.com/posts/item/',
        'http://example.com/posts/item'
    ]
    const userDo = Object.create(UserDO.prototype) as {
        sql:{ exec:(query:string, ...params:unknown[]) => QueryResult }
        createRouter:() => { request:(path:string) => Promise<Response> }
    }

    userDo.sql = {
        exec (query:string, ...params:unknown[]) {
            if (!query.includes('FROM items')) {
                throw new Error(`Unexpected SQL: ${query}`)
            }

            const usesExactLink = query.includes('items.link = ?')
            const hasLikeMatch = query.includes('items.link LIKE')
            const hasWildcardParam = params.some(param => {
                return typeof param === 'string' && param.includes('%')
            })

            if (!usesExactLink || hasLikeMatch || hasWildcardParam) {
                return result([])
            }

            return result(params.some(param => links.includes(
                param as string
            )) ? [exactItem] : [])
        }
    }

    return userDo.createRouter()
}

test('GET /items/by-route uses exact matching for overlapping paths',
    async t => {
        const app = createItemRouteDo()
        const response = await app.request(
            '/items/by-route?route=example.com/posts/item'
        )
        const body = await response.json() as {
            item?:{ title?:string }
        }

        t.equal(response.status, 200, 'route returns a match')
        t.equal(body.item?.title, 'Exact Item', 'returns exact item')
    })
