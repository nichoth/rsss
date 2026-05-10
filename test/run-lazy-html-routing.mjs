import { spawn } from 'node:child_process'

const esbuild = spawn('esbuild', [
    './test/lazy-html-routing.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts'
], {
    stdio: ['ignore', 'pipe', 'inherit']
})

const node = spawn('node', ['--input-type=module'], {
    stdio: ['pipe', 'pipe', 'inherit']
})

const tapSpec = spawn('tap-spec', [], {
    stdio: ['pipe', 'inherit', 'inherit']
})

esbuild.stdout.pipe(node.stdin)
node.stdout.pipe(tapSpec.stdin)

esbuild.on('error', err => {
    console.error(err)
    node.kill()
    tapSpec.kill()
    process.exitCode = 1
})

node.on('error', err => {
    console.error(err)
    esbuild.kill()
    tapSpec.kill()
    process.exitCode = 1
})

tapSpec.on('error', err => {
    console.error(err)
    esbuild.kill()
    node.kill()
    process.exitCode = 1
})

esbuild.on('close', code => {
    if (code !== 0) {
        node.kill()
        tapSpec.kill()
        process.exitCode = code ?? 1
    }
})

node.on('close', code => {
    if (code !== 0) {
        tapSpec.kill()
        process.exitCode = code ?? 1
    }
})

tapSpec.on('close', code => {
    if (code !== 0) {
        process.exitCode = code ?? 1
    }
})
