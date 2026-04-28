import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const server = readFileSync(
    new URL('src/server/index.ts', root),
    'utf8'
)
const userDo = readFileSync(
    new URL('src/server/durable-objects/index.ts', root),
    'utf8'
)
const syncRoute = userDo.slice(
    userDo.indexOf("app.get('/sync'"),
    userDo.indexOf('        return app')
)

assert.doesNotMatch(
    userDo,
    /from 'hono\/cors'|cors\(/,
    'internal Durable Object router should not use Hono CORS'
)

const healthRoutes = [...server.matchAll(/app\.get\('([^']*health)'/g)]
    .map((match) => match[1])

assert.deepEqual(
    healthRoutes,
    ['/api/health'],
    'Worker should expose one documented health route'
)

assert.match(
    userDo,
    /const SYNC_PAGE_LIMIT = 500/,
    'sync endpoint should hard-cap pages at 500 rows'
)

assert.match(
    syncRoute,
    /LIMIT \?/,
    'sync endpoint should bound feed and item queries with LIMIT'
)

assert.doesNotMatch(
    syncRoute,
    /SELECT \* FROM feeds|SELECT items\.\*/,
    'sync endpoint should not use unbounded SELECT * feed/item queries'
)

assert.match(
    syncRoute,
    /updated_at ASC, id ASC/,
    'sync endpoint should order feed pages by cursor columns'
)

assert.match(
    syncRoute,
    /updated_at ASC, items\.id ASC/,
    'sync endpoint should order item pages by cursor columns'
)

assert.match(
    syncRoute,
    /hasMore/,
    'sync response should include pagination state'
)

assert.match(
    syncRoute,
    /nextCursor/,
    'sync response should include a resume cursor'
)
