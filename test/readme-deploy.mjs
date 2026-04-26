import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

const deployStart = readme.indexOf('## Deploy')
const notesStart = readme.indexOf('## Notes')

assert.notEqual(deployStart, -1, 'README has a Deploy section')
assert.notEqual(notesStart, -1, 'README has a Notes section after Deploy')

const deploy = readme.slice(deployStart, notesStart)

for (const name of [
    'ADMIN_TOKEN',
    'SESSION_SECRET',
    'OAUTH_CLIENT_ID',
    'AUTUMN_SECRET_KEY',
    'RESEND_API_KEY',
    'RESEND_FROM'
]) {
    assert.match(deploy, new RegExp(`\\b${name}\\b`), `${name} is listed`)
}

assert.match(
    deploy,
    /wrangler kv namespace create SESSIONS/,
    'README uses current Wrangler KV namespace syntax'
)

assert.doesNotMatch(
    deploy,
    /wrangler kv:namespace create SESSIONS/,
    'README does not use deprecated Wrangler KV namespace syntax'
)

for (const text of [
    '/api/health',
    '/oauth/client-metadata.json',
    'compatibility_flags',
    'nodejs_compat',
    'preview_id'
]) {
    assert.match(deploy, new RegExp(text), `${text} is documented`)
}

assert.match(
    deploy,
    /rotate `SESSION_SECRET`/i,
    'README documents how to rotate SESSION_SECRET'
)

assert.match(
    deploy,
    /active sessions/,
    'README documents the effect on active sessions'
)
