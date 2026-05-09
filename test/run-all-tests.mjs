import { spawnSync } from 'node:child_process'

const commands = [
    'node test/ci-workflow.mjs',
    'node test/dead-code.mjs',
    'node test/deploy-config.mjs',
    'node test/durable-object-parseint-static.mjs',
    'node test/routes-oauth-callback-static.mjs',
    'node test/sidebar-static.mjs',
    'node test/server-routing-static.mjs',
    'node test/sync-invariant-static.mjs',
    'node test/article-fetch-not-in-refresh.mjs',
    'node test/local-first-a11y-static.mjs',
    'node test/local-first-opfs-persistence-static.mjs',
    'node test/local-first-docs.mjs',
    'node test/vite-build-inputs.mjs',
    'node test/vite-isolation-headers.mjs',
    'node test/isolation-headers-static.mjs',
    'node test/run-all-coverage.mjs',
    'esbuild ./test/tab-coordination.ts --bundle | tapout',
    'esbuild ./test/adapter-factory.ts --bundle | tapout',
    'esbuild ./test/article-detect.ts --bundle | tapout',
    'esbuild ./test/publisher-link.ts --bundle | tapout',
    'esbuild ./test/article-extract.ts --bundle | tapout',
    'esbuild ./test/article-fetch.ts --bundle | tapout',
    'esbuild ./test/item-reader-render-state.ts --bundle | tapout',
    [
        'esbuild ./test/fetch-full-endpoint.ts --bundle',
        '--platform=node --format=esm',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '| node --input-type=module | tap-spec'
    ].join(' '),
    [
        'esbuild ./test/sqlite-init.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    [
        'esbuild ./test/local-adapter.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    [
        'esbuild ./test/pull-sync.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    [
        'esbuild ./test/push-sync.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    [
        'esbuild ./test/bootstrap.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    [
        'esbuild ./test/cache-status.ts --bundle',
        '--loader:.wasm=dataurl',
        '| tapout'
    ].join(' '),
    'esbuild ./test/local-first-settings.ts --bundle | tapout',
    [
        'esbuild ./test/session-record.ts --bundle --platform=node',
        '--format=esm',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '| node --input-type=module | tap-spec'
    ].join(' '),
    [
        'esbuild ./test/logout.ts --bundle --platform=node',
        '--format=esm',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '| node --input-type=module | tap-spec'
    ].join(' '),
    [
        'esbuild ./test/account-deletion.ts --bundle --platform=node',
        '--format=esm',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '| node --input-type=module | tap-spec'
    ].join(' '),
    [
        'esbuild ./test/account-deletion-alarm.ts --bundle',
        '--platform=node --format=esm',
        '--alias:cloudflare:workers=./test/cloudflare-workers-stub.ts',
        '| node --input-type=module | tap-spec'
    ].join(' '),
    [
        'esbuild ./test/state-refresh-audit.ts --bundle',
        '--platform=node --format=esm',
        '| node --input-type=module | tap-spec'
    ].join(' '),
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
