import { spawnSync } from 'node:child_process'

const commands = [
    'node test/vite-isolation-headers.mjs',
    [
        'esbuild ./test/index.ts --bundle',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
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
