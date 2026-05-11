import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(
    new URL('../src/client/components/sidebar.ts', import.meta.url),
    'utf8'
)

test('sidebar add-feed input is read through namedItem', () => {
    assert.match(
        source,
        /els\.namedItem\(\s*'new-feed-url'\s*\) as HTMLInputElement/
    )
    assert.doesNotMatch(source, /els\[['"]new-feed-url['"]\]/)
})

test('sidebar empty-state shows feedsError when set, ' +
    'otherwise No feeds yet', () => {
    // Error branch: when feedsError is set the empty state surfaces it.
    assert.match(
        source,
        /feedsError\.value\s*\?[\s\S]+Couldn/
    )
    // Empty branch: when there's no error the original copy still wins.
    assert.match(source, /No feeds yet/)
})

test('sidebar destructures feedsError from state', () => {
    assert.match(source, /feedsError,/)
})
