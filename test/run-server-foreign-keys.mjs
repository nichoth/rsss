import { spawn } from 'node:child_process'

const esbuild = spawn('npx', [
    'esbuild',
    'test/server-foreign-keys.ts',
    '--bundle',
    '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
    '--loader:.wasm=dataurl'
], {
    stdio: ['ignore', 'pipe', 'inherit']
})

const tapout = spawn('npx', ['tapout'], {
    stdio: ['pipe', 'inherit', 'inherit']
})

esbuild.stdout.pipe(tapout.stdin)

esbuild.on('error', (err) => {
    console.error(err)
    tapout.kill()
})

tapout.on('error', (err) => {
    console.error(err)
    esbuild.kill()
})

esbuild.on('close', (code) => {
    if (code !== 0) {
        tapout.stdin.end()
        process.exitCode = code ?? 1
    }
})

tapout.on('close', (code) => {
    if (process.exitCode === undefined) {
        process.exitCode = code ?? 1
    }
})
