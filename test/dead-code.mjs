import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const durableObject = readFileSync(
    new URL('../src/server/durable-objects/index.ts', import.meta.url),
    'utf8'
)
const oauth = readFileSync(
    new URL('../src/server/auth/oauth.ts', import.meta.url),
    'utf8'
)
const state = readFileSync(
    new URL('../src/client/state.ts', import.meta.url),
    'utf8'
)

assert.doesNotMatch(
    durableObject,
    /\/\/\s*function getAttr\b/,
    'parseRss does not retain commented-out getAttr helper code'
)

assert.doesNotMatch(
    oauth,
    /\bgenerateSessionToken\b/,
    'OAuth module does not export unused generateSessionToken'
)

for (const name of [
    'loadBillingStatus',
    'signalCheckoutFailed',
    'openCustomerPortal'
]) {
    assert.doesNotMatch(
        state,
        new RegExp(
            `State\\.${name} = async function \\(\\n\\s+_state:AppState`
        ),
        `${name} does not accept an unused _state parameter`
    )
}
