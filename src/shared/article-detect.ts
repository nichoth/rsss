/**
 * Deterministic "summary-only?" check for an item.
 *
 * Used identically on the client (gating the auto-trigger) and the
 * server (gating the actual fetch). Pure function, no I/O.
 */

import { SUMMARY_TEXT_THRESHOLD } from './schema.js'

const HTML_ENTITY_PATTERN = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi
const HTML_TAG_PATTERN = /<[^>]*>/g

const NAMED_ENTITIES:Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
}

/**
 * Strip HTML tags, decode entities, collapse whitespace, count code
 * points. Counts user-perceived characters as Unicode code points so
 * CJK + emoji content count fairly.
 */
export function plainTextLength (html:string):number {
    if (!html) return 0

    const noTags = html.replace(HTML_TAG_PATTERN, ' ')
    const decoded = noTags.replace(
        HTML_ENTITY_PATTERN,
        (_match, hex, dec, name) => {
            if (hex) {
                const codePoint = Number.parseInt(hex, 16)
                if (Number.isFinite(codePoint) && codePoint > 0) {
                    return String.fromCodePoint(codePoint)
                }
                return ''
            }
            if (dec) {
                const codePoint = Number.parseInt(dec, 10)
                if (Number.isFinite(codePoint) && codePoint > 0) {
                    return String.fromCodePoint(codePoint)
                }
                return ''
            }
            const lowerName = (name || '').toLowerCase()
            return NAMED_ENTITIES[lowerName] || ''
        }
    )
    const collapsed = decoded.replace(/\s+/g, ' ').trim()

    let count = 0
    for (const _ of collapsed) count++
    return count
}

/**
 * R-1 heuristic: an item is summary-only when it has a non-empty link
 * AND the plain-text length of its best-available body is below the
 * SUMMARY_TEXT_THRESHOLD.
 */
export function isSummaryOnly (item:{
    link?:string|null
    content?:string|null
    description?:string|null
}):boolean {
    const link = (item.link || '').trim()
    if (!link) return false

    const body = item.content || item.description || ''
    return plainTextLength(body) < SUMMARY_TEXT_THRESHOLD
}
