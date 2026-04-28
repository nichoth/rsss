import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const wrangler = readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8'
)
const varsBlock = wrangler.match(/"vars"\s*:\s*\{[\s\S]*?\n\t\}/)?.[0] ?? ''

assert.doesNotMatch(
    varsBlock,
    /"AUTUMN_SECRET_KEY"\s*:/,
    'AUTUMN_SECRET_KEY must be configured with wrangler secret put, not vars'
)
