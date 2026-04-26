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
