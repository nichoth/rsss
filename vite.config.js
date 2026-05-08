// @ts-check
import { defineConfig } from 'vite'
import browserslist from 'browserslist'
import { browserslistToTargets } from 'lightningcss'
import preact from '@preact/preset-vite'
import { cloudflare } from '@cloudflare/vite-plugin'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
    return {
        define: {
            global: 'globalThis'
        },
        resolve: {
            alias: {
                '@substrate-system/debug': mode === 'production' ?
                    '@substrate-system/debug/noop' :
                    '@substrate-system/debug'
            }
        },
        plugins: [
            cloudflare(),
            preact({
                devtoolsInProd: false,
                prefreshEnabled: true,
            }),
        ],
        optimizeDeps: {
            // sqlite-wasm references its OPFS proxy with `?vfs=opfs`
            // query strings that Vite's dep optimizer treats as part of
            // the filename, causing "file does not exist" warnings.
            exclude: ['@sqlite.org/sqlite-wasm']
        },
        // https://github.com/vitejs/vite/issues/8644#issuecomment-1159308803
        esbuild: {
            logOverride: { 'this-is-undefined-in-esm': 'silent' }
        },
        publicDir: '_public',
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                targets: browserslistToTargets(browserslist('>= 0.25%')),
            },
        },
        server: {
            port: 2222,
            host: true,
            // Use 127.0.0.1 (not localhost) so the OAuth loopback-client
            // redirect lands on the same origin as the session cookie.
            open: 'http://127.0.0.1:2222/',
            headers: {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'credentialless',
            },
        },

        build: {
            cssMinify: 'lightningcss',
            target: 'esnext',
            minify: mode === 'production',
            outDir: './public',
            emptyOutDir: true,
            sourcemap: 'inline',
        },
        worker: {
            format: 'es',
        },
        environments: {
            client: {
                build: {
                    rollupOptions: {
                        // Inspect lazy SQLite packaging with:
                        // npm run build && find public -type f | sort
                        input: {
                            index: './index.html',
                        },
                    },
                },
            },
        }
    }
})
