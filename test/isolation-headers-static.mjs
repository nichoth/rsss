import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = readFileSync('src/server/isolation-headers.ts', 'utf8')

assert.match(
    source,
    /credentialless[\s\S]+cross-origin image[\s\S]+auth cookies/,
    [
        'withIsolationHeaders should document that COEP credentialless',
        'strips auth cookies from cross-origin image subresources'
    ].join(' ')
)
