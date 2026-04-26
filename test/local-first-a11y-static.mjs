import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const settings = readFileSync(
    new URL('../src/client/routes/settings.ts', import.meta.url),
    'utf8'
)
const settingsCss = readFileSync(
    new URL('../src/client/routes/settings.css', import.meta.url),
    'utf8'
)
const syncStatus = readFileSync(
    new URL('../src/client/components/sync-status.ts', import.meta.url),
    'utf8'
)
const syncStatusCss = readFileSync(
    new URL('../src/client/components/sync-status.css', import.meta.url),
    'utf8'
)

assert.match(
    syncStatus,
    /role="status"/,
    'sync status should expose status semantics'
)
assert.match(
    syncStatus,
    /aria-live="polite"/,
    'sync status updates should be announced politely'
)
assert.match(
    syncStatus,
    /aria-label=\$\{a11yLabel\}/,
    'sync status should expose tooltip context through an aria label'
)

for (const id of [
    'sync-subscriptions-desc',
    'store-content-desc'
]) {
    assert.match(
        settings,
        new RegExp(`id="${id}"`),
        `settings should render ${id}`
    )
    assert.match(
        settings,
        new RegExp(`aria-describedby="${id}"`),
        `settings controls should reference ${id}`
    )
}

for (const [name, source] of [
    ['settings.css', settingsCss],
    ['sync-status.css', syncStatusCss]
]) {
    assert.doesNotMatch(
        source,
        /(^|[^-])border-radius\s*:/,
        `${name} should not use border-radius`
    )
    assert.doesNotMatch(
        source.replace(/var\([^)]*\)/g, ''),
        /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
        `${name} should use color variables instead of raw colors`
    )
}
