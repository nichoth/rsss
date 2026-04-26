import { spawnSync } from 'node:child_process'

const commands = [
    'node test/ci-workflow.mjs',
    'node test/dead-code.mjs',
    'node test/durable-object-parseint-static.mjs',
    'node test/routes-oauth-callback-static.mjs',
    'node test/sidebar-static.mjs',
    'node test/server-routing-static.mjs',
    'node test/local-first-opfs-persistence-static.mjs',
    'node test/vite-build-inputs.mjs',
    'node test/vite-isolation-headers.mjs',
    [
        'esbuild ./test/index.ts --bundle',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '--loader:.css=text',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' ')
]

for (const command of commands) {
    const result = spawnSync(command, {
        shell: true,
        stdio: 'inherit'
    })

    if (result.status !== 0) {
        process.exit(result.status ?? 1)
    }
}
