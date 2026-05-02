import { test } from '@substrate-system/tapzero'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED_CALLERS = new Set([
    'src/client/components/sidebar-footer.ts',
    'src/client/routes/updates.ts'
])

const REFRESH_PATTERN = /State\.(refreshFeeds|refreshFeed)\s*\(/g

function collectClientFiles (dir:string):string[] {
    const files:string[] = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            files.push(...collectClientFiles(full))
        } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
            files.push(full)
        }
    }
    return files
}

test('no unauthorized State.refreshFeeds / State.refreshFeed call sites',
    t => {
        const clientDir = 'src/client'
        const files = collectClientFiles(clientDir)

        const violations:string[] = []

        for (const file of files) {
            const rel = file.replace(/.*\/src\//, 'src/')
            if (ALLOWED_CALLERS.has(rel)) continue

            const src = readFileSync(file, 'utf8')
            const matches = src.match(REFRESH_PATTERN)
            if (matches) {
                violations.push(`${rel}: ${matches.join(', ')}`)
            }
        }

        t.equal(
            violations.length,
            0,
            'only sidebar-footer and updates.ts may call refreshFeeds/Feed' +
            (violations.length ? `\n  ${violations.join('\n  ')}` : '')
        )
    }
)
