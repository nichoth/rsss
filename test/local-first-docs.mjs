import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const docsReadme = readFileSync(
    new URL('../DOCS/README.md', import.meta.url),
    'utf8'
)

const combined = `${readme}\n${docsReadme}`

assert.match(
    docsReadme,
    /does not ship or register a service worker/i,
    'DOCS/README.md records the v1 service worker decision'
)

for (const staleClaim of [
    /Service Worker \(`_public\/sw\.js`\)/,
    /Service worker registration script/i,
    /service worker caches the app shell/i
]) {
    assert.doesNotMatch(
        docsReadme,
        staleClaim,
        `DOCS/README.md removes stale claim: ${staleClaim}`
    )
}

assert.doesNotMatch(
    readme,
    /wa-sqlite/i,
    'README file tree does not describe the SQLite layer as wa-sqlite'
)

for (const expected of [
    '@sqlite.org/sqlite-wasm',
    'sqlite-worker.ts',
    'OPFS-SAH-pool',
    'cross-origin-isolated',
    'remoteAdapter',
    'single tab'
]) {
    assert.match(
        combined,
        new RegExp(expected),
        `local-first docs mention ${expected}`
    )
}
