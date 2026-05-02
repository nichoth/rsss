/**
 * Server-side HTML body extractor for the on-demand "fetch full
 * article" pipeline. No DOM and no new dependencies — Cloudflare
 * Workers do not have a DOM.
 *
 * Pipeline (per research.md R-3):
 *   1. Strip dangerous / structural noise (script, style, iframe,
 *      header/nav/aside/footer, common chrome class names, comments).
 *   2. Pick a candidate root: first <article>, first <main>, then
 *      the highest-text-density <div>/<section>.
 *   3. Extract the candidate's innerHTML.
 *   4. Sanitise (sanitiseExtractedHtml).
 *   5. Cap at MAX_FULL_CONTENT_BYTES, truncating at the last </p>
 *      or </div> below the cap.
 *   6. Return error 'no_body' if plainTextLength is below
 *      EXTRACTED_MIN_TEXT, or 'too_large' if a clean truncation
 *      point cannot be found.
 */

import {
    EXTRACTED_MIN_TEXT,
    MAX_FULL_CONTENT_BYTES
} from '../shared/schema.js'
import { plainTextLength } from '../shared/article-detect.js'

const STRIP_TAGS = [
    'script',
    'style',
    'noscript',
    'iframe',
    'form',
    'svg',
    'header',
    'nav',
    'aside',
    'footer'
]

const CHROME_CLASS_HINTS = [
    'comments',
    'share',
    'related',
    'newsletter',
    'sidebar',
    'subscribe'
]

export type ExtractResult =
    | { html:string, plainTextLength:number }
    | { error:'no_body' | 'too_large' }

/**
 * Strip a tag and all its contents (used for script, style, etc.).
 */
function stripTagWithContent (html:string, tag:string):string {
    const pattern = new RegExp(
        `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,
        'gi'
    )
    return html.replace(pattern, '')
}

/**
 * Strip self-closing or open variants of a tag without removing its
 * inner content. Used for nav/header/aside/footer where the inner text
 * is sometimes the whole article wrapped in <header><h1>...</h1></header>
 * — but in our case the candidate-selection step ignores the strip list,
 * so we always remove the wrapper-with-content.
 */
function stripWrapperTagWithContent (html:string, tag:string):string {
    return stripTagWithContent(html, tag)
}

function stripHtmlComments (html:string):string {
    return html.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Remove elements whose class attribute mentions one of the chrome
 * hints. This is a regex-only pass; nested structure is approximated.
 */
function stripChromeClasses (html:string):string {
    const hint = CHROME_CLASS_HINTS.join('|')
    const pattern = new RegExp(
        // <tag ... class="... HINT ..." ...>...</tag>
        '<(div|section|aside|nav|ul)\\b[^>]*\\bclass\\s*=\\s*' +
            `["'][^"']*\\b(?:${hint})\\b[^"']*["'][^>]*>` +
            '[\\s\\S]*?<\\/\\1\\s*>',
        'gi'
    )
    let next = html
    let prev:string
    do {
        prev = next
        next = next.replace(pattern, '')
    } while (next !== prev)
    return next
}

/**
 * Strip dangerous attributes and URLs. Defensive storage filter; the
 * client also re-runs DOMPurify at render time.
 *
 * - Drops on*= event handlers.
 * - Drops javascript: URLs in href and src.
 * - Drops data: URLs in href and src EXCEPT data:image/...
 * - Drops residual <script> and <style>.
 * - Drops empty style="".
 */
export function sanitiseExtractedHtml (html:string):string {
    let out = html

    out = stripTagWithContent(out, 'script')
    out = stripTagWithContent(out, 'style')

    // Inline event handlers: on*=...
    out = out.replace(
        /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
        ''
    )

    // javascript: URLs in href / src.
    out = out.replace(
        /\s+(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
        ''
    )

    // data: URLs in href / src, except data:image/...
    out = out.replace(
        /\s+(href|src)\s*=\s*("data:(?!image\/)[^"]*"|'data:(?!image\/)[^']*'|data:(?!image\/)[^\s>]+)/gi,
        ''
    )

    // (regex literals above are kept on one line for clarity; the
    // backslashes are part of the escape sequence and must remain
    // unbroken.)

    // Empty style="".
    out = out.replace(/\s+style\s*=\s*(""|'')/gi, '')

    return out
}

function stripStructuralNoise (html:string):string {
    let out = stripHtmlComments(html)
    for (const tag of STRIP_TAGS) {
        out = stripWrapperTagWithContent(out, tag)
    }
    out = stripChromeClasses(out)
    return out
}

/**
 * Find the inner HTML of the first occurrence of <tag>...</tag>.
 * Naive: assumes no same-tag nesting at the top of the document.
 * Returns null if not found.
 */
function findFirstTagInner (html:string, tag:string):string|null {
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'i')
    const openMatch = open.exec(html)
    if (!openMatch) return null
    const start = openMatch.index + openMatch[0].length
    const closeRe = new RegExp(`<\\/${tag}\\s*>`, 'i')
    closeRe.lastIndex = start
    const rest = html.slice(start)
    const closeMatch = closeRe.exec(rest)
    if (!closeMatch) return null
    return rest.slice(0, closeMatch.index)
}

interface DensityCandidate {
    inner:string
    textLength:number
}

/**
 * Find the <div> or <section> with the highest plain-text content.
 * Walks every top-level element by string scanning.
 */
function findDensestBlock (html:string):string|null {
    const pattern = /<(div|section)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
    let best:DensityCandidate|null = null
    let match:RegExpExecArray|null
    while ((match = pattern.exec(html))) {
        const inner = match[2] || ''
        const length = plainTextLength(inner)
        if (!best || length > best.textLength) {
            best = { inner, textLength: length }
        }
    }
    return best && best.textLength > 0 ? best.inner : null
}

function pickCandidate (html:string):string|null {
    return findFirstTagInner(html, 'article') ||
        findFirstTagInner(html, 'main') ||
        findDensestBlock(html)
}

function utf8ByteLength (s:string):number {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(s).byteLength
    }
    let total = 0
    for (const ch of s) {
        const cp = ch.codePointAt(0) || 0
        if (cp < 0x80) total += 1
        else if (cp < 0x800) total += 2
        else if (cp < 0x10000) total += 3
        else total += 4
    }
    return total
}

