// @ts-check
import { defineConfig } from 'vite'
import browserslist from 'browserslist'
import { browserslistToTargets } from 'lightningcss'
import preact from '@preact/preset-vite'

/**
 * Vite config for Tauri desktop builds
 * Builds the frontend without Cloudflare-specific plugins
 */
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
            preact({
                devtoolsInProd: false,
                prefreshEnabled: true,
            }),
        ],
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
        // For Tauri dev server
        server: {
            port: 5173,
            strictPort: true,
            host: true,
        },
        // Clear output and prevent hot reloading issues with Tauri
        clearScreen: false,
        build: {
            cssMinify: 'lightningcss',
            target: 'esnext',
            minify: mode === 'production',
            outDir: './dist-tauri',
            emptyOutDir: true,
            sourcemap: mode !== 'production',
        }
    }
})
