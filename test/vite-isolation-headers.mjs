import assert from 'node:assert/strict'
import configFactory from '../vite.config.js'

const config = configFactory({ mode: 'development' })

assert.equal(
    config.server.headers['Cross-Origin-Opener-Policy'],
    'same-origin',
    'Vite dev server keeps COOP enabled'
)

assert.equal(
    config.server.headers['Cross-Origin-Embedder-Policy'],
    'credentialless',
    'Vite dev server uses iframe-compatible COEP'
)
