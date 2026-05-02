/**
 * Helpers for the "Read the full article on <publisher>" link.
 *
 * Both helpers return null for empty, malformed, or non-http(s) URLs
 * so the caller can render nothing without further branching.
 */

function tryParse (link:string):URL|null {
    if (!link) return null
    let url:URL
    try {
        url = new URL(link)
    } catch {
        return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
}

function publisherHost (url:URL):string {
    const host = url.host.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
}

export function publisherLinkLabel (link:string):string|null {
    const url = tryParse(link)
    if (!url) return null
    return 'Read the full article on ' + publisherHost(url)
}

export function publisherLinkHref (link:string):string|null {
    const url = tryParse(link)
    if (!url) return null
    return url.toString()
}
