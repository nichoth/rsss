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
            port: 8888,
            host: true,
            open: true,
        },

        build: {
            cssMinify: 'lightningcss',
            target: 'esnext',
            minify: mode === 'production',
            outDir: './public',
            emptyOutDir: true,
            sourcemap: 'inline',
        }
    }
})
