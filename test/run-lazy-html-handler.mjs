import { spawn } from 'node:child_process'

const esbuild = spawn('esbuild', [
    './test/lazy-html-handler.ts',
    '--bundle'
], {
    stdio: ['ignore', 'pipe', 'inherit']
})

const tapout = spawn('tapout', [], {
    stdio: ['pipe', 'inherit', 'inherit']
})

esbuild.stdout.pipe(tapout.stdin)

esbuild.on('error', err => {
    console.error(err)
    tapout.kill()
    process.exitCode = 1
})

tapout.on('error', err => {
    console.error(err)
    esbuild.kill()
    process.exitCode = 1
})

esbuild.on('close', code => {
    if (code !== 0) {
        tapout.kill()
        process.exitCode = code ?? 1
    }
})

tapout.on('close', code => {
    if (code !== 0) {
        process.exitCode = code ?? 1
    }
})
