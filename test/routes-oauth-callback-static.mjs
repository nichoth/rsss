import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routes = readFileSync(
    new URL('../src/client/routes/index.ts', import.meta.url),
    'utf8'
)

const callbackRoute = routes.match(
    /router\.addRoute\('\/oauth\/callback', \(\) => \{[\s\S]*?\n    \}\)/
)?.[0] ?? ''

assert.match(
    callbackRoute,
    /\/\/.*handleOAuthCallback.*async[\s\S]*\/\/.*network/,
    'OAuth callback route comment explains async network work'
)

assert.match(
    callbackRoute,
    /\/\/.*LoginPage[\s\S]*\/\/.*route/,
    'OAuth callback route comment explains route change after LoginPage'
)
