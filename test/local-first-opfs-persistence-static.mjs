import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const browserTest = readFileSync(
    new URL('./local-first-opfs-persistence.ts', import.meta.url),
    'utf8'
)

const manualScript = readFileSync(
    new URL('./manual/local-first-opfs-persistence.js', import.meta.url),
    'utf8'
)

assert.match(
    browserTest,
    /persists local-first feed and item rows across a simulated reload/,
    'US-062 browser test should cover reload persistence'
)

assert.match(
    manualScript,
    /crossOriginIsolated/,
    'manual OPFS verification script should check isolation'
)
