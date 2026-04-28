import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const invariant = 'getPendingOutboxRefs is called after pushSync resolves'
const files = [
    'src/client/db/sync.ts',
    'src/client/db/pull-sync.ts'
]

for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(
        source,
        new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${file} documents the push-then-pull pending-ref invariant`
    )
}
