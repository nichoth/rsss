import { spawnSync } from 'node:child_process'

const commands = [
    'node test/vite-isolation-headers.mjs',
    'node test/isolation-headers-static.mjs',
    'esbuild test/server-headers.ts --bundle | tapout'
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
