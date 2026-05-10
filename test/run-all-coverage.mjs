import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const runner = readFileSync(
    new URL('./run-all-tests.mjs', import.meta.url),
    'utf8'
)

const requiredSuites = [
    'adapter-factory',
    'bootstrap',
    'local-adapter',
    'local-first-settings',
    'pull-sync',
    'push-sync',
    'sqlite-init',
    'tab-coordination'
]

const requiredScriptCommands = [
    'test:initial-feed',
    'test:lazy-html',
    'test:lazy-html-handler'
]

const wasmSuites = [
    'bootstrap',
    'local-adapter',
    'pull-sync',
    'push-sync',
    'sqlite-init'
]

assert.match(
    runner,
    /node test\/run-all-coverage\.mjs/,
    'npm test runs the test runner coverage guard'
)

for (const suite of requiredSuites) {
    assert.match(
        runner,
        new RegExp(`test/${suite}\\.ts`),
        `npm test runs test/${suite}.ts`
    )
}

for (const command of requiredScriptCommands) {
    assert.match(
        runner,
        new RegExp(`npm run ${command}`),
        `npm test runs ${command}`
    )
}

for (const suite of wasmSuites) {
    assert.match(
        runner,
        new RegExp(`test/${suite}\\.ts[\\s\\S]*--loader:\\.wasm=dataurl`),
        `npm test gives test/${suite}.ts the wasm data URL loader`
    )
}
