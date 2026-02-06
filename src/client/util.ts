export function stripHtml (html:string):string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function decodeEntities (html:string):string {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return doc.documentElement.textContent
}

export function formatDate (dateStr:string|null):string {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`

    return date.toLocaleDateString()
}

export function sanitizeHtml (html:string):string {
    // Basic sanitization - remove script tags and event handlers
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/\s*on\w+="[^"]*"/gi, '')
        .replace(/\s*on\w+='[^']*'/gi, '')
        .replace(/javascript:/gi, '')
}

/**
 * Get the closes parent element matching the given selector.
 *
 * @param el Element to start from
 * @param s Selector for an element
 * @returns {HTMLElement|null} The closes parent element that matches.
 */
export function match (el:HTMLElement, s:string):HTMLElement|null {
    if (!el.matches) el = el.parentElement!
    return el.matches(s) ? el : el.closest(s)
}
