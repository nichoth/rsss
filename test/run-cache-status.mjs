import { spawnSync } from 'node:child_process'

const command = [
    'esbuild ./test/cache-status.ts --bundle',
    '--loader:.css=text',
    '--loader:.wasm=dataurl',
    '| tapout'
].join(' ')

const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit'
})

if (result.status !== 0) {
    process.exit(result.status ?? 1)
}
