import assert from 'node:assert/strict'
import configFactory from '../vite.config.js'

const config = configFactory({ mode: 'production' })
const input = config.environments.client.build.rollupOptions.input

assert.deepEqual(
    input,
    { index: './index.html' },
    'Vite client build starts from index.html only'
)

assert.equal(
    Object.hasOwn(input, 'sqlite-init'),
    false,
    'sqlite-init is not a standalone Vite entry'
)
