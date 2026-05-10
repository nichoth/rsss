import { test } from '@substrate-system/tapzero'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const serverDir = join(rootDir, 'src', 'server')

function walkTs (dir:string):string[] {
    const results:string[] = []

    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = statSync(full)

        if (stat.isDirectory()) {
            results.push(...walkTs(full))
        } else if (entry.endsWith('.ts')) {
            results.push(full)
        }
    }

    return results
}

const BARE_IDENT_IMPORT = /\bimport\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g

test('no variable-form dynamic imports under src/server/', t => {
    const files = walkTs(serverDir)

    t.ok(files.length > 0, 'found .ts files under src/server/')

    for (const file of files) {
        const src = readFileSync(file, 'utf8')
        const relative = file.slice(rootDir.length)
        let match:RegExpExecArray|null

        BARE_IDENT_IMPORT.lastIndex = 0

        while ((match = BARE_IDENT_IMPORT.exec(src)) !== null) {
            t.fail(
                `${relative} contains import(<identifier>): ` +
                `import(${match[1]})`
            )
        }
    }

    t.ok(true, 'all dynamic imports in src/server/ use literal paths')
})
