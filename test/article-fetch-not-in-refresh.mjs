/**
 * Static guard for FR-004 / SC-007: the on-demand article-fetch
 * pipeline must not be wired into any feed-refresh / alarm path.
 *
 * This protects the US-144 lockdown ("no automatic feed refresh") by
 * grepping for unauthorised call sites of `fetchFullArticle`,
 * `doFetchFullArticle`, and `extractArticleBody`. Any new caller
 * outside the allow-list must update this file deliberately.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

function readSource (rel) {
    return readFileSync(join(ROOT, rel), 'utf8')
}

function collectFiles (dir, exts) {
    const out = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
            out.push(...collectFiles(full, exts))
        } else if (exts.some(ext => full.endsWith(ext)) &&
            !full.endsWith('.d.ts')) {
            out.push(full)
        }
    }
    return out
}

// 1. Files that may NEVER mention the article-fetch pipeline.
// (feed-parser.ts does not exist in this repo — feed parsing lives
// inside durable-objects/index.ts; check that file's parse helpers
// in step 2 below.)
const FORBIDDEN_FILES = [
    'src/server/feed-fetch.ts'
]

const FORBIDDEN_PATTERNS = [
    /\bfetchFullArticle\b/,
    /\bextractArticleBody\b/,
    /\bdoFetchFullArticle\b/,
    /\bsanitiseExtractedHtml\b/
]

for (const file of FORBIDDEN_FILES) {
    const src = readSource(file)
    for (const pattern of FORBIDDEN_PATTERNS) {
        assert.ok(
            !pattern.test(src),
            `${file} must not reference ${pattern.source} ` +
            '(US-144 lockdown / SC-007: zero added cost on feed refresh)'
        )
    }
}

// 2. In durable-objects/index.ts, the article-fetch pipeline is only
// allowed inside the POST /items/:id/fetch-full route handler and the
// thin doFetchFullArticle wrapper. The refresh / alarm methods must
// not reference it.
const doSrc = readSource('src/server/durable-objects/index.ts')

// Slice each method body using the brace-balanced extractor below.
function methodBody (src, header) {
    const idx = src.indexOf(header)
    if (idx < 0) return ''
    const start = src.indexOf('{', idx)
    if (start < 0) return ''
    let depth = 0
    for (let i = start; i < src.length; i++) {
        const ch = src[i]
        if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return src.slice(start, i + 1)
        }
    }
    return src.slice(start)
}

const REFRESH_HEADERS = [
    'private async fetchFeed (',
    'private async refreshFeeds (',
    'private async refreshFeedBatches (',
    'async alarm (',
    'private selectFeedRefreshBatch (',
    'private async scheduleNextFeedRefresh (',
    'parseFeed (',
    'parseFeedItem ('
]

for (const header of REFRESH_HEADERS) {
    const body = methodBody(doSrc, header)
    if (!body) continue
    for (const pattern of FORBIDDEN_PATTERNS) {
        assert.ok(
            !pattern.test(body),
            `durable-objects/index.ts: ${header.trim()} must not ` +
            `reference ${pattern.source}`
        )
    }
}

// 3. Client side: only item-reader.ts and state.ts may invoke the
// state action. No refresh action (refreshFeeds, refreshFeed,
// refreshAfterSync, runSync, pullSync, pushSync, bootstrap) may
// reference fetchFullArticle.
const CLIENT_ALLOWED_CALLERS = new Set([
    'src/client/state.ts',
    'src/client/routes/item-reader.ts',
    'src/client/db/remote-adapter.ts'
])

const CLIENT_PATTERN = /\bfetchFullArticle\b/

const clientFiles = collectFiles(
    join(ROOT, 'src/client'),
    ['.ts']
)

const violations = []
for (const file of clientFiles) {
    const rel = file.replace(ROOT, '').replace(/^\/+/, '')
    if (CLIENT_ALLOWED_CALLERS.has(rel)) continue
    const src = readFileSync(file, 'utf8')
    if (CLIENT_PATTERN.test(src)) {
        violations.push(rel)
    }
}

assert.equal(
    violations.length,
    0,
    'no unauthorised client call sites for fetchFullArticle: ' +
    violations.join(', ')
)

console.log('# article-fetch-not-in-refresh: ok')