function truncateAtBoundary (html:string):string|null {
    const cap = MAX_FULL_CONTENT_BYTES
    if (utf8ByteLength(html) <= cap) return html

    let lastBoundary = -1
    let scanFrom = 0
    while (scanFrom < html.length) {
        const pIdx = html.indexOf('</p>', scanFrom)
        const dIdx = html.indexOf('</div>', scanFrom)
        let next = -1
        let len = 0
        if (pIdx === -1 && dIdx === -1) break
        if (pIdx === -1) {
            next = dIdx
            len = 6
        } else if (dIdx === -1) {
            next = pIdx
            len = 4
        } else if (pIdx < dIdx) {
            next = pIdx
            len = 4
        } else {
            next = dIdx
            len = 6
        }
        const candidateEnd = next + len
        const candidate = html.slice(0, candidateEnd)
        if (utf8ByteLength(candidate) > cap) break
        lastBoundary = candidateEnd
        scanFrom = next + len
    }

    if (lastBoundary < 0) return null
    return html.slice(0, lastBoundary)
}

export function extractArticleBody (
    html:string,
    _baseUrl:string
):ExtractResult {
    const stripped = stripStructuralNoise(html)
    const candidate = pickCandidate(stripped)
    if (!candidate) return { error: 'no_body' }

    const sanitised = sanitiseExtractedHtml(candidate)

    const text = plainTextLength(sanitised)
    if (text < EXTRACTED_MIN_TEXT) return { error: 'no_body' }

    if (utf8ByteLength(sanitised) > MAX_FULL_CONTENT_BYTES) {
        const truncated = truncateAtBoundary(sanitised)
        if (truncated === null) return { error: 'too_large' }
        const truncatedText = plainTextLength(truncated)
        if (truncatedText < EXTRACTED_MIN_TEXT) return { error: 'no_body' }
        return { html: truncated, plainTextLength: truncatedText }
    }

    return { html: sanitised, plainTextLength: text }
}
