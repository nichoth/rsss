import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const html = readFileSync(
    new URL('../index.html', import.meta.url),
    'utf8'
)

const linkMatch = html.match(/<link\s[^>]*rel="stylesheet"[^>]*>/i)

assert.ok(
    linkMatch,
    'index.html contains a <link rel="stylesheet"> element'
)

const linkOffset = linkMatch.index ?? -1
const headOpen = html.search(/<head\b/i)
const headClose = html.indexOf('</head>')

assert.ok(headOpen !== -1, 'index.html contains <head>')
assert.ok(headClose !== -1, 'index.html contains </head>')

assert.ok(
    linkOffset > headOpen && linkOffset < headClose,
    'first <link rel="stylesheet"> is inside <head>'
)

const scriptOffset = html.search(/<script\b/i)

assert.ok(scriptOffset !== -1, 'index.html contains a <script>')
assert.ok(
    linkOffset < scriptOffset,
    'first <link rel="stylesheet"> appears before the first <script>'
)
