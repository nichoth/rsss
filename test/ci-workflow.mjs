import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

assert.equal(
    existsSync(workflowUrl),
    true,
    'CI workflow exists at .github/workflows/ci.yml'
)

const workflow = readFileSync(workflowUrl, 'utf8')
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'))
const nodeVersion = pkg.engines?.node

assert.equal(
    typeof nodeVersion,
    'string',
    'package.json defines engines.node for CI'
)

assert.match(workflow, /^name: CI$/m, 'workflow is named CI')
assert.match(workflow, /^\s+push:$/m, 'workflow runs on push')
assert.match(workflow, /^\s+pull_request:$/m, 'workflow runs on PRs')

for (const eventName of ['push', 'pull_request']) {
    assert.match(
        workflow,
        new RegExp(`${eventName}:\\n\\s+branches: \\[main\\]`),
        `${eventName} targets main`
    )
}

assert.match(
    workflow,
    new RegExp(`node-version: ['"]?${nodeVersion}['"]?`),
    'workflow uses package engines.node'
)

for (const command of ['npm test', 'npm run typecheck']) {
    assert.match(
        workflow,
        new RegExp(`\\b${command}\\b`),
        `workflow runs ${command}`
    )
}
